-- Free trial without a wallet: a visitor gets a guest account ("guest:<id>") funded from the
-- trial pot, usable on cheap text models and quick pictures. One per network (hashed IP) per 30
-- days. Fuel keeps only the hash, never the IP itself.

create table public.guest_trials (
  ip_hash     text primary key,
  wallet      text not null references public.accounts (wallet),
  created_at  timestamptz not null default now()
);
alter table public.guest_trials enable row level security;
