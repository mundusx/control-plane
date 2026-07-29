alter table public.jobs
add column if not exists classification jsonb not null default '{}'::jsonb;

alter table public.jobs
add column if not exists plan jsonb not null default '{}'::jsonb;
