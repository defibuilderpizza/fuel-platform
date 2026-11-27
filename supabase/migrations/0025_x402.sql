-- x402: agents pay per request with a signed USDC transfer instead of an API key.
-- Fuel co-signs as fee payer, submits it, credits the payer's balance like any deposit (same
-- signature, so the deposit scanner can't credit it twice) and runs the job as that wallet.
-- Each payment pays for one request: this table is the claim (signature is the key).

create table public.x402_payments (
  signature    text primary key,
  wallet       text not null references public.accounts (wallet),
  network      text not null,
  amount_micro bigint not null check (amount_micro > 0),   -- USDC atomic units = USD micro
  resource     text not null,
  job_id       uuid,
  created_at   timestamptz not null default now()
);
create index x402_payments_wallet_idx on public.x402_payments (wallet, created_at desc);
alter table public.x402_payments enable row level security;
