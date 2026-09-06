-- Record the effective isolation mode selected for each harness attempt.

alter table if exists public.harness_attempts
  add column if not exists execution_mode text not null default 'sandbox';

alter table if exists public.harness_attempts
  drop constraint if exists harness_attempts_execution_mode_check;
alter table if exists public.harness_attempts
  add constraint harness_attempts_execution_mode_check
  check (execution_mode in ('sandbox', 'hybrid'));
