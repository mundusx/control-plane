# MundusX Coding Harness v1 implementation contract

Status: **frozen for UAT implementation**  
Contract version: `1.0`  
Owner: EHDA control plane  
Execution authority: paired local-user runner or explicitly hosted EHDA runner
Tracking issue: `mundusx/control-plane#506`

## Objective

Coding Harness v1 turns a model response into a bounded, reviewable software
engineering attempt. EHDA owns task policy, scheduling, lifecycle, approval,
and audit. A separately registered Harness runner owns an isolated workspace and
executes only the typed repository and validation operations authorized by EHDA.
Inference contributors never receive repository content, credentials, workspaces,
or tool authority.

The harness may inspect a repository, propose a patch, run permitted tests,
repair a failed attempt within an explicit budget, and return an evidence
bundle. It never authorizes its own merge, push, deployment, or production
change.

## Explicit v1 boundary

Harness v1 includes:

- immutable source revision selection;
- disposable per-attempt workspaces;
- sandbox and trusted-node hybrid execution modes;
- typed repository read, search, patch, diff, build, and test operations;
- deterministic policy checks before every operation;
- bounded model/tool/validation/repair loops;
- durable run, attempt, tool-call, validation, artifact, and approval state;
- cancellation, timeout, cleanup, recovery, and idempotent retry;
- content-integrity metadata and reconstructable audit events;
- independent approval gates for applying, merging, and deploying a result.
- separate requester, runner, and inference-contributor identities and capacity.

It does **not** include unrestricted shell access, arbitrary host filesystem
access, hidden production credentials, automatic merge/push/deploy, RAG,
pgvector, model training, or distributed model splitting.

## Trust boundary and threat model

The following inputs are untrusted:

- user prompts and uploaded files;
- repository contents, hooks, submodules, build scripts, and tests;
- model text and model-requested tool calls;
- runner claims that are not independently verified;
- command output and generated artifacts.

The control plane is the policy authority. A runner may enforce a stricter
local policy, but it cannot weaken the policy carried by a signed assignment.
The model cannot call a runner tool directly. Every operation passes through the
control-plane authorization and attempt budget.

Chat/VS Code user identity, Harness `runner_id`, and inference contributor
`node_id` are distinct. A local-user runner must be bound to the authenticated
requesting user and explicit tenant/repository scopes. No eligible runner means
`HARNESS_RUNNER_UNAVAILABLE`; contributor fallback is forbidden.

Harness v1 must defend against path traversal, symlink escape, repository hook
execution, command injection, environment/credential disclosure, network data
exfiltration, fork bombs, resource exhaustion, oversized output, malicious test
fixtures, stale-base patching, cross-tenant workspace access, replayed side
effects, and forged evidence.

## Version and compatibility rules

- Requests send `harness_contract_version: "1.0"`.
- Runners register supported contract versions, operations, and isolation modes.
- An unknown non-empty version fails with `HARNESS_VERSION_UNSUPPORTED`.
- A runner that does not advertise version `1.0` is ineligible for harness work.
- Additive optional fields are backward compatible. Removing a field, changing
  its meaning, or changing a unit requires a new contract version.
- Limits use bytes, milliseconds, integer token counts, and UTC timestamps.
- Stable codes are API contracts; human messages are diagnostics only.

## 1. Task and attempt envelope

The control plane normalizes a user request into a task. A task may have one or
more attempts, but an attempt has exactly one immutable base revision and one
workspace.

```json
{
  "harness_contract_version": "1.0",
  "task_id": "task_...",
  "attempt_id": "attempt_...",
  "tenant_id": "tenant_...",
  "repository": {
    "source_id": "repo_...",
    "base_revision": "40-hex-character-commit",
    "allowed_path_prefixes": ["src/", "tests/"],
    "submodules": "disabled",
    "hooks": "disabled"
  },
  "execution": {
    "mode": "sandbox",
    "network": "disabled",
    "max_wall_time_ms": 900000,
    "max_cpu_time_ms": 600000,
    "max_memory_mb": 8192,
    "max_disk_mb": 4096,
    "max_output_bytes": 1048576,
    "max_tool_calls": 80,
    "max_model_turns": 24,
    "max_repair_attempts": 2
  },
  "allowed_operations": [
    "repository.status",
    "repository.diff",
    "file.read",
    "file.search",
    "patch.apply",
    "validation.run"
  ],
  "validation_profiles": ["repository-default"],
  "expires_at": "2026-08-30T12:00:00Z"
}
```

The repository source is referenced by a server-side identifier. Credentials
or credential-bearing clone URLs are never placed in an assignment, prompt,
tool result, log, artifact, or audit payload.

## 2. Execution modes

### Sandbox

Sandbox is the default. The node creates a disposable process/container
boundary with a unique workspace, restricted filesystem, bounded resources,
and disabled network unless a named policy explicitly allows destinations.

