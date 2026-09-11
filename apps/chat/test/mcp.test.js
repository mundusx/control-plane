import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createMcpHttpController } from "../src/features/mcp/http-controller.js";

test("Harness MCP exposes only bounded user-scoped tools", async (context) => {
  let submitted;
  const authStore = {
    async mcpSession(request) {
      return request.headers.authorization === "Bearer test-user-token" ? { id: "user-1" } : null;
    },
    async repositories() { return [{ id: 42, full_name: "owner/repo", permissions: { pull: true, push: true } }]; },
    async repositoryContents() { return { path: "README.md", file: { content: "safe" } }; },
    async harnessRunners() { return [{ runner_id: "runner-1", ready: true, fresh: true }]; },
    async harnessAuthority(userId, repositoryId) {
      assert.equal(userId, "user-1");
      assert.equal(repositoryId, "42");
      return { tenant_id: "tenant-1", repository_source_id: "github:42:owner/repo" };
    },
    async createLocalAgentTask(userId, input) {
      assert.equal(userId, "user-1");
      assert.equal(input.workspace_relative, "local-project");
      return { task_id: "11111111-1111-4111-8111-111111111111", state: "queued" };
    },
  };
  const harnessService = {
    async submitTask(input, options) { submitted = { input, options }; return { task_id: "htask_1", approval: "required" }; },
    async fetchTask(taskId, { session }) { return { task: { task_id: taskId, requested_by_user_id: session.id } }; },
    async cancelTask(taskId) { return { task_id: taskId, state: "cancelled" }; },
  };
  const endpoint = await startMcpServer(context, { authStore, harnessService });
  const client = new Client({ name: "mundusx-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: "Bearer test-user-token" } },
  });
  await client.connect(transport);
  context.after(() => client.close());

  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    "mundusx_cancel_harness_task",
    "mundusx_create_github_repository",
    "mundusx_create_pull_request",
    "mundusx_get_harness_task",
    "mundusx_get_project_task",
    "mundusx_list_projects",
    "mundusx_list_runners",
    "mundusx_project_git_action",
    "mundusx_project_git_status",
    "mundusx_read_repository",
    "mundusx_submit_harness_task",
  ]);
  assert.equal(toolNames.some((name) => /approve|deploy|merge|shell/i.test(name)), false);

  const runners = await client.callTool({ name: "mundusx_list_runners", arguments: {} });
  assert.equal(runners.structuredContent.runners[0].runner_id, "runner-1");

  const submittedResult = await client.callTool({
    name: "mundusx_submit_harness_task",
    arguments: {
      repository_id: "42",
      objective: "Run bounded tests",
      execution_mode: "sandbox",
      allowed_operations: ["file.read", "validation.run"],
    },
  });
  assert.equal(submittedResult.structuredContent.approval, "required");
  assert.equal(submitted.options.session.id, "user-1");
  assert.equal(submitted.options.authority.repository_source_id, "github:42:owner/repo");

  const gitStatus = await client.callTool({
    name: "mundusx_project_git_status",
    arguments: { project_slug: "local-project" },
  });
  assert.equal(gitStatus.structuredContent.project_slug, "local-project");
  assert.equal(gitStatus.structuredContent.state, "queued");
});

test("Harness MCP rejects missing bearer credentials before protocol handling", async (context) => {
  const endpoint = await startMcpServer(context, {
    authStore: { async mcpSession() { return null; } },
    harnessService: {},
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /Bearer/);
});

test("Harness MCP rejects browser origins outside MundusX Chat", async (context) => {
  const endpoint = await startMcpServer(context, {
    authStore: { async mcpSession() { assert.fail("origin is checked before credentials"); } },
    harnessService: {},
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Origin: "https://attacker.example", Authorization: "Bearer token" },
    body: "{}",
  });
  assert.equal(response.status, 403);
});

async function startMcpServer(context, { authStore, harnessService }) {
  const controller = createMcpHttpController({
    enabled: true,
    authStore,
    harnessService,
    publicOrigin: "https://chat.mundusx.ai",
    sendJson(response, status, payload) {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    },
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!await controller({ request, response, url })) {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return new URL(`http://127.0.0.1:${server.address().port}/mcp`);
}
