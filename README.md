![MundusX decentralized compute control-plane mesh banner](media/banner.png)

# Operator Control Plane Repo

This private repository contains the operator-owned control-plane surface:

- `apps/control-plane/` - scheduler, routing, auth, and job management
- `apps/dashboard/` - operator web UI
- `db/` - managed PostgreSQL schema and portable migrations
- `supabase/` - legacy Supabase schema and migrations retained during migration
- `tools/` - shared macOS identity helpers used by the operator surface

The public contributor-facing code lives in the separate open-source repo.

See the component READMEs for local development details:

- `apps/control-plane/README.md`
- `apps/dashboard/README.md`

For the complete cross-repo setup path from local control-plane startup to CLI/node-agent registration, job submission, dashboard verification, and active release-channel follow-ups, see `docs/operator-howto.md`.

Versioned execution contracts:

- `docs/capability-fabric-v1-contract.md` defines node eligibility, routing, and reservation authority.
- `docs/coding-harness-v1-contract.md` defines isolated repository execution, tools, validation, evidence, and approval boundaries.

---

## Environment variables

### Control-plane administrator login

Set `MUNDUSX_ADMIN_LOGIN_ENABLED=true` on the control-plane service to enable Google admin login. All dashboard views and operational read APIs remain public; edits, admission-policy changes, node blocking/contribution changes, and operator actions require an admin session or server-side operator credential. Normal inference submission and signed worker job polling/completion remain available. Set `MUNDUSX_ADMIN_EMAILS` to a comma-separated list of approved Google email addresses. An empty list denies all browser administrators; removing an address revokes its existing sessions on their next request.

Set the same random secret (at least 32 characters) as `MUNDUSX_ADMIN_SSO_SECRET` on both Chat and the control plane. The control plane uses `MUNDUSX_ADMIN_PUBLIC_ORIGIN` (default `https://mundusx.ai`) and `MUNDUSX_ADMIN_CHAT_ORIGIN` (default `https://chat.mundusx.ai`); Chat's `MUNDUSX_CONTROL_PLANE_URL` must match the public origin exactly. Origins must use HTTPS. Chat reuses its existing Google callback, so no new Google callback URL is needed.

The browser receives an opaque Secure/HttpOnly cookie, never an operator token. Admin sessions expire after eight hours, are revoked on logout, and are held in process memory (a control-plane restart requires sign-in again; use one control-plane replica). Cookie-authenticated writes require a matching Origin. Public pages show read-only forms and an Admin sign-in link. Existing operator bearer tokens and verified device polling remain supported. `MUNDUSX_AUTH_DISABLED` does not bypass the administrative-write gate when admin login is enabled. Conversation storage and internal harness APIs retain their existing service authentication.

