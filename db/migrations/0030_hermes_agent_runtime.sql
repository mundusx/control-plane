-- Select an optional local harness without making it part of the cloud trust boundary.
-- This also repairs databases that briefly received the retired Deep Agents enum.

alter table public.local_agent_tasks
  add column if not exists runtime_requested text not null default 'auto',
  add column if not exists runtime_selected text;

alter table public.local_agent_tasks
  drop constraint if exists local_agent_tasks_runtime_requested_check,
  drop constraint if exists local_agent_tasks_runtime_selected_check;

update public.local_agent_tasks set runtime_requested = 'auto'
where runtime_requested not in ('auto', 'native', 'hermes');

update public.local_agent_tasks set runtime_selected = null
where runtime_selected is not null and runtime_selected not in ('native', 'hermes');

alter table public.local_agent_tasks
  add constraint local_agent_tasks_runtime_requested_check
    check (runtime_requested in ('auto', 'native', 'hermes')),
  add constraint local_agent_tasks_runtime_selected_check
    check (runtime_selected is null or runtime_selected in ('native', 'hermes'));

