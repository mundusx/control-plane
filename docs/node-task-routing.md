# Node capability discovery and task routing

Operator-authenticated clients can inspect the live worker directory with
`GET /v1/nodes/capabilities`. Each entry includes heartbeat freshness, policy and
runtime blockers, free capacity, model limits, advertised skills, and matching
execution history. Stale or unhealthy capacity is not shown as available.
Worker skills are labelled `advertised_skill`; supplied scorecards are labelled
`reported_scorecard`. Neither claims an independent quality benchmark.

For an existing job, use `GET /v1/jobs/{job_id}/candidates`. Candidates are ordered
by scheduler score and include the selected model, graph step, and explanations.
The scheduler uses the same candidate filtering and ranking. Unknown jobs return
404; terminal jobs have no candidates. This is a snapshot, not a slot reservation:
the normal claim operation rechecks eligibility and capacity.

Performance scoring uses at most the latest 32 terminal executions for the same
worker, model, and task capability. Switching models does not transfer old results.
Coding, research, synthesis and chat do not share latency samples. Graph steps
use recorded runtime where available. Direct requests use assignment-to-completion
time, excluding queue wait. These timings measure execution speed and reliability,
not semantic answer quality or standardized tokens per second.

New workers remain eligible based on reported capabilities and hard limits;
missing execution history is not treated as a failure. Capacity is refreshed by
heartbeats, maintenance and job claims. Registration launches no synthetic
benchmark workload.
