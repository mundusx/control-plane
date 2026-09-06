-- Durable bounded model/tool-loop usage and no-progress state.

alter table if exists public.harness_attempts
  add column if not exists model_turns integer not null default 0,
  add column if not exists tool_calls integer not null default 0,
  add column if not exists output_bytes bigint not null default 0,
  add column if not exists repair_attempts integer not null default 0,
  add column if not exists last_progress_sha256 text,
  add column if not exists repeated_progress_count integer not null default 0;
