-- Compute credits as SPL tokens (one fungible mint per monthly series). See src/lib/credit-token.ts.
-- Bridging moves credits between a holder and Fuel's bridge account; Fuel's total obligation never
-- changes. Invariant: the bridge's open credits in a series == that series' on-chain token supply.
-- Expiry: tokens not deposited back before their series expires are forfeited (at expiry the
-- bridge's credits are used like everyone else's, into the bridge account). Withdrawals stop a
-- day before expiry.

insert into public.accounts (wallet) values ('fuel:credit-bridge') on conflict (wallet) do nothing;

alter table public.credit_events drop constraint if exists credit_events_kind_check;
alter table public.credit_events add constraint credit_events_kind_check
  check (kind in ('buy', 'use', 'expire', 'reserve', 'bridge_out', 'bridge_in'));

create table if not exists public.credit_mints (
  series_id  text not null references public.credit_series (id),
  network    text not null check (network in ('devnet', 'mainnet')),
  mint       text not null unique,
  created_at timestamptz not null default now(),
  primary key (series_id, network)
);
alter table public.credit_mints enable row level security;

create table if not exists public.credit_bridge (
  id          uuid primary key,
  wallet      text not null references public.accounts (wallet),
  series_id   text not null references public.credit_series (id),
  direction   text not null check (direction in ('out', 'in')),
  units_micro bigint not null check (units_micro > 0),
  status      text not null check (status in ('pending', 'done', 'refunded')),
  signature   text unique,
  note        text,
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index if not exists credit_bridge_wallet_idx on public.credit_bridge (wallet, created_at desc);
alter table public.credit_bridge enable row level security;

-- Withdraw: holder's credits → bridge account (pending until the mint transaction lands).
create or replace function public.fuel_credit_bridge_out(p_id uuid, p_wallet text, p_series text, p_units bigint)
returns text language plpgsql security definer set search_path = public as $$
declare s credit_series;
begin
  if p_units <= 0 then return 'bad_amount'; end if;
  select * into s from credit_series where id = p_series;
  if not found then return 'no_series'; end if;
  if s.expires_at <= now() + interval '1 day' then return 'series_expiring'; end if;
  perform 1 from credit_config where id = 1 for update;
  perform 1 from accounts where wallet in (p_wallet, 'fuel:credit-bridge') order by wallet for update;
  if not fuel_credit_take_units(p_wallet, p_series, p_units) then return 'not_enough_credits'; end if;
  perform fuel_credit_give_units('fuel:credit-bridge', p_series, p_units, 0, 0, 0, 0);
  insert into credit_bridge (id, wallet, series_id, direction, units_micro, status) values (p_id, p_wallet, p_series, 'out', p_units, 'pending');
  insert into credit_events (kind, wallet, units_micro, usd_micro, level, note) values ('bridge_out', p_wallet, p_units, 0, 0, p_series);
  return 'ok';
end $$;

-- The mint landed: record its signature.
create or replace function public.fuel_credit_bridge_out_done(p_id uuid, p_signature text)
returns text language plpgsql security definer set search_path = public as $$
begin
  update credit_bridge set status = 'done', signature = p_signature, done_at = now() where id = p_id and direction = 'out' and status = 'pending';
  return case when found then 'ok' else 'not_pending' end;
end $$;

-- The mint failed: credits go back from the bridge to the holder.
create or replace function public.fuel_credit_bridge_out_refund(p_id uuid, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare b credit_bridge;
begin
  select * into b from credit_bridge where id = p_id and direction = 'out' and status = 'pending' for update;
  if not found then return 'not_pending'; end if;
  perform 1 from credit_config where id = 1 for update;
  perform 1 from accounts where wallet in (b.wallet, 'fuel:credit-bridge') order by wallet for update;
  if not fuel_credit_take_units('fuel:credit-bridge', b.series_id, b.units_micro) then return 'bridge_short'; end if;
  perform fuel_credit_give_units(b.wallet, b.series_id, b.units_micro, 0, 0, 0, 0);
  update credit_bridge set status = 'refunded', note = p_note, done_at = now() where id = p_id;
  return 'ok';
end $$;

-- Deposit: a verified burn of p_units by p_wallet → credits from the bridge back to the holder.
-- The burn's signature can be used once.
create or replace function public.fuel_credit_bridge_in(p_id uuid, p_wallet text, p_series text, p_units bigint, p_signature text)
returns text language plpgsql security definer set search_path = public as $$
declare s credit_series;
begin
  if p_units <= 0 then return 'bad_amount'; end if;
  if exists (select 1 from credit_bridge where signature = p_signature) then return 'already_credited'; end if;
  select * into s from credit_series where id = p_series;
  if not found then return 'no_series'; end if;
  if s.expires_at <= now() then return 'series_expired'; end if;
  insert into accounts (wallet) values (p_wallet) on conflict (wallet) do nothing;
  perform 1 from credit_config where id = 1 for update;
  perform 1 from accounts where wallet in (p_wallet, 'fuel:credit-bridge') order by wallet for update;
  if not fuel_credit_take_units('fuel:credit-bridge', p_series, p_units) then return 'bridge_short'; end if;
  perform fuel_credit_give_units(p_wallet, p_series, p_units, 0, 0, 0, 0);
  insert into credit_bridge (id, wallet, series_id, direction, units_micro, status, signature, done_at) values (p_id, p_wallet, p_series, 'in', p_units, 'done', p_signature, now());
  insert into credit_events (kind, wallet, units_micro, usd_micro, level, note) values ('bridge_in', p_wallet, p_units, 0, 0, p_series);
  return 'ok';
end $$;

revoke all on function public.fuel_credit_bridge_out(uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.fuel_credit_bridge_out_done(uuid, text) from public, anon, authenticated;
revoke all on function public.fuel_credit_bridge_out_refund(uuid, text) from public, anon, authenticated;
revoke all on function public.fuel_credit_bridge_in(uuid, text, text, bigint, text) from public, anon, authenticated;
