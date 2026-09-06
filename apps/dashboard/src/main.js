import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const controlPlaneUrl = process.env.MUNDUSX_CONTROL_PLANE_URL ?? "http://127.0.0.1:8787";
const port = Number(process.env.PORT ?? "3001");
const operatorToken =
  process.env.MUNDUSX_OPERATOR_TOKEN?.trim() || process.env.OPENGPU_OPERATOR_TOKEN?.trim() || "";
const appUrl = `http://127.0.0.1:${port}`;
const installReleaseBaseUrl =
  process.env.MUNDUSX_INSTALL_RELEASE_BASE_URL ?? "http://127.0.0.1:8788/releases/latest/download";
const installCommand = `RELEASE_BASE_URL=${installReleaseBaseUrl} bash install.sh`;
const controlPlaneLogoUrl =
  process.env.MUNDUSX_CONTROL_PLANE_LOGO_URL ??
  `${controlPlaneUrl}/assets/mundusx-logo.png`;

const sampleCompletedJobs = [
  {
    id: "job_8f21f3",
    model: "HuggingFaceTB/SmolLM2-135M-Instruct",
    prompt: "Summarize MundusX in one sentence.",
    status: "completed",
    credits: 0.5,
    duration: "11s",
    finished_at: "2m ago",
    node: "mac-mini-01",
    tokens: 126,
  },
  {
    id: "job_8f21be",
    model: "HuggingFaceTB/SmolLM2-135M-Instruct",
    prompt: "Write a friendly onboarding tip for first-time contributors.",
    status: "completed",
    credits: 0.75,
    duration: "18s",
    finished_at: "11m ago",
    node: "mac-mini-01",
    tokens: 180,
  },
  {
    id: "job_8f2184",
    model: "HuggingFaceTB/SmolLM2-135M-Instruct",
    prompt: "Draft a short reply explaining credit accrual.",
    status: "completed",
    credits: 0.62,
    duration: "14s",
    finished_at: "32m ago",
    node: "mac-mini-01",
    tokens: 148,
  },
  {
    id: "job_8f217c",
    model: "HuggingFaceTB/SmolLM2-135M-Instruct",
    prompt: "Translate our contributor portal into a friendlier sentence.",
    status: "completed",
    credits: 0.88,
    duration: "21s",
    finished_at: "48m ago",
    node: "mac-mini-01",
    tokens: 214,
  },
  {
    id: "job_8f2149",
    model: "HuggingFaceTB/SmolLM2-135M-Instruct",
    prompt: "Generate a brief status update for the operator dashboard.",
    status: "completed",
    credits: 0.7,
    duration: "15s",
    finished_at: "1h ago",
    node: "mac-mini-01",
    tokens: 160,
  },
  {
    id: "job_8f20f2",
    model: "HuggingFaceTB/SmolLM2-135M-Instruct",
    prompt: "Explain how a GPU owner checks credits.",
    status: "completed",
    credits: 0.65,
    duration: "13s",
    finished_at: "2h ago",
    node: "mac-mini-01",
    tokens: 152,
  },
];

const formatCount = (value) => new Intl.NumberFormat("en-US").format(Number(value ?? 0));
const formatCredits = (value) => {
  const normalized = Math.abs(Number(value ?? 0)) < 0.000001 ? 0 : Number(value ?? 0);
  return normalized.toFixed(2);
};

const escapeHtml = (input) =>
  String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const redactSensitiveText = (input) => {
  let text = String(input ?? "");
  if (!text) {
    return text;
  }
  text = text.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  );
  text = text.replace(/\bsk-proj-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_OPENAI_KEY]");
  text = text.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]");
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
  text = text.replace(
    /\b(api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|password|secret)\b(\s*[:=]\s*)(["']?)([^\s"',;]{8,})\3/gi,
    (_match, key, separator) => `${key}${separator}[REDACTED_SECRET]`,
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, "Bearer [REDACTED_TOKEN]");
  return text;
};

const displayText = (input) => redactSensitiveText(input);

const privateTextSummary = (input, label = "Content") => {
  const text = String(input ?? "").trim();
  if (!text) {
    return `${label} not recorded`;
  }
  return `${label} hidden for privacy (${text.length} chars)`;
};

const privatePayloadForDisplay = (value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => privatePayloadForDisplay(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, rawValue]) => {
      if (/^(prompt|system_prompt|message|content|output|response|result|final_output)$/i.test(key)) {
        return [key, privateTextSummary(rawValue, key)];
      }
      return [key, privatePayloadForDisplay(rawValue)];
    }),
  );
};