| Variable | Required | Description |
|---|---|---|
| `PORT` | **Yes** | Port the server binds on (`0.0.0.0:PORT`). Must be set in production (Railway injects it but you must confirm it's present). Without it the server falls back to `127.0.0.1:8787` (loopback only). |
| `MUNDUSX_DATABASE_URL` | Managed database mode | Direct PostgreSQL URL for migrations, schema checks, admin repair, and backup/restore tooling. Do not point this at PgBouncer. |
| `MUNDUSX_DATABASE_POOL_URL` | Managed database mode | PgBouncer pooled runtime URL for control-plane application traffic. Do not use this for migrations. |
| `MUNDUSX_DATABASE_POOL_MODE` | No | Expected PgBouncer mode for health/status reporting. Defaults to `transaction`. |
| `MUNDUSX_DATABASE_TLS_MODE` | No | Expected database TLS mode for health/status reporting. Defaults to `require`. |
| `DATABASE_URL` | Legacy compatibility only | Temporary direct PostgreSQL migration alias accepted when `MUNDUSX_DATABASE_URL` is absent. Do not set it to the PgBouncer pool URL. |
| `MUNDUSX_ENABLE_LEGACY_SUPABASE` | No | Explicit rollback-only switch for the legacy Supabase/PostgREST runtime (`true`, `1`, `yes`, or `on`). Old Supabase variables alone no longer select this backend. |
| `SUPABASE_SERVICE_ROLE_KEY` | Legacy Supabase mode only | Supabase service role key. Find it in Supabase -> Settings -> API -> `service_role`. |
| `SUPABASE_URL` | Legacy Supabase mode only | Supabase project URL (e.g. `https://xxx.supabase.co`). Derived automatically from `DATABASE_URL` if omitted. |
| `MUNDUSX_OPERATOR_TOKEN` | **Strongly recommended** | Bearer token protecting the dashboard (`/`), status, nodes, jobs, credits, and job-submit endpoints. If unset, those endpoints are publicly accessible with no authentication. |
| `OPENGPU_OPERATOR_TOKEN` | Deprecated | Legacy alias for `MUNDUSX_OPERATOR_TOKEN`. It still protects operator routes when the canonical variable is absent, but startup logs warn operators to rename it. |
| `MUNDUSX_ENVIRONMENT` | **Yes in shared deployments** | Environment classification for auth guardrails. Use `local`, `dev`, `development`, `test`, `uat`, or `production`. Defaults to `local` when unset for local development. |
| `MUNDUSX_AUTH_DISABLED` | Local/UAT only | Set to `true`, `1`, `yes`, or `on` to deliberately disable operator authentication even when `MUNDUSX_OPERATOR_TOKEN` is present. Startup rejects this flag unless `MUNDUSX_ENVIRONMENT` is `local`, `dev`, `development`, `test`, or `uat`. |
| `MUNDUSX_CONTROL_PLANE_HOST` | No | Override the bind host. Defaults to `0.0.0.0` when `PORT` is set. |
| `MUNDUSX_CHAT_MAX_ACTIVE_REQUESTS` | No | Maximum admitted parent OpenAI chat requests. Defaults to 7 and is bounded to 1–64. Additional streaming requests wait FIFO with SSE keep-alives before graph planning; non-streaming requests receive `429` plus `Retry-After` so an intermediary cannot abandon a silent queued connection. |
| `MUNDUSX_CHAT_TIMEOUT_SECONDS` | No | Maximum synchronous OpenAI chat execution wait after parent admission. Defaults to 600 seconds and is bounded to 5–900 seconds. |
| `MUNDUSX_WEATHER_URL` | No | Weather-tool origin. Defaults to `https://wttr.in`; override only with a compatible trusted endpoint. |

Sports research is handled by the Hermes harness using its available search and browser tools. The gateway does not require a sports-provider key or replace harness tool results with a provider-specific sports answer.

### Local `.env`

Create a `.env` file at the repo root (never commit it):

```
PORT=8787
MUNDUSX_DATABASE_URL=postgresql://migration-user:password@postgres.example.com:5432/mundusx
MUNDUSX_DATABASE_POOL_URL=postgresql://app-user:password@pgbouncer.example.com:6432/mundusx
MUNDUSX_DATABASE_POOL_MODE=transaction
MUNDUSX_DATABASE_TLS_MODE=require
# Legacy Supabase mirror mode during migration:
# MUNDUSX_ENABLE_LEGACY_SUPABASE=true
# DATABASE_URL=postgresql://postgres.your-ref:password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
# SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
# SUPABASE_URL=https://your-ref.supabase.co
MUNDUSX_OPERATOR_TOKEN=a-strong-random-secret
MUNDUSX_ENVIRONMENT=local
# Local/UAT smoke tests only:
# MUNDUSX_AUTH_DISABLED=true
```

---

## Railway deployment

1. Set all variables above in Railway → **Variables**.
2. Confirm **Networking → Public Networking** is enabled and the target port matches `PORT`.
3. Run database migrations once before (or on) first deploy:
   ```
   ./control-plane migrate
   ```
   Run this with `MUNDUSX_DATABASE_URL` set to the direct PostgreSQL URL. The
   command refuses a URL that matches `MUNDUSX_DATABASE_POOL_URL`; migrations
   must not run through PgBouncer. `DATABASE_URL` remains a temporary legacy
   direct-connection alias during the Supabase migration.
4. The normal start command is just the binary with no arguments: `./control-plane`.

---

## API endpoints

### Node / agent endpoints (require valid device signature)

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/register` | Register a new node |
| `POST` | `/v1/heartbeat` | Send a heartbeat |
| `GET` | `/v1/jobs/next?node_id=...` | Claim next available job |
| `POST` | `/v1/jobs/complete` | Mark a job completed or failed |

### Operator endpoints

These endpoints require `Authorization: Bearer <MUNDUSX_OPERATOR_TOKEN>` when operator auth is enforced. Auth is enforced when `MUNDUSX_OPERATOR_TOKEN` or the deprecated `OPENGPU_OPERATOR_TOKEN` is set and `MUNDUSX_AUTH_DISABLED` is not enabled. `MUNDUSX_AUTH_DISABLED` is rejected at startup outside local/dev/test/UAT environments.

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Dashboard UI |
| `GET` | `/health` | Health check + sync status (JSON) |
| `GET` | `/v1/status` | Full state snapshot (JSON) |
| `GET` | `/v1/nodes` | Node list (JSON) |
| `GET` | `/v1/jobs` | Job list (JSON) |
| `GET` | `/v1/job-events` | Job event log (JSON) |
| `GET` | `/v1/credits` | Credits ledger (JSON) |
| `POST` | `/v1/jobs` | Submit a job |

Operator auth is enforced when `MUNDUSX_OPERATOR_TOKEN` is set and `MUNDUSX_AUTH_DISABLED` is not enabled. The legacy `OPENGPU_OPERATOR_TOKEN` name is accepted only as a deprecated fallback so old deployments fail closed instead of accidentally opening operator routes. `/health` includes `environment`, `operator_auth_enforced`, and `operator_auth_mode` so local/UAT smoke tests can verify the effective mode before submitting work.

### Public OpenAI-compatible gateway

These unauthenticated routes are the stable client boundary for Open WebUI, Hermes, and other OpenAI-compatible clients, matching the former browser-chat contract that accepts `not-required` when a client insists on an API-key value. Virtual model IDs never pin a physical contributor model; the planner and scheduler retain routing authority.

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/models` | Discover `mundusx-agnostic` in UAT or `ehda-agnostic` in Benz EHDA |
| `POST` | `/v1/chat/completions` | Wait for validated output and return a completed OpenAI response |

`stream: true` returns OpenAI-compatible SSE with a role chunk, content chunks, a terminal chunk, and `[DONE]`. Eligible ordinary text requests automatically use authenticated live worker deltas when a healthy streaming-capable node is available and advertise `X-MundusX-Stream-Mode: live-delta`; tools, structured modes, and unsupported nodes retain `validated-buffered` delivery. The OpenAI-compatible endpoint leaves search and other tool execution to the calling client. It forwards supplied tool definitions and tool results to inference without intercepting current-information prompts. Clients must configure their own search tools and must not represent model-only answers as verified live research. Website Chat uses Wikipedia/Wikidata for encyclopedic facts and delegates broader current-web research to the connected local Hermes crawler.

---

## Known gaps

- **Hybrid validated streaming** — eligible ordinary text can relay live deltas in UAT; structured and tool output remains buffered until validation succeeds.
- **`operatorAuth: disabled (MUNDUSX_AUTH_DISABLED=true)`** in logs means operator endpoints are deliberately open for local/UAT smoke tests. Startup rejects this setting when `MUNDUSX_ENVIRONMENT` is `production` or another non-local environment.
- **`operatorAuth: disabled (MUNDUSX_OPERATOR_TOKEN missing)`** in logs means operator endpoints are open because no token was configured.
- **`operatorAuth warning: OPENGPU_OPERATOR_TOKEN is deprecated`** in logs means the process is using the old token alias and should be renamed to `MUNDUSX_OPERATOR_TOKEN`.
