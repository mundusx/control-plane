import test from "node:test";
import assert from "node:assert/strict";
import { webResearchRequest, fetchWebResearch } from "../src/web-research.js";
test('joined who-is typo keeps the requested identity and biography filters', () => {
  assert.deepEqual(webResearchRequest('who isa dave batalla'), {message: 'who is dave batalla', urls: [], researchMode: 'biography'});
});
import { streamChatTurn, submitChatTurn, configFromEnv } from "../src/main.js";

test("standalone assistant identity never enters web research", () => {
  for (const message of ["who are u", "Who r u?", "who are you?", "what are u?", "please introduce yourself", "who made you?"]) {
    assert.equal(webResearchRequest(message), null);
  }
  assert.equal(webResearchRequest("who is Donald Trump?").researchMode, "biography");
  assert.notEqual(webResearchRequest("who are u and what is the latest PostgreSQL version?"), null);
});

test("person lookup normalizes stray trailing underscores, spacing, and contractions before routing", () => {
  for (const message of ["who is alex eala_?", "who is alex eala__?!", "who’s alex eala?", "who   is alex   eala?", "ｗｈｏ is alex eala？"]) {
    const request = webResearchRequest(message);
    assert.equal(request.researchMode, "biography");
    assert.match(request.message, /^who is alex eala[?.!]*$/u);
  }
  assert.equal(webResearchRequest("what is user_name_?").message, "what is user_name_?");
  assert.equal(webResearchRequest("what is C++?").message, "what is C++?");
  assert.equal(webResearchRequest("who is alex_eala_?").message, "who is alex_eala_?");
});

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
test("unfamiliar factual questions research without a known brand or freshness keyword", () => {
  for (const message of ["what is kimi3?", "what is kimi 3", "what is muse glimmer", "search for muse glimmer", "explain quantum computing", "what is NovaEngine9?", "Have you heard of QubitFox?", "what are the newest battery technologies?"]) {
    assert.equal(webResearchRequest(message).researchMode, "factual");
  }
  assert.equal(webResearchRequest("what is 2 + 2?"), null);
  assert.equal(webResearchRequest("what is your name?"), null);
  assert.equal(webResearchRequest("what is the weather in Manila today?"), null);
  assert.equal(webResearchRequest("don't search what is kimi3?"), null);
});
test("professional follow-ups use user identity context, never an invented assistant biography", () => {
  const result = webResearchRequest("what did u check linkedin", [
    { role: "user", content: "Who is Dave Batalla?" },
    { role: "assistant", content: "He is a basketball player and actor." },
  ]);
  assert.equal(result.researchMode, "public_profiles");
  assert.match(result.context, /Dave Batalla/);
  assert.doesNotMatch(result.context, /basketball|actor/);
  assert.equal(webResearchRequest("Who is Dave Batalla?").researchMode, "biography");
  assert.equal(webResearchRequest("who is dave batalla?").researchMode, "biography");
  assert.deepEqual(webResearchRequest("who is alex eala"), { message: "who is alex eala", urls: [], researchMode: "biography" });
  assert.equal(webResearchRequest("OSINT Dave Batalla").researchMode, "public_profiles");
  assert.equal(webResearchRequest("Find a GitHub profile for Dave Batalla").researchMode, "public_profiles");
  assert.equal(webResearchRequest("Don't search LinkedIn for Dave Batalla"), null);
  assert.equal(webResearchRequest("Write a GitHub API function"), null);
  assert.equal(webResearchRequest("How do I create a GitHub repository?").researchMode, "factual");
  assert.doesNotThrow(() => webResearchRequest("what did u check linkedin", null));
});
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

test("general question streams wait for web retrieval and never silently guess on failure", async () => {
  for (const message of ["what is kimi 3", "what is muse glimmer"]) {
    let calls = 0;
    let wire = "";
    const response = { writeHead() {}, flushHeaders() {}, write(value) { wire += value; }, end(value) { wire += value; } };
    const result = await streamChatTurn(response, { message, toolMode: true }, config, async (url, options) => {
      assert.equal(url, "http://worker/research");
      assert.equal(JSON.parse(options.body).message, message);
      assert.equal(JSON.parse(options.body).researchMode, "factual");
      calls++;
      return Response.json({ content: "I could not verify this because retrieval failed.", sources: [], error: "retrieval_failed" });
    });
    assert.equal(calls, 1);
    assert.equal(result.tool, "web_research");
    assert.match(wire, /retrieval failed/);
    assert.doesNotMatch(wire, /does not exist|mid-2024/);
  }
});
