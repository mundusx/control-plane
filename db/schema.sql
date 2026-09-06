-- MundusX managed PostgreSQL schema.
-- Apply through the control-plane migration command with MUNDUSX_DATABASE_URL.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  display_name text,
  role text not null default 'operator',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.devices (
  node_id text primary key,
  user_id uuid references public.users(id),
  public_key_fingerprint text not null unique,
  public_key_hex text not null unique,
  hostname text not null,
  identity_trust_path text not null default 'unknown',
  backend text not null,
  contribution_percent integer not null,
  agent_version text not null,
  capability_fabric_version text,
  capability_manifest_json jsonb,
  state text not null,
  reported_state text,
  available_memory_mb integer not null default 0,
  available_gpu_percent integer not null default 0,
  power_source text not null default 'unknown',
  on_battery boolean not null default false,
  battery_percent integer,
  policy_allowed boolean not null default false,
  policy_reason text,
  computed_policy_allowed boolean not null default false,
  computed_policy_reason text,
  operator_policy_override_target text,
  operator_policy_override_reason text,
  operator_policy_override_actor text,
  operator_policy_override_updated_at text,
  last_seen_at_epoch bigint,
  updated_at_epoch bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.heartbeats (
  id bigint generated always as identity primary key,
  source_heartbeat_key text unique,
  node_id text not null references public.devices(node_id) on delete cascade,
  backend text not null,
  agent_state text not null,
  available_memory_mb integer not null,
  available_gpu_percent integer not null,
  contribution_percent integer not null,
  hostname text not null,
  identity_trust_path text not null default 'unknown',
  power_source text not null,
  on_battery boolean not null,
  battery_percent integer,
  reported_state text,
  policy_allowed boolean not null,
  policy_reason text,
  computed_policy_allowed boolean not null default false,
  computed_policy_reason text,
  operator_policy_override_target text,
  operator_policy_override_reason text,
  operator_policy_override_actor text,
  operator_policy_override_updated_at text,
  observed_at_epoch bigint not null,
  created_at timestamptz not null default now()
);

alter table if exists public.heartbeats
  add column if not exists source_heartbeat_key text;

create table if not exists public.jobs (
  job_id text primary key,
  request_id text not null unique,
  prompt text not null,
  preferred_backend text not null,
  model text,
  system_prompt text,
  max_tokens integer,
  temperature numeric,
  top_p numeric,
  seed bigint,
  classification jsonb not null default '{}'::jsonb,
  plan jsonb not null default '{}'::jsonb,
  graph jsonb not null default '{}'::jsonb,
  status text not null,
  assigned_node_id text references public.devices(node_id),
  worker_id text,
  backend text,
  output text,
  error text,
  submitted_at_epoch bigint,
  assigned_at_epoch bigint,
  completed_at_epoch bigint,
  updated_at_epoch bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.job_events (
  id bigint generated always as identity primary key,
  source_event_id bigint unique,
  node_id text references public.devices(node_id) on delete set null,
  job_id text references public.jobs(job_id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table if exists public.job_events
  add column if not exists source_event_id bigint;

create table if not exists public.policy_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  enabled boolean not null default true,
  rule_type text not null,
  rule_config jsonb not null default '{}'::jsonb,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.credits_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id),
  device_id text references public.devices(node_id),
  job_id text references public.jobs(job_id),
  parent_job_id text references public.jobs(job_id),
  graph_node_id text,
  entry_type text not null,
  amount numeric not null default 0,
  currency text not null default 'credits',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

drop trigger if exists devices_set_updated_at on public.devices;
create trigger devices_set_updated_at
before update on public.devices
for each row execute function public.set_updated_at();

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
before update on public.jobs
for each row execute function public.set_updated_at();

drop trigger if exists policy_rules_set_updated_at on public.policy_rules;
create trigger policy_rules_set_updated_at
before update on public.policy_rules
for each row execute function public.set_updated_at();

create index if not exists heartbeats_node_id_idx on public.heartbeats(node_id);
create index if not exists heartbeats_source_heartbeat_key_idx on public.heartbeats(source_heartbeat_key);
create index if not exists jobs_status_idx on public.jobs(status);
create index if not exists jobs_assigned_node_id_idx on public.jobs(assigned_node_id);
create index if not exists job_events_node_id_idx on public.job_events(node_id);
create index if not exists job_events_job_id_idx on public.job_events(job_id);
create index if not exists job_events_source_event_id_idx on public.job_events(source_event_id);

-- Coding Harness v1 durable lifecycle, evidence, approvals, and capacity state.

create table if not exists public.harness_tasks (
  task_id text primary key,
  harness_contract_version text not null,
  tenant_id text not null,
  repository_source_id text not null,
  objective text not null default '',
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

create table if not exists public.harness_runners (
  runner_id text primary key,
  device_id text not null,
  public_key_hex text not null,
  kind text not null check (kind in ('local_user', 'ehda_hosted')),
  owner_user_id uuid references public.users(id) on delete set null,
  tenant_ids jsonb not null default '[]'::jsonb,
  repository_source_ids jsonb not null default '[]'::jsonb,
  local_projects jsonb not null default '[]'::jsonb,
  execution_modes jsonb not null default '[]'::jsonb,
  supported_operations jsonb not null default '[]'::jsonb,
  network_default_disabled boolean not null default true,
  max_workspace_mb integer not null check (max_workspace_mb > 0),
  usable_memory_mb integer not null check (usable_memory_mb > 0),
  parallel_slots integer not null check (parallel_slots > 0),
  trusted_identity boolean not null default false,
  ready boolean not null default false,
  last_seen_epoch bigint not null
);

create table if not exists public.harness_attempts (
  attempt_id text primary key,
  task_id text not null references public.harness_tasks(task_id) on delete cascade,
  runner_id text not null references public.harness_runners(runner_id) on delete restrict,
  node_id text references public.devices(node_id) on delete set null,
  execution_mode text not null default 'sandbox',
  state text not null,
  state_version bigint not null default 1,
  reserved_slots integer not null default 1,
  workspace_id text,
  failure_code text,
  created_at_epoch bigint not null,
  updated_at_epoch bigint not null,
  started_at_epoch bigint,
  finished_at_epoch bigint,
  model_turns integer not null default 0,
  tool_calls integer not null default 0,
  output_bytes bigint not null default 0,
  repair_attempts integer not null default 0,
  last_progress_sha256 text,
  repeated_progress_count integer not null default 0
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
  runner_id text not null references public.harness_runners(runner_id) on delete restrict,
  node_id text references public.devices(node_id) on delete set null,
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
  artifact_sha256 text not null default repeat('0', 64),
  base_revision text not null default repeat('0', 40),
  environment_sha256 text not null default repeat('0', 64),
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
create index if not exists harness_runners_owner_ready_idx
  on public.harness_runners(owner_user_id, ready, last_seen_epoch desc)
  where ready = true;

create table if not exists public.harness_runner_pairings (
  pairing_hash text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  runner_id text,
  public_key_hex text,
  created_at timestamptz not null default now(),
  check (length(pairing_hash) = 64),
  check (runner_id is null or length(runner_id) between 1 and 160),
  check (public_key_hex is null or length(public_key_hex) >= 64)
);

create index if not exists harness_runner_pairings_user_idx
  on public.harness_runner_pairings(user_id, created_at desc);
create index if not exists harness_runner_pairings_expiry_idx
  on public.harness_runner_pairings(expires_at)
  where consumed_at is null;

create table if not exists public.harness_runner_bootstrap_sessions (
  session_id uuid primary key,
  bootstrap_hash text not null unique,
  approval_hash text not null unique,
  device_id text not null,
  public_key_hex text not null,
  user_id uuid references public.users(id) on delete cascade,
  approved_at timestamptz,
  consumed_at timestamptz,
  runner_id text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (length(bootstrap_hash) = 64),
  check (length(approval_hash) = 64),
  check (length(device_id) between 1 and 160),
  check (length(public_key_hex) between 64 and 256),
  check (runner_id is null or length(runner_id) between 1 and 160)
);

create table if not exists public.local_agent_bootstrap_sessions (
  session_id uuid primary key,
  connector_hash text not null unique check (length(connector_hash) = 64),
  approval_hash text not null unique check (length(approval_hash) = 64),
  device_name text not null check (length(device_name) between 1 and 160),
  user_id uuid references public.users(id) on delete cascade,
  approved_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists local_agent_bootstrap_expiry_idx
  on public.local_agent_bootstrap_sessions(expires_at)
  where approved_at is null;

create index if not exists harness_runner_bootstrap_user_idx
  on public.harness_runner_bootstrap_sessions(user_id, created_at desc);
create index if not exists harness_runner_bootstrap_expiry_idx
  on public.harness_runner_bootstrap_sessions(expires_at)
  where consumed_at is null;

create table if not exists public.mcp_personal_access_tokens (
  token_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique check (length(token_hash) = 64),
  name text not null check (length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists mcp_personal_access_tokens_user_active_idx
  on public.mcp_personal_access_tokens(user_id, created_at desc)
  where revoked_at is null;
create index if not exists mcp_personal_access_tokens_expiry_idx
  on public.mcp_personal_access_tokens(expires_at)
  where revoked_at is null;
create index if not exists harness_attempts_runner_state_idx
  on public.harness_attempts(runner_id, state);
create unique index if not exists harness_active_reservation_attempt_idx
  on public.harness_capacity_reservations(attempt_id)
  where state = 'active';
create index if not exists harness_active_reservation_runner_idx
  on public.harness_capacity_reservations(runner_id, expires_at_epoch)
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

create table if not exists public.harness_operational_policy (
  singleton boolean primary key default true check (singleton),
  kill_switch boolean not null default false,
  drained_runners jsonb not null default '[]'::jsonb,
  tenant_max_active_attempts integer not null default 4,
  tenant_max_queued_tasks integer not null default 25,
  tenant_max_artifact_bytes bigint not null default 104857600,
  updated_at timestamptz not null default now()
);

create table if not exists public.harness_operational_events (
  id bigserial unique,
  event_id text primary key,
  actor text not null,
  action text not null,
  target text,
  metadata jsonb not null default '{}'::jsonb,
  created_at_epoch bigint not null
);

create table if not exists public.user_skills (
  skill_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  slug text not null,
  title text not null,
  description text not null default '',
  content text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug),
  check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  check (length(title) between 1 and 100),
  check (length(description) <= 500),
  check (length(content) between 1 and 12000)
);

create index if not exists user_skills_user_updated_idx
  on public.user_skills(user_id, updated_at desc);

create table if not exists public.global_skill_overrides (
  skill_id text primary key,
  content text not null,
  enabled boolean not null default true,
  version integer not null default 1,
  updated_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (skill_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  check (length(content) between 1 and 12000),
  check (version > 0)
);
