import { httpError } from "../../shared/http-error.js";

export function createControlPlaneHarnessTaskGateway({
  controlPlaneUrl,
  token,
  fetchImpl = fetch,
  actor = "mundusx-chat",
}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const baseUrl = String(controlPlaneUrl || "").replace(/\/+$/, "");

  return Object.freeze({
    async createTask(task) {
      const upstream = await fetchImpl(`${baseUrl}/internal/harness/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-MundusX-Actor": actor,
        },
        body: JSON.stringify(task),
      });
      return parseGatewayResponse(upstream);
    },

    async getTask(taskId) {
      const upstream = await fetchImpl(
        `${baseUrl}/internal/harness/tasks/${encodeURIComponent(taskId)}`,
        { headers: { Authorization: `Bearer ${token}`, "X-MundusX-Actor": actor } },
      );
      return parseGatewayResponse(upstream);
    },

    async cancelTask(taskId) {
      const upstream = await fetchImpl(
        `${baseUrl}/internal/harness/tasks/${encodeURIComponent(taskId)}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "X-MundusX-Actor": actor },
        },
      );
      return parseGatewayResponse(upstream);
    },
  });
}

async function parseGatewayResponse(upstream) {
  const text = await upstream.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!upstream.ok) {
    throw httpError(upstream.status, payload.error || `control plane returned ${upstream.status}`);
  }
  return payload;
}
