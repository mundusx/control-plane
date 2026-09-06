# MundusX Capability Fabric v1 implementation contract

Status: **frozen for UAT implementation**  
Contract version: `1.0`  
Owner: MundusX control plane  
Compatibility baseline: control-plane `uat` at `9fec252`, Node Agent `uat` at `2f40977`

## Objective

Given a normalized job and the currently available heterogeneous nodes, the
control plane selects the best eligible execution target using registered
capabilities, live capacity, measured performance, policy constraints, and an
explainable deterministic score.

The control plane owns scheduling truth. Node agents report observations and
execute assignments; they do not select work for themselves.

## Explicit v1 boundary

Capability Fabric v1 includes:

- versioned node capability registration;
- dynamic heartbeat/live state;
- deterministic job requirements;
- eligibility gates with stable rejection codes;
- configurable scoring after eligibility;
- atomic capacity reservation;
- deterministic retry and lifecycle rules;
- performance observations and reconstructable routing decisions.

It does **not** include RAG, semantic memory, context assembly, LangGraph
planning policy, model training, distributed model splitting, or complex
preemption. Planner output may describe requirements, but it cannot bypass a
control-plane eligibility gate.

Capability Fabric data is relational and belongs in provider-neutral
PostgreSQL. Runtime traffic uses `MUNDUSX_DATABASE_POOL_URL`; migrations and
administration use the direct `MUNDUSX_DATABASE_URL`. Supabase REST/Auth are not
part of the primary runtime path. `pgvector` is not required for v1. A future
Context Engine may add pgvector for semantic retrieval without changing this
scheduler contract.

## Version and compatibility rules

- A v1 Node Agent sends `capability_fabric_version: "1.0"` during registration.
- A v1 registration must include `capabilities` and pass validation.
- An unknown non-empty version is rejected with
  `UNSUPPORTED_CAPABILITY_FABRIC_VERSION`.
- A missing version is accepted temporarily as a legacy registration. Legacy
  nodes remain governed by existing heartbeat compatibility rules and are not
  represented as v1-verified.
- Additive optional fields are backward compatible. Removing a field, changing
  its meaning, or changing a unit requires a new contract version.
- Memory is measured in MiB, percentages are integer `0..100`, capability
  scores are integer `0..100`, and timestamps are UTC.

## 1. Node capability registration

The existing `/v1/register` envelope remains authoritative:

```json
{
  "node_id": "gx10-e88e",
  "public_key_fingerprint": "...",
  "public_key_hex": "...",
  "hostname": "gx10-e88e",
  "identity_trust_path": "managed",
  "backend": "vllm",
  "contribution_percent": 100,
  "capability_fabric_version": "1.0",
  "capabilities": {
    "schema_version": 4,
    "backend": "vllm",
    "contribution_percent": 100,
    "physical_memory_mb": 131072,
    "usable_memory_mb": 122880,
    "physical_vram_mb": 131072,
    "usable_vram_mb": 118000,
    "runtime_mode": "vllm",
    "parallel_slots": 16,
    "capacity_class": "server",
    "supported_roles": ["chat", "coding", "synthesizer"],
    "supported_tools": ["repository"],
    "active_model": {
      "name": "qwen3-coder",
      "context_tokens": 131072,
      "quantization": "fp8",
      "task_capabilities": ["coding", "reasoning"]
    },
    "ready_for_jobs": true
  },
  "agent_version": "..."
}
```

`schema_version` is the existing Node Agent profile schema and is independent
from `capability_fabric_version`. Registration is a durable snapshot of
relatively static hardware/runtime/model capability. Fast-changing load and
availability come from heartbeat.

Registration validation returns stable codes:

| Code | Condition |
|---|---|
| `UNSUPPORTED_CAPABILITY_FABRIC_VERSION` | version is not `1.0` |
| `CAPABILITY_MANIFEST_REQUIRED` | v1 registration omits `capabilities` |
| `CAPABILITY_BACKEND_MISMATCH` | envelope and manifest backends differ |
| `CAPABILITY_CONTRIBUTION_MISMATCH` | contribution percentages differ |
| `CAPABILITY_RUNTIME_REQUIRED` | runtime mode is blank or too long |
| `CAPABILITY_SLOTS_INVALID` | slots are outside `1..=255` |
| `CAPABILITY_ROLE_INVALID` | role list is empty for a ready v1 node |
| `CAPABILITY_MODEL_INVALID` | an advertised active model has no name |

## 2. Heartbeat and live state

Heartbeat remains the dynamic contract and must not rewrite the registered
manifest. It reports current state, available memory, current model health,
load, slots, power policy, and runtime readiness.

Target cadence is five seconds. Eligibility state is derived by the control
plane:

