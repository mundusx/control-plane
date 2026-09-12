# MundusX Chat

Legacy standalone chat surface. The OpenAI-compatible adapter and live-weather route now live in the control plane so clients can use one API origin.

This service powers the canonical MundusX browser chat at `https://chat.mundusx.ai`.

## Run locally

```powershell
$env:MUNDUSX_CONTROL_PLANE_URL = "https://uat.mundusx.ai"
$env:PORT = "3002"
pnpm --filter @mundusx/chat dev
```

Open `http://127.0.0.1:3002`.

## Railway

Deploy this as a separate Railway service from the control-plane monorepo.

Recommended Railway settings:

| Setting | Value |
| --- | --- |
| Root Directory | `apps/chat` |
| Build Command | empty / Railway default |
| Start Command | `pnpm start` |
| Healthcheck Path | `/health` |

Required environment:

```text
MUNDUSX_CONTROL_PLANE_URL=https://uat.mundusx.ai
```

Optional environment:

```text
MUNDUSX_OPERATOR_TOKEN=<only if the target control plane requires auth>
MUNDUSX_CHAT_MODEL=<optional explicit model override>
MUNDUSX_CHAT_TIMEOUT_SECONDS=90
MUNDUSX_WEATHER_CACHE_URL=<optional redis://, rediss://, valkey://, or valkeys:// URL>
MUNDUSX_FACTUAL_SUMMARY_URL=<optional factual summary API origin>
MUNDUSX_WIKIDATA_ENTITY_URL=<optional Wikidata entity API origin>
```

MundusX Chat uses per-user PostgreSQL sessions by default. Run migrations through
`0028_google_identity.sql`,
configure at least one login provider, and keep the database and provider secrets server-side:

```text
MUNDUSX_CHAT_AUTH_REQUIRED=true
MUNDUSX_DATABASE_POOL_URL=<PgBouncer DATABASE_URL reference>
MUNDUSX_PUBLIC_ORIGIN=https://chat.mundusx.ai
MUNDUSX_GITHUB_CLIENT_ID=<GitHub App client id>
MUNDUSX_GITHUB_CLIENT_SECRET=<GitHub App client secret>
MUNDUSX_GOOGLE_CLIENT_ID=<Google OAuth web client id>
MUNDUSX_GOOGLE_CLIENT_SECRET=<Google OAuth web client secret>
MUNDUSX_AUTH_ENCRYPTION_KEY=<base64-encoded 32-byte key>
RESEND_API_KEY=<optional, enables verified-email links>
MUNDUSX_AUTH_EMAIL_FROM=MundusX <login@your-verified-domain.example>
```

GitHub is optional for creating and testing local projects. When import or publication is enabled,
the GitHub App callback is `${MUNDUSX_PUBLIC_ORIGIN}/api/auth/github/callback`. Configure the App
with account permission `Email addresses: read`, repository permission `Contents: read`, and
repository permission `Administration: read and write`. The Administration permission lets an
authenticated user explicitly create a repository in their own account; it does not create a
MundusX-owned repository. Install the App for all repositories if newly created repositories must
be immediately available to the Harness. MundusX Chat
uses the App's user-to-server token so repository visibility is restricted by both the installation
and the signed-in user's current GitHub rights. Tokens are encrypted at rest and never returned to
the browser. New Projects are local-first; publication creates a private repository by default.
Imported repositories derive a policy from safe top-level paths. MundusX Chat then pins the
current default-branch commit. A
browser cannot choose its own tenant, unverified repository, validation command, or base revision.

Google login uses the web-server OAuth flow with state and PKCE and requests only `openid email
profile`. Configure its exact authorized redirect URI as
`${MUNDUSX_PUBLIC_ORIGIN}/api/auth/google/callback`. The verified Google subject is linked to the
internal MundusX user; Google access and refresh tokens are not stored.

The local-first **Projects** workspace is disabled by default. To expose it,
provide the server-side Harness token and runner download page:

```text
MUNDUSX_HARNESS_UI_ENABLED=true
MUNDUSX_HARNESS_SERVICE_TOKEN=<same secret configured on the control plane>
MUNDUSX_MCP_ENABLED=true
MUNDUSX_HARNESS_RUNNER_DOWNLOAD_URL=https://downloads.mundusx.ai/prod/latest/mundusx-harness-setup-windows-x86_64.exe
```

The stable `/prod/latest/<asset>` channel is an allowlisted redirect to the latest signed binary in
the public `mundusx/releases` repository. Attach `downloads.mundusx.ai` to this Railway service
before setting the variable; the built-in fallback remains the canonical GitHub Releases URL.

