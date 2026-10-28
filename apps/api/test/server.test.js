const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApi } = require("../src/server");
const { interactiveDefaults } = require("../src/policy");
const { toChat } = require("../src/responses");
async function fixture(t, handler, options = {}) {
  const upstream = http.createServer(handler);
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const gateway = createApi({
    upstreamUrl: "http://127.0.0.1:" + upstream.address().port,
    upstreamToken: "server-only-secret",
    authenticate: (k) =>
      k === "test-client-key" ? { id: "tester", user: "TESTER" } : null,
    recordUsage: () => {},
    ...options,
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  t.after(() => {
    gateway.closeAllConnections();
    gateway.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const base = "http://127.0.0.1:" + gateway.address().port;
  return {
    gateway,
    base,
    call: (path, body, auth = true) =>
      fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: "Bearer test-client-key" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
  };
}
const payload = {
  model: "mundusx-agnostic",
  messages: [
    { role: "system", content: "Keep my rules" },
    { role: "user", content: "Hello" },
  ],
};
test("health is public; model and inference routes require keys; administration is never proxied", async (t) => {
  let forwarded = 0;
  const f = await fixture(t, (_, res) => {
    forwarded++;
    res.end('{"object":"list","data":[]}');
  });
  assert.equal((await f.call("/health", undefined, false)).status, 200);
  assert.equal((await f.call("/v1/models", undefined, false)).status, 401);
  assert.equal((await f.call("/v1/nodes")).status, 404);
  assert.equal((await f.call("/api/admin")).status, 404);
  assert.equal(forwarded, 0);
  assert.equal((await f.call("/v1/models")).status, 200);
});
test("native messages, tools, choices and model reach upstream unchanged; client key is replaced", async (t) => {
  let got;
  const f = await fixture(t, (req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      got = JSON.parse(text);
      assert.equal(req.headers.authorization, "Bearer server-only-secret");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"x"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );
    });
  });
  const body = {
    ...payload,
    temperature: 0.2,
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ],
    tool_choice: "auto",
  };
  const r = await f.call("/v1/chat/completions", body);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].finish_reason, "tool_calls");
  assert.deepEqual(got, body);
});
test("SSE text and tool deltas are forwarded before the upstream finishes", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  t.after(() => release());
  const first =
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n';
  const f = await fixture(t, async (_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(first);
    await gate;
    res.end("data: [DONE]\n\n");
  });
  const r = await f.call("/v1/chat/completions", { ...payload, stream: true });
  const reader = r.body.getReader();
  const chunk = await reader.read();
  assert.equal(new TextDecoder().decode(chunk.value), first);
  release();
  let rest = "";
  for (;;) {
    const c = await reader.read();
    if (c.done) break;
    rest += new TextDecoder().decode(c.value);
  }
  assert.match(rest, /\[DONE\]/);
});
test("concurrency and malformed requests are bounded without leaking slots", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  t.after(() => release());
  const f = await fixture(
    t,
    async (_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
      await gate;
      res.end("data: [DONE]\n\n");
    },
    { maxConcurrent: 1 },
  );
  assert.equal((await f.call("/v1/chat/completions", {})).status, 400);
  const first = await f.call("/v1/chat/completions", {
    ...payload,
    stream: true,
  });
  const blocked = await f.call("/v1/chat/completions", payload);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "2");
  release();
  await first.text();
});
test("Nemotron fast default preserves explicit thinking and never alters native tool turns", () => {
  const ordinary = { ...payload, model: "nemotron-3.5-super-vl" };
  assert.equal(
    interactiveDefaults(ordinary).chat_template_kwargs.enable_thinking,
    false,
  );
  assert.equal(ordinary.chat_template_kwargs, undefined);
  assert.equal(
    interactiveDefaults({
      ...ordinary,
      chat_template_kwargs: { enable_thinking: true },
    }).chat_template_kwargs.enable_thinking,
    true,
  );
  assert.equal(
    interactiveDefaults({ ...ordinary, tools: [{ type: "function" }] })
      .chat_template_kwargs,
    undefined,
  );
  assert.equal(
    interactiveDefaults({ ...ordinary, reasoning_effort: "high" })
      .chat_template_kwargs,
    undefined,
  );
});
test("Responses input and function-call results convert without losing tool identity", () => {
  const p = toChat({
    model: "m",
    store: false,
    instructions: "Be concise",
    input: [
      {
        type: "function_call",
        call_id: "c",
        name: "read_file",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "c", output: "done" },
      { role: "user", content: [{ type: "input_text", text: "Continue" }] },
    ],
    tools: [
      { type: "function", name: "read_file", parameters: { type: "object" } },
    ],
  });
  assert.equal(p.messages[1].tool_calls[0].id, "c");
  assert.equal(p.messages[2].tool_call_id, "c");
  assert.equal(p.tools[0].function.name, "read_file");
  assert.throws(
    () => toChat({ model: "m", input: "x", previous_response_id: "resp_x" }),
    /Stateful/,
  );
});
test("Responses nonstream returns standard response, text and function call objects", async (t) => {
  const f = await fixture(t, (_, res) =>
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "Hello",
              tool_calls: [
                { id: "call1", function: { name: "read", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
    ),
  );
  const r = await f.call("/v1/responses", {
    model: "m",
    input: "Hi",
    store: false,
  });
  const p = await r.json();
  assert.equal(p.object, "response");
  assert.equal(p.status, "completed");
  assert.equal(p.output[0].content[0].text, "Hello");
  assert.equal(p.output[1].call_id, "call1");
  assert.equal(p.usage.total_tokens, 6);
});
test("Responses streams typed text and function-call events and completion usage", async (t) => {
  const f = await fixture(t, (_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of [
      { choices: [{ index: 0, delta: { content: "Hello " } }] },
      { choices: [{ index: 0, delta: { content: "world" } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call1",
                  type: "function",
                  function: { name: "read", arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      {
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
      },
    ])
      res.write("data: " + JSON.stringify(c) + "\n\n");
    res.end("data: [DONE]\n\n");
  });
  const r = await f.call("/v1/responses", {
    model: "m",
    input: "Hi",
    stream: true,
    store: false,
  });
  const text = await r.text();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(
    events.map((e) => e.sequence_number),
    events.map((_, i) => i),
  );
  assert.ok(events.some((e) => e.type === "response.output_text.delta"));
  assert.ok(
    events.some((e) => e.type === "response.function_call_arguments.delta"),
  );
  const last = events.at(-1);
  assert.equal(last.type, "response.completed");
  assert.equal(last.response.output[0].content[0].text, "Hello world");
  assert.equal(last.response.output[1].arguments, '{"path":"x"}');
  assert.equal(last.response.usage.total_tokens, 9);
});

test("oversized bodies return an OpenAI error and release capacity", async (t) => {
  const f = await fixture(t, (_, res) => res.end('{"data":[]}'), {
    maxBody: 128,
    maxConcurrent: 1,
  });
  const r = await f.call("/v1/chat/completions", {
    ...payload,
    messages: [{ role: "user", content: "x".repeat(256) }],
  });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error.type, "invalid_request_error");
  assert.equal((await f.call("/v1/models")).status, 200);
});
test("disconnect closes the upstream stream and frees the request slot", async (t) => {
  let aborted;
  const closed = new Promise((r) => (aborted = r));
  let requests = 0;
  const f = await fixture(
    t,
    (req, res) => {
      requests++;
      if (req.url === "/v1/models") return res.end('{"data":[]}');
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
      res.on("close", aborted);
    },
    { maxConcurrent: 1 },
  );
  const controller = new AbortController();
  const r = await fetch(f.base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer test-client-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...payload, stream: true }),
    signal: controller.signal,
  });
  await r.body.getReader().read();
  controller.abort();
  await closed;
  assert.equal((await f.call("/v1/models")).status, 200);
  assert.equal(requests, 2);
});

test("unsupported model features return explicit errors rather than silently degrading", async (t) => {
  const f = await fixture(t, () => {
    throw Error("Unsupported request must not reach upstream");
  });
  for (const body of [
    { ...payload, n: 2 },
    { ...payload, response_format: { type: "json_object" } },
  ])
    assert.equal((await f.call("/v1/chat/completions", body)).status, 400);
  for (const body of [
    { model: "m", input: "Hi", stream: "yes" },
    { model: "m", input: "Hi", text: { format: { type: "json_schema" } } },
  ])
    assert.equal((await f.call("/v1/responses", body)).status, 400);
});
test("an interrupted Responses upstream cannot produce a completed event", async (t) => {
  const f = await fixture(t, (_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "incomplete" } }],
        }) +
        "\n\n",
    );
  });
  const r = await f.call("/v1/responses", {
    model: "m",
    input: "Hi",
    stream: true,
  });
  let text = "",
    failed = false;
  const reader = r.body.getReader();
  try {
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      text += new TextDecoder().decode(c.value);
    }
  } catch {
    failed = true;
  }
  assert.equal(failed, true);
  assert.doesNotMatch(text, /response.completed/);
});
