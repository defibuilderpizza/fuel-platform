-- Credit series + an order book, so holders can trade credits with each other inside Fuel.
--
-- Series: every credit bought in a calendar month belongs to that month's series and expires on
-- the same day: the 1st of the month three months after (e.g. bought in Nov 2026 → expires
-- 1 Feb 2027, so 2–3 months). Credits in one series are interchangeable, which makes them tradeable.
--
-- Order book (per series): limit orders to buy or sell, matched price-time (best price first,
-- then oldest), at the resting order's price. Sell orders escrow the credits; buy orders escrow
-- the money (price × amount + fee). Each side pays trade_fee_bps. Trades never touch the credit
-- reserve: Fuel's total obligation doesn't change, only who holds the credits.

create table public.credit_series (
  id          text primary key,              -- 'YYYY-MM' (purchase month)
  starts_at   timestamptz not null,
  expires_at  timestamptz not null
);
alter table public.credit_series enable row level security;

alter table public.credit_lots add column series_id text references public.credit_series (id);
create index credit_lots_series_idx on public.credit_lots (wallet, series_id) where status = 'open';

alter table public.credit_config
  add column trading_enabled  boolean not null default false,
  add column trade_fee_bps    int not null default 50 check (trade_fee_bps between 0 and 1000),
  add column expiry_months    int not null default 3 check (expiry_months between 1 and 12);

create table public.credit_orders (
  id            uuid primary key default gen_random_uuid(),
  wallet        text not null references public.accounts (wallet),
  series_id     text not null references public.credit_series (id),
  side          text not null check (side in ('buy', 'sell')),
  price_micro   bigint not null check (price_micro > 0),   -- micro-USD per 1 credit
  units_micro   bigint not null check (units_micro > 0),   -- micro-credits ordered
  units_open    bigint not null check (units_open >= 0),
  escrow_micro  bigint not null default 0,                 -- buy orders: money still held
  status        text not null default 'open' check (status in ('open', 'filled', 'cancelled')),
  created_at    timestamptz not null default now(),
  closed_at     timestamptz
);
create index credit_orders_book_idx on public.credit_orders (series_id, side, status, price_micro, created_at);
create index credit_orders_wallet_idx on public.credit_orders (wallet, created_at desc);
alter table public.credit_orders enable row level security;

create table public.credit_trades (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  series_id     text not null references public.credit_series (id),
  price_micro   bigint not null,
  units_micro   bigint not null,
  buyer         text not null,
  seller        text not null,
  buy_order     uuid not null,
  sell_order    uuid not null,
  buyer_fee     bigint not null,
  seller_fee    bigint not null
);
create index credit_trades_series_idx on public.credit_trades (series_id, at desc);
alter table public.credit_trades enable row level security;

alter table public.ledger_entries drop constraint if exists ledger_entries_source_check;
alter table public.ledger_entries add constraint ledger_entries_source_check
  check (source in ('public_deposit', 'ring_topup', 'job', 'credit_redeem', 'adjustment', 'lane_payout', 'faucet_trial', 'seller_payout', 'team_transfer', 'credit_buy', 'credit_use', 'forward_bond', 'forward_premium', 'credit_trade'));

-- Outstanding credits now include those escrowed in open sell orders (still owed by Fuel).
create or replace function public.fuel_credit_outstanding_micro(p_unit_usd numeric, p_wallet text default null)
returns bigint language sql stable security definer set search_path = public as $$
  select (coalesce(floor((
    coalesce((select sum(units_left_micro) from credit_lots where status = 'open' and (p_wallet is null or wallet = p_wallet)), 0)
    + coalesce((select sum(units_open) from credit_orders where status = 'open' and side = 'sell' and (p_wallet is null or wallet = p_wallet)), 0)
  ) * p_unit_usd), 0))::bigint;
$$;

-- The series credits bought right now belong to (created on first use).
create or replace function public.fuel_credit_current_series()
returns credit_series language plpgsql security definer set search_path = public as $$
declare s credit_series; m int; start timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
begin
  select expiry_months into m from credit_config where id = 1;
  insert into credit_series (id, starts_at, expires_at)
    values (to_char(start at time zone 'utc', 'YYYY-MM'), start, start + make_interval(months => coalesce(m, 3)))
    on conflict (id) do nothing;
  select * into s from credit_series where id = to_char(start at time zone 'utc', 'YYYY-MM');
  return s;
