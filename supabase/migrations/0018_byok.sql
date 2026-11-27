-- Bring your own key: a customer stores their own provider API key (OpenAI, Anthropic) and Fuel
-- calls that provider with it. The provider bills the customer directly; Fuel only adds routing,
-- receipts, limits and team features. Keys are encrypted with FUEL_SECRETS_KEY (AES-256-GCM)
-- before they're stored and are never returned. Off unless FUEL_BYOK_PROVIDERS lists the provider.
create table public.provider_keys (
  wallet      text not null references public.accounts (wallet) on delete cascade,
  provider    text not null check (provider in ('openai', 'anthropic')),
  key_enc     text not null,
  last4       text not null,
  created_at  timestamptz not null default now(),
  primary key (wallet, provider)
);
alter table public.provider_keys enable row level security;
