alter table public.credits_ledger
  add column if not exists parent_job_id text references public.jobs(job_id),
  add column if not exists graph_node_id text;

create index if not exists credits_ledger_parent_job_id_idx on public.credits_ledger(parent_job_id);
create index if not exists credits_ledger_graph_node_id_idx on public.credits_ledger(graph_node_id);
