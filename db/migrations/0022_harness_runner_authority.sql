begin;

create table if not exists public.harness_runners (
  runner_id text primary key,
  device_id text not null,
  public_key_hex text not null,
  kind text not null check (kind in ('local_user', 'ehda_hosted')),
  owner_user_id uuid references public.users(id) on delete set null,
  tenant_ids jsonb not null default '[]'::jsonb,
  repository_source_ids jsonb not null default '[]'::jsonb,
  execution_modes jsonb not null default '[]'::jsonb,
  supported_operations jsonb not null default '[]'::jsonb,
  network_default_disabled boolean not null default true,
  max_workspace_mb integer not null check (max_workspace_mb > 0),
  usable_memory_mb integer not null check (usable_memory_mb > 0),
  parallel_slots integer not null check (parallel_slots > 0),
  trusted_identity boolean not null default false,
  ready boolean not null default false,
  last_seen_epoch bigint not null
);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'harness_operational_policy'
      and column_name = 'drained_nodes'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'harness_operational_policy'
      and column_name = 'drained_runners'
  ) then
    alter table public.harness_operational_policy
      rename column drained_nodes to drained_runners;
  end if;
end $$;

insert into public.harness_runners (
  runner_id, device_id, public_key_hex, kind, tenant_ids,
  repository_source_ids, execution_modes, supported_operations,
  max_workspace_mb, usable_memory_mb, parallel_slots, ready, last_seen_epoch
) values (
  'legacy-unassigned', 'legacy-unassigned', repeat('0', 64), 'ehda_hosted', '[]'::jsonb,
  '[]'::jsonb, '["sandbox"]'::jsonb, '["legacy.audit_only"]'::jsonb,
  1, 1, 1, false, 0
) on conflict (runner_id) do nothing;

alter table public.harness_attempts
  add column if not exists runner_id text references public.harness_runners(runner_id) on delete restrict;
update public.harness_attempts
set runner_id = 'legacy-unassigned'
where runner_id is null;
alter table public.harness_attempts
  alter column runner_id set not null;

alter table public.harness_capacity_reservations
  add column if not exists runner_id text references public.harness_runners(runner_id) on delete restrict;
update public.harness_capacity_reservations
set runner_id = 'legacy-unassigned'
where runner_id is null;
alter table public.harness_capacity_reservations
  alter column runner_id set not null;
alter table public.harness_capacity_reservations
  alter column node_id drop not null;

drop index if exists public.harness_attempts_node_state_idx;
drop index if exists public.harness_active_reservation_node_idx;
create index if not exists harness_runners_owner_ready_idx
  on public.harness_runners(owner_user_id, ready, last_seen_epoch desc)
  where ready = true;
create index if not exists harness_attempts_runner_state_idx
  on public.harness_attempts(runner_id, state);
create index if not exists harness_active_reservation_runner_idx
  on public.harness_capacity_reservations(runner_id, expires_at_epoch)
  where state = 'active';

commit;
