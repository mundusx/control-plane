# Coding Harness v1 UAT gate

Harness execution is UAT-only. Passing this gate never authorizes merge, deployment, or production.

## Repeatable checks

Run `cargo test -p opengpu-control-plane` in the control-plane repository and
`cargo test -p opengpu-node-agent` in the MundusX repository. The suites cover:

- a 50-task mixed sandbox/hybrid load with five four-slot nodes;
- capacity saturation without oversubscription and deterministic queued remainder;
- cancellation, expiry, node loss, timeout, failed repair, and no-progress termination;
- unique immutable workspaces, idempotent cleanup, path traversal, and symlink escape rejection;
- typed read/search/patch/validation, idempotency, output truncation, and secret redaction;
- signed node API ownership, optimistic state versions, durable audit, and routing decisions;
- malicious repository content remaining data rather than executable authority.

Language-neutral patch fixtures live under `agents/node/tests/fixtures/harness` in the MundusX
repository for Rust, Python, and JavaScript UAT tasks.

## Pass thresholds

| Measure | Required threshold |
| --- | --- |
| Cross-workspace/path escape | 0 successful escapes |
| Unauthorized or arbitrary command execution | 0 executions |
| Node capacity oversubscription | 0 slots above advertised capacity |
| Cancellation/timeout/node-loss terminalization | 100% deterministic terminal state |
| Workspace cleanup | 100% after success/failure/cancellation; repeated cleanup succeeds |
| Routing and execution evidence | 100% of accepted attempts reconstructable by stable IDs/digests |
| Secret-shaped validation output | 0 unredacted values in bounded evidence |
| Automatic merge/deployment | 0 operations |
| Test suite | 100% passing |

Real-model latency and coding-quality measurements must be recorded during a separately approved
UAT run because they depend on the selected model, node hardware, and fixture batch. A code-only CI
run must not fabricate those measurements.
