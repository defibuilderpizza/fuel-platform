-- Compute credits (off-chain v0): prepay compute at today's price.
--
-- One credit = unit_base_usd × (index level / 100), where the level is the Fuel Compute Index.
-- So a credit's value moves exactly with what compute costs. Credits are bought from the
-- Fuel balance and used back into it; they expire after expiry_days and are then used
-- automatically at that day's value (holders never lose them).
--
-- Reserve: money set aside to honour credits. It gets each credit's principal plus the risk
-- premium; using credits pays out of it; Fuel tops it up. Coverage = reserve / what Fuel would
-- owe if every outstanding credit were used today. Selling pauses below mint_min_coverage;
-- each wallet's daily use is capped below redeem_limit_coverage.
-- Units are micro-credits (1 credit = 1,000,000) so fractions work.

create table public.credit_config (
  id                     int primary key default 1 check (id = 1),
  enabled                boolean not null default false,
  unit_base_usd          numeric not null default 0.5625,   -- value of 1 credit at index 100
  cap_usd                numeric not null default 2500,      -- max value of all outstanding credits
  wallet_cap_usd         numeric not null default 250,       -- max value one wallet can hold
  fee_bps                int not null default 100,           -- 1%: Fuel's fee, revenue
  premium_max_bps        int not null default 300,           -- up to 3%: risk premium, goes to the reserve
  mint_min_coverage      numeric not null default 1.25,
  redeem_limit_coverage  numeric not null default 1.10,
  redeem_daily_usd       numeric not null default 50,
  expiry_days            int not null default 90,
  reserve_micro          bigint not null default 0,          -- may go negative: that's a shortfall Fuel covers
  updated_at             timestamptz not null default now()
);
insert into public.credit_config (id) values (1);

create table public.credit_lots (
  id                uuid primary key default gen_random_uuid(),
  wallet            text not null references public.accounts (wallet),
  units_micro       bigint not null check (units_micro > 0),
  units_left_micro  bigint not null check (units_left_micro >= 0),
  level_at_buy      numeric not null,
  unit_usd_at_buy   numeric not null,
  paid_micro        bigint not null,           -- total taken from the balance
  principal_micro   bigint not null,
  fee_micro         bigint not null,
  premium_micro     bigint not null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  status            text not null default 'open' check (status in ('open', 'used', 'expired'))
);
create index credit_lots_wallet_idx on public.credit_lots (wallet, created_at);
create index credit_lots_open_idx on public.credit_lots (expires_at) where status = 'open';

create table public.credit_events (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  kind         text not null check (kind in ('buy', 'use', 'expire', 'reserve')),
  wallet       text,
  lot_id       uuid,
  units_micro  bigint,
  usd_micro    bigint not null,
  level        numeric,
  note         text
);
create index credit_events_wallet_idx on public.credit_events (wallet, at desc);

alter table public.credit_config enable row level security;
alter table public.credit_lots enable row level security;
alter table public.credit_events enable row level security;

alter table public.ledger_entries drop constraint if exists ledger_entries_source_check;
alter table public.ledger_entries add constraint ledger_entries_source_check
  check (source in ('public_deposit', 'ring_topup', 'job', 'credit_redeem', 'adjustment', 'lane_payout', 'faucet_trial', 'seller_payout', 'team_transfer', 'credit_buy', 'credit_use'));

-- Value of all open credits at a given unit price (micro-USD).
create or replace function public.fuel_credit_outstanding_micro(p_unit_usd numeric, p_wallet text default null)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(floor(sum(units_left_micro) * p_unit_usd), 0)::bigint
  from credit_lots where status = 'open' and (p_wallet is null or wallet = p_wallet);
$$;

-- Buy credits. Checks (atomically, under a lock on the config row): enabled, total cap,
-- wallet cap, coverage after the sale, balance. Returns 'ok:<lot id>' or a reason.
create or replace function public.fuel_credit_buy(
  p_wallet text, p_units_micro bigint, p_unit_usd numeric, p_level numeric,
  p_principal_micro bigint, p_fee_micro bigint, p_premium_micro bigint, p_markup_bps int
) returns text language plpgsql security definer set search_path = public as $$
declare c credit_config; a accounts; total bigint; outstanding bigint; mine bigint; owe numeric; lot uuid;
begin
  if p_units_micro <= 0 or p_principal_micro <= 0 then return 'bad_amount'; end if;
  select * into c from credit_config where id = 1 for update;
  if not c.enabled then return 'disabled'; end if;
  outstanding := fuel_credit_outstanding_micro(p_unit_usd);
  mine := fuel_credit_outstanding_micro(p_unit_usd, p_wallet);
  if outstanding + p_principal_micro > c.cap_usd * 1000000 then return 'cap_reached'; end if;
  if mine + p_principal_micro > c.wallet_cap_usd * 1000000 then return 'wallet_cap_reached'; end if;
  -- coverage after the sale, against what delivering the compute would cost Fuel
  owe := (outstanding + p_principal_micro) / (1 + p_markup_bps / 10000.0);
  if (c.reserve_micro + p_principal_micro + p_premium_micro) < c.mint_min_coverage * owe then return 'coverage_low'; end if;
  total := p_principal_micro + p_fee_micro + p_premium_micro;
  select * into a from accounts where wallet = p_wallet for update;
  if not found or a.balance_micro - a.held_micro < total then return 'insufficient_balance'; end if;
  update accounts set balance_micro = balance_micro - total where wallet = p_wallet;
  insert into credit_lots (wallet, units_micro, units_left_micro, level_at_buy, unit_usd_at_buy, paid_micro, principal_micro, fee_micro, premium_micro, expires_at)
    values (p_wallet, p_units_micro, p_units_micro, p_level, p_unit_usd, total, p_principal_micro, p_fee_micro, p_premium_micro, now() + make_interval(days => c.expiry_days))
    returning id into lot;
  insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, -total, 'credit_buy', lot::text);
  update credit_config set reserve_micro = reserve_micro + p_principal_micro + p_premium_micro, updated_at = now() where id = 1;
  insert into credit_events (kind, wallet, lot_id, units_micro, usd_micro, level) values ('buy', p_wallet, lot, p_units_micro, total, p_level);
  return 'ok:' || lot;
