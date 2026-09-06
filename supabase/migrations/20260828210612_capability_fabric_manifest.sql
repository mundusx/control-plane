-- Capability Fabric v1: preserve the validated static registration snapshot.
-- Dynamic runtime/load observations remain in worker_health_json and heartbeats.

alter table if exists public.devices
  add column if not exists capability_fabric_version text,
  add column if not exists capability_manifest_json jsonb;

create index if not exists devices_capability_fabric_version_idx
  on public.devices(capability_fabric_version)
  where capability_fabric_version is not null;
