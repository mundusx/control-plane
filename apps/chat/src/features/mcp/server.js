import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { localProjectAuthority } from "../harness/project-policy.js";
import { CHAT_HARNESS_OPERATIONS } from "../harness/service.js";

const operationSchema = z.enum(CHAT_HARNESS_OPERATIONS);
const taskIdSchema = z.string().regex(/^htask_[A-Za-z0-9_-]+$/, "task_id is invalid");

export function createHarnessMcpServer({ authStore, harnessService, session }) {
  if (!authStore || !harnessService || !session?.id) {
    throw new TypeError("MCP server requires authenticated Harness dependencies");
  }

  const server = new McpServer({ name: "mundusx-harness", version: "1.0.0" }, {
    instructions: "MundusX Harness tools are user-scoped. Never claim a file, patch, merge, deployment, or validation changed until task evidence reports it. Applying, merging, UAT deployment, and production deployment require separate approval outside this MCP server.",
  });

  server.registerTool("mundusx_list_projects", {
    title: "List MundusX projects",
    description: "List GitHub repositories accessible to the authenticated MundusX user. Credentials are never returned.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, toolHandler(async () => ({ repositories: await authStore.repositories(session.id) })));

  server.registerTool("mundusx_read_repository", {
    title: "Read a bounded repository path",
    description: "Read a directory or bounded text file from a repository the authenticated user can access. Secret paths are blocked and obvious credentials are redacted.",
    inputSchema: z.object({
      repository_id: z.string().regex(/^\d+$/, "repository_id is invalid"),
      path: z.string().max(500).default(""),
      ref: z.string().max(200).default(""),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, toolHandler(async ({ repository_id, path, ref }) => authStore.repositoryContents(session.id, repository_id, path, ref)));

  server.registerTool("mundusx_list_runners", {
    title: "List the user's Harness runners",
    description: "Show only the authenticated user's local Harness runners and their current bounded capabilities.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, toolHandler(async () => ({ runners: await authStore.harnessRunners(session.id) })));

  server.registerTool("mundusx_submit_harness_task", {
    title: "Submit bounded Harness work",
    description: "Submit a sandbox or hybrid coding task for one authorized GitHub repository or local project. This does not approve apply, merge, or deployment.",
    inputSchema: z.object({
      repository_id: z.string().regex(/^\d+$/).optional(),
      project_slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80).optional(),
      project_template: z.enum(["generic", "java-maven"]).default("generic"),
      objective: z.string().min(1).max(4000),
      execution_mode: z.enum(["sandbox", "hybrid"]).default("sandbox"),
      allowed_operations: z.array(operationSchema).min(1).max(CHAT_HARNESS_OPERATIONS.length),
    }).refine((value) => Boolean(value.repository_id) !== Boolean(value.project_slug), {
      message: "Provide exactly one of repository_id or project_slug",
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, toolHandler(async (input) => {
    const authority = input.project_slug
      ? localProjectAuthority(session, input)
      : await authStore.harnessAuthority(
        session.id,
        input.repository_id,
        input.execution_mode,
        input.allowed_operations,
      );
    return harnessService.submitTask(input, { session, authority });
  }));

  server.registerTool("mundusx_get_harness_task", {
    title: "Get Harness task evidence",
    description: "Read task state and evidence only when the task belongs to the authenticated user.",
    inputSchema: z.object({ task_id: taskIdSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, toolHandler(async ({ task_id }) => harnessService.fetchTask(task_id, { session })));

  server.registerTool("mundusx_cancel_harness_task", {
    title: "Cancel a Harness task",
    description: "Request cancellation of a non-terminal Harness task owned by the authenticated user.",
    inputSchema: z.object({ task_id: taskIdSchema }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, toolHandler(async ({ task_id }) => harnessService.cancelTask(task_id, { session })));

  return server;
}

function toolHandler(action) {
  return async (input = {}) => {
    try {
      const payload = await action(input);
      return jsonToolResult(payload);
    } catch (error) {
      const payload = {
        error: String(error?.message || "MundusX Harness request failed"),
        status: Number(error?.statusCode || 500),
      };
      return { ...jsonToolResult(payload), isError: true };
    }
  };
}

function jsonToolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
