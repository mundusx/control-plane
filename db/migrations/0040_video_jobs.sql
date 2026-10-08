alter table public.media_artifacts add column if not exists content_type text not null default 'image/png';
alter table public.media_artifacts add column if not exists frames integer;
alter table public.media_artifacts add column if not exists fps integer;
alter table public.media_artifacts drop constraint if exists media_artifacts_byte_size_check;
alter table public.media_artifacts add constraint media_artifacts_byte_size_check check (
  (content_type='image/png' and byte_size between 1 and 33554432 and frames is null and fps is null)
  or (content_type='video/mp4' and byte_size between 1 and 134217728 and width=1280 and height=704 and frames in (49,121,241) and fps=24));
create table if not exists public.media_generation_jobs (
  job_id text primary key references public.jobs(job_id),
  owner_user_id uuid not null references public.users(id),
  idempotency_key text not null,
  request jsonb not null,
  state text not null default 'queued' check(state in ('queued','running','completed','failed','cancelled')),
  node_id text references public.devices(node_id),
  lease_hash text,
  lease_until timestamptz,
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(owner_user_id,idempotency_key)
);
create index if not exists media_generation_queue_idx on public.media_generation_jobs(created_at,job_id) where state='queued';
create unique index if not exists media_generation_node_slot_idx on public.media_generation_jobs(node_id) where state='running';
create table if not exists public.media_worker_nonces (node_id text not null references public.devices(node_id), nonce uuid not null, expires_at timestamptz not null, primary key(node_id,nonce));
revoke all on public.media_generation_jobs, public.media_worker_nonces from public;
create unique index if not exists credits_video_reward_once_idx on public.credits_ledger(job_id) where entry_type='job_reward' and metadata->>'work_type'='video_generation';
