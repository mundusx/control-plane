import { createControlPlaneHarnessTaskGateway } from "../../adapters/control-plane/harness-task-gateway.js";
import { httpError } from "../../shared/http-error.js";

export const CHAT_HARNESS_OPERATIONS = Object.freeze([
  "repository.status",
  "repository.diff",
  "file.read",
  "file.search",
  "patch.apply",
  "validation.run",
]);

const CHAT_HARNESS_OPERATION_SET = new Set(CHAT_HARNESS_OPERATIONS);

export function createHarnessService({ config, gateway } = {}) {
  if (!config) {
    throw new TypeError("Harness service requires config");
  }

  const token = config.harnessServiceToken || config.operatorToken;
  const taskGateway = gateway || (token
    ? createControlPlaneHarnessTaskGateway({
      controlPlaneUrl: config.controlPlaneUrl,
      token,
    })
    : null);

  return Object.freeze({
    async submitTask(body, { session = null, authority = null } = {}) {
      if (!config.harnessUiEnabled) {
        throw httpError(404, "Coding Harness is not enabled");
      }
      requireConfiguredGateway(token, taskGateway);

      const grant = !authority && session
        ? session.harness_grants?.find((candidate) => candidate.grant_id === body?.grant_id)
        : null;
      if (session && !grant && !authority) {
        throw httpError(403, "No repository authority permits this Harness request");
      }

      const boundary = resolveHarnessBoundary({ config, authority, grant });
      const objective = String(body?.objective ?? "").trim();
      if (!objective || objective.length > 4000) {
        throw httpError(400, "objective must contain 1 to 4000 characters");
      }

      const executionMode = String(body?.execution_mode ?? "sandbox");
      if (!["sandbox", "hybrid"].includes(executionMode)) {
        throw httpError(400, "execution_mode must be sandbox or hybrid");
      }
      if ((authority || grant) && !(authority?.allowed_execution_modes ?? grant?.allowed_execution_modes)?.includes(executionMode)) {
        throw httpError(403, "The repository grant does not permit this execution mode");
      }

      const allowedOperations = normalizeAllowedOperations(body?.allowed_operations);
      const payload = await taskGateway.createTask({
        harness_contract_version: "1.0",
        tenant_id: boundary.tenantId,
        repository_source_id: boundary.repositorySourceId,
        objective,
        base_revision: boundary.baseRevision,
        allowed_path_prefixes: boundary.allowedPathPrefixes,
        execution_mode: executionMode,
        allowed_operations: allowedOperations,
        validation_profiles: boundary.validationProfiles,
        requested_by_user_id: session?.id ?? null,
        submitted_via: session ? "mundusx-chat" : "service",
      });

      if (!payload.task_id) {
        throw httpError(502, "control plane did not return a Harness task id");
      }
      return { task_id: payload.task_id, state: payload.state ?? "created", approval: "required" };
    },

    async fetchTask(taskId, { session = null } = {}) {
      requireConfiguredGateway(token, taskGateway);
      const payload = await taskGateway.getTask(taskId);
      if (!payload.task || (session && payload.task.requested_by_user_id !== session.id)) {
        throw httpError(404, "Harness task is not available to this user");
      }
      return payload;
    },

    async cancelTask(taskId, { session = null } = {}) {
      requireConfiguredGateway(token, taskGateway);
      const current = await taskGateway.getTask(taskId);
      if (!current.task || !session || current.task.requested_by_user_id !== session.id) {
        throw httpError(404, "Harness task is not available to this user");
      }
      return taskGateway.cancelTask(taskId);
    },
  });
}

export async function submitHarnessTask(body, config, fetchImpl = fetch, session = null, authority = null) {
  return createHarnessService({
    config,
    gateway: configuredGateway(config, fetchImpl),
  }).submitTask(body, { session, authority });
}

export async function fetchHarnessTask(taskId, config, fetchImpl = fetch, session = null) {
  return createHarnessService({
    config,
    gateway: configuredGateway(config, fetchImpl),
  }).fetchTask(taskId, { session });
}

function configuredGateway(config, fetchImpl) {
  const token = config?.harnessServiceToken || config?.operatorToken;
  if (!token) return null;
  return createControlPlaneHarnessTaskGateway({
    controlPlaneUrl: config.controlPlaneUrl,
    token,
    fetchImpl,
  });
}

function requireConfiguredGateway(token, gateway) {
  if (!token || !gateway) {
    throw httpError(503, "Coding Harness service authentication is not configured");
  }
}

function resolveHarnessBoundary({ config, authority, grant }) {
  const tenantId = authority?.tenant_id ?? grant?.tenant_id ?? config.harnessTenantId;
  const repositorySourceId = authority?.repository_source_id ?? grant?.repository_source_id ?? config.harnessRepositorySourceId;
  const allowedPathPrefixes = authority?.allowed_path_prefixes ?? grant?.allowed_path_prefixes ?? splitConfigList(config.harnessAllowedPathPrefixes);
  const validationProfiles = authority?.validation_profiles ?? grant?.validation_profiles ?? splitConfigList(config.harnessValidationProfiles);
  const baseRevision = authority?.base_revision ?? config.harnessBaseRevision;

  if (
    !tenantId ||
    !repositorySourceId ||
    !/^[0-9a-f]{40}$/.test(baseRevision) ||
    !allowedPathPrefixes?.length ||
    !validationProfiles?.length
  ) {
    throw httpError(503, "Coding Harness project boundary is incomplete");
  }

  return { tenantId, repositorySourceId, allowedPathPrefixes, validationProfiles, baseRevision };
}

function normalizeAllowedOperations(value) {
  const operations = Array.isArray(value) ? [...new Set(value.map(String))] : [];
  if (operations.length === 0 || operations.some((operation) => !CHAT_HARNESS_OPERATION_SET.has(operation))) {
    throw httpError(400, "allowed_operations contains an unavailable tool");
  }
  return operations;
}

function splitConfigList(value) {
  return String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
}
