alter table public.jobs
add column if not exists graph jsonb not null default '{}'::jsonb;
