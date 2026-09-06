import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createControlPlaneHarnessTaskGateway } from "../src/adapters/control-plane/harness-task-gateway.js";
import { createHarnessHttpController } from "../src/features/harness/http-controller.js";
import { localProjectAuthority } from "../src/features/harness/project-policy.js";
import { createHarnessService } from "../src/features/harness/service.js";

test("local project policy derives a bounded owner authority", () => {
  const session = { id: "ad36260d-40bc-44a9-b637-d03093e1f310" };
  const authority = localProjectAuthority(session, {
    project_slug: "my-java-program",
    project_template: "java-maven",
  });

  assert.equal(authority.tenant_id, `owner:${session.id}`);
  assert.equal(authority.repository_source_id, `local-project:${session.id}:java-maven:my-java-program`);
  assert.equal(authority.base_revision, "0".repeat(40));
  assert.deepEqual(authority.validation_profiles, ["java-maven-test"]);
  assert.ok(authority.allowed_path_prefixes.includes("src"));
  assert.throws(() => localProjectAuthority(session, { project_slug: "My Project" }), /lowercase hyphenated/);
  assert.throws(() => localProjectAuthority(null, { project_slug: "valid" }), (error) => error.statusCode === 401);
});

test("Harness service submits only its resolved project boundary", async () => {
  let submitted;
  const service = createHarnessService({
    config: harnessConfig({
      harnessTenantId: "ehda-uat",
      harnessRepositorySourceId: "github:mundusx/control-plane",
      harnessBaseRevision: "a".repeat(40),
      harnessAllowedPathPrefixes: "apps/control-plane,docs",
      harnessValidationProfiles: "control-plane-tests",
    }),
    gateway: {
      async createTask(payload) {
        submitted = payload;
        return { task_id: "htask_abc", state: "created" };
      },
    },
  });

  const result = await service.submitTask({
    objective: "Add a bounded test",
    repository_source_id: "github:attacker/override",
    allowed_operations: ["file.read", "validation.run"],
    execution_mode: "sandbox",
  });

  assert.equal(submitted.repository_source_id, "github:mundusx/control-plane");
  assert.equal(submitted.tenant_id, "ehda-uat");
  assert.deepEqual(submitted.allowed_path_prefixes, ["apps/control-plane", "docs"]);
  assert.deepEqual(result, { task_id: "htask_abc", state: "created", approval: "required" });
});

test("Harness service derives authority from the authenticated grant", async () => {
  let submitted;
  const service = createHarnessService({
    config: harnessConfig({ harnessBaseRevision: "b".repeat(40) }),
    gateway: {
      async createTask(payload) {
        submitted = payload;
        return { task_id: "htask_user", state: "created" };
      },
    },
  });
  const session = {
    id: "ad36260d-40bc-44a9-b637-d03093e1f310",
    harness_grants: [{
      grant_id: "grant-1",
      tenant_id: "tenant-authorized",
      repository_source_id: "github:mundusx/authorized",
      allowed_path_prefixes: ["apps/chat"],
      validation_profiles: ["chat-tests"],
      allowed_execution_modes: ["sandbox"],
    }],
  };

  await service.submitTask({
    grant_id: "grant-1",
    objective: "Test account-bound submission",
    execution_mode: "sandbox",
    allowed_operations: ["file.read", "validation.run"],
    tenant_id: "tenant-attacker",
  }, { session });

  assert.equal(submitted.tenant_id, "tenant-authorized");
  assert.equal(submitted.repository_source_id, "github:mundusx/authorized");
  assert.equal(submitted.requested_by_user_id, session.id);
  assert.equal(submitted.submitted_via, "mundusx-chat");
});

test("Harness service exposes task evidence only to its requesting user", async () => {
  const payload = {
    task: { task_id: "htask_private", requested_by_user_id: "owner-user", state: "completed" },
    validations: [],
  };
  const service = createHarnessService({
    config: harnessConfig(),
    gateway: { async getTask() { return payload; } },
  });

  assert.equal((await service.fetchTask("htask_private", { session: { id: "owner-user" } })).task.task_id, "htask_private");
  await assert.rejects(
    service.fetchTask("htask_private", { session: { id: "different-user" } }),
    (error) => error.statusCode === 404,
  );
});

test("Harness service cancels a task only for its requesting user", async () => {
  const cancelled = [];
  const service = createHarnessService({
    config: harnessConfig(),
    gateway: {
      async getTask() {
        return { task: { task_id: "htask_private", requested_by_user_id: "owner-user" } };
      },
      async cancelTask(taskId) {
        cancelled.push(taskId);
        return { task_id: taskId, state: "cancelled" };
      },
    },
  });

  assert.deepEqual(
    await service.cancelTask("htask_private", { session: { id: "owner-user" } }),
    { task_id: "htask_private", state: "cancelled" },
  );
  await assert.rejects(
    service.cancelTask("htask_private", { session: { id: "different-user" } }),
    (error) => error.statusCode === 404,
  );
  assert.deepEqual(cancelled, ["htask_private"]);
});

