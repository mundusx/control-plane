-- Durable Harness quotas, kill switch, node drain, and authenticated operator audit.

create table if not exists public.harness_operational_policy (
  singleton boolean primary key default true check (singleton),
  kill_switch boolean not null default false,
  drained_nodes jsonb not null default '[]'::jsonb,
  tenant_max_active_attempts integer not null default 4,
  tenant_max_queued_tasks integer not null default 25,
  tenant_max_artifact_bytes bigint not null default 104857600,
  updated_at timestamptz not null default now()
);

insert into public.harness_operational_policy (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.harness_operational_events (
  id bigserial unique,
  event_id text primary key,
  actor text not null,
  action text not null,
  target text,
  metadata jsonb not null default '{}'::jsonb,
  created_at_epoch bigint not null
);

create index if not exists harness_operational_events_created_idx
  on public.harness_operational_events(created_at_epoch);
