-- Authenticated personal skills and administrator-owned global skill overrides.

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

