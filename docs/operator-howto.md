# MundusX CLI And Control-Plane Operator How-To

This guide is the cross-repo path for maintainers who need to bring up a local or UAT MundusX loop from a clean machine. It separates commands that run in the CLI repository from commands that run in the private control-plane repository.

## Repository Map

| Area | Repository | Use |
|---|---|---|
| CLI, installer, node agent, model/runtime checks | `mundusx/mundusx` | Contributor-facing commands such as `opengpu install`, `opengpu doctor`, `opengpu-agent run`, and `opengpu jobs wait`. |
| Control plane, dashboard, state, operator auth | `mundusx/control-plane` | Private operator service, dashboard, Supabase persistence, node/job APIs, and UAT deployment configuration. |

Do not edit generated release assets or local runtime state to make a smoke pass. Fix the source repo that owns the failing behavior.

## 1. Prepare The Control Plane

Run these commands in `mundusx/control-plane`.

```powershell
git switch uat
git pull --ff-only origin uat
```

Create a local `.env` for private operator testing:

```dotenv
PORT=8787
MUNDUSX_ENVIRONMENT=local
MUNDUSX_OPERATOR_TOKEN=replace-with-a-local-secret
# Local or UAT smoke only:
# MUNDUSX_AUTH_DISABLED=true
```

For shared UAT, keep `MUNDUSX_ENVIRONMENT=uat`. For production, use `MUNDUSX_ENVIRONMENT=production` and never set `MUNDUSX_AUTH_DISABLED=true`; startup rejects auth-disabled production mode.

Start the service:

```powershell
cargo run -p opengpu-control-plane
```

Verify the operator auth mode before submitting work:

```powershell
curl.exe http://127.0.0.1:8787/health
```

Expected local/UAT no-auth smoke signal:

```json
{
  "operator_auth_enforced": false,
  "operator_auth_mode": "explicitly-disabled",
  "environment": "local"
}
```

Expected protected local/UAT signal:

```json
{
  "operator_auth_enforced": true,
  "operator_auth_mode": "enforced"
}
```

## 2. Prepare The CLI And Node Agent

Run these commands in `mundusx/mundusx`.

```powershell
git switch uat
git pull --ff-only origin uat
cargo build --workspace
```

Install or configure the CLI for the local control plane:

```powershell
opengpu config set control-plane-url http://127.0.0.1:8787
opengpu login
opengpu doctor
```

When `MUNDUSX_AUTH_DISABLED=true` is active for local/UAT smoke, `opengpu login` is optional for operator routes. When auth is enforced, store the same value as `MUNDUSX_OPERATOR_TOKEN`. On Windows, operator tokens are protected with DPAPI outside `config.json`.

Prepare the contributor runtime and model:

```powershell
opengpu install
opengpu model list
opengpu model use HuggingFaceTB/SmolLM2-135M-Instruct
opengpu doctor
```

For CUDA hosts, confirm trusted runtime paths and driver health before allowing jobs:

```powershell
opengpu-agent health
```

`policyAllowed: no` is a stop signal. Fix the reported runtime, model, cap, power, or trusted-path issue before submitting jobs.

## 3. Start The Operator Dashboard

Run these commands in `mundusx/control-plane/apps/dashboard`.

```powershell
npm install
$env:OPENGPU_CONTROL_PLANE_URL="http://127.0.0.1:8787"
$env:PORT="3001"
npm run dev
```

Use these pages for operator workflows:

| Page | Purpose |
|---|---|
| `http://127.0.0.1:3001/` | Read-only command deck for fleet health, routing pressure, jobs, credits, and sync state. |
| `http://127.0.0.1:3001/portal/jobs` | Human-readable completed job history with search and pagination. |
| `http://127.0.0.1:3001/docs` | Local docs preview for install, identity, onboarding, credits, and releases. |
| `http://127.0.0.1:3001/install` | Local install-page preview backed by `install.json`. |

Use JSON endpoints for diagnostics and scripts, not primary operator navigation:

| Endpoint | Purpose |
|---|---|
| `/health` | Lightweight deployment, storage, environment, and auth-mode check. |
| `/v1/status` | Full state snapshot for automation and debugging. |
| `/v1/nodes` | Registered node list. |
| `/v1/jobs` | Job list. |
| `/v1/jobs/:id` | Individual job status and output polling. |
| `/v1/job-events` | Append-only event stream. |
| `/v1/credits` | Credit ledger. |

## 4. Run A Local/UAT No-Auth Smoke

The preferred smoke path is the CLI repo script because it exercises both repositories together.

Run this in `mundusx/mundusx` with the sibling control-plane checkout at `../control-plane`:

```bash
./scripts/no-auth-e2e-smoke.sh
```

The script starts the control plane with `MUNDUSX_AUTH_DISABLED=true`, confirms `/health` reports `operator_auth_enforced=false`, seeds an isolated `OPENGPU_HOME`, registers and heartbeats a signed node, submits a job, lets the node agent claim and complete it, and polls the result with:

```bash
opengpu jobs wait <job_id> --timeout 20 --interval 1 --json
```

For a manual smoke, use this sequence:

```powershell
opengpu-agent run --once
opengpu jobs submit --model HuggingFaceTB/SmolLM2-135M-Instruct --prompt "Return the word ready" --json
opengpu-agent run --once
opengpu jobs status <job_id> --json
opengpu jobs wait <job_id> --timeout 300 --interval 2 --json
```

Pass criteria:

- `/health` shows the intended environment and auth mode before work is submitted.
- The node registration appears in the dashboard and `/v1/nodes`.
- The heartbeat reports `runtime_ready=true` and a compatible backend.
- `opengpu jobs submit` returns a queued job id.
- The agent claims and completes the job.
- `opengpu jobs wait` reaches `completed` or returns a clear terminal failure.

## 5. UAT Deployment Checks

Before declaring UAT ready, verify the deployed control plane rather than only local state:

```powershell
curl.exe https://uat.mundusx.ai/health
curl.exe https://uat.mundusx.ai/v1/status -H "Authorization: Bearer <MUNDUSX_OPERATOR_TOKEN>"
```

Confirm:

- Railway deploys from `uat`.
- `/health` returns 200.
- `/health` or `/v1/status` reports the expected deploy fingerprint for the current `uat` commit.
- `storage_source` is `postgres` for shared UAT after the managed Postgres migration.
- `storage_source=local-json-fallback`, `supabase_sync.degraded=true`, or an unconfigured
  runtime pool is a failed shared-UAT storage check, even when `/health` returns 200.
- `database.runtime_pool.configured=true` confirms application traffic is using the
  PgBouncer path; migrations and admin work continue to use the direct URL.
- Operator auth is enforced unless the environment is deliberately in a local/UAT smoke window.

## 6. Active Follow-Up Issues

Keep the how-to operational and link to active release/distribution work instead of restating it as finished:

| Issue | Why It Remains Active |
|---|---|
| `mundusx/mundusx#73` | Windows CLI release asset for `install.ps1`. |
| `mundusx/mundusx#110` | Homebrew channel publishing. |
| `mundusx/mundusx#111` | WinGet package publishing. |
| `mundusx/mundusx#113` | Protected Linux device identity storage. |
| `mundusx/mundusx#114` | macOS non-exportable identity enforcement policy. |

Closed Windows DPAPI identity, protected operator-token storage, strict installer verification, and release-signing fixes should stay described as shipped controls. Do not recreate duplicate issues for those completed items during board audits.
