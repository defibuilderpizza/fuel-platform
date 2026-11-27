-- Fuel Phase 1b: private top-ups via Helius Privacy Rings.
-- An agent sends a private transfer (amount encrypted on-chain) to Fuel's ring address.
-- Fuel decrypts it with its viewing keys and credits the agent's wallet balance.
-- Amounts here are private from the public, not from Fuel: Fuel must know them to run the balance.

-- One row per received ring output. (signature, leaf_index) is unique on-chain.
create table public.ring_receipts (
  signature      text not null,
  leaf_index     bigint not null,
  slot           bigint not null,
  kind           text not null,                 -- SDK kind: privateTransfer | deposit | ...
  sender_wallet  text,                          -- public signer of the transfer; null if unclear
  asset          text not null,                 -- 'SOL' | 'USDC' | other mint address
  amount_raw     numeric not null,
  usd_price      numeric,
  credited_micro bigint not null default 0,
  status         text not null check (status in ('credited', 'unattributed', 'unsupported_asset', 'not_allowlisted', 'over_cap')),
  created_at     timestamptz not null default now(),
  primary key (signature, leaf_index)
);
create index ring_receipts_sender_idx on public.ring_receipts (sender_wallet, created_at desc);
create index ring_receipts_review_idx on public.ring_receipts (status) where status <> 'credited';

-- The receiver wallet's sync state (UTXO cursors), sealed with AES-GCM before it gets here.
-- Single row. The lease stops two scanners syncing at once.
create table public.ring_state (
  id          integer primary key default 1 check (id = 1),
  snapshot    text,
  lease_until timestamptz not null default 'epoch',
  lease_owner text,
  synced_at   timestamptz,
  synced_slot bigint
);
insert into public.ring_state (id) values (1) on conflict do nothing;

alter table public.ring_receipts enable row level security;
alter table public.ring_state    enable row level security;

-- Take the scanner lease for p_seconds if nobody holds it. Returns true if taken.
create or replace function public.fuel_ring_lease(p_owner text, p_seconds integer)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update ring_state set lease_until = now() + make_interval(secs => p_seconds), lease_owner = p_owner
   where id = 1 and (lease_until < now() or lease_owner = p_owner);
  return found;
end $$;

create or replace function public.fuel_ring_release(p_owner text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update ring_state set lease_until = 'epoch', lease_owner = null where id = 1 and lease_owner = p_owner;
end $$;

-- Record a ring output once. Credits the sender's balance when status = 'credited'.
-- Returns true if this call recorded it (false = already seen).
create or replace function public.fuel_record_ring(
  p_signature text, p_leaf_index bigint, p_slot bigint, p_kind text, p_sender text,
  p_asset text, p_amount_raw numeric, p_usd_price numeric, p_credit bigint, p_status text
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_status = 'credited' then
    insert into accounts (wallet) values (p_sender) on conflict do nothing;
  end if;
  insert into ring_receipts (signature, leaf_index, slot, kind, sender_wallet, asset, amount_raw, usd_price, credited_micro, status)
    values (p_signature, p_leaf_index, p_slot, p_kind, p_sender, p_asset, p_amount_raw, p_usd_price,
            case when p_status = 'credited' then p_credit else 0 end, p_status)
    on conflict (signature, leaf_index) do nothing;
  if not found then return false; end if;
  if p_status = 'credited' and p_credit > 0 then
    update accounts set balance_micro = balance_micro + p_credit where wallet = p_sender;
    insert into ledger_entries (wallet, delta_micro, source, ref_id)
      values (p_sender, p_credit, 'ring_topup', p_signature || ':' || p_leaf_index);
  end if;
  return true;
end $$;

revoke all on function public.fuel_ring_lease(text, integer) from public, anon, authenticated;
revoke all on function public.fuel_ring_release(text) from public, anon, authenticated;
revoke all on function public.fuel_record_ring(text, bigint, bigint, text, text, text, numeric, numeric, bigint, text) from public, anon, authenticated;
