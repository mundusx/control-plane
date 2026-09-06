begin;

alter table public.harness_runners
  add column if not exists local_projects jsonb not null default '[]'::jsonb;

commit;