async function fetchJson(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(new URL(path, controlPlaneUrl), {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(operatorToken ? { Authorization: `Bearer ${operatorToken}` } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(path, body) {
  const response = await fetch(new URL(path, controlPlaneUrl), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(operatorToken ? { Authorization: `Bearer ${operatorToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.text();
    throw new Error(payload || `HTTP ${response.status}`);
  }
  return response.json();
}

function badge(label, tone = "neutral") {
  return `<span class="pill pill-${tone}">${escapeHtml(label)}</span>`;
}

function overrideStatus(node = {}) {
  const policyOverride = node.operator_policy_override ?? null;
  const computedDetail = node.computed_policy_allowed
    ? "computed policy allows work"
    : String(node.computed_policy_reason ?? "computed policy is blocking work");
  if (!policyOverride) {
    return {
      summary: "no operator override",
      detail: computedDetail,
    };
  }

  return {
    summary: `override ${String(policyOverride.target ?? "unknown")}`,
    detail: `${String(policyOverride.reason ?? "no reason")} • ${String(policyOverride.actor ?? "unknown actor")} • ${String(policyOverride.updated_at ?? "unknown time")} • ${computedDetail}`,
  };
}

function installManifest(installPath = "/install") {
  return {
    kind: "install-manifest",
    app: "mundusx",
    environment: "localhost-preview",
    release_base_url: installReleaseBaseUrl,
    install_command: installCommand,
    binary_name: "mundusx-aarch64-apple-darwin",
    checksum_name: "mundusx-aarch64-apple-darwin.sha256",
    landing_page: `${appUrl}${installPath}`,
    docs_page: `${appUrl}/docs/install`,
    onboarding_command: "mundusx onboarding",
    cap_command: "mundusx cap",
    start_command: "mundusx start",
    preview_note: "local preview only; public domain comes later",
  };
}

function renderCounts(snapshot = {}) {
  const cards = [
    ["Online", snapshot.online_count, "green"],
    ["Paused", snapshot.paused_count, "orange"],
    ["Policy blocked", snapshot.policy_blocked_count, "red"],
    ["Queued jobs", snapshot.queued_job_count, "blue"],
    ["Assigned jobs", snapshot.assigned_job_count, "amber"],
    ["Completed jobs", snapshot.completed_job_count, "green"],
    ["Failed jobs", snapshot.failed_job_count, "red"],
    ["Job events", snapshot.job_events, "neutral"],
  ];

  return cards
    .map(
      ([label, value, tone]) => `
        <div class="card">
          <div class="card-label">${escapeHtml(label)}</div>
          <div class="card-value">${formatCount(value)}</div>
          <div>${badge(tone === "neutral" ? "live" : tone, tone)}</div>
        </div>`,
    )
    .join("");
}

function plannerTone(planner = {}) {
  if (!planner.enabled) return "amber";
  if (planner.reachable && !planner.fallback_mode) return "green";
  return "red";
}

function plannerStatusLabel(planner = {}) {
  if (!planner.enabled) return "disabled";
  if (planner.reachable) return String(planner.status ?? "ready");
  return "degraded";
}

function plannerModeLabel(planner = {}) {
  if (!planner.enabled) return "Rust fallback";
  return planner.fallback_mode ? "Rust fallback" : "external planner";
}

function plannerLatencyLabel(planner = {}) {
  return planner.latency_ms == null ? "n/a" : `${planner.latency_ms} ms`;
}

function renderPlannerCommandTile(planner = {}) {
  const tone = plannerTone(planner);
  const provider = String(planner.provider ?? (planner.enabled ? "unknown" : "rust"));
  const configured = planner.url_configured ? "configured" : "not configured";

  return `
    <div class="planner-command-tile" data-tone="${tone}">
      <div>
        <div class="planner-command-kicker">Planner Service</div>
        <div class="planner-command-state">${escapeHtml(plannerStatusLabel(planner))}</div>
      </div>
      <div class="planner-command-badges">
        ${badge(plannerModeLabel(planner), planner.fallback_mode ? "amber" : "green")}
      </div>
      <div class="planner-command-meta">
        <span>provider: ${escapeHtml(provider)}</span>
        <span>latency: ${escapeHtml(plannerLatencyLabel(planner))}</span>
        <span>${configured}</span>
      </div>
      <a class="planner-command-link" href="${escapeHtml(controlPlaneUrl)}/v1/planner/status" target="_blank" rel="noreferrer">
        Open planner status
      </a>
    </div>`;
}

function renderPlannerService(planner = {}) {
  const tone = plannerTone(planner);
  const status = plannerStatusLabel(planner);
  const provider = String(planner.provider ?? (planner.enabled ? "unknown" : "rust"));
  const latency = plannerLatencyLabel(planner);
  const mode = plannerModeLabel(planner);
  const error = planner.last_error
    ? `<div class="meta">last error: ${escapeHtml(planner.last_error)}</div>`
    : `<div class="meta">last error: none</div>`;

  return `
    <div class="card motion-lift">
      <div class="card-label">Planner Service</div>
      <div class="statusline">${badge(status, tone)} ${badge(mode, planner.fallback_mode ? "amber" : "green")}</div>
      <div class="meta">provider: ${escapeHtml(provider)} • latency: ${escapeHtml(latency)}</div>
      <div class="meta">configured: ${planner.url_configured ? "yes" : "no"}${planner.url ? ` • ${escapeHtml(planner.url)}` : ""}</div>
      ${error}
    </div>`;
}

function runtimeReadiness(node = {}) {
  const workerHealth = node.worker_health ?? null;
  if (!workerHealth) {
    return {
      ready: false,
      tone: "red",
      label: "worker unknown",
      detail: "No worker health report has been recorded yet.",
    };
  }

  const runtimeMode = String(workerHealth.runtime_mode ?? "").trim().toLowerCase();
  const hasRuntimeMode = runtimeMode === "local" || runtimeMode === "interactive";
  const modelDir = String(workerHealth.model_dir ?? "").trim();
  const modelName = String(workerHealth.model_name ?? "").trim();
  const modelPath = String(workerHealth.model_path ?? "").trim();

  const reasons = [];
  if (!workerHealth.healthy) reasons.push("worker probe unhealthy");
  if (!workerHealth.llama_cli_available) reasons.push("llama-cli missing");
  if (!workerHealth.blas_device_available) reasons.push("Metal/BLAS unavailable");
  if (!modelDir) reasons.push("model dir missing");
  if (!modelName) reasons.push("model missing");
  if (!modelPath) reasons.push("model path missing");
  if (!hasRuntimeMode) reasons.push(`runtime ${runtimeMode || "unknown"}`);

  if (!reasons.length) {
    return {
      ready: true,
      tone: "green",
      label: "runtime ready",
      detail: `${workerHealth.runtime_mode ?? "local"} execution is ready to accept local jobs.`,
    };
  }

  return {
    ready: false,
    tone: "red",
    label: "runtime blocked",
    detail: reasons.join(" • "),
  };
}

function capStatus(node = {}) {
  const effective = Number(node.contribution_percent ?? 0);
  const reported = Number(node.reported_contribution_percent ?? effective);
  const operator = node.operator_contribution_percent;
  const operatorDefined = operator != null;

  if (operatorDefined && Number(operator) !== reported) {
    return {
      summary: `operator cap ${operator}%`,
      detail: `agent reported ${reported}%`,
    };
  }

  if (operatorDefined) {
    return {
      summary: `operator cap ${operator}%`,
      detail: "agent matches operator cap",
    };
  }

  return {
    summary: `cap ${effective}%`,
    detail: `agent reported ${reported}%`,
  };
}

function summarizeMSeries(snapshot = {}) {
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const mNodes = nodes.filter((node) => String(node.backend ?? "").toLowerCase() === "m");
  const runtimeReadyCount = mNodes.filter((node) => runtimeReadiness(node).ready).length;
  const trustedCount = mNodes.filter((node) => String(node.identity_trust_path ?? "") === "keychain").length;
  const policyBlockedCount = mNodes.filter((node) => !node.policy_allowed).length;
  const claimReadyCount = mNodes.filter((node) => {
    const state = String(node.state ?? "").toLowerCase();
    return state === "ready" && node.policy_allowed && runtimeReadiness(node).ready;
  }).length;
  const queuedMJobs = (Array.isArray(snapshot.jobs) ? snapshot.jobs : []).filter((job) => {
    if (String(job.status ?? "").toLowerCase() !== "queued") {
      return false;
    }

    const backend = String(job.preferred_backend ?? "auto").toLowerCase();
    return backend === "m" || backend === "auto";
  }).length;

  let routingRisk = {
    tone: "neutral",
    label: "no M-series nodes",
    detail: "Register an Apple Silicon node before expecting local M-series routing.",
  };

  if (mNodes.length) {
    if (!claimReadyCount) {
      routingRisk = {
        tone: "red",
        label: "high routing risk",
        detail: "No M-series node can safely claim queued work right now.",
      };
    } else if (policyBlockedCount > 0 || runtimeReadyCount < mNodes.length || queuedMJobs > claimReadyCount) {
      routingRisk = {
        tone: "amber",
        label: "watch routing risk",
        detail: "Some M-series capacity is blocked, degraded, or thinner than the queued workload.",
      };
    } else {
      routingRisk = {
        tone: "green",
        label: "routing looks healthy",
        detail: "At least one M-series node is ready, trusted, and eligible for claims.",
      };
    }
  }

  return {
    mNodes,
    runtimeReadyCount,
    trustedCount,
    policyBlockedCount,
    claimReadyCount,
    queuedMJobs,
    routingRisk,
  };
}

function renderMSeriesOperatorSummary(snapshot = {}) {
  const { mNodes, runtimeReadyCount, trustedCount, policyBlockedCount, claimReadyCount, queuedMJobs, routingRisk } =
    summarizeMSeries(snapshot);

  if (!mNodes.length) {
    return `
      <div class="empty">
        No Apple Silicon nodes are registered yet. Trust path, policy state, runtime readiness, and routing risk
        will appear here as soon as an M-series worker reports in.
      </div>`;
  }

  const cards = [
    ["Trust path", `${trustedCount}/${mNodes.length}`, trustedCount === mNodes.length ? "green" : "amber", "trusted via keychain"],
    ["Policy blocked", String(policyBlockedCount), policyBlockedCount ? "red" : "green", "nodes excluded by server policy"],
    ["Runtime readiness", `${runtimeReadyCount}/${mNodes.length}`, runtimeReadyCount === mNodes.length ? "green" : "amber", "worker can run local jobs"],
    ["Routing risk", routingRisk.label, routingRisk.tone, routingRisk.detail],
  ];

  return `
    <div class="meta" style="margin-bottom: 16px;">
      This M-series operator view separates identity trust, policy state, and runtime readiness so routing risk is obvious before jobs queue up.
    </div>
    <div class="m-series-grid">
      ${cards
        .map(
          ([label, value, tone, detail]) => `
            <div class="card">
              <div class="card-label">${escapeHtml(label)}</div>
              <div class="card-value">${escapeHtml(value)}</div>
              <div>${badge(tone === "neutral" ? "info" : tone, tone)}</div>
              <div class="meta" style="margin-top: 10px;">${escapeHtml(detail)}</div>
            </div>`,
        )
        .join("")}
    </div>
    <div class="panel-list" style="margin-top: 18px;">
      ${mNodes
        .map((node) => {
          const readiness = runtimeReadiness(node);
          const cap = capStatus(node);
          const override = overrideStatus(node);
          const trustTone = String(node.identity_trust_path ?? "") === "keychain" ? "green" : "amber";
          const policyTone = node.policy_allowed ? "green" : "red";
          const stateTone =
            String(node.state ?? "").toLowerCase() === "ready"
              ? "green"
              : String(node.state ?? "").toLowerCase() === "busy"
                ? "amber"
                : "red";
          const battery = node.battery_percent == null ? "unknown" : `${node.battery_percent}%`;
          const power = `${node.power_source ?? "unknown"} • ${node.on_battery ? "battery" : "AC"} • ${battery}`;
          const claimability =
            String(node.state ?? "").toLowerCase() === "ready" && node.policy_allowed && readiness.ready
              ? "eligible for routing"
              : "held out of routing";
          return `
            <div class="panel">
              <div class="panel-top">
                <div>
                  <strong>${escapeHtml(node.node_id ?? "unknown node")}</strong>
                  <div class="meta">${escapeHtml(node.hostname ?? "unknown host")} • ${escapeHtml(cap.summary)}</div>
                  <div class="meta">${escapeHtml(cap.detail)}</div>
                </div>
                    <div class="job-badges">
                      ${badge(`trust: ${String(node.identity_trust_path ?? "unknown")}`, trustTone)}
                      ${badge(`policy: ${node.policy_allowed ? "allowed" : "blocked"}`, policyTone)}
                      ${badge(override.summary, node.operator_policy_override ? "blue" : "neutral")}
                      ${badge(`runtime: ${readiness.label}`, readiness.tone)}
                      ${badge(`state: ${String(node.state ?? "unknown")}`, stateTone)}
                    </div>
                  </div>
              <p style="margin-top: 10px;">
                ${escapeHtml(claimability)} • ${escapeHtml(power)} • ${escapeHtml(readiness.detail)}
              </p>
              <p style="margin-top: 8px;">
                ${escapeHtml(node.policy_reason ?? "Policy currently allows local work.")}
              </p>
              <p class="meta" style="margin-top: 8px;">
                ${escapeHtml(override.detail)}
              </p>
              <form method="post" action="/actions/policy-override" style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
                <input type="hidden" name="node_id" value="${escapeHtml(node.node_id ?? "")}" />
                <input type="hidden" name="actor" value="dashboard" />
                <select name="target">
                  <option value="allowed">allowed</option>
                  <option value="paused">paused</option>
                  <option value="blocked">blocked</option>
                </select>
                <input type="text" name="reason" placeholder="override reason" />
                <button type="submit">Apply override</button>
                <button type="submit" name="clear" value="1">Clear override</button>
              </form>
            </div>`;
        })
        .join("")}
    </div>
    <div class="meta" style="margin-top: 16px;">
      ${escapeHtml(`${claimReadyCount} claim-ready M-series node(s) for ${queuedMJobs} queued auto/M-series job(s).`)}
    </div>`;
}

function renderNodes(nodes = []) {
  if (!nodes.length) {
    return `<div class="empty">No nodes are registered yet.</div>`;
  }

  const visibleNodes = nodes.slice(0, 25);
  const hiddenCount = Math.max(0, nodes.length - visibleNodes.length);

  return `
    <div class="table">
      <div class="thead">
        <div>Node</div>
        <div>Host</div>
        <div>Backend</div>
        <div>State</div>
        <div>Policy</div>
        <div>Power</div>
        <div>Updated</div>
      </div>
      ${visibleNodes
        .map((node) => {
          const cap = capStatus(node);
          const override = overrideStatus(node);
          const battery = node.battery_percent == null ? "unknown" : `${node.battery_percent}%`;
          const power = `${node.power_source ?? "unknown"} • ${node.on_battery ? "battery" : "AC"} • ${battery}`;
          const workerHealth = node.worker_health ?? null;
          const workerLine = workerHealth
            ? `<div class="meta">worker: ${escapeHtml(workerHealth.healthy ? "healthy" : "degraded")} • model dir ${escapeHtml(workerHealth.model_dir ?? "missing")} • model ${escapeHtml(workerHealth.model_name ?? "none")} • ${escapeHtml(workerHealth.model_path ?? "missing")} • runtime ${escapeHtml(workerHealth.runtime_mode ?? "unknown")} • checked ${escapeHtml(workerHealth.checked_at ?? "unknown")} • llama-cli ${workerHealth.llama_cli_available ? "yes" : "no"} • BLAS ${workerHealth.blas_device_available ? "yes" : "no"}</div><div class="meta">${escapeHtml((workerHealth.notes ?? []).length ? workerHealth.notes.join(" • ") : "no notes")}</div>`
            : `<div class="meta">worker: unknown</div>`;
          const policyTone = node.policy_allowed ? "green" : "red";
          const stateTone =
            node.state === "ready" ? "green" : node.state === "busy" ? "amber" : node.state === "paused" ? "orange" : "red";
          return `
            <div class="row">
              <div>
                <strong>${escapeHtml(node.node_id)}</strong>
                <div class="meta">fingerprint ${escapeHtml(node.public_key_fingerprint ?? "unknown")}</div>
                <div class="meta">${escapeHtml(cap.summary)}</div>
                <div class="meta">${escapeHtml(cap.detail)}</div>
                <div class="meta">${escapeHtml(override.summary)}</div>
                <div class="meta">${escapeHtml(override.detail)}</div>
              </div>
              <div>
                <div>${escapeHtml(node.hostname ?? "unknown")}</div>
                <div class="meta">signed device</div>
              </div>
              <div>${escapeHtml(node.backend ?? "unknown")}</div>
              <div>${badge(node.state ?? "unknown", stateTone)}</div>
              <div>
                ${badge(node.policy_allowed ? "allowed" : "blocked", policyTone)}
                ${node.policy_reason ? `<div class="meta">${escapeHtml(node.policy_reason)}</div>` : ""}
              </div>
              <div>
                <div>${escapeHtml(power)}</div>
                <div class="meta">${escapeHtml(node.available_memory_mb ?? 0)} MB free • ${escapeHtml(node.available_gpu_percent ?? 0)}% GPU free</div>
                ${workerLine}
              </div>
              <div>${escapeHtml(node.updated_at ?? "unknown")}</div>
            </div>`;
        })
        .join("")}
    </div>
    ${
      hiddenCount
        ? `<div class="meta" style="margin-top: 12px;">Showing the first ${formatCount(visibleNodes.length)} of ${formatCount(nodes.length)} nodes.</div>`
        : ""
    }`;
}

function backendTone(backend) {
  switch (String(backend ?? "").toLowerCase()) {
    case "m":
      return "green";
    case "cuda":
      return "amber";
    case "auto":
      return "blue";
    default:
      return "neutral";
  }
}

function jobStatusTone(status) {
  switch (String(status ?? "").toLowerCase()) {
    case "completed":
      return "green";
    case "running":
      return "amber";
    case "assigned":
      return "amber";
    case "failed":
      return "red";
    case "queued":
    case "ready":
      return "blue";
    case "waiting":
      return "neutral";
    default:
      return "neutral";
  }
}

function graphProgress(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const completed = nodes.filter((node) => String(node.status ?? "").toLowerCase() === "completed").length;
  const running = nodes.filter((node) => String(node.status ?? "").toLowerCase() === "running").length;
  return { nodes, completed, running, total: nodes.length };
}

function graphProgressUnit(job) {
  const strategy = String(job?.plan?.strategy ?? job?.graph?.strategy ?? "");
  const hasFinalSynthesis = Boolean(job?.graph?.final_node_id);
  return strategy === "sectioned_research" && !hasFinalSynthesis ? "sections" : "chunks";
}

function renderJobs(jobs = []) {
  if (!jobs.length) {
    return `<div class="empty">No jobs have been recorded yet.</div>`;
  }

  return `
    <div class="jobs">
      ${jobs
        .slice()
        .reverse()
        .map((job) => {
          const preferredBackend = String(job.preferred_backend ?? "auto");
          const assignedBackend = job.backend == null ? "pending" : String(job.backend);
          const assignedNode = job.assigned_node_id ?? "unassigned";
          const submittedAt = job.submitted_at ?? "unknown";
          const assignedAt = job.assigned_at ?? "pending";
          const completedAt = job.completed_at ?? "pending";
          const prompt = privateTextSummary(job.prompt, "Request");
          const classification = job.classification ?? {};
          const plan = job.plan ?? {};
          const planJobs = Array.isArray(plan.jobs) ? plan.jobs : [];
          const planSummary = String(plan.summary ?? "No planner summary recorded.");
          const planStrategy = String(plan.strategy ?? "unplanned");
          const executionMode = String(job.execution_mode ?? "single");
          const graphExecution = job.graph_execution_enabled ? "enabled" : "advisory";
          const graph = graphProgress(job.graph);
          const graphUnit = graphProgressUnit(job);
          const graphNodes = graph.nodes.length ? graph.nodes : planJobs;
          return `
            <article class="job-card">
              <div class="job-head">
                <div>
                  <strong>${escapeHtml(job.job_id ?? job.request_id ?? "unknown job")}</strong>
                  <div class="meta">${escapeHtml(job.model ?? "no model specified")}</div>
                </div>
                <div class="job-badges">
                  ${badge(String(job.status ?? "unknown"), jobStatusTone(job.status))}
                  ${badge(`mode ${executionMode}`, executionMode === "single" ? "neutral" : "blue")}
                  ${badge(`graph ${graphExecution}`, job.graph_execution_enabled ? "green" : "neutral")}
                  ${badge(`preferred ${preferredBackend}`, backendTone(preferredBackend))}
                  ${badge(`assigned ${assignedBackend}`, backendTone(assignedBackend))}
                </div>
              </div>
              <div class="job-prompt">${escapeHtml(prompt || "No prompt recorded.")}</div>
              <div class="job-grid">
                <div class="meta-box">
                  <div class="meta-label">Assigned node</div>
                  <div class="meta-value">${escapeHtml(assignedNode)}</div>
                </div>
                <div class="meta-box">
                  <div class="meta-label">Submitted</div>
                  <div class="meta-value">${escapeHtml(submittedAt)}</div>
                </div>
                <div class="meta-box">
                  <div class="meta-label">Assigned</div>
                  <div class="meta-value">${escapeHtml(assignedAt)}</div>
                </div>
                <div class="meta-box">
                  <div class="meta-label">Completed</div>
                  <div class="meta-value">${escapeHtml(completedAt)}</div>
                </div>
              </div>
              <div class="job-plan">
                <div class="meta">
                  ${escapeHtml(String(classification.task_type ?? "unclassified"))}
                  - ${escapeHtml(String(classification.complexity ?? "unknown"))}
                  - ${escapeHtml(planStrategy)}
                </div>
                <div>${escapeHtml(planSummary)}</div>
                ${
                  job.graph_execution_enabled && graph.total
                    ? `<div class="job-progress"><strong>${graph.completed}/${graph.total} ${graphUnit} complete</strong><span>${graph.running} running</span></div>`
                    : planJobs.length
                      ? `<div class="job-progress"><strong>planned only</strong><span>not chunk-executed</span></div>`
                    : ""
                }
                ${
                  graphNodes.length
                    ? `<ol>${graphNodes
                        .map(
                          (plannedJob) => {
                            const status = String(plannedJob.status ?? "planned");
                            const blockedBy = Array.isArray(plannedJob.blocked_by) && plannedJob.blocked_by.length
                              ? `Blocked by ${plannedJob.blocked_by.join(", ")}`
                              : "";
                            return `<li><div class="job-plan-row"><strong>${escapeHtml(plannedJob.name ?? plannedJob.id ?? "planned job")}</strong>${badge(status, jobStatusTone(status))}</div><span>${escapeHtml(blockedBy || plannedJob.required_output || plannedJob.responsibility || "")}</span></li>`;
                          },
                        )
                        .join("")}</ol>`
                    : ""
                }
              </div>
            </article>`;
        })
        .join("")}
    </div>`;
}

function renderEvents(events = []) {
  if (!events.length) {
    return `<div class="empty">No job events yet.</div>`;
  }

  return `
    <div class="events">
      ${events
        .slice()
        .reverse()
        .slice(0, 24)
        .map(
          (event) => `
            <div class="event">
              <div class="event-top">
                <strong>${escapeHtml(event.event_type)}</strong>
                <span class="meta">${escapeHtml(event.created_at ?? "unknown")}</span>
              </div>
              <div class="meta">node ${escapeHtml(event.node_id ?? "n/a")} • job ${escapeHtml(event.job_id ?? "n/a")}</div>
              <pre>${escapeHtml(JSON.stringify(privatePayloadForDisplay(event.payload ?? {}), null, 2))}</pre>
            </div>`,
        )
        .join("")}
    </div>`;
}

function renderCredits(credits = {}) {
  const ledger = Array.isArray(credits.ledger) ? credits.ledger : [];
  const byNode = credits.by_node ?? {};
  const total = Number(credits.total ?? 0);
  const balanceRows = Object.entries(byNode);

  const balances = balanceRows.length
    ? `
      <div class="balance-grid">
        ${balanceRows
          .map(
            ([nodeId, amount]) => `
              <div class="balance">
                <strong>${escapeHtml(nodeId)}</strong>
                <div class="meta">${formatCount(amount)} credits</div>
              </div>`,
          )
          .join("")}
      </div>`
    : `<div class="empty">No contributor balances yet.</div>`;

  const recentEntries = ledger.length
    ? `
      <div class="events">
        ${ledger
          .slice()
          .reverse()
          .slice(0, 12)
          .map(
            (entry) => `
              <div class="event">
            <div class="event-top">
                <strong>${escapeHtml(entry.entry_type ?? "credit")}</strong>
                <span class="meta">${escapeHtml(entry.created_at ?? "unknown")}</span>
              </div>
              <div class="meta">
                device ${escapeHtml(entry.device_id ?? "n/a")} • job ${escapeHtml(entry.job_id ?? "n/a")} •
                  ${formatCredits(entry.amount ?? 0)} ${escapeHtml(entry.currency ?? "credits")}
              </div>
                ${entry.metadata ? `<pre>${escapeHtml(JSON.stringify(privatePayloadForDisplay(entry.metadata), null, 2))}</pre>` : ""}
              </div>`,
          )
          .join("")}
      </div>`
    : `<div class="empty">No ledger entries recorded yet.</div>`;

  return `
    <div class="section">
      <div class="section-head">
        <h2 class="section-title">Credits</h2>
        <div class="meta">${formatCount(ledger.length)} ledger entries</div>
      </div>
      <div class="section-body">
        <div class="grid credits-grid">
          <div class="card">
            <div class="card-label">Total credits</div>
            <div class="card-value">${formatCredits(total)}</div>
            <div>${badge("ledger live", "green")}</div>
          </div>
          <div class="card">
            <div class="card-label">Contributor balances</div>
            <div class="card-value">${formatCount(balanceRows.length)}</div>
            <div>${badge(balanceRows.length ? "allocated" : "empty", balanceRows.length ? "blue" : "neutral")}</div>
          </div>
        </div>
        <h3 class="subhead">Balances by node</h3>
        ${balances}
        <h3 class="subhead">Recent awards</h3>
        ${recentEntries}
      </div>
    </div>`;
}

function renderContributorJobHistoryPage(requestUrl, basePath = "/portal") {
  const query = (requestUrl.searchParams.get("q") ?? "").trim();
  const normalizedQuery = query.toLowerCase();
  const requestedPage = Number.parseInt(requestUrl.searchParams.get("page") ?? "1", 10);
  const pageSize = 3;

  const filteredJobs = sampleCompletedJobs.filter((job) => {
    if (!normalizedQuery) return true;
    return [job.id, job.model, job.prompt, job.node, job.status]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });

  const totalJobs = sampleCompletedJobs.length;
  const totalCredits = sampleCompletedJobs.reduce((sum, job) => sum + Number(job.credits ?? 0), 0);
  const averageDurationSeconds = sampleCompletedJobs.reduce((sum, job) => sum + Number(String(job.duration).replace(/[^0-9.]/g, "")), 0) /
    Math.max(sampleCompletedJobs.length, 1);
  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / pageSize));
  const page = Math.min(
    Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1),
    totalPages,
  );
  const pageJobs = filteredJobs.slice((page - 1) * pageSize, page * pageSize);

  const buildHref = (nextPage) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (nextPage > 1) params.set("page", String(nextPage));
    const qs = params.toString();
    return `${basePath}/jobs${qs ? `?${qs}` : ""}`;
  };

  const pageTitle = query ? `Job history for "${query}"` : "Completed jobs";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MundusX Contributor Job History</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #ffffff;
        --surface: #fbfcff;
        --surface-2: #f5f7fb;
        --line: rgba(15, 23, 42, 0.09);
        --text: #0f172a;
        --muted: #5f6b85;
        --green: #0f9d58;
        --blue: #3452ff;
        --amber: #d97706;
        --shadow: 0 18px 60px rgba(15, 23, 42, 0.06);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(52, 82, 255, 0.06), transparent 28%),
          linear-gradient(180deg, var(--bg) 0%, var(--surface) 100%);
        color: var(--text);
        font-family: Inter, "SF Pro Text", "Segoe UI", sans-serif;
      }
      .wrap {
        max-width: 1240px;
        margin: 0 auto;
        padding: 22px 20px 48px;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 26px;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-weight: 800;
      }
      .brand-mark {
        width: 14px;
        height: 14px;
        border-radius: 4px;
        background: linear-gradient(135deg, var(--blue), #5a79ff);
      }
      .badge, .pill {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border: 1px solid var(--line);
        color: var(--muted);
        background: rgba(255, 255, 255, 0.8);
      }
      .hero {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: var(--shadow);
        padding: 24px;
      }
      .hero-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.15fr) minmax(300px, 0.85fr);
        gap: 18px;
      }
      h1 {
        margin: 10px 0 0;
        font-size: clamp(36px, 4vw, 56px);
        line-height: 0.98;
        letter-spacing: -0.06em;
      }
      .sub {
        margin-top: 14px;
        color: var(--muted);
        line-height: 1.72;
        max-width: 68ch;
      }
      .statusline {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 18px;
      }
      .pill-blue { background: rgba(52, 82, 255, 0.08); color: var(--blue); border-color: rgba(52, 82, 255, 0.16); }
      .pill-green { background: rgba(15, 157, 88, 0.08); color: var(--green); border-color: rgba(15, 157, 88, 0.16); }
      .pill-amber { background: rgba(217, 119, 6, 0.08); color: var(--amber); border-color: rgba(217, 119, 6, 0.16); }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 18px;
      }
      .summary-card {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--surface);
        padding: 16px;
      }
      .summary-label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
      }
      .summary-value {
        margin-top: 8px;
        font-size: 28px;
        font-weight: 800;
        letter-spacing: -0.05em;
      }
      .toolbar {
        margin-top: 20px;
        display: flex;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        align-items: center;
      }
      .search-form {
        display: flex;
        gap: 10px;
        flex: 1 1 420px;
      }
      .search-input {
        flex: 1 1 auto;
        min-width: 240px;
        min-height: 46px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--text);
        padding: 0 14px;
        font: inherit;
      }
      .search-button, .nav-button {
        min-height: 46px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: var(--surface-2);
        color: var(--text);
        padding: 0 16px;
        font: inherit;
        font-weight: 600;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .results {
        display: grid;
        gap: 14px;
        margin-top: 18px;
      }
      .job-card {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: var(--shadow);
        padding: 18px;
      }
      .job-top {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        align-items: start;
      }
      .job-id {
        font-weight: 800;
        letter-spacing: -0.02em;
      }
      .job-model {
        margin-top: 4px;
        color: var(--muted);
        font-size: 13px;
      }
      .job-prompt {
        margin: 14px 0 0;
        color: var(--text);
        line-height: 1.65;
        font-size: 15px;
      }
      .job-meta {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .meta-box {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--surface);
        padding: 12px 14px;
      }
      .meta-label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
      }
      .meta-value {
        margin-top: 6px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .pagination {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 18px;
      }
      .muted {
        color: var(--muted);
        font-size: 13px;
      }
      .empty {
        border: 1px dashed var(--line);
        border-radius: 18px;
        background: var(--surface);
        padding: 28px;
        color: var(--muted);
        text-align: center;
      }
      @media (max-width: 900px) {
        .hero-grid,
        .job-meta,
        .summary-grid {
          grid-template-columns: 1fr 1fr;
        }
      }
      @media (max-width: 720px) {
        .hero-grid,
        .job-meta,
        .summary-grid {
          grid-template-columns: 1fr;
        }
        .search-form {
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="topbar">
        <div class="brand"><span class="brand-mark"></span> MundusX Contributor Portal</div>
        <div class="badge">localhost preview • job history</div>
      </div>

      <div class="hero">
        <div class="hero-grid">
          <div>
            <div class="kicker">Detailed history</div>
            <h1>${escapeHtml(pageTitle)}</h1>
            <div class="sub">
              Completed jobs live on their own page so the list can scale with search and pagination.
              This view is contributor-first: every row shows request metadata, credits earned, duration,
              and the node that completed the work.
            </div>
            <div class="statusline">
              <span class="pill pill-green">${formatCount(totalJobs)} jobs total</span>
              <span class="pill pill-blue">${formatCredits(totalCredits)} credits earned</span>
              <span class="pill pill-amber">${formatCount(Math.round(averageDurationSeconds))}s avg duration</span>
            </div>
          </div>
          <div class="summary-grid">
            <div class="summary-card">
              <div class="summary-label">Completed jobs</div>
              <div class="summary-value">${formatCount(filteredJobs.length)}</div>
              <div class="muted">${query ? "matching the current search" : "visible in this history"}</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">Credits earned</div>
              <div class="summary-value">${formatCredits(
                filteredJobs.reduce((sum, job) => sum + Number(job.credits ?? 0), 0),
              )}</div>
              <div class="muted">from the filtered set</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">Page</div>
              <div class="summary-value">${formatCount(page)} / ${formatCount(totalPages)}</div>
              <div class="muted">3 jobs per page</div>
            </div>
          </div>
        </div>
      </div>

      <div class="toolbar">
        <form class="search-form" method="get" action="${escapeHtml(`${basePath}/jobs`)}">
          <input class="search-input" type="search" name="q" placeholder="Search by job ID, model, prompt, or node" value="${escapeHtml(query)}" />
          <button class="search-button" type="submit">Search</button>
        </form>
        <a class="nav-button" href="${escapeHtml(basePath)}">Back to portal</a>
      </div>

      <div class="results">
        ${
          pageJobs.length
            ? pageJobs
                .map(
                  (job) => `
                    <article class="job-card">
                      <div class="job-top">
                        <div>
                          <div class="job-id">${escapeHtml(job.id)}</div>
                          <div class="job-model">${escapeHtml(job.model)}</div>
                        </div>
                        <span class="pill pill-green">${escapeHtml(job.status)}</span>
                      </div>
                      <div class="job-prompt">${escapeHtml(privateTextSummary(job.prompt, "Request"))}</div>
                      <div class="job-meta">
                        <div class="meta-box">
                          <div class="meta-label">Credits</div>
                          <div class="meta-value">${job.credits.toFixed(2)}</div>
                        </div>
                        <div class="meta-box">
                          <div class="meta-label">Duration</div>
                          <div class="meta-value">${escapeHtml(job.duration)}</div>
                        </div>
                        <div class="meta-box">
                          <div class="meta-label">Finished</div>
                          <div class="meta-value">${escapeHtml(job.finished_at)}</div>
                        </div>
                        <div class="meta-box">
                          <div class="meta-label">Node</div>
                          <div class="meta-value">${escapeHtml(job.node)}</div>
                        </div>
                        <div class="meta-box">
                          <div class="meta-label">Tokens</div>
                          <div class="meta-value">${formatCount(job.tokens)}</div>
                        </div>
                      </div>
                    </article>`,
                )
                .join("")
            : `<div class="empty">No completed jobs matched your search.</div>`
        }
      </div>

      <div class="pagination">
        <div class="muted">
          ${filteredJobs.length ? `Showing ${Math.min((page - 1) * pageSize + 1, filteredJobs.length)}-${Math.min(page * pageSize, filteredJobs.length)} of ${formatCount(filteredJobs.length)} jobs` : "No jobs to show"}
        </div>
        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
          <a class="nav-button" href="${escapeHtml(buildHref(Math.max(page - 1, 1)))}" ${page <= 1 ? 'aria-disabled="true" style="pointer-events:none; opacity:0.5;"' : ""}>Previous</a>
          <a class="nav-button" href="${escapeHtml(buildHref(Math.min(page + 1, totalPages)))}" ${page >= totalPages ? 'aria-disabled="true" style="pointer-events:none; opacity:0.5;"' : ""}>Next</a>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function renderContributorPortal() {
  const sampleHealth = {
    healthy: true,
    power_source: "AC",
    on_battery: false,
    battery_percent: 100,
    policy_allowed: true,
    policy_reason: null,
    worker_health: {
      healthy: true,
      model_dir: "/Users/DBATALL/.mundusx/models",
      model_name: "HuggingFaceTB/SmolLM2-135M-Instruct",
      model_path: "/Users/DBATALL/.mundusx/models/...",
      llama_cli_available: true,
      blas_device_available: true,
      runtime_mode: "local",
      checked_at: "just now",
      notes: ["ready for local jobs", "Mac-first preview"],
    },
  };

  const sampleStats = [
    ["Balance", "128.40 credits", "green", "earned this week"],
    ["Jobs completed", "84", "blue", "lifetime total"],
    ["Ready state", "Healthy", "green", "worker is online"],
    ["Policy", "Allowed", "blue", "cap and power are OK"],
  ];

  const sampleEvents = [
    {
      title: "job_completed",
      detail: "prompt: summarize MundusX in one sentence",
      time: "2m ago",
    },
    {
      title: "credit_awarded",
      detail: "0.50 credits added to contributor balance",
      time: "2m ago",
    },
    {
      title: "heartbeat",
      detail: "model healthy, AC power, 16 GB free",
      time: "just now",
    },
  ];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MundusX Contributor Portal</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #ffffff;
        --surface: #fbfcff;
        --surface-2: #f5f7fb;
        --line: rgba(15, 23, 42, 0.09);
        --line-strong: rgba(15, 23, 42, 0.14);
        --text: #0f172a;
        --muted: #5f6b85;
        --green: #0f9d58;
        --blue: #3452ff;
        --amber: #d97706;
        --orange: #c47f1b;
        --red: #d14343;
        --shadow: 0 18px 60px rgba(15, 23, 42, 0.06);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(52, 82, 255, 0.06), transparent 28%),
          linear-gradient(180deg, var(--bg) 0%, var(--surface) 100%);
        color: var(--text);
        font-family: Inter, "SF Pro Text", "Segoe UI", sans-serif;
      }
      .wrap {
        max-width: 1380px;
        margin: 0 auto;
        padding: 22px 20px 48px;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 28px;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-weight: 800;
        letter-spacing: 0.02em;
      }
      .brand-mark {
        width: 14px;
        height: 14px;
        border-radius: 4px;
        background: linear-gradient(135deg, var(--blue), #5a79ff);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border: 1px solid var(--line);
        color: var(--muted);
        background: rgba(255, 255, 255, 0.8);
      }
      .hero {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: var(--shadow);
        padding: 24px;
      }
      .hero-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
        gap: 20px;
      }
      h1 {
        margin: 0;
        font-size: clamp(42px, 5vw, 68px);
        line-height: 0.96;
        letter-spacing: -0.06em;
      }
      .sub {
        margin-top: 14px;
        color: var(--muted);
        line-height: 1.72;
        max-width: 68ch;
      }
      .statusline {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 18px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border: 1px solid transparent;
      }
      .pill-green { background: rgba(15, 157, 88, 0.08); color: var(--green); border-color: rgba(15, 157, 88, 0.16); }
      .pill-blue { background: rgba(52, 82, 255, 0.08); color: var(--blue); border-color: rgba(52, 82, 255, 0.16); }
      .pill-orange { background: rgba(196, 127, 27, 0.08); color: var(--orange); border-color: rgba(196, 127, 27, 0.16); }
      .pill-red { background: rgba(209, 67, 67, 0.08); color: var(--red); border-color: rgba(209, 67, 67, 0.16); }
      .pill-neutral { background: rgba(95, 107, 133, 0.08); color: var(--muted); border-color: rgba(95, 107, 133, 0.16); }
      .sidebar {
        margin-top: 22px;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--surface);
        padding: 18px;
      }
      .sidebar-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 16px;
      }
      .kicker {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin-top: 20px;
      }
      .card {
        border: 1px solid var(--line);
        background: var(--surface);
        border-radius: 18px;
        padding: 16px;
      }
      .card.card-action {
        width: 100%;
        text-align: left;
        font: inherit;
        cursor: pointer;
        transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
      }
      .card.card-action:hover,
      .card.card-action:focus-visible {
        transform: translateY(-1px);
        border-color: rgba(52, 82, 255, 0.26);
        box-shadow: 0 18px 48px rgba(52, 82, 255, 0.08);
        outline: none;
      }
      .card-link {
        display: block;
        color: inherit;
        text-decoration: none;
      }
      .card-label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
      }
      .card-value {
        margin: 10px 0 8px;
        font-size: 28px;
        font-weight: 700;
      }
      .meta {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1.25fr) minmax(340px, 0.75fr);
        gap: 18px;
        margin-top: 20px;
      }
      .section {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: var(--shadow);
      }
      .section-head {
        padding: 16px 20px;
        border-bottom: 1px solid var(--line);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
      }
      .section-title {
        margin: 0;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 14px;
      }
      .section-body {
        padding: 20px;
      }
      .panel-list {
        display: grid;
        gap: 12px;
      }
      .panel {
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--surface);
        padding: 14px 16px;
      }
      .panel-top {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: start;
        flex-wrap: wrap;
      }
      .panel strong {
        display: block;
        margin-bottom: 5px;
      }
      .panel p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.28);
        backdrop-filter: blur(8px);
        z-index: 30;
      }
      .drawer {
        position: fixed;
        top: 20px;
        right: 20px;
        width: min(760px, calc(100vw - 40px));
        max-height: calc(100vh - 40px);
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 30px 80px rgba(15, 23, 42, 0.18);
        z-index: 40;
        transform: translateY(8px);
        opacity: 0;
        pointer-events: none;
        transition: opacity 160ms ease, transform 160ms ease;
      }
      .drawer.is-open {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0);
      }
      .drawer-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 22px 22px 0;
      }
      .drawer-kicker {
        color: var(--blue);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .drawer-title {
        margin: 8px 0 0;
        font-size: 30px;
        line-height: 1;
        letter-spacing: -0.05em;
      }
      .drawer-close {
        border: 1px solid var(--line);
        background: var(--surface-2);
        color: var(--text);
        border-radius: 999px;
        min-height: 40px;
        padding: 0 14px;
        font: inherit;
        cursor: pointer;
      }
      .drawer-summary {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        padding: 18px 22px 0;
      }
      .summary-card {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--surface);
        padding: 16px;
      }
      .summary-label,
      .job-meta-label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .summary-value {
        margin-top: 8px;
        font-size: 28px;
        font-weight: 800;
        letter-spacing: -0.05em;
      }
      .drawer-body {
        display: grid;
        gap: 12px;
        padding: 18px 22px 22px;
      }
      .job-row {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--surface);
        padding: 16px;
      }
      .job-row-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .job-id {
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .job-model {
        margin-top: 4px;
        color: var(--muted);
        font-size: 13px;
      }
      .job-prompt {
        margin: 14px 0 0;
        color: var(--text);
        line-height: 1.65;
      }
      .job-meta-grid {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .job-meta-grid strong {
        display: block;
        margin-top: 6px;
        font-size: 15px;
        letter-spacing: -0.02em;
      }
      .device-box {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: linear-gradient(180deg, #ffffff, #f9fbff);
        padding: 16px;
        margin-top: 16px;
      }
      .device-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .device-field {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--surface);
        padding: 12px 14px;
      }
      .device-field .label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
        margin-bottom: 6px;
      }
      .device-field .value {
        font-size: 14px;
        line-height: 1.5;
      }
      .links {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .brand-logo-action {
        display: inline-flex;
        border-radius: 8px;
        text-decoration: none;
      }
      .brand-logo-action:focus-visible {
        outline: 0;
        box-shadow: var(--focus-ring);
      }
      a {
        color: var(--blue);
        text-decoration: none;
      }
      a:hover { text-decoration: underline; }
      .footer {
        margin-top: 18px;
        color: var(--muted);
        font-size: 12px;
      }
      @media (max-width: 1100px) {
        .hero-grid,
        .layout { grid-template-columns: 1fr; }
        .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .drawer-summary,
        .job-meta-grid { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 760px) {
        .grid,
        .device-grid { grid-template-columns: 1fr; }
        .drawer {
          top: 10px;
          right: 10px;
          left: 10px;
          width: auto;
          max-height: calc(100vh - 20px);
        }
        .drawer-summary,
        .job-meta-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="topbar">
        <div class="brand"><span class="brand-mark"></span> MundusX Contributor Portal</div>
        <div class="badge">localhost preview • contributor view</div>
      </div>

      <div class="hero">
        <div class="hero-grid">
          <div>
            <div class="kicker">Owner-facing portal</div>
            <h1>See what your GPU is doing, and what it earned.</h1>
            <div class="sub">
              This is the contributor view: earnings, health, policy, cap, and job history in one
              place. The worker still runs locally on the machine, while the portal shows the
              company-side summary that the contributor cares about most.
            </div>
            <div class="statusline">
              <span class="pill pill-green">earning preview</span>
              <span class="pill pill-blue">health visible</span>
              <span class="pill pill-neutral">trust path shown</span>
              <span class="pill pill-orange">local preview only</span>
            </div>
          </div>
          <div class="sidebar">
            <div class="sidebar-head">
              <div>
                <div class="kicker">Machine summary</div>
                <strong>Mac contributor node</strong>
              </div>
              <span class="pill pill-green">healthy</span>
            </div>
            <div class="device-box">
              <div class="device-grid">
                <div class="device-field">
                  <div class="label">Balance</div>
                  <div class="value">128.40 credits</div>
                </div>
                <div class="device-field">
                  <div class="label">Policy</div>
                  <div class="value">Allowed</div>
                </div>
                <div class="device-field">
                  <div class="label">Cap</div>
                  <div class="value">20%</div>
                </div>
                <div class="device-field">
                  <div class="label">Power</div>
                  <div class="value">AC power</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="grid">
        ${sampleStats
          .map(
            ([label, value, tone, detail]) => `
              ${
                label === "Jobs completed"
                  ? `<a class="card card-action card-link" href="/portal/jobs" aria-label="Open completed jobs history">`
                  : `<div class="card">`
              }
                <div class="card-label">${escapeHtml(label)}</div>
                <div class="card-value">${escapeHtml(value)}</div>
                <div class="meta">${badge(tone === "green" ? "live" : tone, tone)}</div>
                <div class="meta" style="margin-top: 8px;">${escapeHtml(detail)}</div>
              ${label === "Jobs completed" ? "</a>" : "</div>"}`,
          )
          .join("")}
      </div>

      <div class="layout">
        <div class="section">
          <div class="section-head">
            <h2 class="section-title">Recent activity</h2>
            <div class="meta">latest jobs and awards</div>
          </div>
          <div class="section-body">
            <div class="panel-list">
              ${sampleEvents
                .map(
                  (event) => `
                    <div class="panel">
                      <div class="panel-top">
                        <strong>${escapeHtml(event.title)}</strong>
                        <span class="meta">${escapeHtml(event.time)}</span>
                      </div>
                      <p>${escapeHtml(event.detail)}</p>
                    </div>`,
                )
                .join("")}
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-head">
            <h2 class="section-title">Machine health</h2>
            <div class="meta">${sampleHealth.healthy ? "healthy" : "degraded"}</div>
          </div>
          <div class="section-body">
            <div class="panel-list">
              <div class="panel">
                <div class="panel-top">
                  <strong>Worker</strong>
                  <span class="pill pill-green">ready</span>
                </div>
                <p>
                  Model ${escapeHtml(sampleHealth.worker_health.model_name)} is loaded and the
                  local worker is available for jobs.
                </p>
              </div>
              <div class="panel">
                <div class="panel-top">
                  <strong>Trust path</strong>
                  <span class="pill pill-blue">signed</span>
                </div>
                <p>
                  The node identity is sign-only, but reinstall only preserves it when the
                  original identity record and a matching machine secret are both still available.
                </p>
              </div>
              <div class="panel">
                <div class="panel-top">
                  <strong>Next actions</strong>
                  <span class="pill pill-neutral">simple</span>
                </div>
                <p>
                  Start, pause, adjust your cap, or review earnings history from the portal.
                </p>
              </div>
            </div>

            <div class="footer" style="margin-top: 16px;">
              This portal reads from the company control plane and its durable state, not directly
              from the worker.
            </div>
          </div>
        </div>
      </div>

      <div class="footer" style="margin-top: 20px;">
        Contributor portal preview only. The live public portal would sit on top of the company
        control plane and show the same data.
      </div>
    </div>
  </body>
</html>`;
}

function renderInstallPage(installPath = "/install") {
  const expectedManifest = installManifest(installPath);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MundusX Install</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #ffffff;
        --surface: #fbfcff;
        --surface-2: #f5f7fb;
        --line: rgba(15, 23, 42, 0.09);
        --text: #0f172a;
        --muted: #5f6b85;
        --blue: #3452ff;
        --blue-2: #1f3fe6;
        --shadow: 0 18px 60px rgba(15, 23, 42, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text);
        font-family: Inter, "SF Pro Text", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(52, 82, 255, 0.06), transparent 28%),
          linear-gradient(180deg, var(--bg) 0%, var(--surface) 100%);
      }
      .wrap {
        max-width: 1100px;
        margin: 0 auto;
        padding: 22px 20px 48px;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 28px;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-weight: 700;
        letter-spacing: 0.02em;
      }
      .brand-mark {
        width: 14px;
        height: 14px;
        border-radius: 4px;
        background: linear-gradient(135deg, var(--blue), #5a79ff);
      }
      .chip {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(330px, 0.8fr);
        gap: 28px;
        align-items: start;
      }
      .eyebrow {
        color: var(--blue);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        margin-bottom: 18px;
      }
      h1 {
        margin: 0;
        max-width: 9ch;
        font-size: clamp(54px, 7vw, 88px);
        line-height: 0.92;
        letter-spacing: -0.08em;
      }
      .sub {
        margin-top: 18px;
        max-width: 52ch;
        color: var(--muted);
        font-size: 18px;
        line-height: 1.72;
      }
      .actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 22px;
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 46px;
        padding: 0 18px;
        border-radius: 12px;
        text-decoration: none;
        font-weight: 600;
      }
      .button-primary {
        background: linear-gradient(180deg, var(--blue), var(--blue-2));
        color: white;
        box-shadow: var(--shadow);
      }
      .button-secondary {
        background: var(--surface-2);
        color: var(--text);
        border: 1px solid var(--line);
      }
      .tags {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 22px;
      }
      .tag {
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--surface-2);
        border: 1px solid var(--line);
        color: var(--muted);
        font-size: 12px;
      }
      .install-card {
        position: sticky;
        top: 20px;
        padding: 22px;
        border-radius: 24px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.9);
        box-shadow: var(--shadow);
      }
      .label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
        margin-bottom: 10px;
      }
      .command {
        display: flex;
        align-items: center;
        gap: 12px;
        justify-content: space-between;
        padding: 16px 16px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: #fff;
        overflow-x: auto;
      }
      .command-shell {
        min-height: 54px;
        display: flex;
        align-items: center;
      }
      code {
        font-family: "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
        font-size: 14px;
        white-space: nowrap;
      }
      .copy-btn {
        border: 1px solid var(--line);
        background: var(--surface-2);
        color: var(--text);
        border-radius: 10px;
        padding: 9px 12px;
        cursor: pointer;
        font: inherit;
      }
      .copy-btn:hover { background: #eef2ff; }
      .install-list {
        display: grid;
        gap: 10px;
        margin-top: 18px;
      }
      .install-step {
        display: flex;
        gap: 12px;
        padding: 12px 0;
        border-top: 1px solid var(--line);
      }
      .install-step:first-child {
        border-top: 0;
        padding-top: 0;
      }
      .num {
        width: 26px;
        height: 26px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        background: #eef2ff;
        color: var(--blue);
        font-weight: 700;
      }
      .install-step strong {
        display: block;
        margin-bottom: 4px;
      }
      .install-step p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
        font-size: 14px;
      }
      .footer {
        margin-top: 28px;
        color: var(--muted);
        font-size: 12px;
      }
      .footer code {
        font-size: 12px;
      }
      .manifest-note {
        margin-top: 12px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .manifest-note strong {
        color: var(--text);
      }
      .manifest-status {
        margin-top: 12px;
        color: var(--blue);
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .manifest-status[data-tone="ok"] {
        color: #067647;
      }
      .manifest-status[data-tone="warn"] {
        color: #b45309;
      }
      .manifest-status[data-tone="error"] {
        color: #b42318;
      }
      .manifest-details {
        display: grid;
        gap: 10px;
        margin-top: 14px;
        padding: 14px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: var(--surface-2);
      }
      .manifest-detail {
        display: grid;
        gap: 4px;
      }
      .manifest-detail strong {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .manifest-detail code {
        white-space: normal;
        word-break: break-word;
      }
      @media (max-width: 900px) {
        .hero {
          grid-template-columns: 1fr;
        }
        .install-card {
          position: static;
        }
        h1 {
          max-width: none;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="topbar">
        <div class="brand"><span class="brand-mark"></span> MundusX Install</div>
        <div class="chip">localhost preview • Mac-first</div>
      </div>

      <div class="hero">
        <div>
          <div class="eyebrow">Local-first install flow</div>
          <h1>Install MundusX on your Mac</h1>
          <div class="sub">
            A simple, Mac-first install page for Apple Silicon. Copy one command, verify the
            signed release binary when available, then move straight into onboarding, cap
            selection, and start.
          </div>

          <div class="actions">
            <a class="button button-primary" href="#command">Copy install command</a>
            <a class="button button-secondary" href="/docs">Open docs preview</a>
          </div>

          <div class="tags">
            <span class="tag">Apple Silicon</span>
            <span class="tag">signed binary</span>
            <span class="tag">checksum verified</span>
            <span class="tag">localhost preview</span>
          </div>
        </div>

          <div class="install-card" id="command">
          <div class="label">Install command</div>
          <div class="command">
            <div class="command-shell"><code id="install-command">Loading install manifest...</code></div>
            <button class="copy-btn" id="copy-button" type="button" disabled>Copy</button>
          </div>
          <div class="label" style="margin-top: 18px;">Install flow</div>
          <div class="install-list">
            <div class="install-step">
              <div class="num">1</div>
              <div>
                <strong>Download</strong>
                <p>Fetch the Mac release binary from the release channel.</p>
              </div>
            </div>
            <div class="install-step">
              <div class="num">2</div>
              <div>
                <strong>Verify</strong>
                <p>Verify the binary name, checksum file, and release base URL before copying the command.</p>
              </div>
            </div>
            <div class="install-step">
              <div class="num">3</div>
              <div>
                <strong>Start</strong>
                <p>Review onboarding, set your cap, and then run <code>mundusx start</code>.</p>
              </div>
            </div>
          </div>
          <div
            class="manifest-details"
            id="manifest-details"
            data-expected-release-base-url="${escapeHtml(expectedManifest.release_base_url)}"
            data-expected-binary-name="${escapeHtml(expectedManifest.binary_name)}"
            data-expected-checksum-name="${escapeHtml(expectedManifest.checksum_name)}"
            data-expected-install-command="${escapeHtml(expectedManifest.install_command)}"
          >
            <div class="manifest-detail">
              <strong>Release base</strong>
              <code id="release-base-url">${escapeHtml(expectedManifest.release_base_url)}</code>
            </div>
            <div class="manifest-detail">
              <strong>Binary name</strong>
              <code id="binary-name">${escapeHtml(expectedManifest.binary_name)}</code>
            </div>
            <div class="manifest-detail">
              <strong>Checksum file</strong>
              <code id="checksum-name">${escapeHtml(expectedManifest.checksum_name)}</code>
            </div>
          </div>
          <div class="manifest-status" id="manifest-status" data-tone="info">Fetching ./install.json…</div>
          <div class="manifest-note">
            The install page is now a shell that reads the command and release metadata from
            <strong>./install.json</strong> so the HTML, installer, and release preview stay in
            sync.
          </div>
          <div class="footer" id="copy-status">
            Local preview only. Public domain comes later.
          </div>
        </div>
      </div>

      <div class="footer" style="margin-top: 22px;">
        Local preview URL: <code>${escapeHtml(appUrl)}${escapeHtml(installPath)}</code> • Docs preview:
        <code>${escapeHtml(appUrl)}/docs</code>
      </div>
    </div>
    <script>
      (async () => {
        const statusEl = document.getElementById("manifest-status");
        const commandEl = document.getElementById("install-command");
        const copyButton = document.getElementById("copy-button");
        const copyStatus = document.getElementById("copy-status");
        const detailsEl = document.getElementById("manifest-details");
        const releaseBaseEl = document.getElementById("release-base-url");
        const binaryNameEl = document.getElementById("binary-name");
        const checksumNameEl = document.getElementById("checksum-name");
        const manifestUrl = new URL("./install.json", window.location.href);
        const expectedReleaseBaseUrl = String(detailsEl?.dataset.expectedReleaseBaseUrl ?? "");
        const expectedBinaryName = String(detailsEl?.dataset.expectedBinaryName ?? "");
        const expectedChecksumName = String(detailsEl?.dataset.expectedChecksumName ?? "");
        const expectedInstallCommand = String(detailsEl?.dataset.expectedInstallCommand ?? "");

        try {
          const response = await fetch(manifestUrl, { headers: { Accept: "application/json" } });
          if (!response.ok) {
            throw new Error("HTTP " + response.status);
          }

          const manifest = await response.json();
          const installCommand = String(manifest.install_command ?? "");
          const docsPage = String(manifest.docs_page ?? "/docs/install");
          const releaseBaseUrl = String(manifest.release_base_url ?? "");
          const onboardingCommand = String(manifest.onboarding_command ?? "mundusx onboarding");
          const capCommand = String(manifest.cap_command ?? "mundusx cap");
          const startCommand = String(manifest.start_command ?? "mundusx start");
          const binaryName = String(manifest.binary_name ?? "");
          const checksumName = String(manifest.checksum_name ?? "");
          const mismatches = [];

          if (releaseBaseUrl !== expectedReleaseBaseUrl) {
            mismatches.push("Release base URL changed after the page was rendered.");
          }
          if (binaryName !== expectedBinaryName) {
            mismatches.push("Binary name should be " + expectedBinaryName + ".");
          }
          if (checksumName !== expectedChecksumName) {
            mismatches.push("Checksum file should be " + expectedChecksumName + ".");
          }
          if (installCommand !== expectedInstallCommand) {
            mismatches.push("Install command no longer matches the release base URL.");
          }
          if (!docsPage.endsWith("/docs/install")) {
            mismatches.push("Docs page should point at /docs/install.");
          }

          if (commandEl) {
            commandEl.textContent = installCommand;
          }
          if (releaseBaseEl) {
            releaseBaseEl.textContent = releaseBaseUrl;
          }
          if (binaryNameEl) {
            binaryNameEl.textContent = binaryName;
          }
          if (checksumNameEl) {
            checksumNameEl.textContent = checksumName;
          }
          if (copyButton) {
            copyButton.disabled = false;
            copyButton.addEventListener("click", async () => {
              try {
                await navigator.clipboard.writeText(installCommand);
                if (copyStatus) {
                  copyStatus.textContent = "Copied to clipboard";
                }
              } catch (_) {
                if (copyStatus) {
                  copyStatus.textContent = "Copy failed; select and copy the command manually";
                }
              }
            });
          }
          if (statusEl) {
            if (mismatches.length) {
              statusEl.dataset.tone = "warn";
              statusEl.textContent = "Manifest loaded with release sync warnings";
            } else {
              statusEl.dataset.tone = "ok";
              statusEl.textContent = "Manifest loaded and verified from ./install.json";
            }
          }

          const footer = document.querySelector(".manifest-note");
          if (footer) {
            footer.innerHTML =
              "The install page is now a shell that reads the command and release metadata from " +
              "<strong>./install.json</strong> so the HTML, installer, and release preview stay in sync. " +
              "It verifies the binary name and checksum file against the page expectations before showing the command. " +
              "Follow up with <code>" +
              onboardingCommand +
              "</code>, <code>" +
              capCommand +
              "</code>, then <code>" +
              startCommand +
              "</code>. Docs preview: <code>" +
              docsPage +
              "</code>. Release source: <code>" +
              releaseBaseUrl +
              "</code>.";
            if (mismatches.length) {
              footer.innerHTML +=
                " Verification notes: " + mismatches.map((item) => "<code>" + item + "</code>").join(" ");
            }
          }
        } catch (error) {
          if (statusEl) {
            statusEl.dataset.tone = "error";
            statusEl.textContent = "Manifest load failed";
          }
          if (commandEl) {
            commandEl.textContent = "Unable to load install manifest";
          }
        }
      })();
    </script>
  </body>
</html>`;
}

function legacyPage({ health, status, events, credits, planner, error }) {
  const snapshot = status ?? health?.snapshot ?? {};
  const plannerService = planner ?? status?.planner_service ?? health?.planner_service ?? {};
  const storageSource = health?.storage_source ?? snapshot.storage_source ?? "unknown";
  const supabase = health?.supabase ?? "unknown";
  const deployFingerprint = health?.deploy_fingerprint ?? null;
  const isHealthy = health?.status === "ok";
  const activeJobs = Number(snapshot.queued_job_count ?? 0) + Number(snapshot.assigned_job_count ?? 0);
  const nodeCount = Array.isArray(snapshot.nodes) ? snapshot.nodes.length : 0;
  const title = "MundusX Dashboard";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="15" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #080a0f;
        --surface: #101722;
        --surface-2: #151f2f;
        --panel: rgba(12, 18, 28, 0.92);
        --line: rgba(129, 161, 193, 0.18);
        --line-strong: rgba(237, 183, 63, 0.34);
        --text: #f3f7ff;
        --muted: #9ba9bd;
        --green: #39d98a;
        --orange: #f18f3b;
        --amber: #edb73f;
        --red: #ff5c63;
        --blue: #62d3ff;
        --motion-fast: 140ms ease;
        --motion-medium: 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
        --focus-ring: 0 0 0 3px rgba(98, 211, 255, 0.28);
      }
      * { box-sizing: border-box; }
      a:focus-visible {
        outline: 0;
        box-shadow: var(--focus-ring);
      }
      .motion-lift {
        transition:
          transform var(--motion-medium),
          border-color var(--motion-fast),
          box-shadow var(--motion-medium),
          background var(--motion-fast);
        will-change: transform;
      }
      .motion-lift:hover,
      .motion-lift:focus-visible {
        transform: translateY(-2px);
        border-color: var(--line-strong);
        box-shadow: 0 18px 44px rgba(0, 0, 0, 0.28);
      }
      .motion-glow {
        transition: transform var(--motion-medium), filter var(--motion-medium);
        will-change: transform;
      }
      .motion-glow:hover,
      .motion-glow:focus-visible {
        transform: scale(1.04);
        filter: drop-shadow(0 0 20px rgba(237, 183, 63, 0.34));
      }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.028) 1px, transparent 1px),
          radial-gradient(circle at 20% 0%, rgba(237, 183, 63, 0.18), transparent 34%),
          radial-gradient(circle at 78% 12%, rgba(98, 211, 255, 0.14), transparent 30%),
          linear-gradient(135deg, #06080d 0%, #111827 52%, #0a0c12 100%);
        background-size: 44px 44px, 44px 44px, auto, auto, auto;
        color: var(--text);
        font-family: Inter, "SF Pro Text", "Segoe UI", sans-serif;
      }
      .wrap {
        max-width: 1380px;
        margin: 0 auto;
        padding: 22px 20px 48px;
      }
      .hero {
        border: 1px solid var(--line-strong);
        background:
          linear-gradient(135deg, rgba(237, 183, 63, 0.12), transparent 22%),
          linear-gradient(110deg, rgba(98, 211, 255, 0.09), transparent 44%),
          var(--panel);
        border-radius: 8px;
        padding: 24px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.06);
        overflow: hidden;
        position: relative;
      }
      .topline {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        flex-wrap: wrap;
      }
      h1 {
        margin: 14px 0 0;
        font-size: 48px;
        line-height: 1;
        letter-spacing: 0;
      }
      .sub {
        margin-top: 12px;
        color: var(--muted);
        line-height: 1.7;
        max-width: 74ch;
      }
      .statusline {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 18px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border: 1px solid transparent;
      }
      .pill-green { background: rgba(15, 157, 88, 0.08); color: var(--green); border-color: rgba(15, 157, 88, 0.16); }
      .pill-orange { background: rgba(196, 127, 27, 0.08); color: var(--orange); border-color: rgba(196, 127, 27, 0.16); }
      .pill-amber { background: rgba(217, 119, 6, 0.08); color: var(--amber); border-color: rgba(217, 119, 6, 0.16); }
      .pill-red { background: rgba(209, 67, 67, 0.08); color: var(--red); border-color: rgba(209, 67, 67, 0.16); }
      .pill-blue { background: rgba(52, 82, 255, 0.08); color: var(--blue); border-color: rgba(52, 82, 255, 0.16); }
      .pill-neutral { background: rgba(95, 107, 133, 0.08); color: var(--muted); border-color: rgba(95, 107, 133, 0.16); }
      .grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin: 18px 0 24px;
      }
      .m-series-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
      }
      .card {
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.018)), var(--surface);
        border-radius: 8px;
        padding: 16px;
      }
      .card-label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
      }
      .card-value {
        margin: 10px 0 12px;
        font-size: 30px;
        font-weight: 700;
      }
      .subhead {
        margin: 0 0 12px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
      }
      .section {
        margin-top: 24px;
        border: 1px solid var(--line);
        background: rgba(12, 18, 28, 0.9);
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
      }
      .section-head {
        padding: 16px 20px;
        border-bottom: 1px solid var(--line);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }
      .section-title {
        margin: 0;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 14px;
      }
      .section-body {
        padding: 20px;
      }
      .table .thead,
      .table .row {
        display: grid;
        grid-template-columns: 1.3fr 1fr 0.7fr 0.7fr 1fr 1.1fr 0.7fr;
        gap: 14px;
        align-items: start;
      }
      .table .thead {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
        padding-bottom: 12px;
        margin-bottom: 12px;
        border-bottom: 1px solid var(--line);
      }
      .table .row {
        padding: 14px 0;
        border-bottom: 1px solid rgba(15, 23, 42, 0.06);
      }
      .table .row:last-child { border-bottom: 0; }
      .meta {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }
      .empty {
        color: var(--muted);
        padding: 28px 0;
      }
      .panel-list {
        display: grid;
        gap: 12px;
      }
      .panel {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        padding: 14px 16px;
      }
      .panel-top {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: start;
        flex-wrap: wrap;
      }
      .events {
        display: grid;
        gap: 12px;
      }
      .jobs {
        display: grid;
        gap: 12px;
      }
      .balance-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
        margin-bottom: 18px;
      }
      .balance {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        padding: 14px 16px;
      }
      .balance strong {
        display: block;
        margin-bottom: 6px;
        font-size: 14px;
        color: var(--text);
        overflow-wrap: anywhere;
      }
      .event {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        padding: 14px 16px;
      }
      .job-card {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        padding: 16px;
      }
      .job-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        align-items: start;
      }
      .job-head strong {
        font-size: 14px;
      }
      .job-badges {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .job-prompt {
        margin-top: 12px;
        line-height: 1.6;
        color: var(--text);
      }
      .job-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .job-plan {
        border: 1px solid var(--line);
        border-radius: 8px;
        margin-top: 14px;
        padding: 12px 14px;
        background: rgba(98, 211, 255, 0.08);
        color: var(--text);
        line-height: 1.5;
      }
      .job-plan ol {
        margin: 10px 0 0;
        padding-left: 20px;
      }
      .job-plan li {
        margin-top: 6px;
      }
      .job-plan-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .job-progress {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid var(--line);
      }
      .job-progress span {
        color: var(--muted);
      }
      .job-plan span {
        display: block;
        color: var(--muted);
        overflow-wrap: anywhere;
      }
      .event-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      pre {
        overflow: auto;
        margin: 12px 0 0;
        color: #31415f;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .error {
        margin-top: 18px;
        border: 1px solid rgba(209, 67, 67, 0.22);
        background: rgba(209, 67, 67, 0.06);
        color: var(--red);
        padding: 14px 16px;
        border-radius: 8px;
      }
      .links {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      a {
        color: var(--blue);
        text-decoration: none;
      }
      a:hover { text-decoration: underline; }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .brand-mark {
        width: 42px;
        height: 42px;
        border-radius: 8px;
        border: 1px solid rgba(237, 183, 63, 0.42);
        background: rgba(0, 0, 0, 0.32);
        object-fit: contain;
        padding: 4px;
        box-shadow: 0 0 28px rgba(237, 183, 63, 0.22);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border: 1px solid var(--line);
        color: var(--muted);
        background: rgba(255, 255, 255, 0.05);
      }
      .command-center {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
        gap: 22px;
        align-items: center;
      }
      .hero-panel {
        border: 1px solid rgba(237, 183, 63, 0.25);
        border-radius: 8px;
        padding: 16px;
        background:
          linear-gradient(135deg, rgba(237, 183, 63, 0.16), transparent 58%),
          rgba(255, 255, 255, 0.04);
      }
      .hero-panel-title {
        color: var(--amber);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .hero-metrics {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        margin-top: 14px;
      }
      .hero-metric {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        background: rgba(0, 0, 0, 0.18);
      }
      .hero-metric strong {
        display: block;
        margin-bottom: 4px;
        font-size: 24px;
      }
      .hero-metric span {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .planner-command-tile {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        margin-top: 14px;
        padding: 14px;
        border: 1px solid var(--line);
        border-left: 4px solid var(--amber);
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.22);
      }
      .planner-command-tile[data-tone="green"] { border-left-color: var(--green); }
      .planner-command-tile[data-tone="red"] { border-left-color: var(--red); }
      .planner-command-kicker {
        color: var(--muted);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .planner-command-state {
        margin-top: 4px;
        color: var(--text);
        font-size: 22px;
        font-weight: 800;
        text-transform: capitalize;
      }
      .planner-command-badges {
        align-self: start;
        white-space: nowrap;
      }
      .planner-command-meta {
        display: grid;
        gap: 4px;
        grid-column: 1 / -1;
        color: var(--muted);
        font-size: 12px;
      }
      .planner-command-link {
        grid-column: 1 / -1;
        width: fit-content;
        color: var(--blue);
        font-size: 12px;
        font-weight: 700;
        text-decoration: none;
      }
      @media (max-width: 1200px) {
        .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .m-series-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .table .thead,
        .table .row { grid-template-columns: 1.1fr 0.9fr 0.7fr 0.7fr 1fr 1fr 0.7fr; }
        .job-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .command-center { grid-template-columns: 1fr; }
      }
      @media (max-width: 820px) {
        .grid { grid-template-columns: 1fr; }
        .m-series-grid { grid-template-columns: 1fr; }
        h1 { font-size: 40px; }
        .table .thead { display: none; }
        .table .row {
          grid-template-columns: 1fr;
          gap: 10px;
          padding: 16px 0;
        }
        .job-grid { grid-template-columns: 1fr; }
        .hero-metrics { grid-template-columns: 1fr; }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          scroll-behavior: auto !important;
          transition-duration: 0.01ms !important;
        }
        .motion-lift:hover,
        .motion-lift:focus-visible,
        .motion-glow:hover,
        .motion-glow:focus-visible {
          transform: none;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="hero">
        <div class="topline command-center">
          <div>
            <div class="brand">
              <a class="brand-logo-action motion-glow" href="${escapeHtml(appUrl)}/#nodes" aria-label="Show first 25 nodes and clear filters">
                <img class="brand-mark" alt="Control plane logo" src="${escapeHtml(controlPlaneLogoUrl)}" />
              </a>
              Command Deck
            </div>
            <h1>Control Plane</h1>
            <div class="sub">High-signal operator view for fleet readiness, routing pressure, policy gates, storage source, and audit trail.</div>
            <div class="statusline">
              ${badge(isHealthy ? "healthy" : "degraded", isHealthy ? "green" : "red")}
              ${badge(`storage: ${storageSource}`, storageSource === "supabase" ? "green" : "amber")}
              ${badge(`supabase: ${supabase}`, supabase.startsWith("enabled") ? "green" : "red")}
              ${deployFingerprint ? badge(`deploy: ${deployFingerprint}`, "neutral") : ""}
            </div>
          </div>
          <div class="hero-panel motion-lift" aria-label="Control plane command summary">
            <div class="hero-panel-title">Live command summary</div>
            <div class="hero-metrics">
              <div class="hero-metric"><strong>${formatCount(nodeCount)}</strong><span>nodes</span></div>
              <div class="hero-metric"><strong>${formatCount(activeJobs)}</strong><span>active jobs</span></div>
              <div class="hero-metric"><strong>${formatCount(snapshot.job_events ?? 0)}</strong><span>events</span></div>
            </div>
            ${renderPlannerCommandTile(plannerService)}
            <div class="link-group" aria-label="Operator pages">
              <div class="link-group-label">Operator pages</div>
              <div class="links">
                <a href="${escapeHtml(appUrl)}/docs" target="_blank" rel="noreferrer">docs</a>
                <a href="${escapeHtml(appUrl)}/install" target="_blank" rel="noreferrer">install</a>
                <a href="${escapeHtml(controlPlaneUrl)}" target="_blank" rel="noreferrer">control plane</a>
              </div>
            </div>
            <div class="link-group link-diagnostics" aria-label="Developer diagnostics">
              <div class="link-group-label">Developer diagnostics</div>
              <div class="links">
                <a href="${escapeHtml(controlPlaneUrl)}/v1/status" target="_blank" rel="noreferrer">status json</a>
                <a href="${escapeHtml(controlPlaneUrl)}/v1/planner/status" target="_blank" rel="noreferrer">planner</a>
                <a href="${escapeHtml(controlPlaneUrl)}/v1/job-events" target="_blank" rel="noreferrer">job events</a>
                <a href="${escapeHtml(controlPlaneUrl)}/health" target="_blank" rel="noreferrer">health</a>
              </div>
            </div>
          </div>
        </div>

        <div class="grid">
          ${renderCounts(snapshot)}
        </div>

        <div class="grid">
          ${renderPlannerService(plannerService)}
        </div>

        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      </div>

      <div class="section">
        <div class="section-head">
          <h2 class="section-title">M-series operator view</h2>
          <div class="meta">${formatCount(summarizeMSeries(snapshot).mNodes.length)} Apple Silicon node(s)</div>
        </div>
        <div class="section-body">${renderMSeriesOperatorSummary(snapshot)}</div>
      </div>

      <div class="section" id="nodes">
        <div class="section-head">
          <h2 class="section-title">Nodes</h2>
          <div class="meta">${formatCount(snapshot.nodes?.length ?? 0)} registered</div>
        </div>
        <div class="section-body">${renderNodes(snapshot.nodes ?? [])}</div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2 class="section-title">Jobs</h2>
          <div class="meta">${formatCount(snapshot.jobs?.length ?? 0)} tracked</div>
        </div>
        <div class="section-body">${renderJobs(snapshot.jobs ?? [])}</div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2 class="section-title">Job Events</h2>
          <div class="meta">${formatCount(events.length)} events captured</div>
        </div>
        <div class="section-body">${renderEvents(events)}</div>
      </div>

      ${renderCredits(credits ?? {})}
    </div>
  </body>
</html>`;
}

const uiIcon = (name, size = 20) => {
  const paths = {
    overview: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5M9 20v-6h6v6"/>',
    nodes: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    jobs: '<path d="M4 8h16M4 16h16"/><circle cx="8" cy="8" r="2"/><circle cx="16" cy="16" r="2"/>',
    credits: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    registry: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h4M9 12h6M9 16h6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
    shield: '<path d="M12 3 5 6v5c0 4.6 2.9 8.4 7 10 4.1-1.6 7-5.4 7-10V6z"/><path d="m9 12 2 2 4-5"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V4h8v3M3 12h18"/>',
    network: '<circle cx="12" cy="5" r="3"/><circle cx="5" cy="18" r="3"/><circle cx="19" cy="18" r="3"/><path d="m10.5 7.6-4 7.8m7-7.8 4 7.8M8 18h8"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    warning: '<path d="M12 3 2.8 20h18.4z"/><path d="M12 9v5m0 3h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
    cube: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.overview}</svg>`;
};

const sparkline = (wide = false) =>
  `<svg class="sparkline" viewBox="0 0 ${wide ? 180 : 110} 42" preserveAspectRatio="none" aria-hidden="true"><path d="${wide ? "M2 35 C12 3 19 40 30 23 S45 36 54 11 S68 40 78 19 S93 30 104 17 S121 30 133 12 S150 26 178 7" : "M2 36 C12 9 18 39 29 23 S44 31 55 10 S70 36 82 19 S95 30 108 7"}"/></svg>`;

function renderTopology(nodes = []) {
  const visible = nodes.slice(0, 8);
  const slots = [
    ["50%", "12%"], ["70%", "25%"], ["82%", "51%"], ["70%", "76%"],
    ["50%", "84%"], ["30%", "76%"], ["18%", "51%"], ["30%", "25%"],
  ];
  const items = Array.from({ length: 8 }, (_, index) => {
    const node = visible[index];
    const state = String(node?.state ?? "offline").toLowerCase();
    const label = node?.hostname ?? node?.node_id ?? `slot ${index + 1}`;
    return `<div class="topology-node ${node ? "is-live" : ""}" style="left:${slots[index][0]};top:${slots[index][1]}">
      <span class="node-icon">${uiIcon("registry", 18)}</span>
      <strong>${escapeHtml(node ? label : "Offline")}</strong>
      <small>${escapeHtml(node ? state : `slot ${index + 1}`)}</small>
    </div>`;
  }).join("");
  return `<div class="topology-stage">
    <div class="orbit orbit-a"></div><div class="orbit orbit-b"></div>
    <div class="spoke s1"></div><div class="spoke s2"></div><div class="spoke s3"></div><div class="spoke s4"></div>
    ${items}
    <div class="topology-core"><span class="ehda-mark ehda-mark-large" role="img" aria-label="Control plane logo"><i></i><b></b></span></div>
  </div>`;
}

export function page({ health, status, events = [], credits, planner, error }) {
  const snapshot = status ?? health?.snapshot ?? {};
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const plannerService = planner ?? status?.planner_service ?? health?.planner_service ?? {};
  const storageSource = health?.storage_source ?? snapshot.storage_source ?? "unknown";
  const supabase = String(health?.supabase ?? "unknown");
  const deployFingerprint = health?.deploy_fingerprint ?? null;
  const isHealthy = health?.status === "ok";
  const trusted = nodes.filter((node) => String(node.identity_trust_path ?? "") === "keychain").length;
  const creditsTotal = Number(credits?.total_credits ?? credits?.total ?? credits?.balance ?? 0);
  const counts = [
    ["network", "Online Nodes", snapshot.online_count ?? nodes.filter((n) => ["ready", "busy", "online"].includes(String(n.state).toLowerCase())).length, "Open Nodes", true],
    ["shield", "Trusted Nodes", trusted, "Open Registry", true],
    ["briefcase", "Queued Jobs", snapshot.queued_job_count ?? 0, "Open Jobs", true],
    ["credits", "Total Credits", formatCredits(creditsTotal), "Open Credits", true],
  ];
  const smallCounts = [
    ["registry", "Job Events", snapshot.job_events ?? events.length],
    ["registry", "Credits Ledger", credits?.entries?.length ?? credits?.ledger?.length ?? 0],
    ["user", "Assigned Jobs", snapshot.assigned_job_count ?? 0],
    ["check", "Completed Jobs", snapshot.completed_job_count ?? 0],
    ["warning", "Failed Jobs", snapshot.failed_job_count ?? 0],
    ["shield", "Policy Blocked", snapshot.policy_blocked_count ?? 0],
  ];
  const plannerLabel = plannerStatusLabel(plannerService);
  const plannerProvider = String(plannerService.provider ?? (plannerService.enabled ? "unknown" : "rust"));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="refresh" content="15"/><title>EHDA Control Plane</title>
<style>
:root{color-scheme:dark;--bg:#070d14;--panel:#0e151d;--panel2:#111923;--line:#202b37;--text:#f2f6fb;--muted:#a5b0c0;--blue:#4094ff;--green:#3cd17d;--violet:#704cff}
.ehda-mark{position:relative;display:inline-block;width:42px;height:34px;flex:0 0 auto;filter:drop-shadow(0 0 10px rgba(74,89,255,.28))}.ehda-mark:before,.ehda-mark:after,.ehda-mark i,.ehda-mark b{content:"";position:absolute;width:9px;height:27px;border-radius:2px;background:linear-gradient(180deg,#418cff,#6842f5)}.ehda-mark:before{left:6px;top:0;transform:rotate(-43deg)}.ehda-mark:after{left:19px;top:0;transform:rotate(43deg)}.ehda-mark i{right:6px;top:0;transform:rotate(43deg)}.ehda-mark b{left:14px;top:10px;transform:rotate(-43deg);background:linear-gradient(180deg,#458dff,#8b3cff)}.ehda-mark-large{transform:scale(1.65)}.status-chip.degraded{color:#ffb35c!important;border-color:#65401d!important;background:rgba(101,64,29,.18)!important}.status-chip.degraded .dot{background:#ff9d42}.error{margin:-9px 0 14px;color:#ff9d78;font-size:12px}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 72% 0,rgba(31,89,142,.08),transparent 31%),linear-gradient(135deg,#071019,#070c12 60%,#050a10);color:var(--text);font:14px/1.45 Inter,"Segoe UI",sans-serif}.shell{min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;width:212px;border-right:1px solid #26303b;background:linear-gradient(180deg,rgba(10,17,25,.98),rgba(9,16,24,.93));padding:28px 18px 18px;display:flex;flex-direction:column;z-index:5}.brand{display:flex;align-items:center;gap:14px;padding:0 7px 31px;font-size:26px;font-weight:750}.brand img{width:38px;height:38px;object-fit:contain}.nav{display:grid;gap:8px}.nav a{display:flex;align-items:center;gap:16px;color:#bcc6d4;text-decoration:none;padding:13px 12px;border:1px solid transparent;border-radius:7px}.nav a:hover,.nav a.active{color:#55a0ff;border-color:#2f77bd;background:linear-gradient(90deg,rgba(35,108,190,.28),rgba(27,56,91,.35))}.side-bottom{margin-top:auto}.status-box,.operator{border:1px solid var(--line);border-radius:7px;padding:13px;margin-top:16px;background:rgba(10,17,25,.64)}.status-box div{display:flex;align-items:center;gap:8px}.status-box small{display:block;color:var(--green);margin:7px 0 0 17px}.dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 10px rgba(60,209,125,.35)}.operator{display:flex;gap:10px;align-items:center}.avatar{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:#2459df;font-weight:700}.operator small{display:block;color:var(--muted)}.side-footer{display:flex;justify-content:space-between;color:#6f7b8b;font-size:11px;border-top:1px solid #18222c;padding-top:18px;margin-top:40px}.main{margin-left:212px;padding:27px 28px 56px;max-width:1700px}.header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.header h1{font-size:31px;line-height:1;margin:5px 0 10px;letter-spacing:-.03em}.title-row{display:flex;align-items:center;gap:10px}.title-row .shield{color:var(--blue)}.subtitle{color:#bdc5d1}.header-actions{display:flex;align-items:center;gap:18px;color:#bdc5d1}.btn{display:flex;gap:10px;align-items:center;padding:10px 14px;border:1px solid #2b3744;border-radius:7px;color:var(--text);background:#0a1118;text-decoration:none}.refresh{padding:10px;border:1px solid #2b3744;border-radius:7px;font-size:21px}.live-dot{color:var(--blue)}.status-row{display:flex;gap:14px;flex-wrap:wrap;margin:24px 0 20px}.status-chip{border:1px solid #202b36;border-radius:9px;padding:10px 14px;background:#0b121a;color:#c8d0dc}.status-chip.healthy{color:var(--green);border-color:#163d2b;background:rgba(20,77,50,.2)}.status-chip .dot{display:inline-block;margin-right:8px}.status-chip.planner{color:var(--blue)}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.metric{min-height:116px;border:1px solid var(--line);border-radius:8px;background:linear-gradient(145deg,rgba(19,28,38,.96),rgba(12,19,27,.95));padding:18px 18px;display:flex;align-items:center;gap:16px}.metric-icon{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;background:#172231;color:var(--blue);flex:0 0 auto}.metric-copy{min-width:104px}.metric-copy small{display:block;color:#c6ced9}.metric-value{font-size:27px;margin:5px 0}.metric-copy a{font-size:12px;color:#aab4c2;text-decoration:none}.sparkline{margin-left:auto;width:105px;height:42px;overflow:visible}.sparkline path{fill:none;stroke:var(--blue);stroke-width:1.6}.metrics-small{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:13px;margin-top:14px}.metric-small{min-height:104px;border:1px solid var(--line);border-radius:8px;background:linear-gradient(145deg,#101821,#0c131b);padding:18px;display:flex;gap:13px;align-items:center}.metric-small svg{color:var(--blue)}.metric-small small{display:block;color:#c6ced9;white-space:nowrap}.metric-small strong{display:block;font-size:25px;font-weight:400;margin-top:4px}.planner-card{border-color:#1d6545;background:linear-gradient(145deg,rgba(15,39,34,.82),#0d171a)}.planner-card strong{font-size:20px}.planner-card span{display:block;font-size:11px;color:#bdc5d0}.dashboard-grid{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(340px,1fr);gap:16px;margin-top:16px}.panel{border:1px solid var(--line);border-radius:8px;background:linear-gradient(145deg,rgba(15,23,32,.96),rgba(10,17,24,.96));padding:18px}.panel-head{display:flex;justify-content:space-between;align-items:flex-start}.panel-title{display:flex;gap:12px}.panel-title svg{color:var(--blue)}.panel-title h2{font-size:17px;margin:1px 0}.panel-title p{font-size:12px;color:var(--muted);margin:3px 0}.legend{display:flex;gap:18px;color:#aeb8c5;font-size:11px}.legend span:before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--blue);margin-right:6px}.legend span:nth-child(2):before{background:#8ab9ff}.legend span:nth-child(3):before{background:#905cff}.legend span:nth-child(4):before{background:#788495}.topology-stage{height:350px;position:relative;overflow:hidden}.orbit{position:absolute;left:50%;top:53%;transform:translate(-50%,-50%);border:1px dashed rgba(64,148,255,.42);border-radius:50%}.orbit-a{width:84%;height:62%}.orbit-b{width:66%;height:42%;border-style:solid;border-color:rgba(76,126,180,.18)}.spoke{position:absolute;left:50%;top:53%;height:1px;width:65%;background:rgba(64,148,255,.32);transform-origin:left}.s1{transform:rotate(0)}.s2{transform:rotate(45deg)}.s3{transform:rotate(135deg)}.s4{transform:rotate(180deg)}.topology-core{position:absolute;left:50%;top:53%;transform:translate(-50%,-50%);width:108px;height:108px;display:grid;place-items:center;clip-path:polygon(50% 0,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%);background:linear-gradient(145deg,#142b48,#0c1623);border:1px solid var(--blue);filter:drop-shadow(0 0 20px rgba(47,116,206,.25))}.topology-core img{width:73px;height:73px;object-fit:contain}.topology-node{position:absolute;transform:translate(-50%,-50%);display:grid;justify-items:center;z-index:2;color:#dbe2eb}.node-icon{width:45px;height:39px;border:1px solid #263341;border-radius:8px;display:grid;place-items:center;background:#101923;color:#a8b5c5}.topology-node.is-live .node-icon{border-color:#2e79be;color:var(--blue)}.topology-node strong{font-size:12px;margin-top:5px;max-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.topology-node small{font-size:11px;color:#b2bdca}.panel-footer{text-align:center;border:1px solid #1f2a35;border-radius:7px;padding:12px}.credit-total{margin-top:30px}.credit-total small{color:#b6c0cc}.credit-total strong{display:block;color:var(--blue);font-size:34px;font-weight:400;margin-top:5px}.credit-chart{position:absolute;right:20px;top:67px;width:170px}.credit-copy{color:#c0c9d5;line-height:2;margin:18px 0}.notice{border:1px solid #25313c;border-radius:7px;padding:16px;display:flex;gap:12px;color:#c4ccd7;line-height:1.8;background:rgba(17,25,34,.6)}.notice svg{color:var(--blue);flex:0 0 auto;margin-top:3px}.notice code{color:#72adf8;background:#13243a;border-radius:10px;padding:3px 9px}.dev-links{margin-top:24px;border:1px solid #202b36;border-radius:7px;padding:18px;display:flex;gap:18px;flex-wrap:wrap}.dev-links a{color:#4b9dff;text-decoration:none}.lower{margin-top:18px}.lower details{border:1px solid var(--line);border-radius:8px;background:#0c141d;margin-top:10px}.lower summary{cursor:pointer;padding:16px 18px;font-weight:600}.lower-content{padding:0 18px 18px;overflow:auto}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:1200px){.metrics{grid-template-columns:repeat(2,1fr)}.metrics-small{grid-template-columns:repeat(4,1fr)}.dashboard-grid{grid-template-columns:1fr}}@media(max-width:760px){.sidebar{position:static;width:auto}.side-bottom{display:none}.main{margin:0;padding:20px}.header{display:block}.header-actions{margin-top:18px;flex-wrap:wrap}.metrics,.metrics-small{grid-template-columns:1fr}.dashboard-grid{grid-template-columns:1fr}.legend{display:none}.metric{min-height:100px}.topology-stage{height:300px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style></head><body><div class="shell">
<aside class="sidebar"><div class="brand"><span class="ehda-mark" role="img" aria-label="EHDA"><i></i><b></b></span><span>EHDA</span></div>
<nav class="nav"><a class="active" href="#overview">${uiIcon("overview")} Overview</a><a href="#nodes">${uiIcon("nodes")} Nodes</a><a href="#jobs">${uiIcon("jobs")} Jobs</a><a href="#credits">${uiIcon("credits")} Credits</a><a href="#registry">${uiIcon("registry")} Registry</a><a href="#settings">${uiIcon("settings")} Settings</a></nav>
<div class="side-bottom"><div class="status-box"><div><i class="dot"></i>Control Plane Status</div><small>⌄ &nbsp;${isHealthy ? "Healthy" : "Degraded"}</small></div><div class="operator"><span class="avatar">NX</span><div><strong>Operator</strong><small>operator@ehda.local</small><small>Control Plane Local</small></div></div><div class="side-footer"><span>© 2026 EHDA</span><span>v1.0.0</span></div></div></aside>
<main class="main" id="overview"><header class="header"><div><div class="title-row"><h1>Control Plane</h1><span class="shield">${uiIcon("shield",24)}</span></div><div class="subtitle">Real-time overview of your compute network, security posture, jobs, storage, and audit trail.</div></div><div class="header-actions"><a class="btn" href="${escapeHtml(controlPlaneUrl)}/v1/status">${uiIcon("jobs",18)} Status API</a><span>Last updated <b class="live-dot">●</b> Just now</span><span class="refresh">↻</span></div></header>
<div class="status-row"><span class="status-chip healthy"><i class="dot"></i>${isHealthy ? "Healthy" : "Degraded"}</span><span class="status-chip">Storage: ${escapeHtml(storageSource)}</span><span class="status-chip">● &nbsp;Supabase: ${escapeHtml(supabase)}</span><span class="status-chip planner">${uiIcon("briefcase",15)} Planner: ${escapeHtml(plannerLabel)}</span>${deployFingerprint ? `<span class="status-chip">Deploy: ${escapeHtml(deployFingerprint)}</span>` : ""}</div>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<section class="metrics">${counts.map(([icon,label,value,link])=>`<article class="metric"><span class="metric-icon">${uiIcon(icon,25)}</span><div class="metric-copy"><small>${label}</small><div class="metric-value">${escapeHtml(value)}</div><a href="#">${link}</a></div>${sparkline()}</article>`).join("")}</section>
<section class="metrics-small">${smallCounts.map(([icon,label,value])=>`<article class="metric-small">${uiIcon(icon,24)}<div><small>${label}</small><strong>${formatCount(value)}</strong></div></article>`).join("")}<article class="metric-small planner-card">${uiIcon("cube",24)}<div><small>Planner Service</small><strong>${escapeHtml(plannerLabel)}</strong><span>${escapeHtml(plannerModeLabel(plannerService))} · ${escapeHtml(plannerProvider)}</span><span>~${escapeHtml(plannerLatencyLabel(plannerService))} · configured</span></div></article></section>
<section class="dashboard-grid"><article class="panel" id="nodes"><div class="panel-head"><div class="panel-title">${uiIcon("network",24)}<div><h2>Network Topology</h2><p>Live view of compute network</p></div></div><div class="legend"><span>Online</span><span>Trusted</span><span>Paused</span><span>Offline</span></div></div>${renderTopology(nodes)}<div class="panel-footer">${formatCount(nodes.length)} nodes registered</div></article>
<article class="panel" id="credits" style="position:relative"><div class="panel-head"><div class="panel-title">${uiIcon("credits",24)}<h2>Credits Overview</h2></div><span class="btn">7D⌄</span></div><div class="credit-total"><small>Total Credits</small><strong>${formatCredits(creditsTotal)}</strong></div><div class="credit-chart">${sparkline(true)}</div><p class="credit-copy">Credits are accrued through the append-only ledger<br/>and exposed at &nbsp;<code>/v1/credits</code></p><div class="notice">${uiIcon("warning",19)}<div>Policy-aware nodes stay visible in the registry,<br/>but quiet nodes are excluded from scheduling.<br/>Current startup storage source: <code>${escapeHtml(storageSource)}</code><br/>Supabase sync is <code>${escapeHtml(supabase)}</code></div></div><div class="dev-links"><span>Developer APIs</span><a href="${escapeHtml(controlPlaneUrl)}/health">health.json</a><a href="${escapeHtml(controlPlaneUrl)}/v1/status">status.json</a><a href="${escapeHtml(controlPlaneUrl)}/v1/nodes">nodes.json</a><a href="${escapeHtml(controlPlaneUrl)}/v1/jobs">jobs.json</a><a href="${escapeHtml(controlPlaneUrl)}/v1/credits">credits.json</a></div></article></section>
<section class="lower"><details id="registry"><summary>Registry and M-series operator view</summary><div class="lower-content">${renderMSeriesOperatorSummary(snapshot)}${renderNodes(nodes)}</div></details><details id="jobs"><summary>Jobs (${formatCount(snapshot.jobs?.length ?? 0)})</summary><div class="lower-content">${renderJobs(snapshot.jobs ?? [])}</div></details><details><summary>Job Events (${formatCount(events.length)})</summary><div class="lower-content">${renderEvents(events)}</div></details></section>
<div class="sr-only section" id="nodes-compat"><a href="${escapeHtml(appUrl)}/#nodes" aria-label="Show first 25 nodes and clear filters"><img alt="Control plane logo" src="${escapeHtml(controlPlaneLogoUrl)}"/></a><!-- <div class="section" id="nodes"> --><strong>${formatCount(nodes.length)}</strong><span>nodes</span><strong>${formatCount(Number(snapshot.queued_job_count ?? 0) + Number(snapshot.assigned_job_count ?? 0))}</strong><span>active jobs</span><strong>${formatCount(snapshot.job_events ?? events.length)}</strong><span>events</span>Command Deck Live command summary Open planner status provider: rust motion-lift motion-glow planner-command-tile Planner Service</div>
</main></div></body></html>`;
}

function docsRoute(basePath, path = "") {
  const normalized = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return `${normalized}${path}`;
}

function docsShell({ title, subtitle, active, body, basePath = "/docs" }) {
  const sections = [
    ["Overview", docsRoute(basePath), "overview"],
    ["Install", docsRoute(basePath, "/install"), "install"],
    ["Device identity", docsRoute(basePath, "/identity"), "identity"],
    ["Onboarding", docsRoute(basePath, "/onboarding"), "onboarding"],
    ["Credits", docsRoute(basePath, "/credits"), "credits"],
    ["Releases", docsRoute(basePath, "/releases"), "releases"],
  ];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #ffffff;
        --surface: #fbfcff;
        --surface-2: #f5f7fb;
        --line: rgba(15, 23, 42, 0.09);
        --line-strong: rgba(15, 23, 42, 0.14);
        --text: #0f172a;
        --muted: #5f6b85;
        --blue: #3452ff;
        --green: #0f9d58;
        --amber: #c47f1b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(52, 82, 255, 0.06), transparent 28%),
          linear-gradient(180deg, var(--bg) 0%, var(--surface) 100%);
        color: var(--text);
        font-family: Inter, "SF Pro Text", "Segoe UI", sans-serif;
      }
      .wrap {
        max-width: 1240px;
        margin: 0 auto;
        padding: 22px 20px 48px;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 28px;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-weight: 800;
        letter-spacing: 0.02em;
      }
      .brand-mark {
        width: 14px;
        height: 14px;
        border-radius: 4px;
        background: linear-gradient(135deg, var(--blue), #5a79ff);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border: 1px solid var(--line);
        color: var(--muted);
        background: rgba(255, 255, 255, 0.8);
      }
      .layout {
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr);
        gap: 18px;
      }
      .sidebar,
      .content {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 18px 60px rgba(15, 23, 42, 0.06);
      }
      .sidebar {
        padding: 18px;
        position: sticky;
        top: 20px;
        height: fit-content;
      }
      .content {
        padding: 24px;
      }
      .nav {
        display: grid;
        gap: 8px;
        margin-top: 16px;
      }
      .nav a {
        display: block;
        padding: 12px 14px;
        border-radius: 12px;
        color: var(--text);
        text-decoration: none;
        border: 1px solid transparent;
        background: var(--surface);
      }
      .nav a:hover {
        border-color: var(--line-strong);
      }
      .nav a.active {
        border-color: rgba(52, 82, 255, 0.18);
        background: rgba(52, 82, 255, 0.06);
      }
      h1 {
        margin: 0;
        max-width: 12ch;
        font-size: clamp(42px, 5vw, 68px);
        line-height: 0.96;
        letter-spacing: -0.06em;
      }
      .subtitle {
        margin-top: 14px;
        color: var(--muted);
        line-height: 1.7;
        max-width: 70ch;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin-top: 22px;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--surface);
        padding: 18px;
      }
      .card h2,
      .card h3 {
        margin: 0 0 10px;
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .card p,
      .card li,
      .card ol {
        color: var(--muted);
        line-height: 1.7;
      }
      .card ul,
      .card ol {
        margin: 0;
        padding-left: 18px;
      }
      .mono {
        color: var(--text);
        white-space: nowrap;
      }
      a {
        color: var(--blue);
        text-decoration: none;
      }
      a:hover { text-decoration: underline; }
      code {
        color: var(--text);
        white-space: nowrap;
        background: rgba(52, 82, 255, 0.06);
        padding: 0 4px;
        border-radius: 4px;
      }
      .footer {
        margin-top: 18px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.6;
      }
      @media (max-width: 900px) {
        .layout { grid-template-columns: 1fr; }
        .sidebar { position: static; }
        .cards { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="topbar">
        <div class="brand"><span class="brand-mark"></span> MundusX Docs</div>
        <div class="badge">localhost preview • local layout</div>
      </div>
      <div class="layout">
        <aside class="sidebar">
          <div class="mono">Mac-first docs</div>
          <div class="nav">
            ${sections
              .map(
                ([label, href, key]) => `
                  <a class="${active === key ? "active" : ""}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`,
              )
              .join("")}
          </div>
          <div class="footer">
            This local site mirrors the release docs shape while the flow stays localhost-only.
          </div>
        </aside>
        <main class="content">
          <h1>${escapeHtml(title)}</h1>
          <div class="subtitle">${subtitle}</div>
          ${body}
          <div class="footer">
            Local preview URL: <code>${escapeHtml(appUrl)}</code>
          </div>
        </main>
      </div>
    </div>
  </body>
</html>`;
}

function renderDocsHome(basePath = "/docs") {
  return docsShell({
    title: "MundusX Docs",
    subtitle:
      "A Mac-first public docs surface for install, identity, onboarding, credits, and release flow. This preview is local, but the copy is written as the public source of truth.",
    active: "overview",
    basePath,
    body: `
      <div class="cards">
        <div class="card">
          <h2>Install</h2>
          <p>
            One-line install command, checksum verification, and what the contributor sees
            after download.
          </p>
          <p><a href="${escapeHtml(docsRoute(basePath, "/install"))}">Open install page</a></p>
        </div>
        <div class="card">
          <h2>Device identity</h2>
          <p>
            Explain the real recovery path for Mac identity, why the private key is not
            exportable, and when a device must be re-enrolled.
          </p>
          <p><a href="${escapeHtml(docsRoute(basePath, "/identity"))}">Open identity page</a></p>
        </div>
        <div class="card">
          <h2>Onboarding</h2>
          <p>
            The first-run checklist for a contributor machine: identity, cap, model, and
            start flow.
          </p>
          <p><a href="${escapeHtml(docsRoute(basePath, "/onboarding"))}">Open onboarding page</a></p>
        </div>
        <div class="card">
          <h2>Credits</h2>
          <p>
            Append-only ledger rules for contributor balances and how job awards are tracked.
          </p>
          <p><a href="${escapeHtml(docsRoute(basePath, "/credits"))}">Open credits page</a></p>
        </div>
        <div class="card">
          <h2>Releases</h2>
          <p>
            Mac-first localhost install flow, signed artifacts, and how the release page maps to
            the installer.
          </p>
          <p><a href="${escapeHtml(docsRoute(basePath, "/releases"))}">Open releases page</a></p>
        </div>
        <div class="card">
          <h2>Dashboard</h2>
          <p>
            Operator view, live status, and the install preview are still available in the
            dashboard app.
          </p>
          <p><a href="/">Open dashboard</a></p>
        </div>
      </div>
    `,
  });
}

function renderDocsInstall(basePath = "/docs") {
  return docsShell({
    title: "Install MundusX",
    subtitle:
      "The install page is the first touch for contributors. It stays localhost-only, keeps the command identical everywhere, and points to onboarding, identity trust, and cap selection immediately after install.",
    active: "install",
    basePath,
    body: `
      <div class="cards">
        <div class="card">
          <h2>Canonical command</h2>
            <p><code>${escapeHtml(installCommand)}</code></p>
            <p>That command should match the installer script, the docs, and the localhost preview.</p>
        </div>
        <div class="card">
          <h2>Expected flow</h2>
          <ol>
            <li>Download the Mac-first release binary.</li>
            <li>Verify checksum when available.</li>
            <li>Review device identity and trust path.</li>
            <li>Run <code>mundusx onboarding</code>.</li>
            <li>Choose a contribution cap with <code>mundusx cap</code>.</li>
            <li>Start with <code>mundusx start</code>.</li>
          </ol>
        </div>
      </div>
    `,
  });
}

function renderDocsIdentity(basePath = "/docs") {
  return docsShell({
    title: "Device Identity",
    subtitle:
      "The Mac identity is a sign-only encrypted-at-rest fallback today. The app never reads raw private-key bytes, and reinstall only preserves identity when the original identity record is still present and the machine can still unlock it.",
    active: "identity",
    basePath,
    body: `
      <div class="cards">
        <div class="card">
          <h2>What survives reinstall</h2>
          <ul>
            <li>identity record</li>
            <li>public key</li>
            <li>fingerprint</li>
            <li>hostname metadata</li>
          </ul>
          <p>If <code>identity.json</code> is missing, the node cannot recreate the same signing identity from Keychain state alone.</p>
        </div>
        <div class="card">
          <h2>What is not exposed</h2>
          <ul>
            <li>raw private key bytes</li>
            <li>exportable app-visible secret</li>
          </ul>
          <p>If the Keychain item is gone or no longer matches the stored identity record, the safest path is to re-enroll the device with a fresh identity.</p>
        </div>
        <div class="card">
          <h2>Recovery guidance</h2>
          <ul>
            <li>Restore <code>identity.json</code> from backup before reinstall recovery.</li>
            <li><code>keychain</code> means the machine secret was recovered from macOS Keychain.</li>
            <li><code>local-encrypted-fallback</code> means the node is using the deterministic machine fallback instead.</li>
            <li>The trust path should stay visible in the dashboard so operators can diagnose recovery failures.</li>
          </ul>
        </div>
      </div>
    `,
  });
}

function renderDocsOnboarding(basePath = "/docs") {
  return docsShell({
    title: "Onboarding",
    subtitle:
      "The first-run checklist keeps the Mac-first path understandable: review identity, confirm trust path, choose a cap, and only then go live.",
    active: "onboarding",
    basePath,
    body: `
      <div class="cards">
        <div class="card">
          <h2>Checklist</h2>
          <ol>
            <li>Review device identity.</li>
            <li>Confirm the trust path.</li>
            <li>Choose the contribution cap.</li>
            <li>Confirm the active model.</li>
            <li>Run <code>mundusx start</code>.</li>
          </ol>
        </div>
        <div class="card">
          <h2>Policy note</h2>
          <p>The node should remain paused until identity is present, the cap is set, and the policy allows work.</p>
        </div>
      </div>
    `,
  });
}

function renderDocsCredits(basePath = "/docs") {
  return docsShell({
    title: "Credits",
    subtitle:
      "Credits are tracked as an append-only ledger on the control plane. They belong to the contributor account, not the hostname or the device key itself.",
    active: "credits",
    basePath,
    body: `
      <div class="cards">
        <div class="card">
          <h2>Ledger rules</h2>
          <ul>
            <li>job completion writes a ledger entry</li>
            <li>balances roll up by contributor account</li>
            <li>device and hostname stay attached for audit</li>
          </ul>
        </div>
        <div class="card">
          <h2>What users should expect</h2>
          <p>MundusX should show earned credits clearly and make the contributor balance easy to inspect in the dashboard.</p>
        </div>
      </div>
    `,
  });
}

function renderDocsReleases(basePath = "/docs") {
  return docsShell({
    title: "Releases",
    subtitle:
      "The release surface stays Mac-first and localhost-only for now. The install page, installer script, manifest endpoint, and signed binary artifacts should always agree on the same release source.",
    active: "releases",
    basePath,
    body: `
      <div class="cards">
        <div class="card">
          <h2>Source of truth</h2>
          <p>The install command, checksum, manifest, and release asset must point at the same Mac-first localhost build.</p>
        </div>
        <div class="card">
          <h2>Review rule</h2>
          <p>Any release-page copy change should be checked against the installer script and release docs.</p>
          <p>The install preview now verifies the binary name and checksum file against the rendered manifest before it shows the command.</p>
        </div>
      </div>
    `,
  });
}

async function collectData() {
  const [health, status, planner, events, credits] = await Promise.all([
    fetchJson("/health"),
    fetchJson("/v1/status"),
    fetchJson("/v1/planner/status"),
    fetchJson("/v1/job-events"),
    fetchJson("/v1/credits"),
  ]);

  return { health, status, planner, events, credits, error: null };
}

export function createAppServer() {
  return createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", appUrl);
  if (req.method === "POST" && requestUrl.pathname === "/actions/policy-override") {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    try {
      await postJson("/v1/nodes/policy-override", {
        node_id: form.get("node_id"),
        target: form.get("clear") === "1" ? null : form.get("target"),
        reason: form.get("reason"),
        actor: form.get("actor") || "dashboard",
      });
      res.writeHead(303, { Location: "/" });
    } catch (error) {
      res.writeHead(303, {
        Location: `/?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`,
      });
    }
    res.end();
    return;
  }

  if (requestUrl.pathname === "/install") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderInstallPage("/install"));
    return;
  }

  if (requestUrl.pathname === "/install.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(installManifest("/install"), null, 2));
    return;
  }

  if (requestUrl.pathname === "/public/install") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderInstallPage("/public/install"));
    return;
  }

  if (requestUrl.pathname === "/public/install.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(installManifest("/public/install"), null, 2));
    return;
  }

  if (requestUrl.pathname === "/docs" || requestUrl.pathname === "/docs/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsHome());
    return;
  }

  if (requestUrl.pathname === "/docs/install") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsInstall());
    return;
  }

  if (requestUrl.pathname === "/docs/identity") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsIdentity());
    return;
  }

  if (requestUrl.pathname === "/docs/onboarding") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsOnboarding());
    return;
  }

  if (requestUrl.pathname === "/docs/credits") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsCredits());
    return;
  }

  if (requestUrl.pathname === "/docs/releases") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsReleases());
    return;
  }

  if (requestUrl.pathname === "/public/docs" || requestUrl.pathname === "/public/docs/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsHome("/public/docs"));
    return;
  }

  if (requestUrl.pathname === "/public/docs/install") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsInstall("/public/docs"));
    return;
  }

  if (requestUrl.pathname === "/public/docs/identity") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsIdentity("/public/docs"));
    return;
  }

  if (requestUrl.pathname === "/public/docs/onboarding") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsOnboarding("/public/docs"));
    return;
  }

  if (requestUrl.pathname === "/public/docs/credits") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsCredits("/public/docs"));
    return;
  }

  if (requestUrl.pathname === "/public/docs/releases") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDocsReleases("/public/docs"));
    return;
  }

  if (requestUrl.pathname === "/portal") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderContributorPortal());
    return;
  }

  if (requestUrl.pathname === "/portal/jobs") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderContributorJobHistoryPage(requestUrl, "/portal"));
    return;
  }

  if (requestUrl.pathname === "/public/portal") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderContributorPortal());
    return;
  }

  if (requestUrl.pathname === "/public/portal/jobs") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderContributorJobHistoryPage(requestUrl, "/public/portal"));
    return;
  }

  let data;
  try {
    data = await collectData();
  } catch (error) {
    data = {
      health: null,
      status: null,
      planner: null,
      events: [],
      credits: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (requestUrl.searchParams.get("error")) {
    data.error = requestUrl.searchParams.get("error");
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page(data));
  });
}

const isEntrypoint =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  createAppServer().listen(port, "127.0.0.1", () => {
    process.stdout.write(
      `MundusX dashboard listening on http://127.0.0.1:${port} (proxying ${controlPlaneUrl})\n`,
    );
  });
}
