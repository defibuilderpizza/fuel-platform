-- GPU / endpoint sellers. A seller runs an OpenAI-compatible server (vLLM, SGLang, Ollama…)
-- and applies to sell its models on Fuel. Fuel probes the endpoint; a person approves it;
-- then it competes in the same cheapest-first routing as every other provider.
-- Sellers earn their own listed price for every job they serve, as Fuel balance credit.

create table public.sellers (
  id            uuid primary key default gen_random_uuid(),
  wallet        text not null references public.accounts (wallet),
  name          text not null check (char_length(name) between 2 and 48),
  endpoint_url  text not null check (endpoint_url ~ '^https://' and char_length(endpoint_url) <= 300),
  api_key_enc   text,                                  -- AES-256-GCM, key held only by the server
  contact       text check (char_length(contact) <= 120),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'paused')),
  review_note   text check (char_length(review_note) <= 300),
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz
);
create index sellers_wallet_idx on public.sellers (wallet);
create index sellers_status_idx on public.sellers (status);

-- What a seller offers. `model` is the name agents send (must match Fuel's catalogue naming).
create table public.seller_models (
  seller_id         uuid not null references public.sellers (id) on delete cascade,
  model             text not null check (char_length(model) between 2 and 120),
  kind              text not null default 'chat' check (kind in ('chat', 'embedding')),
  provider_model_id text not null check (char_length(provider_model_id) between 1 and 120),
  input_per_mtok    numeric not null check (input_per_mtok >= 0 and input_per_mtok <= 1000),
  output_per_mtok   numeric not null default 0 check (output_per_mtok >= 0 and output_per_mtok <= 1000),
  context_length    integer,
  probe_ok          boolean,
  probe_ms          integer,
  probe_error       text,
  probed_at         timestamptz,
  primary key (seller_id, model)
);

alter table public.sellers       enable row level security;
alter table public.seller_models enable row level security;

alter table public.ledger_entries drop constraint if exists ledger_entries_source_check;
alter table public.ledger_entries add constraint ledger_entries_source_check
  check (source in ('public_deposit', 'ring_topup', 'job', 'credit_redeem', 'adjustment', 'lane_payout', 'faucet_trial', 'seller_payout'));

-- Pay a seller for a job it served (once per job).
create or replace function public.fuel_seller_pay(p_wallet text, p_micro bigint, p_job uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_micro <= 0 then return; end if;
  insert into ledger_entries (wallet, delta_micro, source, ref_id) values (p_wallet, p_micro, 'seller_payout', p_job::text)
    on conflict (source, ref_id) do nothing;
  if found then
    update accounts set balance_micro = balance_micro + p_micro where wallet = p_wallet;
  end if;
end $$;
revoke all on function public.fuel_seller_pay(text, bigint, uuid) from public, anon, authenticated;
