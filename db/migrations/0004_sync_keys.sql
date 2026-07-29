-- MundusX migration 0004: add idempotency keys for mirrored audit rows.

alter table if exists public.heartbeats
  add column if not exists source_heartbeat_key text;

alter table if exists public.job_events
  add column if not exists source_event_id bigint;

create unique index if not exists heartbeats_source_heartbeat_key_key
  on public.heartbeats(source_heartbeat_key);

create unique index if not exists job_events_source_event_id_key
  on public.job_events(source_event_id);

create index if not exists heartbeats_source_heartbeat_key_idx
  on public.heartbeats(source_heartbeat_key);

create index if not exists job_events_source_event_id_idx
  on public.job_events(source_event_id);
