-- Per-user chat authentication and Harness repository authorization.

alter table public.users
  add column if not exists status text not null default 'active',
  add column if not exists last_login_at timestamptz;

create table if not exists public.user_identities (
  identity_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null check (provider in ('github', 'email')),
  provider_subject text not null,
  provider_login text,
  email text not null,
  email_verified boolean not null default false,
  profile_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subject)
);

create index if not exists user_identities_user_id_idx
  on public.user_identities (user_id);

create table if not exists public.user_sessions (
  session_hash text primary key check (length(session_hash) = 64),
  csrf_hash text not null check (length(csrf_hash) = 64),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent_hash text,
  ip_prefix_hash text
);

create index if not exists user_sessions_user_active_idx
  on public.user_sessions (user_id, expires_at)
  where revoked_at is null;

create table if not exists public.auth_challenges (
  challenge_hash text primary key check (length(challenge_hash) = 64),
  challenge_type text not null check (challenge_type in ('github_oauth', 'email_magic_link')),
  email text,
  code_verifier text,
  redirect_path text not null default '/',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  request_ip_hash text
);

create index if not exists auth_challenges_email_recent_idx
  on public.auth_challenges (lower(email), created_at desc)
  where email is not null;

create table if not exists public.user_repository_grants (
  grant_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  tenant_id text not null,
  repository_source_id text not null,
  allowed_path_prefixes text[] not null default '{}',
  validation_profiles text[] not null default '{}',
  allowed_execution_modes text[] not null default '{sandbox}',
  status text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  granted_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, tenant_id, repository_source_id)
);

create index if not exists user_repository_grants_active_idx
  on public.user_repository_grants (user_id, status);

create table if not exists public.user_chat_conversations (
  conversation_id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists user_chat_conversations_user_idx
  on public.user_chat_conversations (user_id, created_at desc);

alter table public.harness_tasks
  add column if not exists requested_by_user_id uuid references public.users(id),
  add column if not exists submitted_via text;

create index if not exists harness_tasks_requesting_user_idx
  on public.harness_tasks (requested_by_user_id, created_at_epoch desc)
  where requested_by_user_id is not null;
