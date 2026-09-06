-- Bind local agent project tasks to a validated workspace-relative project slug.

alter table public.local_agent_tasks
  add column if not exists workspace_relative text;

alter table public.local_agent_tasks
  drop constraint if exists local_agent_tasks_workspace_relative_check;

alter table public.local_agent_tasks
  add constraint local_agent_tasks_workspace_relative_check check (
    workspace_relative is null or workspace_relative ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  );

