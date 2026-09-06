import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createHarnessMcpServer } from "./server.js";

export function createMcpHttpController({ enabled, authStore, harnessService, publicOrigin, sendJson }) {
  return async function handleMcpRequest({ request, response, url }) {
    if (url.pathname !== "/mcp") return false;
    if (!enabled) {
      sendJson(response, 404, { error: "MundusX Harness MCP is not enabled" });
      return true;
    }

    const origin = String(request.headers.origin || "");
    if (origin && origin !== publicOrigin) {
      sendJson(response, 403, { error: "MCP origin is not allowed" });
      return true;
    }

    const session = await authStore.mcpSession(request);
    if (!session) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="MundusX Harness MCP"');
      sendJson(response, 401, { error: "A valid MundusX MCP access token is required" });
      return true;
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Use POST for this stateless MCP endpoint" });
      return true;
    }

    const server = createHarnessMcpServer({ authStore, harnessService, session });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      await transport.handleRequest(request, response);
    } finally {
      await server.close().catch(() => {});
    }
    return true;
  };
}
