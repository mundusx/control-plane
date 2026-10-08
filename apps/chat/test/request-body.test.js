import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readJsonBody } from "../src/main.js";

test("agent model bodies can exceed 64 KB; oversize bodies receive HTTP 413 instead of a dropped socket", async (t) => {
  const server = createServer(async (request, response) => {
    try {
      const body = await readJsonBody(request, request.url === "/model" ? 32 * 1024 * 1024 : undefined);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ length: body.content?.length || 0 }));
    } catch (error) {
      response.writeHead(error.statusCode || 500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const post = (path, content) => fetch(base + path, { method: "POST", body: JSON.stringify({ content }) });
  const model = await post("/model", "x".repeat(70000));
  assert.equal(model.status, 200);
  assert.equal((await model.json()).length, 70000);
  const ordinary = await post("/ordinary", "x".repeat(70000));
  assert.equal(ordinary.status, 413);
  assert.match((await ordinary.json()).error, /too large/);
  const unicode = await post("/ordinary", "界".repeat(23000));
  assert.equal(unicode.status, 413, "limit counts UTF-8 bytes rather than characters");
  await unicode.text();
  const largeContext = await post("/model", 'code with Unicode 界 and "quotes"\n'.repeat(131072));
  assert.equal(largeContext.status, 200, "large model context survives JSON and Unicode overhead");
  await largeContext.text();
  const oversizedModel = await post("/model", "x".repeat(32 * 1024 * 1024));
  assert.equal(oversizedModel.status, 413);
  await oversizedModel.text();
  const healthy = await post("/ordinary", "still working");
  assert.equal(healthy.status, 200);
  await healthy.text();
});

test("model discovery reports the deployed 131072-token window", async () => {
  const { openAiModelsResponse } = await import("../src/main.js");
  const model = openAiModelsResponse().data[0];
  assert.equal(model.context_length, 131072);
  assert.equal(model.max_model_len, 131072);
});

test("model context errors retain their status rather than becoming retryable outages", async () => {
  const { relayNativeHermesToolStream } = await import("../src/main.js");
  for (const status of [400, 413, 422]) {
    let calls = 0;
    await assert.rejects(relayNativeHermesToolStream({}, { messages: [], tools: [] }, {
      agentModelProviders: [{ baseUrl: "https://model.test", model: "test" }],
    }, async () => {
      calls++;
      return new Response("maximum context length exceeded", { status });
    }), (error) => error.statusCode === status && /context length/.test(error.message));
    assert.equal(calls, 1);
  }
});
