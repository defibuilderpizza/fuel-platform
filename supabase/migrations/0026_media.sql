-- Media jobs: pictures and video clips, priced per output (not per token).
-- provider_models rows of kind image/video carry unit_price_usd (provider cost per output) and
-- unit ('image' | 'clip'); their per-token prices stay 0. Video runs asynchronously: the job
-- keeps the provider's job id so Fuel can poll it. Outputs themselves are never stored.

alter table public.provider_models drop constraint if exists provider_models_kind_check;
alter table public.provider_models add constraint provider_models_kind_check check (kind in ('chat', 'embedding', 'image', 'video'));
alter table public.provider_models add column if not exists unit_price_usd numeric check (unit_price_usd is null or unit_price_usd > 0);
alter table public.provider_models add column if not exists unit text check (unit is null or unit in ('image', 'clip'));

alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('chat', 'embedding', 'image', 'video'));
alter table public.jobs add column if not exists provider_job_id text;
alter table public.jobs add column if not exists outputs integer;
create index if not exists jobs_running_video_idx on public.jobs (created_at) where kind = 'video' and status = 'running';
