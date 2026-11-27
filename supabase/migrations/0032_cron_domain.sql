-- The 5-minute scanner now calls the site on its own domain (fuelai.cloud) instead of the
-- vercel.app address. Same job name, schedule and Vault secret as 0003.
select cron.unschedule('fuel-ring-scan') where exists (select 1 from cron.job where jobname = 'fuel-ring-scan');
select cron.schedule(
  'fuel-ring-scan',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := 'https://fuelai.cloud/api/cron/ring-scan',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'fuel_cron_secret')
    ),
    timeout_milliseconds := 60000
  );
  $$
);