Chat users can submit only a local project, path, validation, mode, and tool boundary granted to their
internal user id. A submitted
task remains in `created` state until an operator separately approves UAT execution in EHDA. Users
connect their local runner through a browser-approved, one-use, ten-minute bootstrap session; no
user UUID, GitHub token, raw bootstrap secret, or approval token is stored. The approval token stays
in the URL fragment so it is not sent in HTTP request URLs. The launcher cannot approve merge or deployment.

The **Projects** panel exposes one **Connect this computer** action only when local work is first
requested. The lightweight installer creates an OS-protected signing identity, opens one browser
approval, configures per-user background startup, and starts the runner. Chat polls runner
heartbeats and automatically resumes the original coding request after connection. Browser restarts
do not require pairing again; manual one-time pairing remains available only for compatibility.
GitHub CLI authentication is optional until the user asks to publish. The
optional publication commands are `gh auth login --hostname github.com --git-protocol https --web`
and `gh auth setup-git`; MundusX Chat never provides a token input. Pairing does not require GitHub.
The runner is a native Rust executable, not a project technology stack. It uses Git for workspace
isolation and repository validation; Java tasks additionally use Maven when Maven is installed.
Project technology is inferred from the coding request in chat rather than selected during creation.
New projects use lowercase slugs and live
under `documents/mundusx/projects/<slug>` on the user's device.
Creation asks only for the local project identity and does not require a runner or create a Harness
task. Planning and ordinary project chat work immediately. When the user first requests an explicit
local action such as creating or editing files, running tests, building, installing, or committing,
MundusX Chat checks runner readiness and reveals one-time setup only when needed. With a ready runner,
those local-action messages become bounded Harness tasks for the active project.
The composer Project control lists the authenticated user's runner-reported local projects, marks
the active project, switches context, creates a new project, or returns to unscoped chat. A bounded
per-user browser-local recent list keeps previously selected names usable while the runner is
temporarily offline; the runner inventory remains the authoritative on-device source.

Railway provides `PORT`; the app reads it automatically.

## Environment

| Name | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port for the chat app |
| `MUNDUSX_CONTROL_PLANE_URL` | `https://uat.mundusx.ai` | UAT control-plane API origin |
| `MUNDUSX_OPERATOR_TOKEN` | unset | Optional bearer token for protected UAT/API deployments |
| `OPENGPU_OPERATOR_TOKEN` | unset | Deprecated fallback token name |
| `MUNDUSX_CHAT_AUTH_REQUIRED` | `true` | Requires an active individual session for browser `/api/*` routes; fail-closed when storage is unavailable |
| `MUNDUSX_DATABASE_POOL_URL` | unset | PgBouncer runtime URL used for identity, session, conversation-owner, and grant checks |
| `MUNDUSX_PUBLIC_ORIGIN` | `https://chat.mundusx.ai` | Exact browser origin and OAuth callback base; also enforced for CSRF checks |
| `MUNDUSX_GITHUB_CLIENT_ID` | unset | Enables GitHub App user authorization when paired with its secret |
| `MUNDUSX_GITHUB_CLIENT_SECRET` | unset | Server-only GitHub App client secret |
| `MUNDUSX_GOOGLE_CLIENT_ID` | unset | Enables Google login when paired with its client secret |
| `MUNDUSX_GOOGLE_CLIENT_SECRET` | unset | Server-only Google OAuth web client secret |
| `MUNDUSX_AUTH_ENCRYPTION_KEY` | unset | Base64-encoded 32-byte AES key required to encrypt GitHub user/refresh tokens at rest |
| `RESEND_API_KEY` | unset | Enables verified-email single-use login links when paired with a sender |
| `MUNDUSX_AUTH_EMAIL_FROM` | unset | Verified sender used for sign-in links |
| `MUNDUSX_CHAT_MODEL` | unset | Optional explicit model override; unset means control-plane routed contributor models |
| `MUNDUSX_CHAT_DEFAULT_MODEL` | unset | Deprecated alias for `MUNDUSX_CHAT_MODEL` |
| `MUNDUSX_CHAT_TIMEOUT_SECONDS` | `90` | Default server-side poll timeout for one chat turn |
| `MUNDUSX_WEATHER_URL` | `https://wttr.in` | Weather API origin for direct weather answers |
| `MUNDUSX_WEATHER_CACHE_URL` | unset | Optional Redis/Valkey URL for weather response caching |
| `VALKEY_URL` | unset | Fallback cache URL when `MUNDUSX_WEATHER_CACHE_URL` is unset |
| `REDIS_URL` | unset | Fallback cache URL when `MUNDUSX_WEATHER_CACHE_URL` and `VALKEY_URL` are unset |
| `MUNDUSX_WEATHER_TTL_SECONDS` | `7200` | Weather cache TTL; default is 2 hours |
| `MUNDUSX_FACTUAL_SUMMARY_URL` | `https://en.wikipedia.org/api/rest_v1/page/summary` | Factual summary API used before LLM jobs for obvious history/who/what questions |
| `MUNDUSX_WIKIDATA_ENTITY_URL` | `https://www.wikidata.org/wiki/Special:EntityData` | Wikidata entity API used for current office-holder questions |
| `MUNDUSX_HARNESS_UI_ENABLED` | `false` | Exposes user-owned local-first Projects and inline runner setup when set to `true` |
| `MUNDUSX_HARNESS_SERVICE_TOKEN` | unset | Server-only token used to submit Harness tasks to the control plane |
| `MUNDUSX_MCP_ENABLED` | `false` | Exposes the user-scoped Streamable HTTP Harness MCP endpoint and MundusX Chat connection manager |
| `MUNDUSX_HARNESS_RUNNER_DOWNLOAD_URL` | Windows one-click runner setup asset | Optional override for the user-owned runner installer shown during one-time setup |

