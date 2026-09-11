import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { localProjectAuthority } from "../harness/project-policy.js";
import { CHAT_HARNESS_OPERATIONS } from "../harness/service.js";

const operationSchema = z.enum(CHAT_HARNESS_OPERATIONS);
const taskIdSchema = z.string().regex(/^htask_[A-Za-z0-9_-]+$/, "task_id is invalid");
const localTaskIdSchema = z.string().uuid("task_id is invalid");
const projectSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);
const gitActionSchema = z.enum(["init", "clone", "commit", "fetch", "update_fast_forward", "create_branch", "set_github_remote", "push"]);

export function createHarnessMcpServer({ authStore, harnessService, session }) {
  if (!authStore || !harnessService || !session?.id) {
    throw new TypeError("MCP server requires authenticated Harness dependencies");
  }

  const server = new McpServer({ name: "mundusx-harness", version: "1.0.0" }, {
    instructions: "MundusX project and Harness tools are user-scoped. Never claim a file, Git operation, patch, merge, deployment, or validation changed until task evidence reports it. Remote merge, UAT deployment, and production deployment require separate authority.",
  });

  server.registerTool("mundusx_list_projects", {
    title: "List MundusX projects",
    description: "List GitHub repositories accessible to the authenticated MundusX user. Credentials are never returned.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, toolHandler(async () => ({ repositories: await authStore.repositories(session.id) })));

  server.registerTool("mundusx_create_github_repository", {
    title: "Create a GitHub repository",
    description: "Create a user-owned GitHub repository after the user has explicitly requested publication. The repository is empty when publishing an existing local project.",
    inputSchema: z.object({
      name: z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/),
      description: z.string().max(350).default(""),
      visibility: z.enum(["private", "public"]).default("private"),
      initialize: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, toolHandler((input) => authStore.createRepository(session.id, { ...input, template: "generic" })));

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

  server.registerTool("mundusx_project_git_status", {
    title: "Inspect local project Git status",
    description: "Ask the paired MundusX computer for the active branch, remote, synchronization counts, and changed files in one local project.",
    inputSchema: z.object({ project_slug: projectSlugSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, toolHandler(async ({ project_slug }) => submitProjectOperation(authStore, session, project_slug, { operation: "git_status" }, false)));

  server.registerTool("mundusx_project_git_action", {
    title: "Run a bounded local project Git action",
    description: "Initialize, clone, commit, fetch, fast-forward, create a branch, connect a GitHub remote, or push through the authenticated user's paired computer. Clone accepts an empty project folder. Force push and arbitrary remotes are unavailable.",
    inputSchema: z.object({
      project_slug: projectSlugSchema,
      action: gitActionSchema,
      message: z.string().min(1).max(200).optional(),
      branch: z.string().min(1).max(200).optional(),
      github_url: z.string().url().max(500).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, toolHandler(async ({ project_slug, action, message, branch, github_url }) => {
    const operation = {
      init: "git_init",
      clone: "git_clone",
      commit: "git_commit",
      fetch: "git_fetch",
      update_fast_forward: "git_update",
      create_branch: "git_create_branch",
      set_github_remote: "git_remote_set",
      push: "git_push",
    }[action];
    if (action === "commit" && !message) throw Object.assign(new Error("message is required for commit"), { statusCode: 400 });
    if (action === "create_branch" && !branch) throw Object.assign(new Error("branch is required when creating a branch"), { statusCode: 400 });
    if (["clone", "set_github_remote"].includes(action) && !github_url) throw Object.assign(new Error("github_url is required for this action"), { statusCode: 400 });
    return submitProjectOperation(authStore, session, project_slug, { operation, message, branch, url: github_url }, true);
  }));

  server.registerTool("mundusx_get_project_task", {
    title: "Get local project task result",
    description: "Read the state and evidence for a local project operation owned by the authenticated user.",
    inputSchema: z.object({ task_id: localTaskIdSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, toolHandler(async ({ task_id }) => authStore.localAgentTask(session.id, task_id)));

  server.registerTool("mundusx_create_pull_request", {
    title: "Create a GitHub pull request",
    description: "Open a pull request for a branch already pushed to an authorized GitHub repository.",
    inputSchema: z.object({
      repository_id: z.string().regex(/^\d+$/, "repository_id is invalid"),
      title: z.string().min(1).max(200),
      body: z.string().max(20_000).default(""),
      head: z.string().min(1).max(200),
      base: z.string().min(1).max(200).default("main"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, toolHandler(({ repository_id, ...input }) => authStore.createPullRequest(session.id, repository_id, input)));

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

async function submitProjectOperation(authStore, session, projectSlug, request, allowMutations) {
  const task = await authStore.createLocalAgentTask(session.id, {
    prompt: "MUNDUSX_PROJECT_IO_V1:" + JSON.stringify(request),
    workspace_relative: projectSlug,
    runtime: "auto",
    allow_mutations: allowMutations,
  });
  return { task_id: task.task_id, state: task.state || "queued", project_slug: projectSlug };
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
