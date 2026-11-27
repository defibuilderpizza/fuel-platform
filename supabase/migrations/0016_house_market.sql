-- Fuel's own GPU sells its spare capacity on the open market, at the market rate.
--  - jobs.credit_funded: the job was paid with credit money (so it had priority on Fuel's GPU).
--    Lets Fuel measure how much of the GPU the open market used in the last hour, so the share
--    promised to credits is always kept free.
--  - house_market: on/off switch for selling spare capacity.
--  - house_credit_discount_bps: credit money spent on Fuel's GPU gets this much off (10%),
--    to steer credit holders onto the capacity Fuel has already paid for.
alter table public.jobs add column credit_funded boolean not null default false;
create index jobs_provider_recent_idx on public.jobs (provider, created_at desc);

alter table public.credit_config
  add column house_market              boolean not null default true,
  add column house_credit_discount_bps int not null default 1000 check (house_credit_discount_bps between 0 and 5000);