end $$;

-- Backfill: existing open lots join the series of the month they were bought in.
do $$
declare l record; sid text; st timestamptz;
begin
  for l in select id, created_at, expires_at from credit_lots where series_id is null loop
    st := date_trunc('month', l.created_at at time zone 'utc') at time zone 'utc';
    sid := to_char(st at time zone 'utc', 'YYYY-MM');
    insert into credit_series (id, starts_at, expires_at) values (sid, st, l.expires_at) on conflict (id) do nothing;
    update credit_lots set series_id = sid where id = l.id;
  end loop;
end $$;

-- Buy from Fuel: as in 0015, but into the current month's series (its expiry).
drop function if exists public.fuel_credit_buy(text, bigint, numeric, numeric, bigint, bigint, bigint, int, bigint);
create or replace function public.fuel_credit_buy(
  p_wallet text, p_units_micro bigint, p_unit_usd numeric, p_level numeric,
  p_principal_micro bigint, p_fee_micro bigint, p_premium_micro bigint, p_markup_bps int, p_locked_micro bigint
) returns text language plpgsql security definer set search_path = public as $$
declare c credit_config; a accounts; s credit_series; total bigint; outstanding bigint; mine bigint; unbacked numeric; lot uuid;
begin
  if p_units_micro <= 0 or p_principal_micro <= 0 then return 'bad_amount'; end if;
  select * into c from credit_config where id = 1 for update;
  if not c.enabled then return 'disabled'; end if;
  s := fuel_credit_current_series();
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

-- Use credits: as in 0015, soonest-expiring first.
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
  for l in select * from credit_lots where wallet = p_wallet and status = 'open' order by expires_at, created_at for update loop
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

