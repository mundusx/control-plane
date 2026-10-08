create table if not exists public.runtime_token_usage (
  call_id uuid primary key,
  job_id text not null references public.jobs(job_id),
  node_id text not null references public.devices(node_id),
  worker_id text not null,
  call_index integer not null,
  model text,
  completion_tokens bigint not null check(completion_tokens between 0 and 1000000000),
  prompt_tokens bigint check(prompt_tokens between 0 and 1000000000),
  source text not null check(source='runtime'),
  recorded_at timestamptz not null default now(),
  unique(job_id,worker_id,call_index)
);
create table if not exists public.runtime_token_totals (
  id integer primary key check(id=1),
  completion_tokens bigint not null default 0,
  prompt_tokens bigint not null default 0,
  measured_calls bigint not null default 0,
  tracking_started_at timestamptz not null default now(),
  last_recorded_at timestamptz
);
insert into public.runtime_token_totals(id) values(1) on conflict do nothing;
revoke all on public.runtime_token_usage,public.runtime_token_totals from public;
