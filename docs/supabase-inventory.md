# Supabase Usage Inventory

Parent epic: #239

This inventory supports the migration from Supabase platform services to a
managed PostgreSQL service with PgBouncer for runtime application pooling. It
does not change runtime behavior.

## Summary

The control plane already has two separate persistence paths:

- Runtime mirroring and restore now prefer `apps/control-plane/src/postgres_store.rs`
  when `MUNDUSX_DATABASE_POOL_URL` or `MUNDUSX_DATABASE_URL` is configured.
- Legacy runtime mirroring and restore still use `apps/control-plane/src/supabase.rs`,
  which talks to Supabase PostgREST over HTTPS with `SUPABASE_SERVICE_ROLE_KEY`.
- Schema migrations use `apps/control-plane/src/migrations.rs`, which connects
  directly with the Rust `postgres` crate through `MUNDUSX_DATABASE_URL`, with
  `DATABASE_URL` accepted as a temporary legacy alias.

The highest-risk replacement work is not generic PostgreSQL compatibility. The
schema is mostly plain PostgreSQL. The risky pieces are the Supabase REST/Data
API assumptions, service-role key configuration, RLS role names, PostgREST
schema-cache reload, dashboard health labels, and docs that describe the
Supabase pooler as the primary database connection.

## Runtime Code Inventory

| Area | Current dependency | Classification | Follow-up owner |
| --- | --- | --- | --- |
| `apps/control-plane/src/supabase.rs` | `SupabaseMirror::from_env()` requires `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL`, or derives `SUPABASE_URL` from a Supabase-shaped `DATABASE_URL`. | Supabase-platform-specific | #243 |
| `apps/control-plane/src/supabase.rs` | Runtime writes use PostgREST paths under `/rest/v1/<table>` with `Prefer` headers and `on_conflict` query parameters. | Supabase Data API/PostgREST-specific | #243 |
| `apps/control-plane/src/supabase.rs` | Runtime restore fetches `devices`, `jobs`, `job_events`, and `credits_ledger` through PostgREST select/order queries. | Supabase Data API/PostgREST-specific | #243 |
| `apps/control-plane/src/supabase.rs` | Chat memory writes and reads use `chat_conversations` and `chat_messages` through PostgREST. | Supabase Data API/PostgREST-specific | #243 |
| `apps/control-plane/src/supabase.rs` | Missing-table fallback recognizes PostgREST error code `PGRST205`. | Supabase Data API/PostgREST-specific | #243 |
| `apps/control-plane/src/postgres_store.rs` | Runtime restore and mirror writes use plain SQL over the configured PostgreSQL/PgBouncer URL for nodes, jobs, heartbeats, job events, credits, and chat memory. | Managed PostgreSQL runtime path | #243 |
| `apps/control-plane/src/main.rs` | `StorageSource::Supabase`, `SupabaseSyncStatus`, `note_supabase_failure`, startup restore, route-level mirror writes, and `/health` fields are named around Supabase. | Runtime state and health naming | #242, #243 |
| `apps/control-plane/src/main.rs` | `/health` emits `storage_source`, `supabase`, and `supabase_sync`. `/v1/status` embeds `storage_source` through state snapshots. | Operator API contract | #242 |
| `apps/control-plane/src/state.rs` | `snapshot(storage_source)` stores the caller-provided storage source string; tests include `"supabase"` expectations. | Plain runtime state with storage label | #242, #246 |
| `apps/control-plane/src/contracts.rs` | `ControlPlaneSnapshot.storage_source` is a generic string field, not Supabase-specific. | Plain contract-compatible | #242 |
| `apps/control-plane/src/migrations.rs` | Uses `postgres`, `postgres-native-tls`, `schema_migrations`, and direct migration URLs. Reads canonical SQL from `db/schema.sql` and `db/migrations`, with legacy `supabase/` fallback. | Plain PostgreSQL-compatible migration flow | #244 |
| `apps/control-plane/Cargo.toml` | Already depends on `postgres` and `postgres-native-tls` for migrations. | Plain PostgreSQL-compatible | #244 |

## Schema And Migration Inventory

Canonical managed PostgreSQL migration files live under `db/`:

