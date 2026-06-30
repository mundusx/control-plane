# MundusX Operator Repo

This private repository contains the company-owned operator surface for MundusX:

- `apps/control-plane/` - scheduler, routing, auth, and job management
- `apps/dashboard/` - operator web UI
- `supabase/` - company-side schema and migrations
- `tools/` - shared macOS identity helpers used by the operator surface

The public contributor-facing code lives in the separate open-source repo.

See the component READMEs for local development details:

- `apps/control-plane/README.md`
- `apps/dashboard/README.md`

For the complete cross-repo setup path from local control-plane startup to CLI/node-agent registration, job submission, dashboard verification, and active release-channel follow-ups, see `docs/operator-howto.md`.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | **Yes** | Port the server binds on (`0.0.0.0:PORT`). Must be set in production (Railway injects it but you must confirm it's present). Without it the server falls back to `127.0.0.1:8787` (loopback only). |
| `DATABASE_URL` | **Yes** | Supabase Postgres connection string. Used for migrations and state persistence. Find it in Supabase → Settings → Database → Connection string (use the pooler URI). |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase service role key. Find it in Supabase → Settings → API → `service_role`. |
| `SUPABASE_URL` | No | Supabase project URL (e.g. `https://xxx.supabase.co`). Derived automatically from `DATABASE_URL` if omitted. |
| `MUNDUSX_OPERATOR_TOKEN` | **Strongly recommended** | Bearer token protecting the dashboard (`/`), status, nodes, jobs, credits, and job-submit endpoints. If unset, those endpoints are publicly accessible with no authentication. |
| `OPENGPU_OPERATOR_TOKEN` | Deprecated | Legacy alias for `MUNDUSX_OPERATOR_TOKEN`. It still protects operator routes when the canonical variable is absent, but startup logs warn operators to rename it. |
| `MUNDUSX_ENVIRONMENT` | **Yes in shared deployments** | Environment classification for auth guardrails. Use `local`, `dev`, `development`, `test`, `uat`, or `production`. Defaults to `local` when unset for local development. |
| `MUNDUSX_AUTH_DISABLED` | Local/UAT only | Set to `true`, `1`, `yes`, or `on` to deliberately disable operator authentication even when `MUNDUSX_OPERATOR_TOKEN` is present. Startup rejects this flag unless `MUNDUSX_ENVIRONMENT` is `local`, `dev`, `development`, `test`, or `uat`. |
| `MUNDUSX_CONTROL_PLANE_HOST` | No | Override the bind host. Defaults to `0.0.0.0` when `PORT` is set. |

### Local `.env`

Create a `.env` file at the repo root (never commit it):

```
PORT=8787
DATABASE_URL=postgresql://postgres.your-ref:password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_URL=https://your-ref.supabase.co
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
   You can do this as a Railway one-off job or from a local machine with `DATABASE_URL` set.
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
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completion (queued, non-streaming) |

Operator auth is enforced when `MUNDUSX_OPERATOR_TOKEN` is set and `MUNDUSX_AUTH_DISABLED` is not enabled. The legacy `OPENGPU_OPERATOR_TOKEN` name is accepted only as a deprecated fallback so old deployments fail closed instead of accidentally opening operator routes. `/health` includes `environment`, `operator_auth_enforced`, and `operator_auth_mode` so local/UAT smoke tests can verify the effective mode before submitting work.

---

## Known gaps

- **No `GET /v1/jobs/:id`** — after submitting a job or chat completion you get a `job_id` back, but there is no endpoint yet to poll individual job status or retrieve the result.
- **Streaming not supported** — `POST /v1/chat/completions` with `"stream": true` returns `400`.
- **`operatorAuth: disabled (MUNDUSX_AUTH_DISABLED=true)`** in logs means operator endpoints are deliberately open for local/UAT smoke tests. Startup rejects this setting when `MUNDUSX_ENVIRONMENT` is `production` or another non-local environment.
- **`operatorAuth: disabled (MUNDUSX_OPERATOR_TOKEN missing)`** in logs means operator endpoints are open because no token was configured.
- **`operatorAuth warning: OPENGPU_OPERATOR_TOKEN is deprecated`** in logs means the process is using the old token alias and should be renamed to `MUNDUSX_OPERATOR_TOKEN`.
