-- Tiered compute credits, counted in tokens.
--
-- Four tiers, each its own credit (and its own order book):
--   max   top closed models (Claude Opus / Fable, GPT Astra)
--   pro   other closed models (Claude Sonnet / Haiku, GPT Sol / Terra / Luna) and open models
--         costing $1.50+ per 1M tokens (the largest, e.g. Kimi K3)
--   open  open-weight chat models under $1.50 per 1M tokens
--   lane  embeddings and classification (incl. the laptop lane)
-- 1 credit = at least 1M tokens at a 3:1 input:output mix on any model in its tier. A tier's
-- price_micro is what 1M such tokens cost on its dearest model today, incl. Fuel's markup (the
-- app refreshes it from live prices). A job uses (its price / price_micro) credits, so the
-- dearest model gets exactly 1M tokens per credit and cheaper ones get more.
--
-- Credits are now spent by jobs, not turned into balance: a job on a model of the tier draws the
-- caller's credits (soonest expiry first). The job's hold is covered by credits taken up front
-- and put into the balance as a "float" from the reserve; at settle, the credits the job didn't
-- need go back and the float minus the job's charge returns to the reserve. Net effect: the
-- caller's balance doesn't move, the reserve pays the job, the caller's credits pay the reserve.
--
-- Series are per month per tier: 'YYYY-MM-<tier>'. Credits of a dearer tier can be converted
-- into a cheaper tier's credits of the same month at the price ratio, minus trade_down_fee_bps.
-- Credits were never sold before this migration (no lots), so the old untiered series goes.

create table public.credit_tiers (
  id           text primary key check (id ~ '^[a-z]+$'),
  name         text not null,
  sort         int not null,
  description  text not null,
  price_micro  bigint not null default 0,   -- USD micro per credit, refreshed from live prices
  price_at     timestamptz,
  active       boolean not null default true
);
alter table public.credit_tiers enable row level security;
insert into public.credit_tiers (id, name, sort, description) values
  ('max',  'Max',  1, 'Top closed models: Claude Opus and Fable, GPT Astra'),
  ('pro',  'Pro',  2, 'Claude Sonnet and Haiku, GPT Sol, Terra and Luna, and the largest open models (Kimi K3, GLM, DeepSeek Pro)'),
  ('open', 'Open', 3, 'Open-weight chat models under $1.50 per 1M tokens: Qwen, DeepSeek Flash, MiniMax and more'),
  ('lane', 'Lane', 4, 'Embeddings and classification, incl. the laptop lane');

alter table public.credit_config
  add column trade_down_fee_bps int not null default 500 check (trade_down_fee_bps between 0 and 2000);

-- The untiered series held nothing; drop it (and any other empty one).
delete from public.credit_series s
 where not exists (select 1 from public.credit_lots l where l.series_id = s.id)
   and not exists (select 1 from public.credit_orders o where o.series_id = s.id)
   and not exists (select 1 from public.credit_trades t where t.series_id = s.id)
   and not exists (select 1 from public.credit_mints m where m.series_id = s.id)
   and not exists (select 1 from public.credit_bridge b where b.series_id = s.id);
alter table public.credit_series add column tier text references public.credit_tiers (id);
update public.credit_series set tier = 'open' where tier is null;
alter table public.credit_series alter column tier set not null;

alter table public.credit_events drop constraint if exists credit_events_kind_check;
alter table public.credit_events add constraint credit_events_kind_check
  check (kind in ('buy', 'use', 'expire', 'reserve', 'bridge_out', 'bridge_in', 'convert'));

-- Series of a tier for the month credits are bought in now (created on first use).
drop function if exists public.fuel_credit_current_series();
create or replace function public.fuel_credit_current_series(p_tier text)
returns credit_series language plpgsql security definer set search_path = public as $$
declare s credit_series; m int; start timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc'; sid text;
begin
  select expiry_months into m from credit_config where id = 1;
  sid := to_char(start at time zone 'utc', 'YYYY-MM') || '-' || p_tier;
  insert into credit_series (id, tier, starts_at, expires_at)
    values (sid, p_tier, start, start + make_interval(months => coalesce(m, 3)))
    on conflict (id) do nothing;
  select * into s from credit_series where id = sid;
  return s;
end $$;

