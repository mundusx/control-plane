# MundusX production architecture

MundusX separates orchestration from execution. The control plane plans,
persists, schedules, verifies, and accounts for work. Contributor machines run
the CLI and Node Agent, advertise what they can execute, and claim only work
that matches their live capability profile.

## Component ownership

| Boundary | Component | Responsibility |
|---|---|---|
| Consumer | Chat UI / API | Submit a request and poll progress or the final result |
| Contributor | CLI | Install, authenticate, configure, start, stop, and inspect contribution |
| Contributor | Node Agent | Probe hardware and models, advertise capabilities, heartbeat, claim, execute, and report |
| Contributor | Worker runtime | Execute one bounded model or tool task using CUDA, MLX, vLLM, Vulkan, or CPU |
| Control plane | Planner adapter | Call the configured planner service and fall back to the deterministic Rust planner |
| Planner service | LangGraph workflow | Classify, decompose, and validate a dependency graph |
| Control plane | Scheduler | Match each ready graph stage to a live contributor |
| Control plane | Reducer orchestration | Route reduction to a capable node and provide accepted dependency outputs |
| Control plane | Synthesizer orchestration | Route final synthesis and publish the accepted final result |
| Control plane | State and policy | Persist jobs, graph state, leases, trust, events, fallback decisions, and credits |

The planner service never communicates directly with contributor machines. It
returns an advisory graph. The Rust control plane validates and owns execution.

## Contributor role advertisement

The Node Agent derives roles from actual runtime readiness, installed models,
memory, VRAM, backend, and parallel capacity. A machine can advertise multiple
roles:

- `chat`: direct conversational inference
- `coding`: code generation or review
- `vision`: image-capable inference
- `embedding`: vector or embedding work
- `tool_use`: tool-capable inference
- `chunk_analysis`: bounded independent analysis
- `reducer`: deduplicate and compact accepted partial results
- `synthesizer`: produce the final coherent answer
- `batch`: general background work

Roles describe eligibility, not permanently assigned machine classes. A
128-GB server can be both a normal worker and a synthesizer. A 32-GB MLX
machine may reduce or synthesize when its advertised runtime and model support
the stage. Smaller laptops normally handle chunk analysis, but may advertise
additional roles when they meet the same capability rules.

During mixed-version rollout, the scheduler permits two compatibility aliases:
legacy `batch` can satisfy `chunk_analysis`, and legacy `reducer` can satisfy
`synthesizer`. Agents that do not yet report roles remain eligible through the
existing runtime checks. Explicitly incompatible advertised roles are rejected.

## Request lifecycle

```text
chat/API request
    |
    v
control-plane classification and base requirements
    |
    +--> configured planner service
    |       classify -> decompose -> validate
    |       failure/timeout/invalid response
    |                    |
    +<-------------------+
    | deterministic Rust fallback
    v
persisted dependency graph
    |
    +--> scope or direct task
    +--> parallel chunk_analysis tasks
    +--> reduce accepted chunk outputs
    +--> synthesize final answer
    v
verification, final result, events, trust, and credits
```

For each ready graph node, the scheduler:

1. excludes stale, paused, unhealthy, policy-blocked, or capacity-exhausted nodes;
2. checks backend, runtime mode, requested model, streaming, graph-stage role,
   context/output limits, and every required capability threshold;
3. scores the weighted capability profile, memory, GPU availability, model tier,
   trust, live load, free parallel slots, and recent latency/failures;
4. awards a lease to the best eligible claimant;
5. reassigns work after retryable failure or lease expiry.

## Contributor local-slot leases

Contributor-local inference and network-assigned inference share the same advertised execution capacity. A signed node may acquire, renew, and release a short-lived local lease through `/v1/local-leases`, `/v1/local-leases/renew`, and `/v1/local-leases/release`. Lease records contain capacity metadata only; prompts and outputs are excluded.

The scheduler atomically counts unexpired local lease slots plus active network assignments before awarding work. This prevents the control plane from assigning a slot already being used locally. Lease acquisition is idempotent per node and request ID, leases expire automatically after missed renewal, and local execution never creates completion credits. Operator node views show local and network occupancy separately while preserving the combined active/free capacity view.

The classifier describes each request with multiple weighted abilities such as
`coding`, `reasoning`, `logic`, `math`, `research`, `historical_research`,
`factual_retrieval`, `translation`, `long_context`, and `synthesis`. The planner
may refine this profile per graph step, but it never binds work to a physical
model. Exact node and model selection remains scheduler-owned because only the
scheduler has authoritative live availability.

Workers may add evaluated `capability_scores` to each model inventory entry:

```json
{
  "capability": "reasoning",
  "score": 88,
  "confidence": 92,
  "sample_count": 240
}
```

All values use an integer 0-100 scale. Low-confidence measurements are pulled
toward a neutral score so small samples do not dominate routing. During the
rolling upgrade, legacy `task_capabilities` labels map to a conservative score,
and workers with neither field retain the older compatibility path. A model's
quality never overrides eligibility: a saturated specialist with no free slot
cannot beat a qualified model that is currently available.

Reduction and synthesis prompts contain accepted dependency outputs. A
synthesizer does not need to run on the control-plane machine; the control
plane owns the summary state while a selected contributor performs inference.

## Failure behavior

| Failure | Behavior |
|---|---|
| Planner service unset | Use the deterministic Rust planner |
| Planner timeout, transport error, or invalid response | Record fallback context and use the deterministic plan |
| Required role unavailable | Keep the stage queued until a compatible contributor appears or policy timeout applies |
| Explicit model unavailable | Do not assign to a mismatched node; apply configured fallback policy or reject/expire |
| Reducer or synthesizer disappears | Lease expiry makes the stage eligible for another capable contributor |
| Older Node Agent reports no roles | Use existing runtime eligibility during the rolling upgrade |
| Node advertises roles but lacks the stage role | Reject that node for the stage |

## Deployment

The control plane and planner service are separate logical services and can run
on one server or different servers. Contributor inference should remain on
worker machines. A typical mixed fleet is:

- one control-plane deployment with durable database state;
- one stateless planner-service deployment using LangGraph with deterministic fallback;
- one or more high-memory contributors eligible for reduction and synthesis;
- CUDA and MLX laptops eligible for parallel chunks and any additional roles
  their Node Agents advertise.

No dedicated 128-GB planner machine is required. High-memory servers add
availability and stronger synthesis capacity, but the control plane schedules
them as contributors rather than embedding inference inside the planner.
