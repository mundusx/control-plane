create table if not exists public.project_model_jobs (
  job_id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  project_task_id uuid not null references public.local_agent_tasks(task_id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) between 16 and 128),
  state text not null default 'queued' check (state in ('queued','running','completed','failed','cancelled','expired')),
  request jsonb not null,
  result jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default now() + interval '30 minutes',
  unique (user_id, project_task_id, idempotency_key)
);
create index if not exists project_model_jobs_parent_idx
  on public.project_model_jobs (user_id, project_task_id, created_at desc);
