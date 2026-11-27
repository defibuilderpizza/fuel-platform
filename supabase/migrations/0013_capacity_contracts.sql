-- Capacity contracts: sellers sell compute forward, so Fuel can cap what compute costs it.
--
-- A seller promises: for one of their models, for term_days, serve up to volume_mtok million
-- tokens at no more than the ceiling price. They post a bond (bond_pct of the contract's value)
-- from their Fuel balance. Fuel pays the agreed premium at the end of the term if they kept the
-- promise, and returns the bond. If they break it (price above the ceiling is refused outright;
-- the model down for longer than breach_hours), the bond goes to the credit reserve.
--
-- Routing stays cheapest-first: when market prices rise above the ceiling, the seller is the
-- cheapest route, so Fuel's cost on that volume can't go above the ceiling. When prices fall,
-- Fuel simply uses cheaper routes.

create table public.capacity_contracts (
  id              uuid primary key default gen_random_uuid(),
  seller_id       uuid not null references public.sellers (id) on delete cascade,
  wallet          text not null references public.accounts (wallet),
  model           text not null,
  ceiling_in      numeric not null check (ceiling_in >= 0),     -- USD per 1M input tokens
  ceiling_out     numeric not null check (ceiling_out >= 0),    -- USD per 1M output tokens
  volume_mtok     numeric not null check (volume_mtok > 0),     -- million tokens (input + output)
  term_days       int not null check (term_days in (30, 60, 90)),
  premium_pct     numeric not null check (premium_pct >= 0),    -- of the contract's value
  notional_micro  bigint not null,                              -- volume × typical-job ceiling price
  bond_micro      bigint not null,
  premium_micro   bigint not null,
  status          text not null default 'offered' check (status in ('offered', 'active', 'completed', 'breached', 'rejected', 'withdrawn')),
  used_mtok       numeric not null default 0,
  failing_since   timestamptz,
  note            text,
  created_at      timestamptz not null default now(),
  starts_at       timestamptz,
  ends_at         timestamptz,
  settled_at      timestamptz
);
create index capacity_contracts_seller_idx on public.capacity_contracts (seller_id, status);
create index capacity_contracts_active_idx on public.capacity_contracts (status) where status in ('offered', 'active');
alter table public.capacity_contracts enable row level security;

alter table public.credit_config
  add column forward_bond_pct         numeric not null default 0.20,
  add column forward_max_premium_pct  numeric not null default 5,
  add column forward_breach_hours     int not null default 24;

alter table public.ledger_entries drop constraint if exists ledger_entries_source_check;
alter table public.ledger_entries add constraint ledger_entries_source_check
  check (source in ('public_deposit', 'ring_topup', 'job', 'credit_redeem', 'adjustment', 'lane_payout', 'faucet_trial', 'seller_payout', 'team_transfer', 'credit_buy', 'credit_use', 'forward_bond', 'forward_premium'));

-- Offer a contract: the bond leaves the seller's balance. Returns 'ok:<id>' or a reason.
create or replace function public.fuel_forward_offer(
  p_wallet text, p_seller uuid, p_model text, p_ceiling_in numeric, p_ceiling_out numeric,
  p_volume_mtok numeric, p_term_days int, p_premium_pct numeric, p_notional_micro bigint, p_bond_micro bigint, p_premium_micro bigint
) returns text language plpgsql security definer set search_path = public as $$
declare a accounts; cid uuid;
begin
  if exists (select 1 from capacity_contracts where seller_id = p_seller and model = p_model and status in ('offered', 'active')) then return 'already_committed'; end if;
  select * into a from accounts where wallet = p_wallet for update;
  if not found or a.balance_micro - a.held_micro < p_bond_micro then return 'insufficient_balance'; end if;
  update accounts set balance_micro = balance_micro - p_bond_micro where wallet = p_wallet;
  insert into capacity_contracts (seller_id, wallet, model, ceiling_in, ceiling_out, volume_mtok, term_days, premium_pct, notional_micro, bond_micro, premium_micro)
    values (p_seller, p_wallet, p_model, p_ceiling_in, p_ceiling_out, p_volume_mtok, p_term_days, p_premium_pct, p_notional_micro, p_bond_micro, p_premium_micro)
    returning id into cid;
  insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, -p_bond_micro, 'forward_bond', cid::text || ':post');
  return 'ok:' || cid;
end $$;

-- Close a contract and move the money. p_outcome:
--   'withdrawn' / 'rejected' (only from offered): bond back
--   'completed' (only from active): bond back + premium from the reserve
--   'breached'  (only from active): bond to the reserve
create or replace function public.fuel_forward_close(p_id uuid, p_outcome text, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare c capacity_contracts;
begin
  perform 1 from credit_config where id = 1 for update;
  select * into c from capacity_contracts where id = p_id for update;
  if not found then return 'not_found'; end if;
  if p_outcome in ('withdrawn', 'rejected') and c.status <> 'offered' then return 'wrong_state'; end if;
  if p_outcome in ('completed', 'breached') and c.status <> 'active' then return 'wrong_state'; end if;
  if p_outcome not in ('withdrawn', 'rejected', 'completed', 'breached') then return 'bad_outcome'; end if;
  perform 1 from accounts where wallet = c.wallet for update;
  if p_outcome in ('withdrawn', 'rejected', 'completed') then
    update accounts set balance_micro = balance_micro + c.bond_micro where wallet = c.wallet;
    insert into ledger_entries (wallet, delta_micro, source, ref_id) values (c.wallet, c.bond_micro, 'forward_bond', p_id::text || ':return');
  end if;
  if p_outcome = 'completed' and c.premium_micro > 0 then
    update accounts set balance_micro = balance_micro + c.premium_micro where wallet = c.wallet;
    insert into ledger_entries (wallet, delta_micro, source, ref_id) values (c.wallet, c.premium_micro, 'forward_premium', p_id::text);
    update credit_config set reserve_micro = reserve_micro - c.premium_micro, updated_at = now() where id = 1;
    insert into credit_events (kind, wallet, usd_micro, note) values ('reserve', c.wallet, -c.premium_micro, 'capacity contract premium ' || p_id);
  end if;
  if p_outcome = 'breached' then
    update credit_config set reserve_micro = reserve_micro + c.bond_micro, updated_at = now() where id = 1;
    insert into credit_events (kind, wallet, usd_micro, note) values ('reserve', c.wallet, c.bond_micro, 'capacity contract bond kept (breach) ' || p_id);
  end if;
  update capacity_contracts set status = p_outcome, settled_at = now(), note = coalesce(p_note, note) where id = p_id;
  return 'ok';
end $$;

revoke all on function public.fuel_forward_offer(text, uuid, text, numeric, numeric, numeric, int, numeric, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function public.fuel_forward_close(uuid, text, text) from public, anon, authenticated;
