# Managed Postgres And PgBouncer Topology

Parent epic: #239

Depends on: #240

This document defines the target database topology for replacing Supabase
platform services with a MundusX-operated PostgreSQL service and PgBouncer
runtime pool.

## Target Shape

```text
control-plane runtime
  -> MUNDUSX_DATABASE_POOL_URL
  -> PgBouncer
  -> PostgreSQL

migrations, schema checks, backups, restore, admin repair
  -> MUNDUSX_DATABASE_URL
  -> PostgreSQL
```

PgBouncer is not the database. It is only the runtime connection pooler. Schema
management and operational repair tasks must connect directly to PostgreSQL.

## Environments

### Local Development

- Local development may continue using local JSON fallback when no database is
  configured.
- Developers who test the managed database path should run local PostgreSQL and
  PgBouncer, or point at a disposable development database.
- Local migrations use `MUNDUSX_DATABASE_URL`.
- Local app runtime uses `MUNDUSX_DATABASE_POOL_URL` when PgBouncer is present,
  otherwise it may use `MUNDUSX_DATABASE_URL` only for local development.

### UAT

- UAT must use a dedicated managed PostgreSQL database.
- UAT runtime traffic must use PgBouncer through
  `MUNDUSX_DATABASE_POOL_URL`.
- UAT migrations and schema checks must use direct PostgreSQL through
  `MUNDUSX_DATABASE_URL`.
- `/health` and `/v1/status` should report the active storage source, runtime
  connection health, and migration/admin connection configuration state without
  exposing credentials.

### Production

- Production must use a separate managed PostgreSQL database, separate
  credentials, separate backups, and production-sized PgBouncer limits.
- Production must not share UAT credentials, database names, or PgBouncer pools.
- Production migrations should run as an explicit release step or controlled
  one-off job before the new application revision is promoted.

## Environment Variables

| Variable | Required | Purpose | Connection target |
| --- | --- | --- | --- |
| `MUNDUSX_DATABASE_URL` | Required for managed database mode | Direct PostgreSQL URL for migrations, schema checks, admin repair, backup/restore tooling, and one-off maintenance. | PostgreSQL |
| `MUNDUSX_DATABASE_POOL_URL` | Required for shared UAT/production runtime | Pooled runtime URL used by the control-plane process for node, job, scheduler, credit, chat, and dashboard state. | PgBouncer |
| `MUNDUSX_DATABASE_POOL_MODE` | Recommended | Documents the expected PgBouncer mode. Default target is `transaction`. | Runtime config |
| `MUNDUSX_DATABASE_TLS_MODE` | Recommended | Documents TLS behavior such as `require`, `verify-full`, or local-only relaxed mode. | Runtime and admin |
| `DATABASE_URL` | Legacy compatibility only | Temporary direct PostgreSQL migration alias accepted only when `MUNDUSX_DATABASE_URL` is absent. It must not point at PgBouncer. | Legacy |
| `SUPABASE_URL` | Legacy only | Supabase PostgREST URL. Not part of the target managed database path. | Legacy |
| `SUPABASE_SERVICE_ROLE_KEY` | Legacy only | Supabase PostgREST service-role key. Not part of the target managed database path. | Legacy |

`DATABASE_URL` must not silently mean both direct migration traffic and pooled
runtime traffic. Managed database deployments should set
`MUNDUSX_DATABASE_URL` and reserve `DATABASE_URL` for legacy compatibility only.

## PgBouncer Policy

Default target: transaction pooling.

Transaction pooling is appropriate for stateless API traffic, but application
code must avoid session-level behavior. The runtime storage backend should be
reviewed against these constraints:

- Do not depend on connection-local session variables.
- Do not depend on temporary tables.
- Do not depend on long-lived prepared statements.
- Do not use `LISTEN/NOTIFY` through the runtime pool.
- Do not hold transactions open across request boundaries.
- Do not run schema migrations through PgBouncer.
- Keep each request's database work bounded and explicitly committed.

If a future feature needs session state or `LISTEN/NOTIFY`, it should use a
separate direct connection or a dedicated pool with a documented mode instead
of weakening the default runtime pool.

