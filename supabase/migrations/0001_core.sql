-- Fuel Phase 1: core compute.
-- Money is stored in micro-USD (1e-6 USD = 1 USDC base unit) as bigint.
-- Job content (prompts, inputs, outputs) is never stored anywhere in this schema.
-- Every table has RLS on and no policies: only the service role (server) can touch it.

create extension if not exists pgcrypto;

-- ── Accounts: one per wallet ───────────────────────────────────────────────
create table public.accounts (
  wallet              text primary key,
  balance_micro       bigint not null default 0 check (balance_micro >= 0),
  held_micro          bigint not null default 0 check (held_micro >= 0),
  daily_limit_micro   bigint check (daily_limit_micro is null or daily_limit_micro >= 0),
  per_job_limit_micro bigint check (per_job_limit_micro is null or per_job_limit_micro >= 0),
  created_at          timestamptz not null default now()
);

-- ── Wallet sign-in ─────────────────────────────────────────────────────────
create table public.auth_nonces (
  nonce      text primary key,
  wallet     text not null,
  message    text not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create index auth_nonces_created_idx on public.auth_nonces (created_at);

create table public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  wallet       text not null references public.accounts (wallet),
  key_hash     text not null unique,          -- sha256 hex of the full key
  prefix       text not null,                 -- first chars, for display
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index api_keys_wallet_idx on public.api_keys (wallet);

-- ── Money in ───────────────────────────────────────────────────────────────
create table public.deposits (
  signature      text primary key,            -- one credit per transaction, ever
  wallet         text not null references public.accounts (wallet),
  asset          text not null check (asset in ('USDC', 'SOL')),
  amount_raw     numeric not null,            -- base units (USDC 6dp, SOL lamports)
  usd_price      numeric,                     -- SOL/USD used, null for USDC
  credited_micro bigint not null check (credited_micro >= 0),
  slot           bigint,
  created_at     timestamptz not null default now()
);
create index deposits_wallet_idx on public.deposits (wallet, created_at desc);

-- ── Ledger: every balance change, append-only ──────────────────────────────
create table public.ledger_entries (
  id          bigserial primary key,
  wallet      text not null references public.accounts (wallet),
  delta_micro bigint not null,
  source      text not null check (source in ('public_deposit', 'ring_topup', 'job', 'credit_redeem', 'adjustment')),
  ref_id      text not null,
  created_at  timestamptz not null default now(),
  unique (source, ref_id)
);
create index ledger_wallet_idx on public.ledger_entries (wallet, created_at desc);

-- ── Compute catalogue: which provider serves which model, at what cost ────
create table public.provider_models (
  id                 bigserial primary key,
  model              text not null,           -- the name agents send
  kind               text not null check (kind in ('chat', 'embedding')),
  provider           text not null,           -- 'together' | 'runpod' | 'mock'
  provider_model_id  text not null,           -- the name the provider expects
  base_url           text,                    -- override (RunPod endpoints are per-model)
  input_per_mtok     numeric not null check (input_per_mtok >= 0),  -- USD per 1M input tokens (provider cost)
  output_per_mtok    numeric not null default 0 check (output_per_mtok >= 0),
  context_length     integer,
  enabled            boolean not null default true,
  updated_at         timestamptz not null default now(),
  unique (model, provider)
);
create index provider_models_model_idx on public.provider_models (model) where enabled;

-- ── Jobs = receipts. Price, time, provider. Never content. ────────────────
create table public.jobs (
  id                  uuid primary key,
  wallet              text not null references public.accounts (wallet),
  model               text not null,
  kind                text not null check (kind in ('chat', 'embedding')),
  status              text not null check (status in ('running', 'succeeded', 'failed')),
  provider            text,
  attempts            jsonb not null default '[]'::jsonb,  -- [{provider, ok, status, ms}]
  hold_micro          bigint not null default 0,
  input_tokens        integer,
  output_tokens       integer,
  provider_cost_micro bigint,
  price_micro         bigint,                 -- what the agent paid
  streamed            boolean not null default false,
  latency_ms          integer,
  created_at          timestamptz not null default now(),
  finished_at         timestamptz
);
create index jobs_wallet_idx on public.jobs (wallet, created_at desc);
create index jobs_running_idx on public.jobs (created_at) where status = 'running';

alter table public.accounts        enable row level security;
alter table public.auth_nonces     enable row level security;
alter table public.api_keys        enable row level security;
alter table public.deposits        enable row level security;
alter table public.ledger_entries  enable row level security;
alter table public.provider_models enable row level security;
alter table public.jobs            enable row level security;

-- ── Functions: all balance changes go through these, under a row lock ─────

-- Release holds of jobs that never settled (crashed function, lost stream).
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
  end loop;
end $$;

-- Reserve money for a job before it runs. Returns 'ok' or the reason it can't run.
create or replace function public.fuel_reserve(
  p_job uuid, p_wallet text, p_model text, p_kind text, p_hold bigint, p_streamed boolean
) returns text language plpgsql security definer set search_path = public as $$
declare a accounts; spent_today bigint;
begin
  perform fuel_release_stale(p_wallet);
  select * into a from accounts where wallet = p_wallet for update;
  if not found then return 'insufficient_balance'; end if;

  if a.per_job_limit_micro is not null and p_hold > a.per_job_limit_micro then
    return 'per_job_limit';
  end if;

  if a.daily_limit_micro is not null then
    select coalesce(sum(price_micro), 0) into spent_today from jobs
      where wallet = p_wallet and status = 'succeeded' and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
    if spent_today + a.held_micro + p_hold > a.daily_limit_micro then
      return 'daily_limit';
    end if;
  end if;

  if a.balance_micro - a.held_micro < p_hold then
    return 'insufficient_balance';
  end if;

  update accounts set held_micro = held_micro + p_hold where wallet = p_wallet;
  insert into jobs (id, wallet, model, kind, status, hold_micro, streamed)
    values (p_job, p_wallet, p_model, p_kind, 'running', p_hold, p_streamed);
  return 'ok';
end $$;

-- Settle a job: release the hold, charge the price (never more than the hold).
-- Returns the amount charged. Safe to call twice: a settled job is left alone.
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
         balance_micro = balance_micro - charge
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

-- Credit an on-chain deposit exactly once. Returns true if this call credited it.
create or replace function public.fuel_credit_deposit(
  p_signature text, p_wallet text, p_asset text, p_amount_raw numeric,
  p_usd_price numeric, p_credit bigint, p_slot bigint
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into accounts (wallet) values (p_wallet) on conflict do nothing;
  insert into deposits (signature, wallet, asset, amount_raw, usd_price, credited_micro, slot)
    values (p_signature, p_wallet, p_asset, p_amount_raw, p_usd_price, p_credit, p_slot)
    on conflict (signature) do nothing;
  if not found then return false; end if;
  update accounts set balance_micro = balance_micro + p_credit where wallet = p_wallet;
  insert into ledger_entries (wallet, delta_micro, source, ref_id)
    values (p_wallet, p_credit, 'public_deposit', p_signature);
  return true;
end $$;

-- Consume a sign-in nonce once.
create or replace function public.fuel_use_nonce(p_nonce text, p_wallet text)
returns text language plpgsql security definer set search_path = public as $$
declare m text;
begin
  update auth_nonces set used_at = now()
   where nonce = p_nonce and wallet = p_wallet and used_at is null
     and created_at > now() - interval '10 minutes'
  returning message into m;
  return m;  -- null = unknown, expired or already used
end $$;

revoke all on function public.fuel_release_stale(text) from public, anon, authenticated;
revoke all on function public.fuel_reserve(uuid, text, text, text, bigint, boolean) from public, anon, authenticated;
revoke all on function public.fuel_settle(uuid, text, text, jsonb, integer, integer, bigint, bigint, integer) from public, anon, authenticated;
revoke all on function public.fuel_credit_deposit(text, text, text, numeric, numeric, bigint, bigint) from public, anon, authenticated;
revoke all on function public.fuel_use_nonce(text, text) from public, anon, authenticated;
