export function applyHermesExecutionPolicy(task) {
  if (!task || task.runtime_selected !== "hermes" || task.allow_mutations !== true) return task;
  const prompt = String(task.prompt || "");
  if (prompt.startsWith("MUNDUSX_PROJECT_IO_V1:")) return task;
  const lower = prompt.toLowerCase();
  const sequential = ["do not use project swarm", "don't use project swarm", "without project swarm",
    "use one worker", "single worker", "work sequentially"].some(text => lower.includes(text));
  const explicit = ["use project swarm", "enable project swarm", "run project swarm", "start project swarm",
    "use parallel coding", "use parallel code", "code in parallel", "work in parallel",
    "separate functions at the same time"].some(text => lower.includes(text));
  if (explicit && !sequential) return {...task, execution_policy: "explicit-swarm"};
  // Compatibility for older connectors whose scope heuristics otherwise enable Swarm.
  // Keep the stored user prompt unchanged; this directive only travels to the worker.
  return {...task, execution_policy: "single-worker", prompt:
    "MUNDUSX_HERMES_EXECUTION_POLICY: Use one worker. Do not use Project Swarm.\n\n" + prompt};
}
