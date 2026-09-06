-- Browser-approved bootstrap for a local MundusX development agent.
-- The raw connector credential is returned once to the local app and never stored.

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
