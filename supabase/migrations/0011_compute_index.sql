-- Fuel Compute Index: a chain-linked price index of live chat compute, snapshotted by the
-- 5-minute cron. level starts at 100; median_usd is the median cheapest price per 1M tokens
-- (typical 3:1 input:output job). components holds each model's price at that point, so
-- every step can be recomputed and audited.
create table public.compute_index_points (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  level       numeric not null,
  median_usd  numeric not null,
  models      integer not null,
  matched     integer not null,          -- models priced in both this and the previous point
  components  jsonb not null             -- { "org/model": price_per_1m, ... }
);
create index compute_index_points_at_idx on public.compute_index_points (at desc);
alter table public.compute_index_points enable row level security;