-- What Fuel owes on outstanding credits, at each tier's current price. (p_unit_usd is unused now;
-- kept so the signature doesn't change.)
create or replace function public.fuel_credit_outstanding_micro(p_unit_usd numeric, p_wallet text default null)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(floor(sum(u.units * t.price_micro / 1000000.0)), 0)::bigint from (
    select s.tier, l.units_left_micro as units from credit_lots l join credit_series s on s.id = l.series_id
     where l.status = 'open' and (p_wallet is null or l.wallet = p_wallet)
    union all
    select s.tier, o.units_open from credit_orders o join credit_series s on s.id = o.series_id
     where o.status = 'open' and o.side = 'sell' and (p_wallet is null or o.wallet = p_wallet)
  ) u join credit_tiers t on t.id = u.tier;
$$;

-- Buy from Fuel: as in 0017, into the current month's series of the tier.
drop function if exists public.fuel_credit_buy(text, bigint, numeric, numeric, bigint, bigint, bigint, int, bigint);
create or replace function public.fuel_credit_buy(
  p_wallet text, p_tier text, p_units_micro bigint, p_unit_usd numeric, p_level numeric,
  p_principal_micro bigint, p_fee_micro bigint, p_premium_micro bigint, p_markup_bps int, p_locked_micro bigint
) returns text language plpgsql security definer set search_path = public as $$
declare c credit_config; a accounts; s credit_series; t credit_tiers; total bigint; outstanding bigint; mine bigint; unbacked numeric; lot uuid;
begin
  if p_units_micro <= 0 or p_principal_micro <= 0 then return 'bad_amount'; end if;
  select * into c from credit_config where id = 1 for update;
  if not c.enabled then return 'disabled'; end if;
  select * into t from credit_tiers where id = p_tier;
  if not found or not t.active or t.price_micro <= 0 then return 'no_tier'; end if;
  s := fuel_credit_current_series(p_tier);
  outstanding := fuel_credit_outstanding_micro(p_unit_usd);
  mine := fuel_credit_outstanding_micro(p_unit_usd, p_wallet);
  if outstanding + p_principal_micro > c.cap_usd * 1000000 then return 'cap_reached'; end if;
  if c.require_locked_capacity and outstanding + p_principal_micro > p_locked_micro then return 'capacity_cap'; end if;
  if mine + p_principal_micro > c.wallet_cap_usd * 1000000 then return 'wallet_cap_reached'; end if;
  unbacked := greatest(outstanding + p_principal_micro - p_locked_micro, 0) / (1 + p_markup_bps / 10000.0);
  if unbacked > 0 and (c.reserve_micro + p_principal_micro + p_premium_micro) < c.mint_min_coverage * unbacked then return 'coverage_low'; end if;
  total := p_principal_micro + p_fee_micro + p_premium_micro;
  select * into a from accounts where wallet = p_wallet for update;
  if not found or a.balance_micro - a.held_micro < total then return 'insufficient_balance'; end if;
  update accounts set balance_micro = balance_micro - total where wallet = p_wallet;
  insert into credit_lots (wallet, units_micro, units_left_micro, level_at_buy, unit_usd_at_buy, paid_micro, principal_micro, fee_micro, premium_micro, expires_at, series_id)
    values (p_wallet, p_units_micro, p_units_micro, p_level, p_unit_usd, total, p_principal_micro, p_fee_micro, p_premium_micro, s.expires_at, s.id)
    returning id into lot;
  insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, -total, 'credit_buy', lot::text);
  update credit_config set reserve_micro = reserve_micro + p_principal_micro + p_premium_micro, updated_at = now() where id = 1;
  insert into credit_events (kind, wallet, lot_id, units_micro, usd_micro, level, note) values ('buy', p_wallet, lot, p_units_micro, total, p_level, s.id);
  return 'ok:' || lot;
end $$;

-- Credits are spent by jobs now; turning them into balance by hand is gone.
drop function if exists public.fuel_credit_use(text, bigint, numeric, numeric, bigint);

