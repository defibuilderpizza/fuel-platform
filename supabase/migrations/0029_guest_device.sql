-- One free trial per computer too: a long-lived device cookie (random, hashed here) is recorded
-- with each guest trial, so a browser that used it can't start another from a different network.

alter table public.guest_trials add column if not exists device_hash text;
create unique index if not exists guest_trials_device_idx on public.guest_trials (device_hash) where device_hash is not null;