end $$;

-- Use credits (oldest first) into the Fuel balance at today's value. p_daily_cap_micro limits
-- one wallet's use per 24 h (null = no limit). Returns 'ok:<micro-USD credited>' or a reason.
create or replace function public.fuel_credit_use(p_wallet text, p_units_micro bigint, p_unit_usd numeric, p_level numeric, p_daily_cap_micro bigint)
returns text language plpgsql security definer set search_path = public as $$
declare l credit_lots; left_units bigint := p_units_micro; take bigint; value bigint; total_value bigint := 0; used_today bigint; have bigint;
begin
  if p_units_micro <= 0 then return 'bad_amount'; end if;
  perform 1 from credit_config where id = 1 for update;
  select coalesce(sum(units_left_micro), 0) into have from credit_lots where wallet = p_wallet and status = 'open';
  if have < p_units_micro then return 'not_enough_credits'; end if;
  if p_daily_cap_micro is not null then
    select coalesce(sum(usd_micro), 0) into used_today from credit_events where wallet = p_wallet and kind = 'use' and at > now() - interval '24 hours';
    if used_today + floor(p_units_micro * p_unit_usd) > p_daily_cap_micro then return 'daily_limit'; end if;
  end if;
  perform 1 from accounts where wallet = p_wallet for update;
  for l in select * from credit_lots where wallet = p_wallet and status = 'open' order by created_at for update loop
    exit when left_units <= 0;
    take := least(left_units, l.units_left_micro);
    value := floor(take * p_unit_usd);
    update credit_lots set units_left_micro = units_left_micro - take, status = case when units_left_micro - take = 0 then 'used' else 'open' end where id = l.id;
    insert into credit_events (kind, wallet, lot_id, units_micro, usd_micro, level) values ('use', p_wallet, l.id, take, value, p_level);
    total_value := total_value + value;
    left_units := left_units - take;
  end loop;
  update accounts set balance_micro = balance_micro + total_value where wallet = p_wallet;
  insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, total_value, 'credit_use', 'use:' || gen_random_uuid());
  update credit_config set reserve_micro = reserve_micro - total_value, updated_at = now() where id = 1;
  return 'ok:' || total_value;
end $$;

-- Expire lots past their date: their remaining credits are used for the holder automatically.
create or replace function public.fuel_credit_expire(p_unit_usd numeric, p_level numeric)
returns int language plpgsql security definer set search_path = public as $$
declare l credit_lots; value bigint; n int := 0;
begin
  perform 1 from credit_config where id = 1 for update;
  for l in select * from credit_lots where status = 'open' and expires_at <= now() order by expires_at for update loop
    value := floor(l.units_left_micro * p_unit_usd);
    update credit_lots set units_left_micro = 0, status = 'expired' where id = l.id;
    update accounts set balance_micro = balance_micro + value where wallet = l.wallet;
    insert into ledger_entries (wallet, delta_micro, source, ref_id) values (l.wallet, value, 'credit_use', 'expire:' || l.id);
    insert into credit_events (kind, wallet, lot_id, units_micro, usd_micro, level, note) values ('expire', l.wallet, l.id, l.units_left_micro, value, p_level, 'used automatically at expiry');
    update credit_config set reserve_micro = reserve_micro - value, updated_at = now() where id = 1;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Treasury moves into (positive) or out of (negative) the reserve.
create or replace function public.fuel_credit_reserve(p_delta_micro bigint, p_note text)
returns bigint language plpgsql security definer set search_path = public as $$
declare r bigint;
begin
  update credit_config set reserve_micro = reserve_micro + p_delta_micro, updated_at = now() where id = 1 returning reserve_micro into r;
  insert into credit_events (kind, usd_micro, note) values ('reserve', p_delta_micro, p_note);
  return r;
end $$;

revoke all on function public.fuel_credit_outstanding_micro(numeric, text) from public, anon, authenticated;
revoke all on function public.fuel_credit_buy(text, bigint, numeric, numeric, bigint, bigint, bigint, int) from public, anon, authenticated;
revoke all on function public.fuel_credit_use(text, bigint, numeric, numeric, bigint) from public, anon, authenticated;
revoke all on function public.fuel_credit_expire(numeric, numeric) from public, anon, authenticated;
revoke all on function public.fuel_credit_reserve(bigint, text) from public, anon, authenticated;
