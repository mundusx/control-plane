create table if not exists public.model_catalog (
    singleton boolean primary key default true check (singleton),
    revision bigint not null,
    document jsonb not null,
    updated_by text not null,
    updated_at timestamptz not null default now()
);
alter table public.model_catalog enable row level security;
revoke all on public.model_catalog from public;
do $$ begin
    if exists (select 1 from pg_roles where rolname='anon') then revoke all on public.model_catalog from anon; end if;
    if exists (select 1 from pg_roles where rolname='authenticated') then revoke all on public.model_catalog from authenticated; end if;
end $$;
