import { httpError } from "../../shared/http-error.js";
import { localProjectAuthority } from "./project-policy.js";

export function createHarnessHttpController({
  authStore,
  harnessService,
  readJsonBody,
  sendJson,
}) {
  if (!authStore || !harnessService || !readJsonBody || !sendJson) {
    throw new TypeError("Harness HTTP controller dependencies are incomplete");
  }

  return async function handleHarnessRequest({ request, response, url }) {
    if (!url.pathname.startsWith("/api/harness/")) return false;

    if (request.method === "POST" && url.pathname === "/api/harness/bootstrap/sessions") {
      const body = await readJsonBody(request);
      sendJson(response, 201, await authStore.createHarnessRunnerBootstrap(body));
      return true;
    }

    const bootstrapMatch = url.pathname.match(/^\/api\/harness\/bootstrap\/sessions\/([0-9a-f-]{36})\/(status|approval|approve)$/i);
    if (bootstrapMatch && request.method === "POST" && bootstrapMatch[2] === "status") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await authStore.harnessRunnerBootstrapStatus(bootstrapMatch[1], body?.bootstrap_secret));
      return true;
    }
    if (bootstrapMatch && request.method === "POST" && bootstrapMatch[2] === "approval") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await authStore.harnessRunnerBootstrapApproval(bootstrapMatch[1], body?.approval_token));
      return true;
    }
    if (bootstrapMatch && request.method === "POST" && bootstrapMatch[2] === "approve") {
      const session = await requireSession(request, authStore);
      authStore.requireCsrf(request, session);
      const body = await readJsonBody(request);
      sendJson(response, 200, await authStore.approveHarnessRunnerBootstrap(session.id, bootstrapMatch[1], body?.approval_token));
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/harness/runners") {
      const session = await requireSession(request, authStore);
      const runners = await authStore.harnessRunners(session.id);
      const projects = Array.from(new Set(runners.flatMap((runner) => runner.local_projects || [])))
        .sort()
        .slice(0, 100);
      sendJson(response, 200, { runners, projects });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/harness/runners/pairing") {
      const session = await requireSession(request, authStore);
      authStore.requireCsrf(request, session);
      sendJson(response, 201, await authStore.createHarnessRunnerPairing(session.id));
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/harness/tasks") {
      const body = await readJsonBody(request);
      const session = await requireSession(request, authStore, "Authentication is required for Harness work");
      authStore.requireCsrf(request, session);
      const authority = body?.project_slug
        ? localProjectAuthority(session, body)
        : await authStore.harnessAuthority(
          session.id,
          body?.repository_id,
          String(body?.execution_mode || "sandbox"),
          body?.allowed_operations,
        );
      sendJson(response, 201, await harnessService.submitTask(body, { session, authority }));
      return true;
    }

    const taskMatch = url.pathname.match(/^\/api\/harness\/tasks\/(htask_[A-Za-z0-9_-]+)$/);
    if (request.method === "GET" && taskMatch) {
      const session = await requireSession(request, authStore);
      sendJson(response, 200, await harnessService.fetchTask(taskMatch[1], { session }));
      return true;
    }

    return false;
  };
}

async function requireSession(request, authStore, message = "Authentication required") {
  const session = request.mundusxSession ?? await authStore.session(request);
  if (!session) throw httpError(401, message);
  return session;
}
