-- Outbound bridge between MundusX Chat and a user's local MundusX agent.

create table if not exists public.local_agent_connections (
  connection_id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  device_name text not null,
  capabilities jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (length(device_name) between 1 and 160)
);

create index if not exists local_agent_connections_user_seen_idx
  on public.local_agent_connections(user_id, last_seen_at desc)
  where revoked_at is null;

create table if not exists public.local_agent_tasks (
  task_id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  connection_id uuid references public.local_agent_connections(connection_id) on delete set null,
  conversation_id uuid,
  session_id uuid not null,
  prompt text not null,
  allow_mutations boolean not null default false,
  state text not null default 'queued',
  result jsonb,
  error text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  check (length(prompt) between 1 and 16000),
  check (state in ('queued', 'running', 'completed', 'failed', 'cancelled'))
);

create index if not exists local_agent_tasks_claim_idx
  on public.local_agent_tasks(user_id, created_at)
  where state in ('queued', 'running');

create table if not exists public.local_agent_task_events (
  task_id uuid not null references public.local_agent_tasks(task_id) on delete cascade,
  sequence bigint not null,
  event jsonb not null,
  created_at timestamptz not null default now(),
  primary key (task_id, sequence)
);
