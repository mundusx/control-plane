import test from "node:test";
import assert from "node:assert/strict";

import { configFromEnv, createServerApp } from "../src/main.js";

test("public completion cancellation forwards only the private resume token", async (t) => {
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
    ...configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://gateway.test" }),
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
        Authorization: "Bearer public-client-token",
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
  assert.equal(headers.get("Authorization"), null);
});
