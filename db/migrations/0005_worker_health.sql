-- MundusX migration 0005: persist worker health snapshot on devices and heartbeats.
--
-- The worker health report travels with every heartbeat and drives scheduling
-- eligibility (runtime_ready, streaming_supported, model availability).
-- Before this migration those fields were computed at runtime but never stored,
-- so the dashboard and any audit query could not see historical worker state.

-- devices: latest worker health snapshot per node
alter table if exists public.devices
  add column if not exists worker_healthy       boolean,
  add column if not exists worker_runtime_ready boolean,
  add column if not exists worker_model_name    text,
  add column if not exists worker_runtime_mode  text,
  add column if not exists worker_streaming     boolean,
  add column if not exists worker_health_json   jsonb;

-- heartbeats: full snapshot per heartbeat row for audit trail
alter table if exists public.heartbeats
  add column if not exists worker_healthy       boolean,
  add column if not exists worker_runtime_ready boolean,
  add column if not exists worker_model_name    text,
  add column if not exists worker_runtime_mode  text,
  add column if not exists worker_streaming     boolean,
  add column if not exists worker_health_json   jsonb;

create index if not exists devices_worker_healthy_idx
  on public.devices(worker_healthy);

create index if not exists heartbeats_worker_healthy_idx
  on public.heartbeats(worker_healthy);
