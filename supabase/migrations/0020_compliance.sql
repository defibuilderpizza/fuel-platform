-- Compliance controls promised to model providers (Anthropic, OpenAI):
--  * accounts can be suspended (AUP breach, provider request, sanctions match); suspended
--    wallets can't sign in, and their API keys stop working
--  * wallets on a sanctions list (OFAC SDN digital-currency addresses, scripts/sanctions-sync.mjs)
--    can't sign in, and deposits they send are not credited (recorded for review instead)

alter table public.accounts
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text;

create table if not exists public.sanctioned_wallets (
  wallet      text primary key,
  source      text not null default 'OFAC SDN',
  listed_name text,
  added_at    timestamptz not null default now()
);
alter table public.sanctioned_wallets enable row level security;

-- Deposits refused because the sender is sanctioned. The funds arrived on-chain; this is the
-- record an admin works from (freeze / report). Never credited.
create table if not exists public.blocked_deposits (
  signature  text primary key,
  sender     text not null,
  asset      text not null,
  amount_raw text not null,
  reason     text not null,
  created_at timestamptz not null default now()
);
alter table public.blocked_deposits enable row level security;
