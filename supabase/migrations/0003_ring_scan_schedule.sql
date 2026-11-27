-- Backup scanner for private top-ups: calls Fuel's ring scan every 5 minutes.
-- (Every minute would exceed the Helius free tier; confirm is the fast path anyway.)
-- Before running, store the cron secret (same value as Vercel's CRON_SECRET) in Vault:
--   select vault.create_secret('<CRON_SECRET>', 'fuel_cron_secret', 'Bearer for /api/cron/ring-scan');
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('fuel-ring-scan') where exists (select 1 from cron.job where jobname = 'fuel-ring-scan');
select cron.schedule(
  'fuel-ring-scan',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := 'https://YOUR_SITE/api/cron/ring-scan',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'fuel_cron_secret')
    ),
    timeout_milliseconds := 60000
  );
  $$
);
