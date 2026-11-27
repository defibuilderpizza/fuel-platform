-- Credits backed by Fuel's locked capacity.
--
-- Fuel-operated GPUs serve credit holders only (never the open market). To know who that is,
-- each account tracks credit_funded_micro: the part of its balance that came from credits
-- (used or expired). Jobs spend it first; while it's above zero, the job may run on Fuel's GPUs.
--
-- Credit sales are capped by the capacity Fuel has promised: promise_share of the tokens its
-- locked GPUs can still serve (plus active capacity contracts), valued at today's market price.
-- Only the part of outstanding credits NOT backed by that capacity needs the cash reserve.

alter table public.accounts add column credit_funded_micro bigint not null default 0 check (credit_funded_micro >= 0);

alter table public.credit_config
  add column promise_share            numeric not null default 0.35 check (promise_share > 0 and promise_share <= 1),
  add column require_locked_capacity  boolean not null default true;

-- Settle a job: as before, plus the charge comes out of credit-funded money first.
create or replace function public.fuel_settle(
  p_job uuid, p_status text, p_provider text, p_attempts jsonb,
  p_input_tokens integer, p_output_tokens integer,
  p_provider_cost bigint, p_price bigint, p_latency_ms integer
) returns bigint language plpgsql security definer set search_path = public as $$
declare j jobs; charge bigint := 0;
begin
  select * into j from jobs where id = p_job for update;
  if not found or j.status <> 'running' then return 0; end if;
  perform 1 from accounts where wallet = j.wallet for update;

  if p_status = 'succeeded' then
    charge := least(greatest(coalesce(p_price, 0), 0), j.hold_micro);
  end if;

  update accounts
     set held_micro = greatest(held_micro - j.hold_micro, 0),
         balance_micro = balance_micro - charge,
         credit_funded_micro = greatest(credit_funded_micro - charge, 0)
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
  return charge;
end $$;

-- Buy credits, now also capped by promised locked capacity (p_locked_micro: its value today).
-- The reserve only has to cover credits beyond that capacity.
drop function if exists public.fuel_credit_buy(text, bigint, numeric, numeric, bigint, bigint, bigint, int);
create or replace function public.fuel_credit_buy(
  p_wallet text, p_units_micro bigint, p_unit_usd numeric, p_level numeric,
  p_principal_micro bigint, p_fee_micro bigint, p_premium_micro bigint, p_markup_bps int, p_locked_micro bigint
) returns text language plpgsql security definer set search_path = public as $$
declare c credit_config; a accounts; total bigint; outstanding bigint; mine bigint; unbacked numeric; lot uuid;
begin
  if p_units_micro <= 0 or p_principal_micro <= 0 then return 'bad_amount'; end if;
  select * into c from credit_config where id = 1 for update;
  if not c.enabled then return 'disabled'; end if;
  outstanding := fuel_credit_outstanding_micro(p_unit_usd);
  mine := fuel_credit_outstanding_micro(p_unit_usd, p_wallet);
  if outstanding + p_principal_micro > c.cap_usd * 1000000 then return 'cap_reached'; end if;
  if c.require_locked_capacity and outstanding + p_principal_micro > p_locked_micro then return 'capacity_cap'; end if;
  if mine + p_principal_micro > c.wallet_cap_usd * 1000000 then return 'wallet_cap_reached'; end if;
  -- reserve must cover what locked capacity doesn't, at Fuel's cost of buying it on the market
  unbacked := greatest(outstanding + p_principal_micro - p_locked_micro, 0) / (1 + p_markup_bps / 10000.0);
  if unbacked > 0 and (c.reserve_micro + p_principal_micro + p_premium_micro) < c.mint_min_coverage * unbacked then return 'coverage_low'; end if;
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

-- Use credits: as before, plus the money is marked credit-funded (it may run on Fuel's GPUs).
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
  update accounts set balance_micro = balance_micro + total_value, credit_funded_micro = credit_funded_micro + total_value where wallet = p_wallet;
  insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, total_value, 'credit_use', 'use:' || gen_random_uuid());
  update credit_config set reserve_micro = reserve_micro - total_value, updated_at = now() where id = 1;
  return 'ok:' || total_value;
end $$;

-- Expire: as before, plus the money is marked credit-funded.
create or replace function public.fuel_credit_expire(p_unit_usd numeric, p_level numeric)
returns int language plpgsql security definer set search_path = public as $$
declare l credit_lots; value bigint; n int := 0;
begin
  perform 1 from credit_config where id = 1 for update;
  for l in select * from credit_lots where status = 'open' and expires_at <= now() order by expires_at for update loop
    value := floor(l.units_left_micro * p_unit_usd);
    update credit_lots set units_left_micro = 0, status = 'expired' where id = l.id;
    update accounts set balance_micro = balance_micro + value, credit_funded_micro = credit_funded_micro + value where wallet = l.wallet;
    insert into ledger_entries (wallet, delta_micro, source, ref_id) values (l.wallet, value, 'credit_use', 'expire:' || l.id);
    insert into credit_events (kind, wallet, lot_id, units_micro, usd_micro, level, note) values ('expire', l.wallet, l.id, l.units_left_micro, value, p_level, 'used automatically at expiry');
    update credit_config set reserve_micro = reserve_micro - value, updated_at = now() where id = 1;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.fuel_settle(uuid, text, text, jsonb, integer, integer, bigint, bigint, integer) from public, anon, authenticated;
revoke all on function public.fuel_credit_buy(text, bigint, numeric, numeric, bigint, bigint, bigint, int, bigint) from public, anon, authenticated;
revoke all on function public.fuel_credit_use(text, bigint, numeric, numeric, bigint) from public, anon, authenticated;
revoke all on function public.fuel_credit_expire(numeric, numeric) from public, anon, authenticated;
