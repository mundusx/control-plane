# Predefined contributor classification

Contributors join through reported runtime readiness. The released control plane
does not launch model qualification jobs after connection and does not use old
test results as admission or routing gates. Pending qualification jobs are
cancelled at startup; historical evidence and contribution counters are retained.
The former MUNDUSX_QUALIFICATION_MODE setting cannot enable automatic tests.

The node page separates reported capabilities and predefined classification.
Memory/model classes are estimates, not benchmark scores. Advertisements and routing use the intersection of reported
model capabilities and catalog/operator policy. Runtime health and operator
pause/block policy still determine whether the node is available.
Stopped, stale or unhealthy contributors remain unavailable.

Usable contribution memory selects compact (<8 GiB), standard (8–16 GiB),
workstation (16–64 GiB), or large-memory (64 GiB and above). The model catalog
recognizes Qwen3-Coder-30B-A3B-Instruct and Qwen2.5-Coder Instruct variants.
The alias qwen3-coder is classified as coding-family without inventing parameter
count or quantization. Classification does not certify answer quality.

Managed generation profiles are retained. Qwen3-Coder Instruct defaults include
temperature 0.7, top-p 0.8, top-k 20 and repetition penalty 1.05. Explicit
contributor/request settings take precedence over defaults. Disabling admission
tests does not remove or alter generation settings.

## Admin capability settings

Open Nodes, select a node, and expand **Admin capability settings**. Choose catalog
defaults or a custom task allowlist, context/job caps, and whether to permit
reported native tools and streaming. Save with a reason; reset removes the override.
An empty custom allowlist disables all LLM tasks. Larger coding claims also cover
smaller coding tasks, but never bypass the policy's permitted tiers.

Overrides replace catalog task estimates, allowing an operator to approve a
reported task for an otherwise unknown model. They cannot invent vision,
embeddings, tools, streaming or more slots/context than the contributor reports.
A context override may raise a catalog estimate up to the contributor's reported
limit. Both node APIs expose effective models; raw reports remain available
separately as detected models or reported worker/capability metadata. Automatic generation budgets fit remaining policy context after
prompt/reserve costs; explicit oversized requests remain ineligible. Runtime flags and contributor limits always remain authoritative.

Contributed discrete CUDA VRAM below 12 GiB defaults to small coding; below 24 GiB excludes
large coding. MLX and GB10/vLLM use usable memory. Recognized Qwen coding models
may serve reported math, and larger coding families may serve reported reasoning,
research and synthesis. Unknown models default to chat; explicit runtime claims
for native tools, vision or embeddings are handled separately. Media retains its
existing independent runtime/profile policy.

`POST /v1/nodes/capability-policy` requires an authenticated admin session or
operator token. Body: `{ "node_id": "node-…", "policy": { "allowed_capabilities":
["chat", "small_coding"], "max_context_tokens": 4096, "max_parallel_jobs": 1,
"allow_tools": false, "allow_streaming": true, "reason": "Small jobs only" } }`.
Send `policy: null` to reset. Missing optional fields use catalog defaults.
The API validates task names and numeric bounds before mutation, persists the
versioned node record before confirming success, and records actor/reason in
operator history. Heartbeats and re-registration preserve these settings.
