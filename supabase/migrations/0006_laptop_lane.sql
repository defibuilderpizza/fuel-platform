-- Fuel Phase 4: laptop lane. Browser tabs run small deterministic jobs (embeddings).
-- Each task goes to two laptops; results must agree. Workers are paid in Fuel balance credit.
-- Task content is encrypted to the one laptop doing it (X25519 + XChaCha20-Poly1305): the
-- database only ever holds ciphertext, and rows are deleted when the job finishes.

-- A browser tab that is online and taking work. One wallet can run several tabs.
create table public.lane_workers (
  session_id  uuid primary key,
  wallet      text not null references public.accounts (wallet),
  pubkey      text not null,                    -- the tab's X25519 public key (base64)
  started_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
create index lane_workers_seen_idx on public.lane_workers (last_seen desc);

-- Reputation and earnings per wallet.
create table public.lane_worker_stats (
  wallet        text primary key references public.accounts (wallet),
  verified      integer not null default 0,     -- tasks where the result agreed
  rejected      integer not null default 0,     -- disagreed with the majority or failed a canary
  timeouts      integer not null default 0,
  earned_micro  bigint not null default 0,
  banned        boolean not null default false,
  updated_at    timestamptz not null default now()
);

-- One row per (job, laptop). Ciphertext only; deleted when the job ends.
create table public.lane_tasks (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null,
  session_id     uuid not null references public.lane_workers (session_id) on delete cascade,
  server_pubkey  text not null,                 -- per-job X25519 key the result is sealed to
  ciphertext     text not null,
  result         text,                          -- the laptop's sealed answer
  created_at     timestamptz not null default now(),
  claimed_at     timestamptz,
  done_at        timestamptz
);
create index lane_tasks_session_idx on public.lane_tasks (session_id) where claimed_at is null;
create index lane_tasks_job_idx on public.lane_tasks (job_id);

alter table public.lane_workers      enable row level security;
alter table public.lane_worker_stats enable row level security;
alter table public.lane_tasks        enable row level security;

-- Ledger: worker earnings.
alter table public.ledger_entries drop constraint if exists ledger_entries_source_check;
alter table public.ledger_entries add constraint ledger_entries_source_check
  check (source in ('public_deposit', 'ring_topup', 'job', 'credit_redeem', 'adjustment', 'lane_payout'));

-- Hand the next waiting task to a tab, once.
create or replace function public.fuel_lane_claim(p_session uuid)
returns table (id uuid, job_id uuid, server_pubkey text, ciphertext text)
language plpgsql security definer set search_path = public as $$
begin
  update lane_workers set last_seen = now() where session_id = p_session;
  return query
  update lane_tasks t set claimed_at = now()
   where t.id = (select x.id from lane_tasks x where x.session_id = p_session and x.claimed_at is null
                 order by x.created_at limit 1 for update skip locked)
  returning t.id, t.job_id, t.server_pubkey, t.ciphertext;
end $$;

-- Pay a verified worker and bump its reputation.
create or replace function public.fuel_lane_pay(p_wallet text, p_micro bigint, p_ref text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into lane_worker_stats (wallet) values (p_wallet) on conflict do nothing;
  update lane_worker_stats set verified = verified + 1, earned_micro = earned_micro + greatest(p_micro, 0), updated_at = now()
   where wallet = p_wallet;
  if p_micro > 0 then
    insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, p_micro, 'lane_payout', p_ref)
      on conflict (source, ref_id) do nothing;
    if found then
      update accounts set balance_micro = balance_micro + p_micro where wallet = p_wallet;
    end if;
  end if;
end $$;

-- Record a bad answer or a timeout. Three canary failures ban the wallet from the lane.
create or replace function public.fuel_lane_strike(p_wallet text, p_kind text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into lane_worker_stats (wallet) values (p_wallet) on conflict do nothing;
  update lane_worker_stats set
    rejected = rejected + case when p_kind in ('rejected', 'canary') then 1 else 0 end,
    timeouts = timeouts + case when p_kind = 'timeout' then 1 else 0 end,
    banned = banned or (p_kind = 'canary' and rejected >= 2),
    updated_at = now()
  where wallet = p_wallet;
end $$;

revoke all on function public.fuel_lane_claim(uuid) from public, anon, authenticated;
revoke all on function public.fuel_lane_pay(text, bigint, text) from public, anon, authenticated;
revoke all on function public.fuel_lane_strike(text, text) from public, anon, authenticated;
