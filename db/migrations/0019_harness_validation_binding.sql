-- Bind signed worker validation evidence to the exact patch/base and bounded environment.
alter table if exists public.harness_validations
  add column if not exists artifact_sha256 text not null default repeat('0', 64),
  add column if not exists base_revision text not null default repeat('0', 40),
  add column if not exists environment_sha256 text not null default repeat('0', 64);
