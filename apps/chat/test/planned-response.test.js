import test from "node:test";
import assert from "node:assert/strict";
import { plannedResponseGaps, runPlannedResponse } from "../src/features/chat/planned-response.js";
import { answerCompletionGaps } from "../src/features/chat/answer-completion.js";
import { configFromEnv, streamChatTurn } from "../src/main.js";

function completed(output = "The requested result is 42.") {
  return { job_id: "planned-1", status: "completed", graph_execution_enabled: true,
    plan: { jobs: [{ id: "solve" }, { id: "assemble" }] },
    graph: { nodes: [{ id: "solve", status: "completed", output: "Working" }, { id: "assemble", status: "completed", output }] }, output };
}

test("completion requires every planned job and its output", () => {
  assert.deepEqual(plannedResponseGaps(completed()), []);
  const missing = completed(); missing.graph.nodes.pop();
  assert.match(plannedResponseGaps(missing).join(), /Missing planned step: assemble/);
  const empty = completed(); empty.graph.nodes[0].output = "";
  assert.match(plannedResponseGaps(empty).join(), /Unfinished planned step: solve/);
  assert.ok(plannedResponseGaps({ ...completed(), graph_execution_enabled: false }).length);
  assert.ok(plannedResponseGaps(completed("")).length);
});

test("durable planner polling survives a transient upstream failure", async () => {
  const paths = []; const updates = [];
  const result = await runPlannedResponse({ request: { execution_mode: "decompose" }, timeoutMs: 1000,
    sleep: async () => {}, progress: value => updates.push(value),
    fetchJob: async (path, init) => {
      paths.push(path);
      if (paths.length === 1) { assert.equal(JSON.parse(init.body).execution_mode, "decompose"); return { job_id: "planned-1", status: "queued" }; }
      if (paths.length === 2) throw Object.assign(new Error("busy"), { statusCode: 503 });
      return completed();
    },
  });
  assert.equal(result.job_id, "planned-1");
  assert.deepEqual(paths, ["/v1/jobs", "/v1/jobs/planned-1", "/v1/jobs/planned-1"]);
  assert.equal(updates.at(-1).completed, 2);
});

test("failed and incomplete planner jobs never count as completed responses", async () => {
  for (const job of [{ ...completed(), status: "failed", error: "Worker failed" }, { ...completed(), output: "" }]) {
    await assert.rejects(runPlannedResponse({ request: {}, timeoutMs: 1000, progress() {}, fetchJob: async () => job }), /failed|incomplete/i);
  }
});

function sse(text, finish = "stop") {
  return new Response(`data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}
async function chat(message, fetcher, extra = {}) {
  const events = []; const headers = [];
  const response = { writableEnded: false, writeHead: (status, value) => headers.push(value), flushHeaders() {}, write: value => events.push(value), end(value) { this.writableEnded = true; if (value) events.push(value); } };
  const result = await streamChatTurn(response, { message, historyMessages: [], toolMode: false, ...extra }, configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://control.test" }), fetcher);
  return { result, events: events.join(""), headers };
}

test("complex projects use the planner and publish only one final stream event", async () => {
  const requests = [];
  const output = "## README.md\n```markdown\n# Setup\nnpm install\n# Run\nnpm start\n```\n## Delivery summary\nThe API is provided. Run it as described above. It has not been tested here.";
  const reply = await chat("Create a complete Node.js carwash CRUD API with Swagger", async (url, init) => {
    requests.push(url);
    assert.ok(url.endsWith("/v1/jobs"));
    assert.equal(JSON.parse(init.body).execution_mode, "decompose");
    return Response.json(completed(output));
  });
  assert.equal(requests.length, 1);
  assert.equal(reply.headers.length, 1);
  assert.equal(reply.result.finishReason, "stop");
  assert.match(reply.events, /"progress"/);
  assert.equal((reply.events.match(/data: \[DONE\]/g) ?? []).length, 1);
});

test("advanced math uses planning while arithmetic remains direct", async () => {
  const planned = await chat("Prove the convergence of this infinite series and derive its error bound", async url => {
    assert.ok(url.endsWith("/v1/jobs")); return Response.json(completed("The series was not specified; please provide its terms."));
  });
  assert.equal(planned.result.finishReason, "stop");
  const direct = await chat("Calculate 2 + 2", async url => { assert.ok(url.endsWith("/v1/chat/completions")); return sse("2 + 2 = 4."); });
  assert.equal(direct.result.finishReason, "stop");
});

test("unfinished mathematical expressions resume even after a normal stop", async () => {
  let calls = 0;
  const reply = await chat("Calculate 2 + 2", async (_url, init) => {
    calls++;
    if (calls === 1) return sse("2 + 2 =");
    const prompt = JSON.parse(init.body).messages.at(-1).content;
    const anchor = prompt.match(/CONTINUATION_ANCHOR:\n([\s\S]*?)\nEND_CONTINUATION_ANCHOR/)?.[1] ?? "";
    return sse(anchor + " 4.");
  });
  assert.equal(calls, 2);
  assert.equal(reply.result.content, "2 + 2 = 4.");
  assert.equal(reply.result.finishReason, "stop");
  assert.ok(answerCompletionGaps("\\[x = 4", "Solve x + 1 = 5").length);
});

test("an incomplete graph is surfaced as an error, never a successful stop", async () => {
  const job = completed(); job.graph.nodes.pop();
  const reply = await chat("Create a complete Node.js carwash CRUD API with Swagger", async () => Response.json(job));
  assert.equal(reply.result.finishReason, "error");
  assert.match(reply.events, /Missing planned step/);
  assert.doesNotMatch(reply.events, /"finish_reason":"stop"/);
});

test("a capped planned synthesis continues through the direct stream", async () => {
  const urls = [];
  const reply = await chat("Solve the integral of sin(x) and explain the result", async (url, init) => {
    urls.push(url);
    if (url.endsWith("/v1/jobs")) return Response.json({ ...completed("The antiderivative is"), finish_reason: "length" });
    const prompt = JSON.parse(init.body).messages.at(-1).content;
    const anchor = prompt.match(/CONTINUATION_ANCHOR:\n([\s\S]*?)\nEND_CONTINUATION_ANCHOR/)?.[1] ?? "";
    return sse(anchor + " -cos(x) + C. Differentiating gives sin(x).");
  });
  assert.equal(urls.length, 2);
  assert.ok(urls[1].endsWith("/v1/chat/completions"));
  assert.equal(reply.headers.length, 1);
  assert.equal(reply.result.finishReason, "stop");
  assert.match(reply.result.content, /Differentiating gives sin/);
});

test("planner timeout and permanent polling errors stop the response", async () => {
  await assert.rejects(runPlannedResponse({ request: {}, timeoutMs: 1, progress() {},
    sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    fetchJob: async () => ({ job_id: "pending", status: "queued" }),
  }), /timed out/);
  let calls = 0;
  await assert.rejects(runPlannedResponse({ request: {}, timeoutMs: 1000, progress() {}, sleep: async () => {},
    fetchJob: async () => { if (++calls === 1) return { job_id: "pending" }; throw Object.assign(new Error("unauthorized"), { statusCode: 401 }); },
  }), /unauthorized/);
});
