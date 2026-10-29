// A latency budget for agent clients, not a model tokenizer or context-window claim.
const instructions = m => ['system', 'developer'].includes(m.role);
const jsonSize = value => Buffer.byteLength(JSON.stringify(value) || '', 'utf8');
const estimate = bytes => Math.ceil(bytes / 3);

function agentRequest(body, headers = {}) {
  return /(?:vscode|vs-code|copilot)/i.test(String(headers['user-agent'] || '')) ||
    body.messages?.some(m => typeof m.content === 'string' && m.content.includes('<userRequest>')) ||
    (Array.isArray(body.tools) && body.tools.some(t => /(?:^|[_.:])(?:run_in_terminal|execute_command|run_command|bash|powershell|exec_command)$/i.test(t.function?.name || '')));
}

function breakdown(body) {
  const messages = body.messages || [];
  let current = messages.findLastIndex(m => m.role === 'user');
  if (current < 0) current = 0;
  const groups = { instructions: 0, tools: jsonSize(body.tools || []), history: 0, current_turn: 0, other: 0 };
  messages.forEach((m, i) => { groups[instructions(m) ? 'instructions' : i < current ? 'history' : 'current_turn'] += jsonSize(m); });
  const { messages: ignoredMessages, tools: ignoredTools, ...other } = body;
  groups.other = jsonSize(other);
  // Include JSON framing rather than undercounting the full forwarded request.
  const bytes = jsonSize(body);
  groups.other += Math.max(0, bytes - Object.values(groups).reduce((a, b) => a + b, 0));
  return { bytes, estimated_tokens: estimate(bytes), components_bytes: groups };
}

function budgetContext(input, headers = {}, options = {}) {
  const before = breakdown(input);
  if (!agentRequest(input, headers)) return { body: input, report: { applied: false, before, after: before } };
  const inputTokens = options.inputTokens ?? 24576;
  const totalTokens = options.totalTokens ?? 32768;
  const defaultOutput = options.outputTokens ?? 4096;
  for (const n of [inputTokens, totalTokens, defaultOutput]) {
    if (!Number.isSafeInteger(n) || n <= 0) throw Error('Invalid IDE context budget configuration');
  }
  const requested = input.max_completion_tokens ?? input.max_tokens ?? defaultOutput;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw Object.assign(Error('Output token limit must be a positive integer'), { status: 400, code: 'invalid_output_budget' });
  }
  const safety = 1024;
  const available = Math.min(inputTokens, totalTokens - requested - safety);
  const body = structuredClone(input);
  if (body.max_tokens === undefined && body.max_completion_tokens === undefined) body.max_tokens = defaultOutput;
  let droppedTurns = 0;
  let after = breakdown(body);
  // Evict complete user-led turns only; retain every instruction, the active turn,
  // and all tool calls/results inside retained turns. Never split a tool exchange.
  while (after.estimated_tokens > available) {
    const starts = body.messages.flatMap((m, i) => m.role === 'user' ? [i] : []);
    if (starts.length < 2) break;
    const end = starts[1];
    const removedIds = new Set(body.messages.slice(0, end).filter(m => !instructions(m)).flatMap(m => (m.tool_calls || []).map(c => c.id)));
    if (body.messages.slice(end).some(m => m.role === 'tool' && removedIds.has(m.tool_call_id))) break;
    if (body.messages.some(m => m.role === 'function' || m.function_call)) break;
    body.messages = body.messages.filter((m, i) => i >= end || instructions(m));
    if (!droppedTurns) body.messages.unshift({ role: 'developer', content: 'Context budget notice: older conversation turns were omitted. If a needed fact is missing, ask for it rather than infer it.' });
    droppedTurns++;
    after = breakdown(body);
  }
  const report = { applied: true, estimator: 'utf8_bytes_div_3', input_budget_tokens: available,
    total_budget_tokens: totalTokens, output_reserved_tokens: requested, safety_tokens: safety,
    dropped_turns: droppedTurns, before, after };
  if (available <= 0 || after.estimated_tokens > available) {
    throw Object.assign(Error(`IDE context budget exceeded before queuing: estimated input ${after.estimated_tokens} tokens, input allowance ${Math.max(0, available)}, output reserved ${requested}. Required instructions, tools and the current turn do not fit. Reduce attached context, use fewer tools or switch out of Agent mode for a greeting. No job was created. Token counts are estimates.`),
      { status: 400, code: 'context_budget_exceeded', contextBudget: { ...report, rejected: true } });
  }
  return { body, report };
}
module.exports = { budgetContext, breakdown, agentRequest };
