-- Voice: text to speech (priced per 1,000 characters) and speech to text (per minute of audio).

alter table public.provider_models drop constraint if exists provider_models_kind_check;
alter table public.provider_models add constraint provider_models_kind_check check (kind in ('chat', 'embedding', 'image', 'video', 'mesh', 'speech', 'transcription'));
alter table public.provider_models drop constraint if exists provider_models_unit_check;
alter table public.provider_models add constraint provider_models_unit_check check (unit is null or unit in ('image', 'clip', 'model', '1k_chars', 'minute'));

alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('chat', 'embedding', 'image', 'video', 'mesh', 'speech', 'transcription'));
