import test from "node:test";
import assert from "node:assert/strict";
import { webResearchRequest, fetchWebResearch } from "../src/web-research.js";
import { streamChatTurn, submitChatTurn, configFromEnv } from "../src/main.js";

test("routes natural website questions and contextual follow-ups", () => {
  const question = "what can u tell from https://mundusx.ai/";
  assert.deepEqual(webResearchRequest(question).urls, ["https://mundusx.ai/"]);
  assert.deepEqual(webResearchRequest("What about its pricing?", [{ role: "user", content: question }]).urls, ["https://mundusx.ai/"]);
  assert.ok(webResearchRequest("Search the web for the latest Rust release"));
  assert.equal(webResearchRequest("Write a fetch function for https://mundusx.ai/"), null);
  assert.equal(webResearchRequest("Don't browse https://mundusx.ai/"), null);
  assert.equal(webResearchRequest("Explain `https://example.com` in this code"), null);
  assert.equal(webResearchRequest("What about its pricing?", [{ role: "assistant", content: question }]), null);
});

const config = configFromEnv({ MUNDUSX_WEB_RESEARCH_URL: "http://worker", MUNDUSX_WEB_RESEARCH_TOKEN: "test-token" });
test("worker failures remain truthful and do not fall back to model guesses", async () => {
  assert.match((await fetchWebResearch({}, config, async () => new Response("", { status: 429 }))).content, /busy/);
  assert.match((await fetchWebResearch({}, config, async () => { throw new Error("offline"); })).content, /could not be reached/);
});

test("both chat paths retrieve before answering without a project or device", async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url, "http://worker/research");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(options.body).urls, ["https://mundusx.ai/"]);
    calls++;
    return Response.json({ content: "Retrieved answer [Source](https://mundusx.ai/)", sources: ["https://mundusx.ai/"] });
  };
  const body = { message: "what can u tell from https://mundusx.ai/", toolMode: true };
  const result = await submitChatTurn(body, config, fetchImpl);
  assert.match(result.output, /Retrieved answer/);
  let wire = "";
  const response = { writeHead() {}, flushHeaders() {}, write(value) { wire += value; }, end(value) { wire += value; } };
  await streamChatTurn(response, body, config, fetchImpl);
  assert.match(wire, /Retrieved answer/);
  assert.match(wire, /\[DONE\]/);
  assert.equal(calls, 2);
});