- `db/schema.sql`
- `db/migrations/0001_rls.sql`
- `db/migrations/0002_graph_credit_ledger.sql`
- `db/migrations/0002_job_execution_payload.sql`
- `db/migrations/0003_identity_trust_path.sql`
- `db/migrations/0004_sync_keys.sql`
- `db/migrations/0005_node_policy_overrides.sql`
- `db/migrations/0005_worker_health.sql`
- `db/migrations/0006_job_planning.sql`
- `db/migrations/0007_job_graphs.sql`
- `db/migrations/0008_repair_node_policy_columns.sql`
- `db/migrations/0009_reload_rest_schema_cache.sql`
- `db/migrations/0010_chat_conversations.sql`

Legacy Supabase migration files remain under `supabase/` during parity work:

- `supabase/schema.sql`
- `supabase/migrations/0001_rls.sql`
- `supabase/migrations/0002_graph_credit_ledger.sql`
- `supabase/migrations/0002_job_execution_payload.sql`
- `supabase/migrations/0003_identity_trust_path.sql`
- `supabase/migrations/0004_sync_keys.sql`
- `supabase/migrations/0005_node_policy_overrides.sql`
- `supabase/migrations/0005_worker_health.sql`
- `supabase/migrations/0006_job_planning.sql`
- `supabase/migrations/0007_job_graphs.sql`
- `supabase/migrations/0008_repair_node_policy_columns.sql`
- `supabase/migrations/0009_reload_rest_schema_cache.sql`
- `supabase/migrations/0010_chat_conversations.sql`

### Plain PostgreSQL Objects

These objects should port directly to managed PostgreSQL:

- `public.users`
- `public.devices`
- `public.heartbeats`
- `public.jobs`
- `public.job_events`
- `public.policy_rules`
- `public.credits_ledger`
- `public.chat_conversations`
- `public.chat_messages`
- `public.set_updated_at()`
- update triggers for devices, jobs, policy rules, and chat conversations
- indexes on heartbeat sync keys, job status, assigned nodes, job events,
  worker health, credits graph fields, and chat lookup fields
- `public.schema_migrations` created by `apps/control-plane/src/migrations.rs`

The schema uses ordinary PostgreSQL features: `pgcrypto`, JSONB, identity
columns, partial unique indexes, foreign keys, triggers, and timestamptz values.

### Supabase-Specific Or Platform-Specific Objects

| Object | Why it matters | Follow-up owner |
| --- | --- | --- |
| `supabase/` directory name and SQL comments | Operational naming still says Supabase even though most SQL is portable. | #244, #246 |
| `0001_rls.sql` roles `anon` and `authenticated` | These are Supabase/PostgREST role names. Managed PostgreSQL can keep RLS, but role ownership and grants must be redesigned. | #241, #244 |
| RLS posture | Tables enable RLS and revoke from `anon`/`authenticated`; there are intentionally no client-facing policies. Server access currently relies on Supabase service-role behavior. | #241, #244 |
| `0009_reload_rest_schema_cache.sql` | `notify pgrst, 'reload schema'` is PostgREST/Supabase schema-cache behavior. It should not run against a plain managed Postgres service unless PostgREST is intentionally deployed. | #244, #246 |

No current code path was found for Supabase Auth users, Supabase Storage,
Realtime subscriptions, Edge Functions, or browser-side Supabase clients.

## Data Flow Inventory

### Restore on startup

`SupabaseMirror::restore_state()` fetches:

- `devices?select=*`
- `jobs?select=*`
- `job_events?select=*&order=source_event_id.asc.nullslast,id.asc`
- `credits_ledger?select=*&order=created_at.asc`

It reconstructs `ControlPlaneState` from `NodeRecord`, `JobRecord`,
`JobEventRecord`, and `CreditsLedgerRecord`.

### Runtime writes

The mirror writes these records after in-memory state changes:

- registrations to `devices`
- node snapshots to `devices`
- heartbeats to `devices` and `heartbeats`
- jobs to `jobs`
- job completions to `jobs`
- credit awards to `credits_ledger`
- job events to `job_events`
- chat conversations and messages to `chat_conversations` and `chat_messages`

