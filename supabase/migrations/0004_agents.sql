-- Fuel Phase 2: community fuel. Agents get a public name and page; anyone can top one up.
-- A community top-up carries the agent's name in an on-chain memo ("fuel:<name>"), so the
-- transaction itself says who it is for. Nobody can redirect someone else's payment.

-- ── Agents: a wallet that chose to be public ──────────────────────────────
create table public.agents (
  wallet       text primary key references public.accounts (wallet),
  name         text not null unique check (name ~ '^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$'),
  display_name text not null check (char_length(display_name) between 1 and 48),
  description  text check (char_length(description) <= 280),
  x_handle     text check (x_handle ~ '^[A-Za-z0-9_]{1,15}$'),
  website      text check (website ~ '^https://' and char_length(website) <= 200),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── Deposits: who paid vs who was credited ────────────────────────────────
-- wallet           = credited wallet (the agent, for a community top-up)
-- supporter_wallet = the wallet that paid, when different from the credited one
alter table public.deposits add column supporter_wallet text;
create index deposits_supporter_idx on public.deposits (supporter_wallet) where supporter_wallet is not null;

alter table public.agents enable row level security;

-- Replace the deposit credit function: optional supporter.
drop function if exists public.fuel_credit_deposit(text, text, text, numeric, numeric, bigint, bigint);
create or replace function public.fuel_credit_deposit(
  p_signature text, p_wallet text, p_asset text, p_amount_raw numeric,
  p_usd_price numeric, p_credit bigint, p_slot bigint, p_supporter text default null
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into accounts (wallet) values (p_wallet) on conflict do nothing;
  insert into deposits (signature, wallet, asset, amount_raw, usd_price, credited_micro, slot, supporter_wallet)
    values (p_signature, p_wallet, p_asset, p_amount_raw, p_usd_price, p_credit, p_slot,
            nullif(p_supporter, p_wallet))
    on conflict (signature) do nothing;
  if not found then return false; end if;
  update accounts set balance_micro = balance_micro + p_credit where wallet = p_wallet;
  insert into ledger_entries (wallet, delta_micro, source, ref_id)
    values (p_wallet, p_credit, 'public_deposit', p_signature);
  return true;
end $$;
revoke all on function public.fuel_credit_deposit(text, text, text, numeric, numeric, bigint, bigint, text) from public, anon, authenticated;

-- ── Public stats. Only totals: no job details, no private top-ups. ────────
-- Per agent: balance, jobs completed, community fuel received, supporters.
create or replace view public.agent_stats as
select
  a.wallet, a.name, a.display_name, a.description, a.x_handle, a.website, a.created_at,
  acc.balance_micro,
  (select count(*) from jobs j where j.wallet = a.wallet and j.status = 'succeeded') as jobs_completed,
  coalesce((select sum(d.credited_micro) from deposits d where d.wallet = a.wallet and d.supporter_wallet is not null), 0) as community_micro,
  (select count(distinct d.supporter_wallet) from deposits d where d.wallet = a.wallet and d.supporter_wallet is not null) as supporters
from agents a join accounts acc on acc.wallet = a.wallet;

-- Top supporters of one agent (public deposits only; they're public on-chain anyway).
create or replace function public.fuel_agent_supporters(p_wallet text, p_limit integer)
returns table (supporter_wallet text, total_micro bigint, topups bigint, last_at timestamptz)
language sql stable security definer set search_path = public as $$
  select supporter_wallet, sum(credited_micro)::bigint, count(*), max(created_at)
  from deposits where wallet = p_wallet and supporter_wallet is not null
  group by supporter_wallet order by 2 desc limit least(p_limit, 100)
$$;

-- Top fuellers across all agents.
create or replace function public.fuel_top_fuellers(p_limit integer)
returns table (supporter_wallet text, total_micro bigint, agents bigint, topups bigint)
language sql stable security definer set search_path = public as $$
  select d.supporter_wallet, sum(d.credited_micro)::bigint, count(distinct d.wallet), count(*)
  from deposits d join agents a on a.wallet = d.wallet
  where d.supporter_wallet is not null
  group by d.supporter_wallet order by 2 desc limit least(p_limit, 100)
$$;

revoke all on public.agent_stats from anon, authenticated;
revoke all on function public.fuel_agent_supporters(text, integer) from public, anon, authenticated;
revoke all on function public.fuel_top_fuellers(integer) from public, anon, authenticated;
