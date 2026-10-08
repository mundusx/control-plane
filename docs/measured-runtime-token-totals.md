# Measured EHDA output tokens

The public counter measures runtime-reported completion/output tokens from
instrumented EHDA contributors. Prompt/input tokens are recorded separately and
do not increase the output counter. Internal model calls, retries and reasoning
tokens count when the runtime includes them in completion_tokens. Character-based
display/credit estimates and media pixels never count as measured LLM tokens.

Contributor completions carry a token_usage array with one UUID per actual model
call. The worker preserves final streaming usage once per call, not the sum of
cumulative usage events. Missing usage remains unknown. Ollama/llama.cpp counts
are used only when their runtime metrics expose actual eval counts.

Migration 0045 adds a private per-call ledger and aggregate singleton. Signed
reports must match the assigned contributor. Each call and each worker/call index
is unique; repeat acknowledgements do not count twice. Ledger insertion and total
increments are transactional. Reports are persisted before completion processing;
storage errors request retry instead of acknowledging unrecorded metrics. Completed
report retries must match the saved measurement and cannot append new calls.

GET https://control.mundusx.ai/v1/usage/tokens returns public aggregate statistics
only. Token totals are decimal strings to preserve precision. The response states
source=runtime_reported, includes_estimates=false, the tracking start time and the
limited instrumentation scope. It does not expose prompts, identities or secrets.
The same on-demand aggregate is available at
https://chat.mundusx.ai/v1/usage/tokens. No counter is displayed in chat, appended
to replies, or fetched by the background network poll.

Deploy the control-plane migration/collector first, then instrumented node agents,
then the optional Chat API alias. Node upgrades must preserve identity, configuration
and the user's active runtime mode. Do not interrupt active model jobs. Historical
responses without saved runtime counts cannot be recovered accurately and are
excluded; never backfill them from output characters. The counter is runtime
telemetry, not independent attestation, a credit balance, or a billing change.
