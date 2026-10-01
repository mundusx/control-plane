import test from "node:test";
import assert from "node:assert/strict";
import { parseChatApiKeys, authenticateChatApiKey } from "../src/chat-api-keys.js";
import { configFromEnv, createServerApp } from "../src/main.js";

const key = "test-only-key-01234567890123456789";
const raw = JSON.stringify([{ id: "vscode-alice", key }]);

test("environment keys validate without exposing secrets and authenticate strictly", () => {
  assert.equal(parseChatApiKeys(undefined), null);
  for (const value of ["", "null", "{}", "secret-invalid-json", '[{"id":"a","key":"short"}]']) {
    assert.throws(() => parseChatApiKeys(value), /must be a JSON array/);
  }
  assert.throws(() => parseChatApiKeys(JSON.stringify([{ id: "a", key }, { id: "b", key }])));
  assert.throws(() => parseChatApiKeys(JSON.stringify([{ id: "a", key }, { id: "a", key: key + "2" }])));
  const keys = parseChatApiKeys(raw);
  assert.equal(JSON.stringify(keys).includes(key), false);
  assert.deepEqual(authenticateChatApiKey(`bEaReR ${key}`, keys), { id: "vscode-alice" });
  for (const header of [undefined, key, `Basic ${key}`, "Bearer wrong", `Bearer ${key} `]) {
    assert.equal(authenticateChatApiKey(header, keys), null);
  }
  assert.equal(authenticateChatApiKey(`Bearer ${key}`, []), null);
});

test("HTTP API requires configured keys before reading prompts, including streaming and cancellation", async (t) => {
  const server = createServerApp({ ...configFromEnv({ MUNDUSX_CHAT_API_KEYS: raw }), authStore: {} });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, method, body] of [
    ["/v1/models", "GET"],
    ["/v1/chat/completions", "POST", '{"stream":true}'],
    ["/v1/chat/completions", "POST", "invalid-json"],
    ["/v1/chat/completions/id/cancel", "POST", "{}"],
  ]) {
    for (const authorization of ["", "Bearer wrong"]) {
      const response = await fetch(base + path, { method, body, headers: { authorization } });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
      assert.equal((await response.json()).error.code, "invalid_api_key");
    }
  }
  const models = await fetch(base + "/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(models.status, 200);
  assert.ok(Array.isArray((await models.json()).data));
  const admitted = await fetch(base + "/v1/chat/completions", { method: "POST", body: "{}", headers: { Authorization: `Bearer ${key}` } });
  assert.equal(admitted.status, 400); // Reaches payload validation after authentication.
  const preflight = await fetch(base + "/v1/chat/completions", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal((await fetch(base + "/health")).status, 200);
});

test("an empty configured list denies keys instead of restoring anonymous access", async (t) => {
  const server = createServerApp({ ...configFromEnv({ MUNDUSX_CHAT_API_KEYS: "[]" }), authStore: {} });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(response.status, 401);
});
