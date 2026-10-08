-- File retention must never remove computation history or earned credits.
alter table public.media_artifacts add column if not exists file_deleted_at timestamptz;
create index if not exists media_artifacts_cleanup_idx
  on public.media_artifacts(expires_at) where file_deleted_at is null;

create table if not exists public.media_compute_records (
  job_id text primary key references public.jobs(job_id),
  owner_user_id uuid not null references public.users(id),
  quote jsonb not null,
  status text not null default 'quoted' check (status in ('quoted','settled')),
  artifact_id uuid unique references public.media_artifacts(artifact_id),
  node_id text references public.devices(node_id),
  generation_ms bigint check (generation_ms >= 0),
  ledger_id uuid unique references public.credits_ledger(id),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check ((status='quoted' and ledger_id is null and settled_at is null)
    or (status='settled' and ledger_id is not null and settled_at is not null and artifact_id is not null and node_id is not null))
);
create index if not exists media_compute_owner_idx on public.media_compute_records(owner_user_id,created_at);
revoke all on public.media_compute_records from public;
-- Defense in depth: only one media reward for a logical job, across retry attempts.
create unique index if not exists credits_media_reward_once_idx
  on public.credits_ledger(job_id) where entry_type='job_reward' and metadata->>'work_type'='image_generation';
