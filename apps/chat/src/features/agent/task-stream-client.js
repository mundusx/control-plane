const localTaskReaders = new Map();

async function nextLocalTaskResponse(taskId) {
  let stream = localTaskReaders.get(taskId);
  try {
    if (!stream) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let response;
      try { response = await fetch("/api/agent/tasks/" + encodeURIComponent(taskId) + "/stream", {signal:controller.signal}); }
      finally { clearTimeout(timeout); }
      if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
        controller.abort();
        throw new Error("Task stream unavailable");
      }
      stream = {controller, reader:response.body.getReader(), decoder:new TextDecoder(), buffer:""};
      localTaskReaders.set(taskId, stream);
    }
    while (true) {
      const boundary = stream.buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const event = stream.buffer.slice(0, boundary);
        stream.buffer = stream.buffer.slice(boundary + 2);
        const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const payload = JSON.parse(data);
        if (["completed", "failed", "cancelled"].includes(payload.state)) closeLocalTaskStream(taskId);
        return new Response(data, {headers:{"Content-Type":"application/json"}});
      }
      const timeout = setTimeout(() => stream.controller.abort(), 15000);
      let chunk;
      try { chunk = await stream.reader.read(); } finally { clearTimeout(timeout); }
      if (chunk.done) throw new Error("Task stream ended");
      stream.buffer += stream.decoder.decode(chunk.value, {stream:true});
    }
  } catch {
    closeLocalTaskStream(taskId);
    await sleep(500);
    return fetch("/api/agent/tasks/" + encodeURIComponent(taskId));
  }
}

function closeLocalTaskStream(taskId) {
  localTaskReaders.get(taskId)?.controller.abort();
  localTaskReaders.delete(taskId);
}
window.addEventListener("pagehide", () => {
  for (const taskId of localTaskReaders.keys()) closeLocalTaskStream(taskId);
});

function renderLocalAgentAnswer(pending, payload) {
  const text = payload?.answer?.event?.metadata?.text;
  if (typeof text !== "string") return;
  let section = pending.querySelector(".agent-answer-preview");
  if (!text) { section?.remove(); return; }
  if (!section) {
    section = document.createElement("section");
    section.className = "agent-answer-preview";
    pending.appendChild(section);
  }
  if (section.dataset.sequence === String(payload.answer.sequence)) return;
  section.dataset.sequence = String(payload.answer.sequence);
  section.replaceChildren();
  const label = document.createElement("div");
  label.className = "meta";
  label.textContent = payload.answer.event.metadata.truncated
    ? "Hermes · Current step preview (earlier text omitted)" : "Hermes · Current step";
  section.appendChild(label);
  appendRichMessage(section, text);
  scrollChatToLatest();
}
