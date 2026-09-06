-- User-scoped credentials for the MundusX Harness MCP endpoint.
-- Raw credentials are returned once and never persisted.

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
