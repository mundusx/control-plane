import test from "node:test";
import assert from "node:assert/strict";
import { submitOpenAiChatCompletion, configFromEnv } from "../src/main.js";

test("nonstream native requests preserve schemas, null content, and tool results", async () => {
  const body = { model: "public-alias", stream: false, tool_choice: "auto", max_tokens: 512,
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    messages: [{ role: "user", content: "Fix source" },
      { role: "assistant", content: null, tool_calls: [{ id: "read1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "read1", content: "actual source" }] };
  const expected = { id: "chatcmpl-native", choices: [{ index: 0, finish_reason: "tool_calls", message: {
    role: "assistant", content: null, tool_calls: [{ id: "compile1", type: "function", function: { name: "run_in_terminal", arguments: "{}" } }] } }], mundusx: { job_id: "job1" } };
  let calls = 0;
  const result = await submitOpenAiChatCompletion(body, configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://control.test" }), async (url, options) => {
    calls++;
    assert.equal(url, "https://control.test/v1/chat/completions");
    const sent = JSON.parse(options.body);
    assert.deepEqual(sent.messages, body.messages);
    assert.deepEqual(sent.tools, body.tools);
    assert.equal(sent.tool_choice, "auto");
    assert.equal(sent.stream, false);
    return new Response(JSON.stringify(expected), { status: 200 });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.choices, expected.choices);
  assert.deepEqual(result.mundusx, expected.mundusx);
});

test("a final native tool-result turn without definitions still uses the native endpoint", async () => {
  const body = { messages: [{ role: "user", content: "Run check" }, { role: "tool", tool_call_id: "check1", content: "Exit Code: 0" }] };
  const result = await submitOpenAiChatCompletion(body, configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://control.test" }), async (url, options) => {
    assert.equal(url, "https://control.test/v1/chat/completions");
    assert.deepEqual(JSON.parse(options.body).messages, body.messages);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Check passed" }, finish_reason: "stop" }] }));
  });
  assert.equal(result.choices[0].message.content, "Check passed");
});

test("native upstream errors and empty choices are not converted into fake success", async () => {
  const body = { messages: [{ role: "user", content: "Check" }], tools: [{ type: "function", function: { name: "check" } }] };
  const config = configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://control.test" });
  await assert.rejects(submitOpenAiChatCompletion(body, config, async () => new Response("runtime failed", { status: 502 })), /runtime failed/);
  await assert.rejects(submitOpenAiChatCompletion(body, config, async () => new Response('{"choices":[]}')), /no native completion choices/);
});
