-- USDG on Robinhood Chain (EVM, chain 4663): EVM wallets sign in (addresses stored lowercase)
-- and top up with USDG. A deposit's id is "<tx hash>:<log index>", so a transfer is credited once
-- whether it's confirmed by hand or found by the scanner.

alter table public.deposits drop constraint if exists deposits_asset_check;
alter table public.deposits add constraint deposits_asset_check check (asset in ('USDC', 'SOL', 'USDG'));

-- How far each chain's deposit scanner has read.
create table if not exists public.chain_scan_state (
  chain       text primary key,
  last_block  bigint not null,
  updated_at  timestamptz not null default now()
);
alter table public.chain_scan_state enable row level security;
