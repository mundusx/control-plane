import { httpError } from "../../shared/http-error.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function createLocalAgentHttpController({ authStore, readJsonBody, sendJson }) {
  if (!authStore || !readJsonBody || !sendJson) {
    throw new TypeError("Local agent HTTP controller dependencies are incomplete");
  }

  return async function handleLocalAgentRequest({ request, response, url }) {
    if (!url.pathname.startsWith("/api/agent/")) return false;

    if (request.method === "POST" && url.pathname === "/api/agent/bootstrap/sessions") {
      sendJson(response, 201, await authStore.createLocalAgentBootstrap(await readJsonBody(request)));
      return true;
    }
    const bootstrap = url.pathname.match(new RegExp(`^/api/agent/bootstrap/sessions/(${UUID})/(status|approval|approve)$`, "i"));
    if (bootstrap && request.method === "POST" && bootstrap[2] === "status") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await authStore.localAgentBootstrapStatus(bootstrap[1], body?.connector_token));
      return true;
    }
    if (bootstrap && request.method === "POST" && bootstrap[2] === "approval") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await authStore.localAgentBootstrapApproval(bootstrap[1], body?.approval_token));
      return true;
    }
    if (bootstrap && request.method === "POST" && bootstrap[2] === "approve") {
      const session = await requireSession(request, authStore);
      authStore.requireCsrf(request, session);
      const body = await readJsonBody(request);
      sendJson(response, 200, await authStore.approveLocalAgentBootstrap(session.id, bootstrap[1], body?.approval_token));
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/connector/register") {
      const connector = await requireConnector(request, authStore);
      sendJson(response, 200, await authStore.registerLocalAgent(connector.id, await readJsonBody(request)));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/agent/connector/tasks/next") {
      const connector = await requireConnector(request, authStore);
      const body = await readJsonBody(request);
      const task = await authStore.claimLocalAgentTask(connector.id, body?.connection_id);
      sendJson(response, 200, { task });
      return true;
    }
    const connectorTask = url.pathname.match(new RegExp(`^/api/agent/connector/tasks/(${UUID})/(events|complete|heartbeat)$`, "i"));
    if (connectorTask && request.method === "POST") {
      const connector = await requireConnector(request, authStore);
      const body = await readJsonBody(request);
      const result = connectorTask[2] === "events"
        ? await authStore.appendLocalAgentEvents(connector.id, connectorTask[1], body?.events)
        : connectorTask[2] === "heartbeat"
          ? await authStore.heartbeatLocalAgentTask(connector.id, body?.connection_id, connectorTask[1])
          : await authStore.completeLocalAgentTask(connector.id, connectorTask[1], body);
      sendJson(response, 200, result);
      return true;
    }

    const session = await requireSession(request, authStore);
    if (request.method === "GET" && url.pathname === "/api/agent/status") {
      sendJson(response, 200, await authStore.localAgentStatus(session.id));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/agent/tasks") {
      authStore.requireCsrf(request, session);
      const body = await readJsonBody(request);
      if (body?.conversation_id || body?.conversationId) {
        await authStore.authorizeConversation(
          session.id,
          body.conversation_id || body.conversationId,
          true,
        );
      }
      sendJson(response, 202, await authStore.createLocalAgentTask(session.id, body));
      return true;
    }
    const browserTask = url.pathname.match(new RegExp(`^/api/agent/tasks/(${UUID})(/cancel)?$`, "i"));
    if (browserTask && request.method === "GET" && !browserTask[2]) {
      sendJson(response, 200, await authStore.localAgentTask(session.id, browserTask[1]));
      return true;
    }
    if (browserTask && request.method === "POST" && browserTask[2] === "/cancel") {
      authStore.requireCsrf(request, session);
      sendJson(response, 200, await authStore.cancelLocalAgentTask(session.id, browserTask[1]));
      return true;
    }
    return false;
  };
}

async function requireConnector(request, authStore) {
  const session = await authStore.mcpSession(request);
  if (!session) throw httpError(401, "A valid MundusX connection token is required");
  return session;
}

async function requireSession(request, authStore) {
  const session = request.mundusxSession ?? await authStore.session(request);
  if (!session) throw httpError(401, "Authentication is required for local agent work");
  return session;
}
