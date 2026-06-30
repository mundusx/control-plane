# MundusX Architecture

How M-series and CUDA nodes work together through the control plane, and how consumers use it.

---

## Overview

```
┌──────────────────────────────────┐    ┌──────────────────────────────────┐
│        M-Series Node (macOS)     │    │        CUDA Node (Linux/Win)     │
│                                  │    │                                  │
│  Identity: macOS Keychain        │    │  Identity: ed25519 key pair      │
│            (Secure Enclave)      │    │            (software key)        │
│  trust_path: "keychain"          │    │  trust_path: "local-encrypted-   │
│              → trusted           │    │               fallback"          │
│                                  │    │                                  │
│  backend: m                      │    │  backend: cuda                   │
│  Inference: llama-cli + Metal    │    │  Inference: llama-cli + CUDA     │
│  Power: battery / AC aware       │    │  Power: AC (typically always-on) │
│                                  │    │                                  │
│  1. POST /v1/register            │    │  1. POST /v1/register            │
│  2. loop: POST /v1/heartbeat     │    │  2. loop: POST /v1/heartbeat     │
│  3. poll: GET /v1/jobs/next      │    │  3. poll: GET /v1/jobs/next      │
│  4. run inference locally        │    │  4. run inference locally        │
│  5. POST /v1/jobs/complete       │    │  5. POST /v1/jobs/complete       │
└────────────────┬─────────────────┘    └─────────────────┬────────────────┘
                 │   all requests signed (x-mundusx-signature             │
                 │   + x-mundusx-node-id + x-mundusx-timestamp)          │
                 └──────────────────────┬──────────────────┘
                                        │
                        ┌───────────────▼────────────────┐
                        │          CONTROL PLANE         │
                        │           (Railway)            │
                        │                                │
                        │  Node registry                 │
                        │  Job queue (FIFO, claim-pull)  │
                        │  Scheduler                     │
                        │  Credits ledger                │
                        │  Event log                     │
                        │  Operator dashboard  GET /     │
                        │                                │
                        │  Supabase ←→ local-json        │
                        │  (primary + fallback)          │
                        └───────────────┬────────────────┘
                                        │
                        ┌───────────────▼────────────────┐
                        │           CONSUMER             │
                        │                                │
                        │  POST /v1/chat/completions     │
                        │  POST /v1/jobs                 │
                        │  ← { job_id, status: queued }  │
                        │                                │
                        │  GET /v1/jobs/:id  ← MISSING   │
                        └────────────────────────────────┘
```

---

## Node lifecycle

```
boot
  │
  ▼
POST /v1/register
  │  body: { node_id, public_key_hex, public_key_fingerprint,
  │           hostname, identity_trust_path, backend,
  │           contribution_percent, agent_version }
  │  signed: x-mundusx-signature (ed25519 or Secure Enclave)
  │
  ▼
heartbeat loop  (POST /v1/heartbeat every N seconds)
  │  body: { node_id, backend, agent_state, available_memory_mb,
  │           available_gpu_percent, contribution_percent,
  │           power_source, on_battery, battery_percent,
  │           policy_allowed, policy_reason, worker_health }
  │
  ▼
claim loop  (GET /v1/jobs/next?node_id=...)
  │  control plane assigns a job only if:
  │    state == ready
  │    policy_allowed == true
  │    job.preferred_backend == auto  OR  matches node.backend
  │
  ├── no job available → wait, retry
  │
  └── job returned → run inference locally
        │
        ▼
      POST /v1/jobs/complete
        body: { job_id, node_id, worker_id, backend,
                status: completed|failed,
                output: "...",   ← inference result
                error: "..." }
        │
        ▼
      control plane: marks job completed, awards credits to node
```

---

## Backend routing

Jobs carry a `preferred_backend` field. Nodes self-select by only claiming jobs that match:

| Job `preferred_backend` | Who can claim |
|---|---|
| `auto` | Any ready, policy-allowed node (first to poll wins) |
| `m` | Only M-series nodes |
| `cuda` | Only CUDA nodes |

There is no central push — nodes pull jobs on their own schedule. High-availability comes from having multiple nodes of each type registered and polling.

---

## Consumer flow

### Submit (works today)

```
POST /v1/chat/completions
Authorization: Bearer <MUNDUSX_OPERATOR_TOKEN>

{
  "model": "llama3",
  "messages": [{ "role": "user", "content": "Hello" }]
}

→ 200 OK
{
  "id": "chatcmpl-...",
  "choices": [{ "message": { "role": "assistant", "content": "" }, "finish_reason": "queued" }],
  "mundusx": {
    "job_id": "...",
    "request_id": "...",
    "status": "queued"
  }
}
```

The response is immediate. `content` is empty and `finish_reason` is `"queued"` — inference has not run yet.

### Poll for result (gap — not yet implemented)

Once `GET /v1/jobs/:id` exists:

```
GET /v1/jobs/<job_id>
Authorization: Bearer <MUNDUSX_OPERATOR_TOKEN>

→ 200 OK
{
  "job_id": "...",
  "status": "completed",         ← queued | assigned | completed | failed
  "output": "Hello! How can I help you today?",
  "assigned_node_id": "...",
  "assigned_at": "...",
  "completed_at": "..."
}
```

Poll until `status` is `completed` or `failed`. The `output` and `error` fields are already modelled in `JobRecord` and populated by `POST /v1/jobs/complete` — only the endpoint is missing.

### Direct job submission (for non-chat workloads)

```
POST /v1/jobs
Authorization: Bearer <MUNDUSX_OPERATOR_TOKEN>

{
  "request_id": "my-req-1",
  "prompt": "Summarise this document...",
  "preferred_backend": "auto",   ← auto | m | cuda
  "model": "llama3",
  "max_tokens": 512
}
```

---

## Trust model

| trust_path | Source | Trusted |
|---|---|---|
| `keychain` | macOS Keychain / Secure Enclave | ✅ Yes |
| `local-encrypted-fallback` | Software ed25519 key on disk | ⚠️ No (accepted but flagged) |

All node requests are verified against the public key registered at `POST /v1/register`. The timestamp in the signature header must be within 300 seconds of server time (replay protection).

---

## State persistence

```
Control plane in-memory state
  │
  ├── on every write → save to local JSON  (~/.mundusx-control-plane/state.json)
  │
  └── if Supabase configured → sync to Supabase (best-effort, non-blocking)
        │
        └── if sync fails → state.supabase_sync.degraded = true
                            visible in dashboard + /health
```

On startup the control plane restores from Supabase if available, otherwise from local JSON.

---

## Known gaps

| Gap | Impact |
|---|---|
| No `GET /v1/jobs/:id` | Consumers cannot poll job results — the output never reaches them |
| Streaming not supported | `POST /v1/chat/completions` with `"stream": true` returns 400 |
| No webhook / push | Consumers must poll; no callback URL option |
| Claim is first-come-first-served | No priority, affinity, or load-aware scheduling |
