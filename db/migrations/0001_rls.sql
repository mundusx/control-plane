-- MundusX PostgreSQL RLS hardening.
-- Apply after db/schema.sql.

-- Supabase creates `anon` and `authenticated`; provider-neutral PostgreSQL does
-- not. Revoke them when present without making those platform roles a schema
-- prerequisite.
do $$
declare
  application_role text;
begin
  foreach application_role in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = application_role) then
      execute format(
        'revoke all on table public.users, public.devices, public.heartbeats, public.jobs, public.job_events, public.policy_rules, public.credits_ledger from %I',
        application_role
      );
    end if;
  end loop;
end
$$;

alter table public.users enable row level security;
alter table public.devices enable row level security;
alter table public.heartbeats enable row level security;
alter table public.jobs enable row level security;
alter table public.job_events enable row level security;
alter table public.policy_rules enable row level security;
alter table public.credits_ledger enable row level security;

-- Intentionally no client-facing policies yet.
-- The MundusX control plane uses server-side database credentials only.
-- This keeps contributor, job, and accounting data inaccessible from direct browser access.
