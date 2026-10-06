create table if not exists public.media_worker_presence (
  node_id text primary key references public.devices(node_id),
  public_key_hex text not null,
  profiles jsonb not null,
  last_poll_at timestamptz not null,
  last_assigned_at timestamptz
);
create table if not exists public.media_execution_attempts (
  job_id text not null references public.media_generation_jobs(job_id),
  attempt integer not null,
  node_id text not null references public.devices(node_id),
  profile_id text not null,
  state text not null check(state in ('running','completed','failed','expired')),
  started_at timestamptz not null,
  finished_at timestamptz,
  generation_ms bigint,
  primary key(job_id,attempt)
);
create index if not exists media_attempt_node_profile_idx on public.media_execution_attempts(node_id,profile_id,started_at desc);
revoke all on public.media_worker_presence, public.media_execution_attempts from public;
create table if not exists public.media_routing_clock (profile_id text primary key, assignments bigint not null default 0);
revoke all on public.media_routing_clock from public;
