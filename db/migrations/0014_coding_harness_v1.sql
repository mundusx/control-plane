-- Coding Harness v1 durable lifecycle, evidence, approvals, and capacity state.

create table if not exists public.harness_tasks (
  task_id text primary key,
  harness_contract_version text not null,
  tenant_id text not null,
  repository_source_id text not null,
  base_revision text not null,
  allowed_path_prefixes jsonb not null default '[]'::jsonb,
  execution_mode text not null,
  allowed_operations jsonb not null default '[]'::jsonb,
  validation_profiles jsonb not null default '[]'::jsonb,
  budgets jsonb not null default '{}'::jsonb,
  state text not null,
  state_version bigint not null default 1,
  current_attempt_id text,
  verification_level text,
  terminal_code text,
  created_at_epoch bigint not null,
  updated_at_epoch bigint not null,
  expires_at_epoch bigint not null
);

create table if not exists public.harness_attempts (
  attempt_id text primary key,
  task_id text not null references public.harness_tasks(task_id) on delete cascade,
  node_id text references public.devices(node_id) on delete set null,
  state text not null,
  state_version bigint not null default 1,
  reserved_slots integer not null default 1,
  workspace_id text,
  failure_code text,
  created_at_epoch bigint not null,
  updated_at_epoch bigint not null,
  started_at_epoch bigint,
  finished_at_epoch bigint
);

alter table if exists public.harness_tasks
  drop constraint if exists harness_tasks_current_attempt_id_fkey;
alter table if exists public.harness_tasks
  add constraint harness_tasks_current_attempt_id_fkey
  foreign key (current_attempt_id) references public.harness_attempts(attempt_id)
  deferrable initially deferred;

create table if not exists public.harness_capacity_reservations (
  reservation_id text primary key,
  task_id text not null references public.harness_tasks(task_id) on delete cascade,
  attempt_id text not null references public.harness_attempts(attempt_id) on delete cascade,
  node_id text not null references public.devices(node_id) on delete cascade,
  slots integer not null,
  state text not null,
  created_at_epoch bigint not null,
  expires_at_epoch bigint not null,
  released_at_epoch bigint
);

create table if not exists public.harness_tool_calls (
  tool_call_id text primary key,
  task_id text not null references public.harness_tasks(task_id) on delete cascade,
  attempt_id text not null references public.harness_attempts(attempt_id) on delete cascade,
  operation text not null,
  idempotency_key text,
  input_sha256 text not null,
  output_sha256 text,
  status text not null,
  code text,
  duration_ms bigint,
  output_bytes bigint not null default 0,
  created_at_epoch bigint not null,
  completed_at_epoch bigint,
  unique (attempt_id, idempotency_key)
);

create table if not exists public.harness_validations (
  validation_id text primary key,
  task_id text not null references public.harness_tasks(task_id) on delete cascade,
  attempt_id text not null references public.harness_attempts(attempt_id) on delete cascade,
  profile_id text not null,
  profile_version text not null,
  status text not null,
  code text,
  exit_code integer,
  duration_ms bigint,
  output_sha256 text,
  output_truncated boolean not null default false,
  created_at_epoch bigint not null
);

create table if not exists public.harness_artifacts (
  artifact_id text primary key,
  task_id text not null references public.harness_tasks(task_id) on delete cascade,
  attempt_id text not null references public.harness_attempts(attempt_id) on delete cascade,
  kind text not null,
  sha256 text not null,
  size_bytes bigint not null,
  storage_reference text,
  base_revision text not null,
  changed_paths jsonb not null default '[]'::jsonb,
  verification_level text not null,
  created_at_epoch bigint not null
);

create table if not exists public.harness_approvals (
  approval_id text primary key,
  task_id text not null references public.harness_tasks(task_id) on delete cascade,
  artifact_digest text,
  target text not null,
  scope text not null,
  approver text not null,
  created_at_epoch bigint not null,
  expires_at_epoch bigint not null
);

create table if not exists public.harness_audit_events (
  event_id text primary key,
  task_id text not null references public.harness_tasks(task_id) on delete cascade,
  attempt_id text references public.harness_attempts(attempt_id) on delete set null,
  actor text not null,
  event_type text not null,
  code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at_epoch bigint not null
);

create index if not exists harness_tasks_state_idx
  on public.harness_tasks(state, created_at_epoch);
create index if not exists harness_tasks_tenant_idx
  on public.harness_tasks(tenant_id, created_at_epoch);
create index if not exists harness_attempts_task_idx
  on public.harness_attempts(task_id, created_at_epoch);
create index if not exists harness_attempts_node_state_idx
  on public.harness_attempts(node_id, state);
create unique index if not exists harness_active_reservation_attempt_idx
  on public.harness_capacity_reservations(attempt_id)
  where state = 'active';
create index if not exists harness_active_reservation_node_idx
  on public.harness_capacity_reservations(node_id, expires_at_epoch)
  where state = 'active';
create index if not exists harness_tool_calls_attempt_idx
  on public.harness_tool_calls(attempt_id, created_at_epoch);
create index if not exists harness_validations_attempt_idx
  on public.harness_validations(attempt_id, created_at_epoch);
create index if not exists harness_artifacts_task_idx
  on public.harness_artifacts(task_id, created_at_epoch);
create index if not exists harness_approvals_task_scope_idx
  on public.harness_approvals(task_id, scope, expires_at_epoch);
create index if not exists harness_audit_events_task_idx
  on public.harness_audit_events(task_id, created_at_epoch);

