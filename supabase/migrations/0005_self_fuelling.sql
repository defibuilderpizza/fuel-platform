-- Fuel Phase 3: self-fuelling agents.
-- A project links its fee wallet to its agent (the fee wallet signs to agree). Anything that
-- wallet sends to Fuel's deposit address is credited to the agent automatically. A scanner
-- watches the deposit address, so fee payouts never need a manual confirm.

create table public.agent_fee_sources (
  source_wallet text primary key,                 -- one source feeds one agent
  agent_wallet  text not null references public.agents (wallet) on delete cascade,
  label         text check (char_length(label) <= 48),
  created_at    timestamptz not null default now()
);
create index agent_fee_sources_agent_idx on public.agent_fee_sources (agent_wallet);

-- How each deposit was attributed: memo (community), fee_source (self-fuel), direct (payer).
alter table public.deposits add column via text not null default 'direct' check (via in ('direct', 'memo', 'fee_source'));
update public.deposits set via = 'memo' where supporter_wallet is not null;

-- Scanner cursors: the newest signature already processed, per watched address.
create table public.deposit_scan_state (
  address        text primary key,
  last_signature text,
  scanned_at     timestamptz
);

alter table public.agent_fee_sources  enable row level security;
alter table public.deposit_scan_state enable row level security;

drop function if exists public.fuel_credit_deposit(text, text, text, numeric, numeric, bigint, bigint, text);
create or replace function public.fuel_credit_deposit(
  p_signature text, p_wallet text, p_asset text, p_amount_raw numeric,
  p_usd_price numeric, p_credit bigint, p_slot bigint, p_supporter text default null, p_via text default 'direct'
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into accounts (wallet) values (p_wallet) on conflict do nothing;
  insert into deposits (signature, wallet, asset, amount_raw, usd_price, credited_micro, slot, supporter_wallet, via)
    values (p_signature, p_wallet, p_asset, p_amount_raw, p_usd_price, p_credit, p_slot,
            nullif(p_supporter, p_wallet), case when nullif(p_supporter, p_wallet) is null then 'direct' else p_via end)
    on conflict (signature) do nothing;
  if not found then return false; end if;
  update accounts set balance_micro = balance_micro + p_credit where wallet = p_wallet;
  insert into ledger_entries (wallet, delta_micro, source, ref_id)
    values (p_wallet, p_credit, 'public_deposit', p_signature);
  return true;
end $$;
revoke all on function public.fuel_credit_deposit(text, text, text, numeric, numeric, bigint, bigint, text, text) from public, anon, authenticated;

-- Community fuel = memo top-ups; self fuel = linked fee sources. Supporters = community only.
create or replace view public.agent_stats as
select
  a.wallet, a.name, a.display_name, a.description, a.x_handle, a.website, a.created_at,
  acc.balance_micro,
  (select count(*) from jobs j where j.wallet = a.wallet and j.status = 'succeeded') as jobs_completed,
  coalesce((select sum(d.credited_micro) from deposits d where d.wallet = a.wallet and d.via = 'memo'), 0) as community_micro,
  (select count(distinct d.supporter_wallet) from deposits d where d.wallet = a.wallet and d.via = 'memo') as supporters,
  coalesce((select sum(d.credited_micro) from deposits d where d.wallet = a.wallet and d.via = 'fee_source'), 0) as self_fuel_micro
from agents a join accounts acc on acc.wallet = a.wallet;
revoke all on public.agent_stats from anon, authenticated;

create or replace function public.fuel_agent_supporters(p_wallet text, p_limit integer)
returns table (supporter_wallet text, total_micro bigint, topups bigint, last_at timestamptz)
language sql stable security definer set search_path = public as $$
  select supporter_wallet, sum(credited_micro)::bigint, count(*), max(created_at)
  from deposits where wallet = p_wallet and via = 'memo'
  group by supporter_wallet order by 2 desc limit least(p_limit, 100)
$$;

create or replace function public.fuel_top_fuellers(p_limit integer)
returns table (supporter_wallet text, total_micro bigint, agents bigint, topups bigint)
language sql stable security definer set search_path = public as $$
  select d.supporter_wallet, sum(d.credited_micro)::bigint, count(distinct d.wallet), count(*)
  from deposits d join agents a on a.wallet = d.wallet
  where d.via = 'memo'
  group by d.supporter_wallet order by 2 desc limit least(p_limit, 100)
$$;
revoke all on function public.fuel_agent_supporters(text, integer) from public, anon, authenticated;
revoke all on function public.fuel_top_fuellers(integer) from public, anon, authenticated;