```text
age < 15s    healthy
age 15..30s suspect (no new assignments)
age > 30s    unavailable
```

The existing lease/expiry mechanism remains the implementation authority until
the explicit age states are introduced in PR02.

## 3. Normalized job requirements

The internal authority is the existing `JobRequest`, `RequestClassification`,
and `JobSchedulingRequirements` contract. Together they must preserve:

- request/job identifier and optional session/tenant identifiers;
- task type and interactive/batch priority;
- explicit model and whether substitution is allowed;
- required capabilities and minimum scores;
- context and expected output budget;
- privacy/trust, region, runtime, tool, and repository constraints;
- maximum predicted latency when supplied.

Normalization is deterministic. LangGraph or a model may propose requirements,
but the control plane validates and owns the final values.

## 4. Eligibility

Eligibility runs before scoring. A candidate is eligible only when all required
conditions pass:

```text
identity and admission policy pass
AND node/runtime are healthy
AND requested backend/runtime/model are available
AND required role and capabilities are supported
AND context and output fit
AND trust/privacy/region constraints pass
AND an atomic capacity reservation can fit
```

Every rejected candidate records one or more stable reason codes. Human text is
diagnostic only and must not be consumed as an API contract.

## 5. Scoring and performance profiles

Only eligible candidates are scored. Interactive coding defaults to:

```text
utility = 0.35 latency
        + 0.20 available_capacity
        + 0.15 throughput
        + 0.10 reliability
        + 0.10 session_affinity
        + 0.10 locality
        - penalties
```

Weights are configuration, sum to `1.0` before penalties, and are recorded with
the decision. Performance lookup keys are node class, model, runtime,
precision, context bucket, and predicted concurrency. Benchmark numbers are
data, never source-code constants. Missing profiles use a conservative neutral
score and record `PERFORMANCE_PROFILE_MISSING`.

Existing evidence-backed `capability_scores` remain a model-fit input and do
not override hard eligibility or capacity.

## 6. Reservation, lifecycle, and retry

Selection and capacity reservation are one atomic operation. The invariant is:

> No assignment can become dispatchable unless its capacity reservation was
> committed against still-available capacity.

Canonical lifecycle:

```text
created -> classified -> scheduling -> reserved -> dispatched
        -> running -> streaming -> completed
scheduling -> queued
dispatched/running -> retry_pending -> scheduling
terminal: completed | failed | cancelled | expired
```

Existing external `queued`, `assigned`, `completed`, and `failed` values remain
compatible projections while the richer internal states are introduced.

Pure inference may be retried on another node after reservation release. Tool
execution is not replayed unless it carries an idempotency key and its policy
explicitly permits replay.

## 7. PostgreSQL authority

The target relational model is:

- `devices` plus a durable `capability_manifest_json` snapshot;
- `heartbeats` for append-only live observations;
- existing `jobs` and job graph records;
- `job_assignments` and `capacity_reservations`;
- `performance_profiles` and `performance_observations`;
- `routing_decisions` with candidates, rejections, scores, selected node,
  predicted latency, capacity before/after, weights, version, and timestamp.

All scheduler-critical writes use PostgreSQL transactions. Supabase REST is not
used to emulate a multi-row reservation transaction.

## 8. Internal API surface

Existing public routes remain compatible. The intended internal surface is:

```text
POST /v1/register
POST /v1/heartbeat
GET  /v1/nodes
GET  /v1/nodes/{id}/capabilities
POST /v1/jobs
GET  /v1/jobs/{id}
POST /internal/scheduler/plan
POST /internal/scheduler/reserve
GET  /internal/routing/{job_id}
```

Internal scheduler endpoints require operator/service authentication and are
not called directly by MundusX Chat clients or contributor nodes.

## 9. Delivery sequence and acceptance

| PR | Deliverable | Acceptance criterion |
|---|---|---|
| 01 | Capability manifest and registry | v1 manifest is validated, returned in node state, and durably restored |
| 02 | Heartbeat and live-state expiry | stale/dead/overloaded nodes cannot receive new assignments |
| 03 | Job manifest and eligibility audit | every candidate is eligible or rejected with stable codes |
| 04 | Performance profiles and scorer | ranking uses measured profiles and recorded configurable weights |
| 05 | Atomic reservation and dispatch | concurrent scheduling cannot oversubscribe capacity |
| 06 | Telemetry and routing audit | every routing decision is reconstructable from stored data |

Capability Fabric v1 is UAT-complete when a mixed workload with 50 concurrent
jobs, different context depths/capabilities, saturation, and node loss produces
no invalid selection or oversubscription, respects policy, fails over pure
inference predictably, queues deterministically, and explains every decision.