## Credentials And Roles

Use separate credentials for:

- application runtime
- migrations/schema management
- backup/restore
- break-glass admin repair
- read-only diagnostics, if needed

Recommended role posture:

- Runtime role can read/write only the tables required by the control-plane
  API.
- Migration role owns schema changes and can create/alter/drop managed schema
  objects.
- Backup role has the minimum read permissions required by the backup tool.
- Admin repair role is not used by the normal application process.

The Supabase `anon` and `authenticated` roles should not be copied as-is. If
RLS is retained as defense in depth, define MundusX-owned roles and policies
that match the server-side access model.

## TLS

Shared UAT and production must require encrypted database connections.

Recommended target:

- UAT: TLS required.
- Production: TLS required with certificate verification where provider support
  allows it.
- Local: relaxed TLS is acceptable only for disposable local development.

Connection strings and health output must never expose usernames, passwords,
hostnames with credentials, or raw URLs.

## Pool Sizing

Initial sizing should be conservative until traffic is measured.

Track separately:

- PgBouncer `max_client_conn`
- PgBouncer `default_pool_size`
- PostgreSQL `max_connections`
- control-plane process concurrency
- request timeout and idle transaction timeout

The runtime pool should protect PostgreSQL from spikes. It should not be sized
so high that PostgreSQL accepts every application connection directly.

## Migrations

Migrations must use `MUNDUSX_DATABASE_URL`, not `MUNDUSX_DATABASE_POOL_URL`.

Required migration behavior:

- Fail early if the migration command is pointed at a known PgBouncer URL.
- Record applied migrations in `public.schema_migrations`.
- Apply schema changes before the application revision that depends on them is
  promoted.
- Keep migrations idempotent where practical.
- Keep rollback notes for destructive or irreversible changes.

Portable PostgreSQL schema ownership lives under `db/`. The legacy `supabase/`
directory is retained during migration for compatibility and history. The
managed PostgreSQL migration path intentionally treats the old PostgREST
schema-cache reload as a no-op because PostgREST is not part of the target
database service.

## Backups And Restore

Backups are a first-class requirement for the managed database service.

Minimum UAT expectations:

- scheduled logical or provider-native backups
- documented restore command
- restore rehearsal before production adoption
- clear retention window
- clear owner for failed backup alerts

Minimum production expectations:

- automated backups with retention policy
- point-in-time recovery if the provider supports it
- restore rehearsal on a non-production database
- documented recovery time and recovery point expectations
- monitoring for backup freshness and restore failures

Restore validation should check:

- nodes and latest heartbeat state
- queued/running/completed jobs
- job events
- graph metadata
- credits ledger
- chat conversations and messages
- dashboard read paths

## Monitoring And Health

The application should expose generic database health, not Supabase-specific
health, once the new path exists.

Suggested health fields for #242:

- `storage_source`: `postgres`, `local-json-fallback`, or `local-json-only`
- `database.runtime_pool`: configured, healthy/degraded, and last error summary
- `database.admin_direct`: configured/unconfigured only; do not test admin
  credentials on every request
- `database.pool_mode`: expected PgBouncer mode
- `database.migrations`: latest known migration status when available

Health output must be safe for operators and support staff. It must not include
raw connection strings, passwords, API keys, or provider secret names.

## Rollback Strategy

The migration should preserve a fallback path until UAT proves parity.

Recommended rollout:

1. Add config and generic health fields without changing runtime storage.
2. Add managed PostgreSQL migrations and schema verification.
3. Add plain Postgres runtime backend behind a feature/config switch.
4. Run UAT parity smoke against managed PostgreSQL.
5. Keep the previous Supabase mirror disabled but available for one rollback
   window if operationally necessary.
6. Remove legacy Supabase code/docs only after UAT and production adoption are
   stable.

Rollback from a failed application revision should switch runtime storage back
to the previous known-good path only if data divergence has been assessed. If
both stores accepted writes, reconcile before flipping traffic back.

## Out Of Scope

- Creating the actual managed database service.
- Changing application code.
- Renaming migrations.
- Removing Supabase code.
- Running UAT validation.

Those are owned by #242 through #246.
