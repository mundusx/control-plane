# Control Plane

Private Rust HTTP control plane for node registration, heartbeat ingestion, and live node snapshots.

This subtree is company-owned and governed by the repo-level [LICENSE](../../LICENSE).

The control-plane API and state model live in the source itself, the operator README at the repo root, and the cross-repo operator how-to in `docs/operator-howto.md`.

## Runtime Negotiation Contract

Apple Silicon job routing now uses an explicit runtime contract between submitted jobs and node heartbeats.

- Jobs declare `runtime_mode` and `stream` alongside the existing backend preference.
- Heartbeats report `runtime_ready`, `supported_runtime_modes`, `streaming_supported`, `model_dir`, and `model_path`.
- The control plane only assigns a queued job when the node backend matches and the latest worker capability report explicitly supports that job's runtime requirements.
- Chat completions are queued as `interactive` jobs. Eligible `stream:true` requests automatically use the signed live-delta relay when a streaming-capable node is available; otherwise they retain validated-buffered SSE.
- Request classification now emits weighted `capability_requirements` on a 0-100 scale. The planner can override them globally or per step, while the scheduler retains exact model selection using live free slots and health.
- Model inventory entries may advertise evidence-backed `capability_scores` (`capability`, `score`, `confidence`, and `sample_count`). Legacy `task_capabilities` remain supported with conservative compatibility scoring.

## Planner Service Status

The control plane can report whether an optional stateless planner service is configured and reachable. The Rust control plane remains the source of truth for job state, retries, scheduling, audit, and database persistence. Managed Postgres is selected when `MUNDUSX_DATABASE_POOL_URL` or `MUNDUSX_DATABASE_URL` is configured; the Supabase mirror remains a legacy fallback during migration.

- Configure with `MUNDUSX_PLANNER_URL=http://127.0.0.1:8091/v1/plan`.
- Tune the call timeout with `MUNDUSX_PLANNER_TIMEOUT_MS`; the default is `1500`.
- Operators can inspect live planner integration at `GET /v1/planner/status`; the dashboard shows whether the planner is disabled, reachable, degraded, or using Rust fallback mode.
- Reducer and synthesizer stages require the corresponding first-class capability advertised by the node agent. `MUNDUSX_CRITICAL_ROLE_WAIT_SECONDS` controls the bounded wait before the job fails in a retryable degraded state; the default is 60 seconds.
- `GET /v1/jobs/{job_id}` includes a structured `degradation` object while a critical role is unavailable and after its bounded wait expires. Completed graph outputs remain attached to the job.

## Fallback Policy Contract

Fallback is a policy decision recorded on each job, not an automatic cloud dispatch path. The first MVP provider class is `operator_approved_stronger_model`, which represents a manually approved stronger-model route.

- Eligible triggers are large context, streaming requested, local capacity unavailable, and quality or format verification failure.
- Public and internal requests can become fallback candidates, but the default policy requires operator approval and caps a single fallback decision at 25 cents.
- Sensitive requests are blocked from stronger-model fallback so private prompts and credentials remain on the local execution path unless a future explicit policy changes that rule.
- Each job stores `fallback_decision` with status, triggers, blocked reasons, provider, approval requirement, max cost, and audit reason so operators can inspect why fallback was allowed, blocked, or unnecessary.

## Admin Console Contract

The dashboard remains the read-only operational surface for health, nodes, jobs, credits, and sync state. Mutating controls belong in a distinct admin console so operators can monitor production without accidentally changing routing or policy.

MVP roles:

- `observer`: read dashboard/status data and audit trails.
- `operator`: perform bounded operational actions such as pausing a node, setting contribution caps, and approving eligible fallback decisions.
- `administrator`: manage policy rules, node approval state, role assignments, and system configuration.

MVP administrative actions:

- approve, suspend, or restore a node for routing eligibility
- set or clear node policy overrides with an operator-visible reason
- adjust operator-controlled contribution caps within the safe range
- approve or deny stronger-model fallback decisions when policy requires human approval
- update routing, privacy, fallback, or retention configuration

Every mutating admin action must emit audit metadata with actor, role, action, target, previous value, new value, reason, and timestamp. Node policy override and fallback records already carry operator-facing reason fields; future admin-console endpoints should preserve those fields instead of replacing them with dashboard-only state.
