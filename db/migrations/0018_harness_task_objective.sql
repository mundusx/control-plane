-- Coding Harness tasks require an explicit bounded objective for model execution.
alter table if exists public.harness_tasks
  add column if not exists objective text not null default '';

alter table if exists public.harness_tasks
  drop constraint if exists harness_tasks_objective_length;
alter table if exists public.harness_tasks
  add constraint harness_tasks_objective_length
  check (octet_length(objective) <= 16384);