-- Expiry: what's left is turned into balance at its tier's current price (holders never lose
-- it outright, but it no longer counts as credits).
create or replace function public.fuel_credit_expire(p_unit_usd numeric, p_level numeric)
returns int language plpgsql security definer set search_path = public as $$
declare l record; value bigint; n int := 0;
begin
  perform 1 from credit_config where id = 1 for update;
  for l in select cl.id, cl.wallet, cl.units_left_micro, t.price_micro from credit_lots cl
             join credit_series s on s.id = cl.series_id join credit_tiers t on t.id = s.tier
            where cl.status = 'open' and cl.expires_at <= now() order by cl.expires_at for update of cl loop
    value := floor(l.units_left_micro * l.price_micro / 1000000.0);
    update credit_lots set units_left_micro = 0, status = 'expired' where id = l.id;
    update accounts set balance_micro = balance_micro + value, credit_funded_micro = credit_funded_micro + value where wallet = l.wallet;
    insert into ledger_entries (wallet, delta_micro, source, ref_id) values (l.wallet, value, 'credit_use', 'expire:' || l.id);
    insert into credit_events (kind, wallet, lot_id, units_micro, usd_micro, level, note) values ('expire', l.wallet, l.id, l.units_left_micro, value, p_level, 'turned into balance at expiry');
    update credit_config set reserve_micro = reserve_micro - value, updated_at = now() where id = 1;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ── Jobs paid with credits ──────────────────────────────────────────────────────────────────

create table public.credit_job_holds (
  job_id        uuid primary key references public.jobs (id),
  wallet        text not null references public.accounts (wallet),
  tier          text not null references public.credit_tiers (id),
  price_micro   bigint not null check (price_micro > 0),   -- USD micro per credit at hold time
  units_held    bigint not null check (units_held > 0),
  float_micro   bigint not null check (float_micro > 0),   -- put into the balance to cover the hold
  units_used    bigint,
  charge_micro  bigint,
  created_at    timestamptz not null default now(),
  settled_at    timestamptz
);
create index credit_job_holds_wallet_idx on public.credit_job_holds (wallet, created_at desc);
alter table public.credit_job_holds enable row level security;

create table public.credit_job_takes (
  job_id  uuid not null,
  lot_id  uuid not null references public.credit_lots (id),
  units   bigint not null check (units > 0),
  primary key (job_id, lot_id)
);
alter table public.credit_job_takes enable row level security;

-- Hold a job with credits of p_tier: takes enough credits to cover p_hold at p_price_micro per
-- credit, floats p_hold into the balance from the reserve, then reserves the job as usual.
-- Returns 'ok', 'no_credits' (not enough credits of the tier: pay from balance instead), or
-- fuel_reserve's reason. Nothing changes unless it returns 'ok'.
create or replace function public.fuel_credit_job_reserve(
  p_job uuid, p_wallet text, p_model text, p_kind text, p_hold bigint, p_streamed boolean, p_tier text, p_price_micro bigint
) returns text language plpgsql security definer set search_path = public as $$
declare c credit_config; need bigint; have bigint; l record; left_units bigint; take bigint; r text;
begin
  if p_hold <= 0 or p_price_micro <= 0 then return 'no_credits'; end if;
  select * into c from credit_config where id = 1 for update;
  if not c.enabled then return 'no_credits'; end if;
  need := ceil(p_hold::numeric * 1000000 / p_price_micro);
  perform 1 from accounts where wallet = p_wallet for update;
  if not found then return 'no_credits'; end if;
  select coalesce(sum(cl.units_left_micro), 0) into have from credit_lots cl join credit_series s on s.id = cl.series_id
   where cl.wallet = p_wallet and cl.status = 'open' and s.tier = p_tier and cl.expires_at > now();
  if have < need then return 'no_credits'; end if;

  begin
    left_units := need;
    for l in select cl.id, cl.units_left_micro from credit_lots cl join credit_series s on s.id = cl.series_id
              where cl.wallet = p_wallet and cl.status = 'open' and s.tier = p_tier and cl.expires_at > now()
              order by cl.expires_at, cl.created_at for update of cl loop
      exit when left_units <= 0;
      take := least(left_units, l.units_left_micro);
      update credit_lots set units_left_micro = units_left_micro - take,
        status = case when units_left_micro - take = 0 then 'used' else 'open' end where id = l.id;
      insert into credit_job_takes (job_id, lot_id, units) values (p_job, l.id, take);
      left_units := left_units - take;
    end loop;
    update accounts set balance_micro = balance_micro + p_hold where wallet = p_wallet;
    update credit_config set reserve_micro = reserve_micro - p_hold, updated_at = now() where id = 1;
    insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, p_hold, 'credit_use', 'job:' || p_job);
    r := fuel_reserve(p_job, p_wallet, p_model, p_kind, p_hold, p_streamed);
    if r <> 'ok' then raise exception 'fuel_reserve:%', r; end if;
    insert into credit_job_holds (job_id, wallet, tier, price_micro, units_held, float_micro)
      values (p_job, p_wallet, p_tier, p_price_micro, need, p_hold);
  exception when raise_exception then
    if sqlerrm like 'fuel_reserve:%' then return substr(sqlerrm, 14); end if;
    raise;
  end;
  return 'ok';
