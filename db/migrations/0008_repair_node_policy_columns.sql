-- MundusX migration 0008: repair node policy columns skipped by duplicate 0005 migration versions.

alter table if exists public.devices
  add column if not exists reported_state text,
  add column if not exists computed_policy_allowed boolean not null default false,
  add column if not exists computed_policy_reason text,
  add column if not exists operator_policy_override_target text,
  add column if not exists operator_policy_override_reason text,
  add column if not exists operator_policy_override_actor text,
  add column if not exists operator_policy_override_updated_at text;

alter table if exists public.heartbeats
  add column if not exists reported_state text,
  add column if not exists computed_policy_allowed boolean not null default false,
  add column if not exists computed_policy_reason text,
  add column if not exists operator_policy_override_target text,
  add column if not exists operator_policy_override_reason text,
  add column if not exists operator_policy_override_actor text,
  add column if not exists operator_policy_override_updated_at text;
