-- 3D models ("mesh" jobs): a prompt becomes a picture, then a 3D model (GLB). Priced per model.

alter table public.provider_models drop constraint if exists provider_models_kind_check;
alter table public.provider_models add constraint provider_models_kind_check check (kind in ('chat', 'embedding', 'image', 'video', 'mesh'));
alter table public.provider_models drop constraint if exists provider_models_unit_check;
alter table public.provider_models add constraint provider_models_unit_check check (unit is null or unit in ('image', 'clip', 'model'));

alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('chat', 'embedding', 'image', 'video', 'mesh'));