-- Take units of one series out of a wallet's lots (oldest first). Caller holds the locks.
create or replace function public.fuel_credit_take_units(p_wallet text, p_series text, p_units bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare l credit_lots; left_units bigint := p_units; take bigint; have bigint;
begin
  select coalesce(sum(units_left_micro), 0) into have from credit_lots where wallet = p_wallet and series_id = p_series and status = 'open';
  if have < p_units then return false; end if;
  for l in select * from credit_lots where wallet = p_wallet and series_id = p_series and status = 'open' order by created_at for update loop
    exit when left_units <= 0;
    take := least(left_units, l.units_left_micro);
    update credit_lots set units_left_micro = units_left_micro - take, status = case when units_left_micro - take = 0 then 'used' else 'open' end where id = l.id;
    left_units := left_units - take;
  end loop;
  return true;
end $$;

-- Give units of a series to a wallet as a new lot (trade fills and returned escrow).
create or replace function public.fuel_credit_give_units(p_wallet text, p_series text, p_units bigint, p_price_micro bigint, p_paid bigint, p_fee bigint, p_level numeric)
returns void language plpgsql security definer set search_path = public as $$
declare s credit_series;
begin
  select * into s from credit_series where id = p_series;
  insert into credit_lots (wallet, units_micro, units_left_micro, level_at_buy, unit_usd_at_buy, paid_micro, principal_micro, fee_micro, premium_micro, expires_at, series_id)
    values (p_wallet, p_units, p_units, p_level, p_price_micro / 1000000.0, p_paid, p_paid - p_fee, p_fee, 0, s.expires_at, p_series);
end $$;

-- Place a limit order and match it. Returns 'ok:<order id>:<units filled>' or a reason.
create or replace function public.fuel_credit_place(p_wallet text, p_series text, p_side text, p_price_micro bigint, p_units_micro bigint, p_level numeric)
returns text language plpgsql security definer set search_path = public as $$
declare
  c credit_config; s credit_series; a accounts; o credit_orders; m credit_orders;
  fee_bps int; escrow bigint; qty bigint; px bigint; amount bigint; bfee bigint; sfee bigint;
  buy_id uuid; sell_id uuid; buyer text; seller text; filled bigint := 0; need bigint; open_count int;
begin
  if p_side not in ('buy', 'sell') then return 'bad_side'; end if;
  if p_price_micro <= 0 or p_units_micro < 10000 then return 'bad_amount'; end if;   -- min 0.01 credits
  select * into c from credit_config where id = 1 for update;
  if not c.enabled or not c.trading_enabled then return 'trading_off'; end if;
  select * into s from credit_series where id = p_series;
  if not found then return 'no_series'; end if;
  if s.expires_at <= now() + interval '1 hour' then return 'series_expiring'; end if;
  select count(*) into open_count from credit_orders where wallet = p_wallet and status = 'open';
  if open_count >= 20 then return 'too_many_orders'; end if;
  fee_bps := c.trade_fee_bps;
  perform 1 from accounts where wallet = p_wallet for update;
  if not found then return 'no_account'; end if;

  -- escrow
  if p_side = 'sell' then
    if not fuel_credit_take_units(p_wallet, p_series, p_units_micro) then return 'not_enough_credits'; end if;
    escrow := 0;
  else
    escrow := ceil(p_units_micro::numeric * p_price_micro / 1000000);
    escrow := escrow + ceil(escrow::numeric * fee_bps / 10000);
    select * into a from accounts where wallet = p_wallet;
    if a.balance_micro - a.held_micro < escrow then return 'insufficient_balance'; end if;
    update accounts set balance_micro = balance_micro - escrow where wallet = p_wallet;
  end if;
  insert into credit_orders (wallet, series_id, side, price_micro, units_micro, units_open, escrow_micro)
    values (p_wallet, p_series, p_side, p_price_micro, p_units_micro, p_units_micro, escrow) returning * into o;
  if escrow > 0 then
    insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, -escrow, 'credit_trade', o.id::text || ':escrow');
  end if;

  -- match against the other side: best price, then oldest; never against yourself
  for m in
    select * from credit_orders
     where series_id = p_series and status = 'open' and wallet <> p_wallet
       and side = case when p_side = 'buy' then 'sell' else 'buy' end
       and (case when p_side = 'buy' then price_micro <= p_price_micro else price_micro >= p_price_micro end)
     order by case when p_side = 'buy' then price_micro end asc, case when p_side = 'sell' then price_micro end desc, created_at
     for update
  loop
    exit when o.units_open <= 0;
    qty := least(o.units_open, m.units_open);
    px := m.price_micro;                                   -- trades at the resting order's price
    amount := floor(qty::numeric * px / 1000000);
    bfee := ceil(amount::numeric * fee_bps / 10000);
    sfee := ceil(amount::numeric * fee_bps / 10000);
    -- per-fill rounding must never take more than the buy order still holds
    bfee := least(bfee, greatest((case when p_side = 'buy' then o.escrow_micro else m.escrow_micro end) - amount, 0));
    if p_side = 'buy' then
      buy_id := o.id; sell_id := m.id; buyer := p_wallet; seller := m.wallet;
    else
      buy_id := m.id; sell_id := o.id; buyer := m.wallet; seller := p_wallet;
    end if;
    perform 1 from accounts where wallet in (buyer, seller) order by wallet for update;
    -- buyer: pays from their order's escrow, gets the credits
    update credit_orders set escrow_micro = escrow_micro - (amount + bfee) where id = buy_id;
    perform fuel_credit_give_units(buyer, p_series, qty, px, amount + bfee, bfee, p_level);
    -- seller: paid amount minus fee
    update accounts set balance_micro = balance_micro + (amount - sfee) where wallet = seller;
    insert into ledger_entries (wallet, delta_micro, source, ref_id) values (seller, amount - sfee, 'credit_trade', sell_id::text || ':fill:' || gen_random_uuid());
    insert into credit_trades (series_id, price_micro, units_micro, buyer, seller, buy_order, sell_order, buyer_fee, seller_fee)
      values (p_series, px, qty, buyer, seller, buy_id, sell_id, bfee, sfee);
    update credit_orders set units_open = units_open - qty, status = case when units_open - qty = 0 then 'filled' else 'open' end,
      closed_at = case when units_open - qty = 0 then now() else null end where id = m.id;
    update credit_orders set units_open = units_open - qty, status = case when units_open - qty = 0 then 'filled' else 'open' end,
      closed_at = case when units_open - qty = 0 then now() else null end where id = o.id returning * into o;
    filled := filled + qty;
    -- a resting buy order that filled completely gives back what's left of its escrow
    if p_side = 'sell' then
      select * into m from credit_orders where id = m.id;
      if m.status = 'filled' and m.escrow_micro > 0 then
        update accounts set balance_micro = balance_micro + m.escrow_micro where wallet = m.wallet;
        insert into ledger_entries (wallet, delta_micro, source, ref_id) values (m.wallet, m.escrow_micro, 'credit_trade', m.id::text || ':refund');
        update credit_orders set escrow_micro = 0 where id = m.id;
      end if;
    end if;
  end loop;

  -- the incoming buy order keeps only the escrow its open part still needs; the rest comes back
  if p_side = 'buy' then
    select * into o from credit_orders where id = o.id;
    need := ceil(o.units_open::numeric * o.price_micro / 1000000);
    need := need + ceil(need::numeric * fee_bps / 10000);
    if o.escrow_micro > need then
      update accounts set balance_micro = balance_micro + (o.escrow_micro - need) where wallet = p_wallet;
      insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, o.escrow_micro - need, 'credit_trade', o.id::text || ':refund:' || gen_random_uuid());
      update credit_orders set escrow_micro = need where id = o.id;
    end if;
  end if;
  return 'ok:' || o.id || ':' || filled;