## Current Flow

Runtime assistant skills start from application configuration under `apps/chat/skills/`.
`manifest.json` defines the global catalog and each Markdown file supplies its deployed
default. `/skills` requires an authenticated account. Normal users see global metadata
read-only and can create, edit, enable, disable, or delete only their own PostgreSQL-backed
personal skills. Personal skills are selected only for that user's chat requests and follow
the same validation, size, and secret-rejection rules as global skills.

Users with the `admin`, `platform_admin`, or `super_admin` role can update a global catalog
entry. The database override is versioned and takes effect for authenticated chat requests;
non-administrators never receive the private global Markdown. All writes require the existing
same-origin CSRF protection. Global safety and authorization policy remains outside this
custom-skill layer and cannot be replaced by a personal skill.

1. Browser posts a user message to `POST /api/chat/jobs`.
2. Simple polynomial indefinite integrals are answered directly through the math tool.
3. Obvious weather questions are answered directly through `wttr.in`; if Redis/Valkey is configured the response is cached for 2 hours.
4. Current office-holder questions such as "current president of USA" are answered through Wikidata before using local LLM jobs.
5. Obvious factual history/who/what questions are answered from the factual summary source before using local LLM jobs.
6. The browser detects explicit or time-sensitive current-web requests and sends them to Hermes on the user's connected computer. Hermes uses its browser/search tools and returns source URLs through the local-agent task stream.
7. If Hermes is unavailable, Chat does not send a current-web request to a model as if it were verified. It asks the user to connect the local crawler; Wikipedia and Wikidata remain available for encyclopedic facts.
8. Other requests are submitted as routed MundusX jobs to `POST /v1/jobs` with `execution_mode=auto`.
9. Control plane decides whether the request is single-job or decomposed across graph chunks.
10. Browser streams live worker deltas when available and falls back to polling `GET /api/chat/jobs/:id` when needed.
11. Completed output and graph progress are returned to the browser.

Ordinary model answers use live streaming when the assigned worker supports it. Hermes crawler tasks use the local-agent task stream.

## Legacy Hermes / OpenAI-Compatible Adapter

New integrations should use the control plane directly:

```text
UAT base URL: https://uat.mundusx.ai/v1
Chat completions: POST /chat/completions
Models: GET /models
Model: mundusx-agnostic (model-agnostic interface over heterogeneous routing)
API key: use `not-required` if the client requires a value
Streaming: accepted as buffered SSE after final validation
```

Example:

```bash
curl https://uat.mundusx.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mundusx-agnostic","messages":[{"role":"user","content":"What is the weather in Warsaw?"}]}'
```

`GET /models` intentionally exposes only `mundusx-agnostic`. It is a stable model-agnostic service
identity, not a physical model. Behind it, the heterogeneous MundusX network lets the planner
privately choose the best eligible contributor node,
runtime, and model for every request. Requested model names, selected physical models, and node
identities are not exposed through the Hermes adapter.

The control-plane gateway preserves prior `messages` as model context, handles live weather through its internal tool module, waits internally for planner-owned MundusX jobs, and returns the validated answer in `choices[0].message.content`.

For Open WebUI, go to **Admin Settings → Connections → OpenAI → Add Connection** and use:

```text
Connection type: External / OpenAI-compatible
URL: https://uat.mundusx.ai/v1
API key: not-required
Model IDs filter: leave empty (auto-discovers mundusx-agnostic)
```

The control plane accepts Open WebUI's default `stream=true`. When a streaming-capable node is available, ordinary text is automatically relayed as live OpenAI-compatible SSE. Structured modes and tool responses remain validated-buffered, and every stream ends with `[DONE]`.

## Local MundusX agent

Chat automatically prefers a connected local MundusX agent for ordinary turns
and falls back to the Control Plane when no connector is online. Apply migration
`0026_local_agent_bridge.sql`, create a token under Account > MCP connections,
and run `mundusx connect --workspace .`. See
`docs/mundusx-local-agent-bridge.md` for the security and protocol contract.
