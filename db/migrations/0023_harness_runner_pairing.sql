-- One-time MundusX Chat to local Harness runner pairing. Only SHA-256 digests are stored.

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
