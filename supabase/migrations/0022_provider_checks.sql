-- Results of the provider canary (one tiny request per hosted provider, every 15 minutes).
-- /status uses the latest result when a provider has had no customer traffic in the last hour,
-- so the page shows real health instead of "idle". Kept for 7 days.
create table if not exists public.provider_checks (
  id         bigserial primary key,
  provider   text not null,
  model      text not null,
  ok         boolean not null,
  ms         integer,
  detail     text,
  checked_at timestamptz not null default now()
);
create index if not exists provider_checks_recent_idx on public.provider_checks (provider, checked_at desc);
alter table public.provider_checks enable row level security;
