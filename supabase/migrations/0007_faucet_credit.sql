-- Credit faucet: a small free trial plus earned pay-later credit, inside a fixed pot.
-- Credit can only be spent on Fuel jobs (balances can't be withdrawn). A balance may go
-- negative down to the wallet's credit limit; any money coming in pays the debt first.
-- Exposure is capped three ways: the total pot, a per-agent max, and 25% of real top-ups.

create table public.faucet_config (
  id                  integer primary key default 1 check (id = 1),
  enabled             boolean not null default true,
  pot_micro           bigint  not null default 50000000,   -- $50 total: trials handed out + credit in use
  max_per_agent_micro bigint  not null default 1000000,    -- $1 per wallet: trial + credit
  trial_micro         bigint  not null default 500000,     -- $0.50 free trial, once, not repaid
  credit_share        numeric not null default 0.25,       -- credit = 25% of the last 30 days' top-ups
  due_days            integer not null default 30          -- debt older than this freezes jobs
);
insert into public.faucet_config (id) values (1) on conflict do nothing;

create table public.faucet_trials (
  wallet      text primary key references public.accounts (wallet),
  amount_micro bigint not null,
  granted_at  timestamptz not null default now()
);

alter table public.faucet_config enable row level security;
alter table public.faucet_trials enable row level security;

-- Balances may now go negative (credit in use). Hard floor as a safety net.
alter table public.accounts drop constraint if exists accounts_balance_micro_check;
alter table public.accounts add constraint accounts_balance_floor check (balance_micro >= -100000000);
alter table public.accounts add column debt_since timestamptz;
create index accounts_debt_idx on public.accounts (wallet) where balance_micro < 0;

-- Track when a balance went negative; clear it once repaid.
create or replace function public.fuel_track_debt() returns trigger language plpgsql as $$
begin
  if new.balance_micro < 0 then
    new.debt_since := coalesce(old.debt_since, now());
  else
    new.debt_since := null;
  end if;
  return new;
end $$;
drop trigger if exists accounts_track_debt on public.accounts;
create trigger accounts_track_debt before update of balance_micro on public.accounts
  for each row execute function public.fuel_track_debt();

alter table public.ledger_entries drop constraint if exists ledger_entries_source_check;
alter table public.ledger_entries add constraint ledger_entries_source_check
  check (source in ('public_deposit', 'ring_topup', 'job', 'credit_redeem', 'adjustment', 'lane_payout', 'faucet_trial'));

-- Money a wallet actually paid in over the last 30 days (not faucet, not lane earnings).
create or replace function public.fuel_paid_in_30d(p_wallet text) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(delta_micro), 0)::bigint from ledger_entries
  where wallet = p_wallet and source in ('public_deposit', 'ring_topup') and delta_micro > 0
    and created_at > now() - interval '30 days'
$$;

-- This wallet's credit limit right now (how far below zero it may go).
create or replace function public.fuel_credit_limit(p_wallet text) returns bigint
language sql stable security definer set search_path = public as $$
  select case when not c.enabled then 0 else greatest(0, least(
    c.max_per_agent_micro - coalesce((select amount_micro from faucet_trials t where t.wallet = p_wallet), 0),
    floor(c.credit_share * fuel_paid_in_30d(p_wallet))::bigint
  )) end
  from faucet_config c where c.id = 1
$$;

-- Pot in use: every trial ever granted + credit currently drawn or held across all wallets.
create or replace function public.fuel_pot_used() returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(amount_micro) from faucet_trials), 0)::bigint
       + coalesce((select sum(greatest(0, held_micro - balance_micro)) from accounts), 0)::bigint
$$;

-- Reserve, now credit-aware. Returns 'ok' or why the job can't run.
create or replace function public.fuel_reserve(
  p_job uuid, p_wallet text, p_model text, p_kind text, p_hold bigint, p_streamed boolean
) returns text language plpgsql security definer set search_path = public as $$
declare a accounts; c faucet_config; spent_today bigint; lim bigint; before_exp bigint; after_exp bigint;
begin
  perform fuel_release_stale(p_wallet);
  select * into a from accounts where wallet = p_wallet for update;
  if not found then return 'insufficient_balance'; end if;

  if a.per_job_limit_micro is not null and p_hold > a.per_job_limit_micro then return 'per_job_limit'; end if;
  if a.daily_limit_micro is not null then
    select coalesce(sum(price_micro), 0) into spent_today from jobs
      where wallet = p_wallet and status = 'succeeded' and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
    if spent_today + a.held_micro + p_hold > a.daily_limit_micro then return 'daily_limit'; end if;
  end if;

  -- Overdue debt freezes jobs until it's paid.
  select * into c from faucet_config where id = 1;
  if a.debt_since is not null and a.debt_since < now() - make_interval(days => c.due_days) then return 'credit_overdue'; end if;

  if a.balance_micro - a.held_micro - p_hold < 0 then
    -- Needs credit. Serialise pot accounting across wallets.
    perform 1 from faucet_config where id = 1 for update;
    lim := fuel_credit_limit(p_wallet);
    before_exp := greatest(0, a.held_micro - a.balance_micro);
    after_exp := a.held_micro + p_hold - a.balance_micro;
    if after_exp > lim then return 'insufficient_balance'; end if;
    if fuel_pot_used() - before_exp + after_exp > c.pot_micro then return 'insufficient_balance'; end if;
  end if;

  update accounts set held_micro = held_micro + p_hold where wallet = p_wallet;
  insert into jobs (id, wallet, model, kind, status, hold_micro, streamed)
    values (p_job, p_wallet, p_model, p_kind, 'running', p_hold, p_streamed);
  return 'ok';
end $$;

-- Grant the free trial once, if the pot has room. Returns 'ok' or a reason.
create or replace function public.fuel_faucet_trial(p_wallet text) returns text
language plpgsql security definer set search_path = public as $$
declare c faucet_config;
begin
  select * into c from faucet_config where id = 1 for update;
  if not c.enabled or c.trial_micro <= 0 then return 'disabled'; end if;
  if exists (select 1 from faucet_trials where wallet = p_wallet) then return 'already_claimed'; end if;
  if fuel_pot_used() + c.trial_micro > c.pot_micro then return 'pot_empty'; end if;
  insert into accounts (wallet) values (p_wallet) on conflict do nothing;
  insert into faucet_trials (wallet, amount_micro) values (p_wallet, least(c.trial_micro, c.max_per_agent_micro));
  update accounts set balance_micro = balance_micro + least(c.trial_micro, c.max_per_agent_micro) where wallet = p_wallet;
  insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, least(c.trial_micro, c.max_per_agent_micro), 'faucet_trial', p_wallet);
  return 'ok';
end $$;

revoke all on function public.fuel_paid_in_30d(text) from public, anon, authenticated;
revoke all on function public.fuel_credit_limit(text) from public, anon, authenticated;
revoke all on function public.fuel_pot_used() from public, anon, authenticated;
revoke all on function public.fuel_reserve(uuid, text, text, text, bigint, boolean) from public, anon, authenticated;
revoke all on function public.fuel_faucet_trial(text) from public, anon, authenticated;
