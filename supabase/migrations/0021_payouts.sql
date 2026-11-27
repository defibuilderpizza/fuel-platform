-- USDC payouts of earnings (GPU sellers and laptop-lane workers).
-- Only earnings can be withdrawn, never deposits: withdrawable = min(spendable balance,
-- earned − already paid out or pending). Requesting takes the amount off the balance at once
-- (ledger 'payout'); rejecting or cancelling puts it back ('payout_refund').
-- Fuel holds no hot key: an admin approves, signs the USDC transfer in their own wallet
-- (Solana Pay link with a unique reference), and the cron matches it on-chain.

create table if not exists public.payouts (
  id            uuid primary key,
  wallet        text not null references public.accounts (wallet),
  amount_micro  bigint not null check (amount_micro > 0),
  status        text not null default 'requested' check (status in ('requested', 'approved', 'paid', 'rejected', 'cancelled')),
  reference     text not null unique,  -- Solana Pay reference key (base58 pubkey, no private key exists)
  signature     text unique,           -- the USDC transfer, once found
  note          text,
  requested_at  timestamptz not null default now(),
  decided_at    timestamptz,
  paid_at       timestamptz
);
create index if not exists payouts_wallet_idx on public.payouts (wallet, requested_at desc);
create index if not exists payouts_status_idx on public.payouts (status);
alter table public.payouts enable row level security;

alter table public.ledger_entries drop constraint if exists ledger_entries_source_check;
alter table public.ledger_entries add constraint ledger_entries_source_check
  check (source in ('public_deposit', 'ring_topup', 'job', 'credit_redeem', 'adjustment', 'lane_payout', 'faucet_trial', 'seller_payout', 'team_transfer', 'credit_buy', 'credit_use', 'forward_bond', 'forward_premium', 'credit_trade', 'payout', 'payout_refund'));

-- What a wallet can withdraw right now (micro-USD).
create or replace function public.fuel_payout_available(p_wallet text)
returns bigint language sql stable security definer set search_path = public as $$
  select greatest(0, least(
    coalesce((select balance_micro - held_micro from accounts where wallet = p_wallet), 0),
    coalesce((select sum(delta_micro) from ledger_entries where wallet = p_wallet and source in ('seller_payout', 'lane_payout')), 0)
      - coalesce((select sum(amount_micro) from payouts where wallet = p_wallet and status in ('requested', 'approved', 'paid')), 0)
  ))::bigint
$$;
revoke all on function public.fuel_payout_available(text) from public, anon, authenticated;

create or replace function public.fuel_payout_request(p_id uuid, p_wallet text, p_micro bigint, p_min bigint, p_reference text)
returns text language plpgsql security definer set search_path = public as $$
declare
  a accounts%rowtype;
begin
  select * into a from accounts where wallet = p_wallet for update;
  if not found then return 'no_account'; end if;
  if a.suspended_at is not null then return 'suspended'; end if;
  if p_micro < p_min then return 'below_minimum'; end if;
  if exists (select 1 from payouts where wallet = p_wallet and status in ('requested', 'approved')) then return 'payout_open'; end if;
  if p_micro > fuel_payout_available(p_wallet) then return 'insufficient_earnings'; end if;
  insert into payouts (id, wallet, amount_micro, reference) values (p_id, p_wallet, p_micro, p_reference);
  insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, -p_micro, 'payout', p_id::text);
  update accounts set balance_micro = balance_micro - p_micro where wallet = p_wallet;
  return 'ok';
end $$;
revoke all on function public.fuel_payout_request(uuid, text, bigint, bigint, text) from public, anon, authenticated;

-- Reject (admin) or cancel (owner, before approval): the amount goes back to the balance.
create or replace function public.fuel_payout_close(p_id uuid, p_status text, p_note text, p_wallet text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  p payouts%rowtype;
begin
  if p_status not in ('rejected', 'cancelled') then return 'bad_status'; end if;
  select * into p from payouts where id = p_id for update;
  if not found then return 'not_found'; end if;
  if p_wallet is not null and p.wallet <> p_wallet then return 'not_found'; end if;
  if p_status = 'cancelled' and p.status <> 'requested' then return 'not_cancellable'; end if;
  if p.status not in ('requested', 'approved') then return 'closed'; end if;
  perform 1 from accounts where wallet = p.wallet for update;
  update payouts set status = p_status, note = coalesce(p_note, note), decided_at = now() where id = p_id;
  insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p.wallet, p.amount_micro, 'payout_refund', p_id::text)
    on conflict (source, ref_id) do nothing;
  if found then
    update accounts set balance_micro = balance_micro + p.amount_micro where wallet = p.wallet;
  end if;
  return 'ok';
end $$;
revoke all on function public.fuel_payout_close(uuid, text, text, text) from public, anon, authenticated;