### Hybrid

Hybrid means EHDA still plans, authorizes, and audits centrally while a trusted
user-owned runner performs repository operations locally. Hybrid does not mean
unrestricted host execution. It still requires a per-attempt workspace, path
confinement, environment allowlist, resource limits, child-process cleanup, and
the same tool authorization contract. A policy may fall back from hybrid to
sandbox; it may never silently fall back from sandbox to less isolation.

## 3. Typed operations

V1 operation names and side-effect classes are:

| Operation | Side effect | Replay rule |
|---|---|---|
| `repository.status` | none | freely replayable |
| `repository.diff` | none | freely replayable |
| `file.read` | none | freely replayable |
| `file.search` | none | freely replayable |
| `patch.apply` | workspace write | requires idempotency key |
| `validation.run` | executes workspace code | requires idempotency key and profile |
| `artifact.publish` | durable write | requires idempotency key |

Each call includes `task_id`, `attempt_id`, `tool_call_id`, operation name,
idempotency key when required, input digest, deadline, and remaining budget.
Results include status, stable code, bounded/redacted output, duration, output
digest, and resource usage.

There is no `shell.exec` operation in v1. `validation.run` accepts a named,
server-owned validation profile. Commands embedded only in a prompt, model
response, or repository file are never executable authority.

## 4. Workspace invariants

- The base revision resolves before assignment and is reverified on the node.
- The workspace is unique to one attempt and is never reused across tenants.
- Git hooks, credential helpers, interactive prompts, and submodules are off by
  default.
- Canonicalized paths must remain below the workspace root and within allowed
  prefixes. Symlinks and junctions are resolved before access.
- The original checkout and source repository are read-only to the attempt.
- Processes run without inherited deployment secrets and with an explicit
  environment allowlist.
- All descendants are terminated on completion, cancellation, timeout, agent
  restart recovery, or runner drain.
- Cleanup is idempotent. Only declared, validated artifacts survive cleanup.

## 5. Lifecycle

Canonical task states are:

```text
created -> queued -> reserved -> preparing -> running -> validating
        -> awaiting_approval -> completed

queued/reserved/preparing/running/validating -> cancelling -> cancelled
reserved/preparing/running/validating -> retry_pending -> queued

terminal: completed | failed | cancelled | expired
```

Attempt states are `reserved`, `preparing`, `running`, `validating`,
`succeeded`, `failed`, `cancelled`, and `expired`. A task cannot be completed
unless its final attempt has a validation result or is explicitly marked
`unverified` with the reason recorded.

State transitions use optimistic version checks inside PostgreSQL transactions.
Duplicate messages return the existing result. Conflicting transitions fail
with `HARNESS_STATE_CONFLICT`.

## 6. Budgets, cancellation, and retry

The most restrictive applicable tenant, task, assignment, node, and validation
profile limit wins. Limits cannot be raised by the model or node.

Cancellation is durable before it is delivered to a node. A cancelling task
cannot start another operation. The node terminates descendants, seals any
bounded diagnostic result, deletes the workspace, and acknowledges cleanup.

Read-only operations may be retried. Workspace writes and validation may be
retried only with the same idempotency key on the same attempt. A new runner gets
a new attempt and workspace. External side effects are not part of v1 and are
never replayed.

## 7. Validation and repair

Validation profiles are versioned server-owned data containing executable
path, argument templates, environment allowlist, working directory, resource
limits, network policy, and success criteria. Repository content can suggest a
profile but cannot define executable authority.

A repair turn receives bounded failure evidence. Repair stops when validation
passes, no-progress detection fires, the repair budget is exhausted, or the
task is cancelled. Passing tests do not waive path, policy, scope, or artifact
integrity checks.

## 8. Evidence and artifacts

The final evidence bundle contains:

- task, attempt, runner, contract, policy, and validation-profile versions;
- repository source identifier and immutable base revision;
- final patch/diff digest and changed-path summary;
- validation command-profile identifiers, exit codes, durations, and bounded
  redacted logs;
- tool-call input/output digests and resource totals;
- verification level: `verified`, `partially_verified`, or `unverified`;
- cleanup outcome and timestamps.

Artifacts are content addressed or signed by the runner identity and verified by
the control plane. Raw repository snapshots, credentials, unrelated files, and
unbounded logs are not stored.

## 9. Approval gates

Approval scopes are independent:

| Scope | Authorizes |
|---|---|
| `execute_uat` | create an isolated UAT attempt and run approved tools |
| `apply_patch` | apply the validated patch to a named non-production target |
| `merge` | merge a reviewed commit/PR into a named branch |
| `deploy_uat` | deploy an approved UAT revision |
| `deploy_production` | deploy a named revision to production |

An approval names task, artifact digest, target, scope, approver, and expiry.
Broader scopes are never inferred. In particular, `execute_uat` does not imply
apply, merge, or deployment, and no non-production approval implies production.

