-- Browser-approved local runner bootstrap. Raw bootstrap and approval secrets are never stored.

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

create index if not exists harness_runner_bootstrap_user_idx
  on public.harness_runner_bootstrap_sessions(user_id, created_at desc);

create index if not exists harness_runner_bootstrap_expiry_idx
  on public.harness_runner_bootstrap_sessions(expires_at)
  where consumed_at is null;
