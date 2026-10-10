# Predefined contributor admission

Node capacity and model class are separate classifications. These are starting
estimates, not benchmark scores. The node page labels their source accordingly.

Usable contribution memory selects compact (<8 GiB), standard (8–16 GiB),
workstation (16–64 GiB), or large-memory (64 GiB and above). Starting context is
bounded by reported model context, this node tier, and memory remaining after
reported or catalog-estimated model weight memory. All new contributors start
with one network job at a time; hardware labels do not imply measured speed.

The initial model catalog contains Qwen3-Coder-30B-A3B-Instruct variants and
Qwen2.5-Coder Instruct 0.5B, 1.5B, 3B, 7B, 14B and 32B variants. Smaller models
start with basic coding; 7B/14B/32B variants start with standard coding; the
Qwen3-Coder family starts with expert coding, constrained by available context.
The served alias `qwen3-coder` gets a coding-family classification with a 4K
starting limit; parameter count and quantization are not inferred from that
alias. Unknown models start with chat and a conservative 2K context limit.

One short, server-issued readiness response admits chat and catalog coding.
Streaming requires actual deltas during that response or a separate stream
check. Native tools still require their short call/result checks; vision and
media retain their independent checks.

Deeper context/coding audits start after a 60-second admission grace period and
yield to eligible queued customer work and recent work on the node. Once a probe
is running it finishes normally; it is not preempted by a new customer request.
Failed audits lower allowed capabilities/context; completed measurements can
replace starting estimates. Existing contributors retain their audit policy.

The admission-policy migration preserves prior successful and failed tests for
the exact same configuration. Pending old probes are replaced with fresh IDs;
execution history and billing semantics remain unchanged.
