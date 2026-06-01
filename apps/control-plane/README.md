# Control Plane

Private Rust HTTP control plane for node registration, heartbeat ingestion, and live node snapshots.

This subtree is company-owned and governed by the repo-level [LICENSE](../../LICENSE).

The control-plane API and state model live in the source itself and the operator README at the repo root.

## Runtime Negotiation Contract

Apple Silicon job routing now uses an explicit runtime contract between submitted jobs and node heartbeats.

- Jobs declare `runtime_mode` and `stream` alongside the existing backend preference.
- Heartbeats report `runtime_ready`, `supported_runtime_modes`, `streaming_supported`, `model_dir`, and `model_path`.
- The control plane only assigns a queued job when the node backend matches and the latest worker capability report explicitly supports that job's runtime requirements.
- Chat completions are queued as `interactive` jobs and streaming chat requests still fail fast until node streaming support exists.
