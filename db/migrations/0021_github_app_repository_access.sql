-- GitHub App user-to-server tokens and EHDA-owned repository Harness policy.

create table if not exists public.github_user_tokens (
  user_id uuid primary key references public.users(id) on delete cascade,
  access_ciphertext text not null,
  refresh_ciphertext text,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  token_type text not null default 'bearer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.repository_harness_policies (
  repository_id bigint primary key,
  repository_full_name text not null,
  tenant_id text not null,
  allowed_path_prefixes text[] not null default '{}',
  validation_profiles text[] not null default '{}',
  allowed_execution_modes text[] not null default '{sandbox}',
  status text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  require_write_permission boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists repository_harness_policies_name_idx
  on public.repository_harness_policies (lower(repository_full_name));
