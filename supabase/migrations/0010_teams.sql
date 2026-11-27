-- Team accounts: people who run several agents see and control them in one place.
-- A team has human members (owner / admin / member) and agents (role 'agent').
-- Agents join with an invite code using their OWN API key, so a team can only add a wallet
-- it actually controls. Owners and admins set agents' limits and fund them from their own
-- balance; members can look.

create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 48),
  owner       text not null references public.accounts (wallet),
  created_at  timestamptz not null default now()
);

create table public.team_members (
  team_id    uuid not null references public.teams (id) on delete cascade,
  wallet     text not null references public.accounts (wallet),
  role       text not null check (role in ('owner', 'admin', 'member', 'agent')),
  label      text check (char_length(label) <= 48),
  joined_at  timestamptz not null default now(),
  primary key (team_id, wallet)
);
create index team_members_wallet_idx on public.team_members (wallet);
-- An agent belongs to one team at a time.
create unique index team_members_one_team_per_agent on public.team_members (wallet) where role = 'agent';

create table public.team_invites (
  code        text primary key,
  team_id     uuid not null references public.teams (id) on delete cascade,
  role        text not null check (role in ('admin', 'member', 'agent')),
  created_by  text not null,
  uses_left   integer not null default 1 check (uses_left >= 0),
  expires_at  timestamptz not null default now() + interval '7 days',
  created_at  timestamptz not null default now()
);
create index team_invites_team_idx on public.team_invites (team_id);

alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;

alter table public.ledger_entries drop constraint if exists ledger_entries_source_check;
alter table public.ledger_entries add constraint ledger_entries_source_check
  check (source in ('public_deposit', 'ring_topup', 'job', 'credit_redeem', 'adjustment', 'lane_payout', 'faucet_trial', 'seller_payout', 'team_transfer'));

-- Join a team with an invite code. Returns 'ok' or a reason.
create or replace function public.fuel_team_join(p_code text, p_wallet text, p_label text)
returns text language plpgsql security definer set search_path = public as $$
declare i team_invites;
begin
  select * into i from team_invites where code = p_code for update;
  if not found or i.uses_left <= 0 or i.expires_at < now() then return 'bad_code'; end if;
  if exists (select 1 from team_members where team_id = i.team_id and wallet = p_wallet) then return 'already_member'; end if;
  if i.role = 'agent' and exists (select 1 from team_members where wallet = p_wallet and role = 'agent') then return 'agent_in_other_team'; end if;
  insert into accounts (wallet) values (p_wallet) on conflict do nothing;
  insert into team_members (team_id, wallet, role, label) values (i.team_id, p_wallet, i.role, nullif(p_label, ''));
  update team_invites set uses_left = uses_left - 1 where code = p_code;
  return 'ok';
end $$;

-- Move money from one wallet's own balance (not credit) to another's, atomically.
create or replace function public.fuel_team_transfer(p_from text, p_to text, p_micro bigint, p_ref text)
returns text language plpgsql security definer set search_path = public as $$
declare a accounts;
begin
  if p_micro <= 0 then return 'bad_amount'; end if;
  -- Lock both rows in a fixed order to avoid deadlocks.
  perform 1 from accounts where wallet in (p_from, p_to) order by wallet for update;
  select * into a from accounts where wallet = p_from;
  if not found or a.balance_micro - a.held_micro < p_micro then return 'insufficient_balance'; end if;
  update accounts set balance_micro = balance_micro - p_micro where wallet = p_from;
  update accounts set balance_micro = balance_micro + p_micro where wallet = p_to;
  insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_from, -p_micro, 'team_transfer', p_ref || ':out');
  insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_to, p_micro, 'team_transfer', p_ref || ':in');
  return 'ok';
end $$;

revoke all on function public.fuel_team_join(text, text, text) from public, anon, authenticated;
revoke all on function public.fuel_team_transfer(text, text, bigint, text) from public, anon, authenticated;
