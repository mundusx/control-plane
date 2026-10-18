import test from "node:test";
import assert from "node:assert/strict";

import { configFromEnv, createServerApp } from "../src/main.js";

test("authenticated completion cancellation forwards service credentials, not client credentials", async (t) => {
  const nativeFetch = globalThis.fetch;
  const upstreamCalls = [];
  globalThis.fetch = async (url, init) => {
    upstreamCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ job_id: "chatcmpl-stop", status: "cancelled" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = nativeFetch; });

  const server = createServerApp({
    ...configFromEnv({
      MUNDUSX_CONTROL_PLANE_URL: "https://gateway.test",
      MUNDUSX_OPERATOR_TOKEN: "internal-service-token",
      MUNDUSX_CHAT_API_KEYS: JSON.stringify([{ id: "client", key: "public-client-test-token-0123456789" }]),
    }),
    authStore: {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const response = await nativeFetch(
    `http://127.0.0.1:${server.address().port}/v1/chat/completions/chatcmpl-stop/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer public-client-test-token-0123456789",
        "X-MundusX-Resume-Token": "resume-private",
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "cancelled");
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, "https://gateway.test/v1/chat/completions/chatcmpl-stop/cancel");
  const headers = new Headers(upstreamCalls[0].init.headers);
  assert.equal(headers.get("X-MundusX-Resume-Token"), "resume-private");
  assert.equal(headers.get("Authorization"), "Bearer internal-service-token");
});

test("public streaming retention is opt-in and forwards only the explicit flag", async (t) => {
  const nativeFetch = globalThis.fetch;
  const upstreamCalls = [];
  globalThis.fetch = async (url, init) => {
    upstreamCalls.push({ url: String(url), init });
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { "Content-Type": "text/event-stream" },
    });
  };
  t.after(() => { globalThis.fetch = nativeFetch; });
  const server = createServerApp({ ...configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://gateway.test", MUNDUSX_OPERATOR_TOKEN: "service-test-token" }), authStore: {} });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const retention of [undefined, "false", "true"]) {
    const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(retention ? { "X-MundusX-Retain-On-Disconnect": retention } : {}) },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], stream: true }),
    });
    assert.equal(response.status, 200); await response.text();
    assert.match(response.headers.get("Access-Control-Allow-Headers"), /X-MundusX-Retain-On-Disconnect/);
    const headers = new Headers(upstreamCalls.at(-1).init.headers);
    assert.equal(headers.get("X-MundusX-Retain-On-Disconnect"), retention === "true" ? "true" : null);
    assert.equal(headers.get("Authorization"), "Bearer service-test-token");
  }
  assert.equal(upstreamCalls.length, 3);
});
