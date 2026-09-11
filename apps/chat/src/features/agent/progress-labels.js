function describeAgentProgress(event = {}, active = false) {
  event = event || {};
  const type = event?.type || "", metadata = event?.metadata || {};
  const tool = String(metadata.tool || "").replaceAll("_", " ");
  const activities = {
    build: ["Building the project", "Check whether the project compiles."],
    test: ["Running tests", "Check the behavior covered by the test suite."],
    verification: ["Running verification", "Check the project's reported behavior or build."],
    lint: ["Checking code quality", "Look for lint and formatting issues."],
    dependencies: ["Installing project dependencies", "Prepare the packages needed by the project."],
    run: ["Running the program", "Observe how the program behaves."],
    write: ["Updating project files", "Apply the requested implementation changes."],
    inspect: ["Inspecting the codebase", "Read project context before choosing the next change."],
    research: ["Looking up information", "Gather information for the current request."],
    delegation: ["Running independent tasks in parallel", "Gather bounded analysis or validation before the next dependent action."],
    command: ["Running a local command", "Execute the next command in the project workspace."],
  };
  if (["tool_started", "tool_proposed", "tool_completed"].includes(type)) {
    let activity = metadata.activity;
    if (!activity && metadata.verification === true) activity = "verification";
    if (!activity && ["read file", "search files", "read", "grep", "glob"].includes(tool)) activity = "inspect";
    if (!activity && ["write file", "apply patch", "patch", "write"].includes(tool)) activity = "write";
    if (!activity && tool === "delegate task") activity = "delegation";
    const [action, purpose] = activities[activity] || [tool ? "Using " + tool : "Running a project tool", "Execute the next tool action for this request."];
    const success = metadata.is_error === true ? false : metadata.success;
    const outcome = type !== "tool_completed" ? "running" : success === false ? "failed" : success === true ? "succeeded" : "unknown";
    let label = action;
    if (type === "tool_completed") label += outcome === "failed" ? " — failed" : outcome === "succeeded" ? " — succeeded" : " — finished";
    if (type === "tool_proposed") label = "Preparing: " + action;
    return {label, purpose: type === "tool_completed" && active ? "Waiting for the next agent action; this tool has finished." : purpose, source:"Tool", outcome};
  }
  const labels = {
    harness_started:["Opening the project workspace", "Prepare the harness for this request.", "Harness"],
    model_turn_queued:["Preparing a model request", "Gather the context for the next action.", "Harness"],
    model_requested:["Waiting for the model response", "A model request has been sent for the next action or answer.", "Model"],
    model_turn_completed:["Model request finished", "Waiting for the next agent action.", "Model"],
    model_failed:["Model connection failed", "The harness will report whether it can retry this request.", "Model"],
    context_compacted:["Condensing conversation context", "Make room to continue the current task.", "Harness"],
    file_changed:[String(event.summary || "Project file changed"), "A file change was detected in the project.", "Tool"],
    approval_resolved:[metadata.approved ? "Action approved" : "Action declined", "Apply the user's decision before proceeding.", "Harness"],
    verification_started:["Running verification", "Check the completed work.", "Tool"],
    verification_completed:["Verification finished", "Review the reported check results.", "Tool"],
  };
  if (type === "skills_selected") return {label:"Loaded skills: " + (Array.isArray(metadata.skills) ? metadata.skills : []).map(s => String(s).replaceAll("-", " ")).join(", "),purpose:"Use these workflows for this project task.",source:"Harness",outcome:"info"};
  const [label,purpose,source] = labels[type] || [String(event?.summary || "Waiting for the connector"), "The next update will appear when the harness reports activity.", "Harness"];
  return {label,purpose,source,outcome:type === "model_failed" ? "failed" : "info"};
}