end $$;

-- Cancel an open order: credits or money go back. p_wallet null = admin/system.
create or replace function public.fuel_credit_cancel(p_order uuid, p_wallet text, p_level numeric)
returns text language plpgsql security definer set search_path = public as $$
declare o credit_orders;
begin
  perform 1 from credit_config where id = 1 for update;
  select * into o from credit_orders where id = p_order for update;
  if not found or (p_wallet is not null and o.wallet <> p_wallet) then return 'not_found'; end if;
  if o.status <> 'open' then return 'not_open'; end if;
  perform 1 from accounts where wallet = o.wallet for update;
  if o.side = 'sell' and o.units_open > 0 then
    perform fuel_credit_give_units(o.wallet, o.series_id, o.units_open, 0, 0, 0, p_level);
  end if;
  if o.side = 'buy' and o.escrow_micro > 0 then
    update accounts set balance_micro = balance_micro + o.escrow_micro where wallet = o.wallet;
    insert into ledger_entries (wallet, delta_micro, source, ref_id) values (o.wallet, o.escrow_micro, 'credit_trade', o.id::text || ':cancel');
  end if;
  update credit_orders set status = 'cancelled', escrow_micro = 0, closed_at = now() where id = p_order;
  return 'ok';
end $$;

-- Before a series expires: cancel its open orders (credits and money go back to their owners).
create or replace function public.fuel_credit_close_series(p_level numeric)
returns int language plpgsql security definer set search_path = public as $$
declare o record; n int := 0;
begin
  for o in select ord.id from credit_orders ord join credit_series s on s.id = ord.series_id
            where ord.status = 'open' and s.expires_at <= now() + interval '1 hour' loop
    perform fuel_credit_cancel(o.id, null, p_level);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.fuel_credit_outstanding_micro(numeric, text) from public, anon, authenticated;
revoke all on function public.fuel_credit_current_series() from public, anon, authenticated;
revoke all on function public.fuel_credit_buy(text, bigint, numeric, numeric, bigint, bigint, bigint, int, bigint) from public, anon, authenticated;
revoke all on function public.fuel_credit_use(text, bigint, numeric, numeric, bigint) from public, anon, authenticated;
revoke all on function public.fuel_credit_take_units(text, text, bigint) from public, anon, authenticated;
revoke all on function public.fuel_credit_give_units(text, text, bigint, bigint, bigint, bigint, numeric) from public, anon, authenticated;
revoke all on function public.fuel_credit_place(text, text, text, bigint, bigint, numeric) from public, anon, authenticated;
revoke all on function public.fuel_credit_cancel(uuid, text, numeric) from public, anon, authenticated;
revoke all on function public.fuel_credit_close_series(numeric) from public, anon, authenticated;