end $$;

-- Close a credit-paid job that charged p_charge: credits it didn't need go back to their lots
-- (latest expiry first), and the float it didn't spend goes back to the reserve. Caller holds
-- the job and account locks. No-op for jobs not paid with credits.
create or replace function public.fuel_credit_job_close(p_job uuid, p_charge bigint)
returns void language plpgsql security definer set search_path = public as $$
declare h credit_job_holds; used bigint; back bigint; g bigint; t record; unspent bigint;
begin
  select * into h from credit_job_holds where job_id = p_job and settled_at is null for update;
  if not found then return; end if;
  perform 1 from credit_config where id = 1 for update;
  used := least(ceil(greatest(p_charge, 0)::numeric * 1000000 / h.price_micro), h.units_held);
  back := h.units_held - used;
  for t in select k.lot_id, k.units, cl.status, cl.series_id from credit_job_takes k join credit_lots cl on cl.id = k.lot_id
            where k.job_id = p_job order by cl.expires_at desc, cl.created_at desc for update of cl loop
    exit when back <= 0;
    g := least(back, t.units);
    if t.status = 'expired' then
      perform fuel_credit_give_units(h.wallet, t.series_id, g, 0, 0, 0, 0);   -- expires on the next run
    else
      update credit_lots set units_left_micro = units_left_micro + g, status = 'open' where id = t.lot_id;
    end if;
    back := back - g;
  end loop;
  unspent := h.float_micro - least(greatest(p_charge, 0), h.float_micro);
  if unspent > 0 then
    update accounts set balance_micro = balance_micro - unspent where wallet = h.wallet;
    update credit_config set reserve_micro = reserve_micro + unspent, updated_at = now() where id = 1;
    insert into ledger_entries (wallet, delta_micro, source, ref_id) values (h.wallet, -unspent, 'credit_use', 'job:' || p_job || ':back');
  end if;
  update credit_job_holds set units_used = used, charge_micro = least(greatest(p_charge, 0), h.float_micro), settled_at = now() where job_id = p_job;
  if used > 0 then
    insert into credit_events (kind, wallet, units_micro, usd_micro, level, note) values ('use', h.wallet, used, least(greatest(p_charge, 0), h.float_micro), 0, 'job:' || p_job);
  end if;
end $$;

-- Settle: as in 0015, then closes credit-paid jobs. Their charge doesn't eat credit_funded money.
create or replace function public.fuel_settle(
  p_job uuid, p_status text, p_provider text, p_attempts jsonb,
  p_input_tokens integer, p_output_tokens integer,
  p_provider_cost bigint, p_price bigint, p_latency_ms integer
) returns bigint language plpgsql security definer set search_path = public as $$
declare j jobs; charge bigint := 0; paid_by_credits boolean;
begin
  select * into j from jobs where id = p_job for update;
  if not found or j.status <> 'running' then return 0; end if;
  perform 1 from accounts where wallet = j.wallet for update;
  paid_by_credits := exists (select 1 from credit_job_holds where job_id = p_job and settled_at is null);

  if p_status = 'succeeded' then
    charge := least(greatest(coalesce(p_price, 0), 0), j.hold_micro);
  end if;

  update accounts
     set held_micro = greatest(held_micro - j.hold_micro, 0),
         balance_micro = balance_micro - charge,
         credit_funded_micro = case when paid_by_credits then credit_funded_micro else greatest(credit_funded_micro - charge, 0) end
   where wallet = j.wallet;

  if charge > 0 then
    insert into ledger_entries (wallet, delta_micro, source, ref_id)
      values (j.wallet, -charge, 'job', p_job::text);
  end if;

  update jobs set
    status = p_status, provider = p_provider, attempts = coalesce(p_attempts, '[]'::jsonb),
    input_tokens = p_input_tokens, output_tokens = p_output_tokens,
    provider_cost_micro = p_provider_cost, price_micro = charge,
    latency_ms = p_latency_ms, finished_at = now()
  where id = p_job;

  if paid_by_credits then perform fuel_credit_job_close(p_job, charge); end if;
  return charge;
end $$;