Most write calls depend on PostgREST upsert semantics using `Prefer` and
`on_conflict`. The plain Postgres backend must replace those calls with SQL
`insert ... on conflict` behavior behind the same runtime state boundary.

## Configuration Inventory

| Variable | Current meaning | Migration note |
| --- | --- | --- |
| `DATABASE_URL` | Documented as a Supabase Postgres pooler URL; used by migration code for direct SQL execution. | Split into direct migration/admin URL and pooled app URL in #241/#242. |
| `SUPABASE_SERVICE_ROLE_KEY` | Required by `SupabaseMirror` for PostgREST authorization. | Remove from primary runtime path when plain Postgres backend exists. |
| `SUPABASE_URL` | Optional PostgREST base URL; can be derived from Supabase-shaped `DATABASE_URL`. | Replace with managed database service health/config names. |
| `MUNDUSX_OPERATOR_TOKEN` | Operator API bearer token. | Not a Supabase dependency. |
| `MUNDUSX_ENVIRONMENT` | Auth guardrail environment. | Not a Supabase dependency. |
| `MUNDUSX_AUTH_DISABLED` | Local/UAT auth-disable flag. | Not a Supabase dependency. |
| `MUNDUSX_CONTROL_PLANE_HOST` and `PORT` | Server bind configuration. | Not a Supabase dependency. |

The managed migration path now uses `MUNDUSX_DATABASE_URL` for direct
PostgreSQL migrations/admin work, with `DATABASE_URL` retained as a temporary
legacy direct-connection alias. App traffic should use PgBouncer through
`MUNDUSX_DATABASE_POOL_URL`.

## Dashboard And Operator Surface Inventory

| Area | Current dependency | Follow-up owner |
| --- | --- | --- |
| `apps/dashboard/src/main.js` | Reads `health.supabase` and `health.storage_source`; colors storage green only when `storage_source === "supabase"`. | #242, #246 |
| `apps/dashboard/test/operator-dashboard.test.js` | Fixtures expect `storage_source: "supabase"` and `supabase: "enabled"`. | #242, #246 |
| `apps/dashboard/README.md` | Says the dashboard renders storage source and Supabase status. | #246 |
| Rust-served dashboard in `apps/control-plane/src/main.rs` | Labels UI pills and explanatory copy as `supabase`. | #242, #246 |
| `docs/operator-howto.md` | Says shared UAT should report `storage_source` as `supabase`. | #245, #246 |

## Docs Inventory

Supabase-specific documentation appears in:

- root `README.md`
- `apps/control-plane/README.md`
- `apps/dashboard/README.md`
- `docs/business-requirements.md`
- `docs/mundusx-computations-components-flow.md`
- `docs/operator-howto.md`

The docs should not be rewritten wholesale in this issue. The follow-up cleanup
issue should update them after config, storage, migration, and UAT parity work
has landed.

## Migration Checklist For Follow-up Issues

1. Define direct PostgreSQL and pooled PgBouncer URLs separately (#241).
2. Rename health/status fields or add generic database health fields before
   removing old `supabase` fields (#242).
3. Keep migrations on direct PostgreSQL and reject pooled URLs where practical
   (#244). Portable schema files now live under `db/`; `supabase/` is legacy
   compatibility during the migration.
4. Replace PostgREST mirror calls with SQL operations behind a plain Postgres
   backend (#243). The control plane now selects the Postgres backend first
   when managed database URLs are configured, while retaining Supabase as
   legacy fallback during parity work.
5. Decide whether to keep PostgreSQL RLS as defense in depth and create
   MundusX-owned roles/grants instead of Supabase `anon`/`authenticated` roles
   (#241/#244).
6. Keep `notify pgrst, 'reload schema'` only in the legacy Supabase copy;
   managed PostgreSQL migrations skip it because PostgREST is not part of the
   target service (#244/#246).
7. Validate UAT health/status, register, heartbeat, job submit, claim,
   complete/fail, polling, scheduler state, credits, and dashboard surfaces on
   the managed Postgres path (#245).
8. Remove stale Supabase docs, tests, UI labels, and config examples only after
   parity is proven (#246).

## Out Of Scope For This Inventory

- No database schema changes.
- No config variable changes.
- No route or health payload changes.
- No removal of Supabase code.
- No UAT deployment change.
