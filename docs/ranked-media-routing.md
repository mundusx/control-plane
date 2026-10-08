# Ranked media assignment

Browser, MCP and OpenAI-compatible media requests share the media queue.
Set `MUNDUSX_MEDIA_PLANNER_URL=http://planner.railway.internal:8080/v1/media/plan`
on public Chat after deploying the companion planner-service media graph.
LangGraph selects the operation and exact duration/profile from the explicit
media intent. The queue validates that choice; LangGraph never assigns a GPU.
Natural-language intent detection remains in chat before this media graph.
The existing LLM `/v1/plan` interface remains dedicated to LLM tasks.

Apply migration 0044 through Chat's direct PostgreSQL prestart migration path.
It adds signed worker polling presence, execution attempt history and per-profile
assignment counters. It is additive and leaves existing artifacts, jobs and
credits intact. Ranking is server-side; contributors need no new CLI version.

Eligibility requires a fresh live heartbeat, allowed policy, ready/busy state,
healthy runtime, matching verified profile and adequate media memory budget.
An idle assignment additionally requires an admitted signed worker poll in the
last 45 seconds and no running media job. Presence identity must match the
control-plane public key. Availability snapshots are cached for three seconds.
No eligible contributor means immediate 503 on a new submission; busy eligible
contributors allow a queued job. Idempotent retries preserve existing jobs even
when a contributor subsequently goes offline.

For each exact profile, reliability uses completed versus failed/expired attempts
in the last 30 days with a neutral two-success/two-failure prior. Reliability has
80% weight; same-profile average speed has 20%, after at least three successes.
Speed is worker telemetry, not evidence of visual quality and never a billing
input. Existing quote-based accounting and exactly-once settlement are unchanged.
Historical jobs before this migration are not treated as performance evidence.

Every fifth assignment for a profile explores the least recently assigned free
eligible worker. Other assignments use score, then least recent assignment and
node ID as deterministic tie breaks. This gives new workers a chance without
trusting unrelated LLM scores. Only workers actually polling are considered, so
an idle-looking heartbeat cannot indefinitely reserve work for an absent worker.

PostgreSQL serializes ranking/lease decisions across web replicas. Workers still
pull jobs, but only the selected worker can claim one. Expired leases requeue or
fail according to the existing three-attempt policy and record expiration against
the prior node. One shared media slot per node remains enforced by the existing
unique index. At most 32 compatible queued jobs are examined per claim to avoid
one profile blocking other work the caller can execute.

Rollback: remove the planner URL to use local preset selection, then revert Chat
to the previous deployment to restore first-eligible claim behavior. Keep the
additive migration tables and pending jobs; do not delete media or accounting data.