-- Stale jobs (never settled) also give back their credits and float.
create or replace function public.fuel_release_stale(p_wallet text)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    select id, hold_micro from jobs
    where wallet = p_wallet and status = 'running' and created_at < now() - interval '15 minutes'
    for update
  loop
    update jobs set status = 'failed', finished_at = now() where id = r.id;
    update accounts set held_micro = greatest(held_micro - r.hold_micro, 0) where wallet = p_wallet;
    perform fuel_credit_job_close(r.id, 0);
  end loop;
end $$;

-- ── Trade down: dearer tier → cheaper tier, same month ──────────────────────────────────────
create or replace function public.fuel_credit_trade_down(
  p_wallet text, p_series text, p_to_tier text, p_units bigint, p_from_price bigint, p_to_price bigint, p_fee_bps int
) returns text language plpgsql security definer set search_path = public as $$
declare s credit_series; to_id text; out_units bigint;
begin
  if p_units < 10000 then return 'bad_amount'; end if;
  select * into s from credit_series where id = p_series;
  if not found then return 'no_series'; end if;
  if s.tier = p_to_tier then return 'same_tier'; end if;
  if not exists (select 1 from credit_tiers where id = p_to_tier and active) then return 'no_tier'; end if;
  if p_to_price <= 0 or p_from_price <= 0 or p_to_price >= p_from_price then return 'not_cheaper'; end if;
  if s.expires_at <= now() + interval '1 hour' then return 'series_expiring'; end if;
  perform 1 from credit_config where id = 1 for update;
  perform 1 from accounts where wallet = p_wallet for update;
  if not fuel_credit_take_units(p_wallet, p_series, p_units) then return 'not_enough_credits'; end if;
  out_units := floor(p_units::numeric * p_from_price / p_to_price * (10000 - p_fee_bps) / 10000);
  to_id := left(s.id, 7) || '-' || p_to_tier;
  insert into credit_series (id, tier, starts_at, expires_at) values (to_id, p_to_tier, s.starts_at, s.expires_at) on conflict (id) do nothing;
  perform fuel_credit_give_units(p_wallet, to_id, out_units, 0, 0, 0, 0);
  insert into credit_events (kind, wallet, units_micro, usd_micro, level, note)
    values ('convert', p_wallet, p_units, 0, 0, p_series || '->' || to_id || ':' || out_units);
  return 'ok:' || to_id || ':' || out_units;
end $$;

-- ── Standing rules: Fuel trades for you ─────────────────────────────────────────────────────
create table public.credit_rules (
  id               uuid primary key default gen_random_uuid(),
  wallet           text not null references public.accounts (wallet),
  kind             text not null check (kind in ('keep_min', 'sell_before_expiry')),
  tier             text not null references public.credit_tiers (id),
  min_credits      numeric,      -- keep_min: buy when holdings fall below this…
  target_credits   numeric,      -- …back up to this
  max_price_micro  bigint,       -- keep_min: never pay more per credit (book or Fuel)
  min_price_micro  bigint,       -- sell_before_expiry: never sell for less per credit
  days_before      int,          -- sell_before_expiry: list this many days before expiry
  active           boolean not null default true,
  last_run_at      timestamptz,
  last_result      text,
  created_at       timestamptz not null default now()
);
create index credit_rules_active_idx on public.credit_rules (active, last_run_at);
create index credit_rules_wallet_idx on public.credit_rules (wallet);
alter table public.credit_rules enable row level security;

revoke all on function public.fuel_credit_current_series(text) from public, anon, authenticated;
revoke all on function public.fuel_credit_outstanding_micro(numeric, text) from public, anon, authenticated;
revoke all on function public.fuel_credit_buy(text, text, bigint, numeric, numeric, bigint, bigint, bigint, int, bigint) from public, anon, authenticated;
revoke all on function public.fuel_credit_expire(numeric, numeric) from public, anon, authenticated;
revoke all on function public.fuel_credit_job_reserve(uuid, text, text, text, bigint, boolean, text, bigint) from public, anon, authenticated;
revoke all on function public.fuel_credit_job_close(uuid, bigint) from public, anon, authenticated;
revoke all on function public.fuel_settle(uuid, text, text, jsonb, integer, integer, bigint, bigint, integer) from public, anon, authenticated;
revoke all on function public.fuel_release_stale(text) from public, anon, authenticated;
revoke all on function public.fuel_credit_trade_down(text, text, text, bigint, bigint, bigint, int) from public, anon, authenticated;