## 10. Stable rejection and failure codes

| Code | Condition |
|---|---|
| `HARNESS_VERSION_UNSUPPORTED` | requested contract version is unsupported |
| `HARNESS_RUNNER_UNAVAILABLE` | no paired, fresh, scoped runner is available |
| `HARNESS_RUNNER_OWNER_MISMATCH` | local runner belongs to another requesting user |
| `HARNESS_POLICY_DENIED` | operation or mode is not authorized |
| `HARNESS_AUTH_REQUIRED` | authenticated service/runner authority is missing |
| `HARNESS_BASE_REVISION_INVALID` | base revision is absent, mutable, or mismatched |
| `HARNESS_WORKSPACE_PREPARE_FAILED` | isolated workspace could not be created |
| `HARNESS_PATH_DENIED` | path escapes root or allowed prefixes |
| `HARNESS_SYMLINK_ESCAPE` | symlink/junction resolves outside allowed root |
| `HARNESS_OPERATION_UNSUPPORTED` | typed operation is unknown to this version |
| `HARNESS_IDEMPOTENCY_REQUIRED` | mutating/replay-sensitive call lacks a key |
| `HARNESS_IDEMPOTENCY_CONFLICT` | key was reused with different input |
| `HARNESS_VALIDATION_PROFILE_DENIED` | validation profile is unknown or disallowed |
| `HARNESS_NETWORK_DENIED` | attempted network access violates policy |
| `HARNESS_RESOURCE_EXHAUSTED` | memory, CPU, disk, output, token, or call limit hit |
| `HARNESS_TIMEOUT` | operation or attempt exceeded its deadline |
| `HARNESS_CANCELLED` | durable cancellation prevented or stopped execution |
| `HARNESS_STATE_CONFLICT` | lifecycle transition conflicts with durable state |
| `HARNESS_NO_PROGRESS` | bounded model/tool loop repeated without progress |
| `HARNESS_VALIDATION_FAILED` | required validation did not pass |
| `HARNESS_ARTIFACT_INVALID` | artifact failed integrity, scope, or format checks |
| `HARNESS_CLEANUP_FAILED` | descendants/workspace could not be fully removed |
| `HARNESS_APPROVAL_REQUIRED` | requested apply/merge/deploy scope is not approved |

## 11. Internal API surface

Existing public chat and job routes remain compatible. V1 adds an authenticated
internal surface; exact transport may be HTTP or an equivalent signed queue.

```text
POST /internal/harness/tasks
GET  /internal/harness/tasks/{task_id}
POST /internal/harness/tasks/{task_id}/cancel
POST /internal/harness/runners/register
GET  /internal/harness/runners/attempts/next?runner_id={runner_id}
POST /internal/harness/runners/attempts/{attempt_id}/transition
POST /internal/harness/runners/attempts/{attempt_id}/model-turns
POST /internal/harness/runners/attempts/{attempt_id}/tool-calls
POST /internal/harness/runners/attempts/{attempt_id}/validations
POST /internal/harness/runners/attempts/{attempt_id}/artifacts
POST /internal/harness/attempts/{attempt_id}/tool-calls
POST /internal/harness/attempts/{attempt_id}/events
POST /internal/harness/attempts/{attempt_id}/artifacts
POST /internal/harness/tasks/{task_id}/approvals
```

User-facing clients do not call execution endpoints. Runner endpoints use
`/internal/harness/runners/...`, require a signed `runner_id`, and are separate
from contributor node registration and heartbeat routes.

## 12. PostgreSQL authority

Provider-neutral PostgreSQL stores `harness_runners`, `harness_tasks`, `harness_attempts`,
`harness_tool_calls`, `harness_validations`, `harness_artifacts`,
`harness_approvals`, and bounded `harness_audit_events`. Runtime traffic uses
`MUNDUSX_DATABASE_POOL_URL`; migrations and administration use the direct
`MUNDUSX_DATABASE_URL`.

Reservations and state transitions that affect scheduling are transactional.
Large artifact bodies do not belong in PostgreSQL; the database stores their
metadata, digest, size, retention, and protected storage reference.

## 13. UAT acceptance

Harness v1 is UAT-complete when deterministic fixture repositories and a mixed
50-task workload demonstrate all of the following:

- no cross-workspace or out-of-prefix access;
- no unauthorized command, environment, network, merge, push, or deployment;
- no capacity oversubscription;
- correct cancellation, timeout, crash cleanup, and runner-loss behavior;
- proof that contributor-only nodes cannot claim Harness work or consume runner slots;
- bounded and deterministic retry/repair with no duplicated side effects;
- validated evidence bound to the exact base revision and patch digest;
- reconstructable routing and execution decisions without sensitive payloads;
- explicit partial/unverified outcomes instead of false success;
- separate approval enforcement for apply, merge, UAT deploy, and production.