test("control-plane Harness gateway owns transport details", async () => {
  let request;
  const gateway = createControlPlaneHarnessTaskGateway({
    controlPlaneUrl: "https://uat.mundusx.ai/",
    token: "service-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return textResponse({ task_id: "htask_gateway" });
    },
  });

  const payload = await gateway.createTask({ objective: "contract" });
  assert.equal(request.url, "https://uat.mundusx.ai/internal/harness/tasks");
  assert.equal(request.options.headers.Authorization, "Bearer service-token");
  assert.equal(request.options.headers["X-MundusX-Actor"], "mundusx-chat");
  assert.equal(payload.task_id, "htask_gateway");

  await gateway.cancelTask("htask_gateway");
  assert.equal(request.url, "https://uat.mundusx.ai/internal/harness/tasks/htask_gateway/cancel");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer service-token");
});

test("Harness HTTP controller handles runner inventory as a feature boundary", async () => {
  let rendered;
  const controller = createHarnessHttpController({
    authStore: {
      async session() { return { id: "owner-user" }; },
      async harnessRunners() {
        return [
          { local_projects: ["beta", "alpha"] },
          { local_projects: ["alpha"] },
        ];
      },
    },
    harnessService: {},
    readJsonBody: async () => ({}),
    sendJson: (_response, status, payload) => { rendered = { status, payload }; },
  });

  const handled = await controller({
    request: { method: "GET" },
    response: {},
    url: new URL("https://chat.mundusx.ai/api/harness/runners"),
  });

  assert.equal(handled, true);
  assert.equal(rendered.status, 200);
  assert.deepEqual(rendered.payload.projects, ["alpha", "beta"]);
});

test("Harness HTTP controller exposes unauthenticated runner bootstrap start and status only", async () => {
  const calls = [];
  let rendered;
  const controller = createHarnessHttpController({
    authStore: {
      async createHarnessRunnerBootstrap(body) { calls.push(["start", body]); return { session_id: "session" }; },
      async harnessRunnerBootstrapStatus(id, secret) { calls.push(["status", id, secret]); return { state: "pending" }; },
    },
    harnessService: {},
    readJsonBody: async (request) => request.body,
    sendJson: (_response, status, payload) => { rendered = { status, payload }; },
  });
  await controller({
    request: { method: "POST", body: { device_id: "device", public_key_hex: "ab".repeat(32) } },
    response: {},
    url: new URL("https://chat.mundusx.ai/api/harness/bootstrap/sessions"),
  });
  assert.equal(rendered.status, 201);
  await controller({
    request: { method: "POST", body: { bootstrap_secret: "secret" } },
    response: {},
    url: new URL("https://chat.mundusx.ai/api/harness/bootstrap/sessions/123e4567-e89b-42d3-a456-426614174000/status"),
  });
  assert.equal(rendered.status, 200);
  assert.deepEqual(calls.map((call) => call[0]), ["start", "status"]);
});

test("Harness feature boundaries do not depend on the legacy composition shell", () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
  const boundaryFiles = [
    "features/harness/project-policy.js",
    "features/harness/service.js",
    "features/harness/http-controller.js",
    "features/mcp/http-controller.js",
    "features/mcp/server.js",
    "adapters/control-plane/harness-task-gateway.js",
  ];
  for (const relativePath of boundaryFiles) {
    assert.doesNotMatch(readFileSync(resolve(sourceRoot, relativePath), "utf8"), /from\s+["'][^"']*main\.js["']/);
  }

  const compositionSource = readFileSync(resolve(sourceRoot, "main.js"), "utf8");
  assert.doesNotMatch(compositionSource, /\/internal\/harness\/tasks/);
  assert.doesNotMatch(compositionSource, /function\s+localProjectAuthority/);
  assert.match(compositionSource, /createHarnessHttpController/);
});

function harnessConfig(overrides = {}) {
  return {
    harnessUiEnabled: true,
    harnessServiceToken: "server-secret",
    operatorToken: "",
    controlPlaneUrl: "https://uat.mundusx.ai",
    harnessTenantId: "",
    harnessRepositorySourceId: "",
    harnessBaseRevision: "",
    harnessAllowedPathPrefixes: "",
    harnessValidationProfiles: "",
    ...overrides,
  };
}

function textResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
  };
}
