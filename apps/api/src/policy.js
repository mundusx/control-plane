// Ported from GX10 Nemotron interactive-chat optimization (13c65f9).
// Caller-specified reasoning and native tool turns remain authoritative.
function interactiveDefaults(input) {
  const body = structuredClone(input);
  const model = String(body.model || "")
    .split("/")
    .pop()
    .toLowerCase();
  if (
    (model === "nemotron-3.5-super-vl" ||
      model.startsWith("nvidia-nemotron-3.5-super-vl-")) &&
    !body.tools?.length &&
    body.reasoning_effort === undefined &&
    body.reasoning === undefined
  ) {
    body.chat_template_kwargs = {
      enable_thinking: false,
      ...body.chat_template_kwargs,
    };
  }
  return body;
}
module.exports = { interactiveDefaults };
