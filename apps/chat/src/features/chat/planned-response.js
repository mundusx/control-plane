// The control plane owns planning and execution. This adapter waits for the
// durable job and refuses to treat missing plan outputs as a completed answer.
export function plannedResponseGaps(job) {
  const nodes = job.graph?.nodes;
  const steps = job.plan?.jobs ?? [];
  if (!job.graph_execution_enabled || !Array.isArray(nodes) || nodes.length === 0) {
    return ["The request did not produce an executable plan."];
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const gaps = steps.filter(step => !byId.has(step.id)).map(step => `Missing planned step: ${step.name || step.id}`);
  for (const node of nodes) {
    if (node.status !== "completed" || !String(node.output ?? "").trim()) {
      gaps.push(`Unfinished planned step: ${node.name || node.id}`);
    }
  }
  if (!String(job.output ?? "").trim()) gaps.push("The assembled answer is empty.");
  return gaps;
}

export async function runPlannedResponse({ request, fetchJob, progress, timeoutMs, pollMs = 1500, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const deadline = Date.now() + timeoutMs;
  // Bound even a stalled submission or poll. The underlying durable job is
  // retained by the control plane if the browser disconnects.
  const signal = AbortSignal.timeout(timeoutMs);
  let payload = await fetchJob("/v1/jobs", { method: "POST", body: JSON.stringify(request), signal });
  let job = payload.job ?? payload;
  const id = payload.job_id ?? job.job_id;
  if (!id) throw new Error("The planner did not return a job identifier.");
  while (Date.now() < deadline) {
    const nodes = job.graph?.nodes ?? [];
    progress({ id, completed: nodes.filter(node => node.status === "completed").length, total: nodes.length });
    if (["failed", "cancelled"].includes(job.status)) throw new Error(job.error || "A planned step could not finish.");
    if (job.status === "completed") {
      const gaps = plannedResponseGaps(job);
      if (gaps.length) throw new Error(`The answer is incomplete: ${gaps.join("; ")}`);
      return { ...job, job_id: id };
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    try {
      payload = await fetchJob(`/v1/jobs/${encodeURIComponent(id)}`, { signal });
      job = payload.job ?? payload;
    } catch (error) {
      if (signal.aborted || ![408, 425, 429, 500, 502, 503, 504].includes(error.statusCode)) throw error;
    }
  }
  throw new Error("The planned response timed out before every step finished.");
}
