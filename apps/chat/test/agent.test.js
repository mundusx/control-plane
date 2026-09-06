import test from "node:test";
import assert from "node:assert/strict";

import { createLocalAgentHttpController } from "../src/features/agent/http-controller.js";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";

function controllerFixture(overrides = {}) {
  let rendered;
  const calls = [];
  const authStore = {
    async mcpSession() { return { id: "connector-user" }; },
    async session() { return { id: "browser-user" }; },
    requireCsrf() { calls.push(["csrf"]); },
    async authorizeConversation(...args) { calls.push(["conversation", ...args]); },
    async registerLocalAgent(...args) { calls.push(["register", ...args]); return { connection_id: TASK_ID }; },
    async claimLocalAgentTask(...args) { calls.push(["claim", ...args]); return null; },
    async heartbeatLocalAgentTask(...args) { calls.push(["heartbeat", ...args]); return { state: "cancelled" }; },
    async appendLocalAgentEvents(...args) { calls.push(["events", ...args]); return { accepted: 1 }; },
    async completeLocalAgentTask(...args) { calls.push(["complete", ...args]); return { state: "completed" }; },
    async localAgentStatus(...args) { calls.push(["status", ...args]); return { online: true }; },
    async createLocalAgentTask(...args) { calls.push(["create", ...args]); return { task_id: TASK_ID }; },
    async localAgentTask(...args) { calls.push(["task", ...args]); return { task_id: TASK_ID, state: "running" }; },
    async cancelLocalAgentTask(...args) { calls.push(["cancel", ...args]); return { state: "cancelled" }; },
    async createLocalAgentBootstrap(...args) { calls.push(["bootstrap", ...args]); return { session_id: TASK_ID }; },
    async localAgentBootstrapStatus(...args) { calls.push(["bootstrap-status", ...args]); return { state: "pending" }; },
    async localAgentBootstrapApproval(...args) { calls.push(["bootstrap-approval", ...args]); return { state: "pending" }; },
    async approveLocalAgentBootstrap(...args) { calls.push(["bootstrap-approve", ...args]); return { state: "approved" }; },
    ...overrides,
  };
  return {
    calls,
    controller: createLocalAgentHttpController({
      authStore,
      readJsonBody: async (request) => request.body || {},
      sendJson: (_response, status, payload) => { rendered = { status, payload }; },
    }),
    rendered: () => rendered,
  };
}

test("connector claims work with the MCP token identity", async () => {
  const fixture = controllerFixture();
  const handled = await fixture.controller({
    request: { method: "POST", body: { connection_id: TASK_ID } },
    response: {},
    url: new URL("https://chat.mundusx.ai/api/agent/connector/tasks/next"),
  });
  assert.equal(handled, true);
  assert.deepEqual(fixture.calls[0], ["claim", "connector-user", TASK_ID]);
  assert.deepEqual(fixture.rendered(), { status: 200, payload: { task: null } });
});

test("connector heartbeat exposes cancellation state", async () => {
  const fixture = controllerFixture();
  await fixture.controller({
    request: { method: "POST", body: { connection_id: TASK_ID } },
    response: {},
    url: new URL(`https://chat.mundusx.ai/api/agent/connector/tasks/${TASK_ID}/heartbeat`),
  });
  assert.deepEqual(fixture.calls[0], ["heartbeat", "connector-user", TASK_ID, TASK_ID]);
  assert.equal(fixture.rendered().payload.state, "cancelled");
});

test("browser task submission is session, CSRF, and conversation scoped", async () => {
  const fixture = controllerFixture();
  await fixture.controller({
    request: { method: "POST", body: { prompt: "inspect this repository", conversation_id: TASK_ID } },
    response: {},
    url: new URL("https://chat.mundusx.ai/api/agent/tasks"),
  });
  assert.deepEqual(fixture.calls.map((call) => call[0]), ["csrf", "conversation", "create"]);
  assert.equal(fixture.calls[1][1], "browser-user");
  assert.equal(fixture.rendered().status, 202);
});

test("local agent bootstrap starts without auth and approval requires browser session plus CSRF", async () => {
  const fixture = controllerFixture();
  await fixture.controller({ request: { method: "POST", body: { device_name: "Laptop" } }, response: {}, url: new URL("https://chat.mundusx.ai/api/agent/bootstrap/sessions") });
  assert.deepEqual(fixture.calls[0], ["bootstrap", { device_name: "Laptop" }]);
  assert.equal(fixture.rendered().status, 201);
  await fixture.controller({ request: { method: "POST", body: { approval_token: "secret" } }, response: {}, url: new URL(`https://chat.mundusx.ai/api/agent/bootstrap/sessions/${TASK_ID}/approve`) });
  assert.deepEqual(fixture.calls.slice(1).map((call) => call[0]), ["csrf", "bootstrap-approve"]);
  assert.equal(fixture.calls[2][1], "browser-user");
});

test("browser task submission forwards an explicit Hermes runtime selection", async () => {
  const fixture = controllerFixture();
  await fixture.controller({
    request: { method: "POST", body: { prompt: "inspect this repository", runtime: "hermes" } },
    response: {},
    url: new URL("https://chat.mundusx.ai/api/agent/tasks"),
  });
  const createCall = fixture.calls.find((call) => call[0] === "create");
  assert.equal(createCall[2].runtime, "hermes");
  assert.equal(fixture.rendered().status, 202);
});

test("connector endpoints reject missing MCP credentials", async () => {
  const fixture = controllerFixture({ async mcpSession() { return null; } });
  await assert.rejects(
    fixture.controller({
      request: { method: "POST", body: { connection_id: TASK_ID } },
      response: {},
      url: new URL("https://chat.mundusx.ai/api/agent/connector/tasks/next"),
    }),
    (error) => error.statusCode === 401,
  );
});
