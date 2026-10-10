# Predefined contributor classification

Contributors join through reported runtime readiness. The released control plane
does not launch model qualification jobs after connection and does not use old
test results as admission or routing gates. Pending qualification jobs are
cancelled at startup; historical evidence and contribution counters are retained.
The former MUNDUSX_QUALIFICATION_MODE setting cannot enable automatic tests.

The node page separates reported capabilities and predefined classification.
Memory/model classes are estimates, not benchmark scores. Routing uses reported
model capabilities, context, tools, streaming, runtime health and policy limits.
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
