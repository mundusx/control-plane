mod contracts;
mod migrations;
mod state;
mod supabase;

use contracts::{
    is_trusted_identity_path, trust_path_label, AgentRegistration, ChatCompletionChoice,
    ChatCompletionChoiceMessage, ChatCompletionMundusX, ChatCompletionRequest,
    ChatCompletionResponse, Heartbeat, JobCompletion, JobRecord, JobRequest,
    NodePolicyOverrideInput, NodeRecord, OperatorContributionPercentUpdate,
    OperatorNodePolicyOverrideUpdate, RuntimeMode,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use migrations::{applied_migrations, apply_migrations};
use serde::Serialize;
use state::{load_state, save_state, ControlPlaneState};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use supabase::SupabaseMirror;
use uuid::Uuid;

#[cfg(target_os = "macos")]
#[path = "../../../tools/macos_identity.rs"]
mod macos_identity;
#[cfg(target_os = "macos")]
use state::state_path;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StorageSource {
    Supabase,
    LocalJsonFallback,
    LocalJsonOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OperatorAuthMode {
    Enforced,
    ExplicitlyDisabled,
    MissingTokenDisabled,
}

const OPERATOR_TOKEN_ENV: &str = "MUNDUSX_OPERATOR_TOKEN";
const LEGACY_OPERATOR_TOKEN_ENV: &str = "OPENGPU_OPERATOR_TOKEN";
const AUTH_DISABLED_ENV: &str = "MUNDUSX_AUTH_DISABLED";
const CONTROL_PLANE_ENVIRONMENT_ENV: &str = "MUNDUSX_ENVIRONMENT";
const CONTROL_PLANE_LOGO_PATH: &str = "/assets/mundusx-logo.png";
const CONTROL_PLANE_LOGO_PNG: &[u8] = include_bytes!("../assets/mundusx-logo.png");

impl OperatorAuthMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Enforced => "enforced",
            Self::ExplicitlyDisabled => "explicitly-disabled",
            Self::MissingTokenDisabled => "missing-token-disabled",
        }
    }

    fn enforced(self) -> bool {
        matches!(self, Self::Enforced)
    }

    fn log_label(self) -> &'static str {
        match self {
            Self::Enforced => "enabled (token present)",
            Self::ExplicitlyDisabled => "disabled (MUNDUSX_AUTH_DISABLED=true)",
            Self::MissingTokenDisabled => "disabled (MUNDUSX_OPERATOR_TOKEN missing)",
        }
    }
}

impl StorageSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Supabase => "supabase",
            Self::LocalJsonFallback => "local-json-fallback",
            Self::LocalJsonOnly => "local-json-only",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct SupabaseSyncStatus {
    enabled: bool,
    restore_source: String,
    degraded: bool,
    failure_count: u64,
    last_error: Option<String>,
    last_error_at: Option<String>,
}

impl SupabaseSyncStatus {
    fn enabled(restore_source: StorageSource) -> Self {
        Self {
            enabled: true,
            restore_source: restore_source.as_str().to_string(),
            degraded: false,
            failure_count: 0,
            last_error: None,
            last_error_at: None,
        }
    }

    fn disabled(restore_source: StorageSource) -> Self {
        Self {
            enabled: false,
            restore_source: restore_source.as_str().to_string(),
            degraded: false,
            failure_count: 0,
            last_error: None,
            last_error_at: None,
        }
    }

    fn note_failure(&mut self, error: String) {
        self.degraded = true;
        self.failure_count = self.failure_count.saturating_add(1);
        self.last_error = Some(error);
        self.last_error_at = Some(now_unix_seconds());
    }

    fn summary(&self) -> String {
        if !self.enabled {
            format!("disabled ({})", self.restore_source)
        } else if self.degraded {
            format!("enabled (degraded, {})", self.restore_source)
        } else {
            format!("enabled ({})", self.restore_source)
        }
    }

    fn tone(&self) -> &'static str {
        if !self.enabled {
            "red"
        } else if self.degraded {
            "amber"
        } else {
            "green"
        }
    }
}

fn now_unix_seconds() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn json_response(status: &str, body: serde_json::Value) -> String {
    let payload = body.to_string();
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload
    )
}

fn text_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

fn html_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

fn png_response(status: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: image/png\r\nCache-Control: public, max-age=31536000, immutable\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

fn job_status_path(job_id: &str) -> String {
    format!("/v1/jobs/{job_id}")
}

fn job_async_payload(record: &JobRecord) -> serde_json::Value {
    serde_json::json!({
        "job_id": record.job_id,
        "request_id": record.request_id,
        "status": record.status,
        "status_url": job_status_path(&record.job_id),
        "polling": {
            "method": "GET",
            "url": job_status_path(&record.job_id),
            "recommended_interval_seconds": 2,
            "default_timeout_seconds": 300
        },
        "job": record,
    })
}

fn chat_messages_to_prompt(messages: &[contracts::ChatMessage]) -> (Option<String>, String) {
    let mut system_messages = Vec::new();
    let mut conversation_lines = Vec::new();

    for message in messages {
        let role = message.role.trim().to_lowercase();
        let content = message.content.trim();
        if content.is_empty() {
            continue;
        }

        if role == "system" {
            system_messages.push(content.to_string());
        } else {
            conversation_lines.push(format!("{role}: {content}"));
        }
    }

    let system_prompt = if system_messages.is_empty() {
        None
    } else {
        Some(system_messages.join("\n"))
    };

    let prompt = if conversation_lines.is_empty() {
        messages
            .last()
            .map(|message| message.content.clone())
            .unwrap_or_default()
    } else {
        conversation_lines.join("\n")
    };

    (system_prompt, prompt)
}

fn now_unix_seconds_u64() -> u64 {
    now_unix_seconds().parse::<u64>().unwrap_or(0)
}

fn control_plane_bind_addr_from_env(
    port: Option<&str>,
    host: Option<&str>,
) -> Result<String, String> {
    let trimmed_host = host
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let trimmed_port = port
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");

    if trimmed_port.is_empty() {
        let bind_host = if trimmed_host.is_empty() {
            "127.0.0.1"
        } else {
            trimmed_host
        };
        return Ok(format!("{bind_host}:8787"));
    }

    let parsed_port = trimmed_port
        .parse::<u16>()
        .map_err(|_| format!("invalid PORT value: {trimmed_port}"))?;
    let bind_host = if trimmed_host.is_empty() {
        "0.0.0.0"
    } else {
        trimmed_host
    };

    Ok(format!("{bind_host}:{parsed_port}"))
}

fn control_plane_bind_addr() -> Result<String, String> {
    control_plane_bind_addr_from_env(
        std::env::var("PORT").ok().as_deref(),
        std::env::var("MUNDUSX_CONTROL_PLANE_HOST").ok().as_deref(),
    )
}

fn deploy_fingerprint_from_env(
    explicit: Option<&str>,
    railway_git_commit_sha: Option<&str>,
    source_version: Option<&str>,
    git_commit_sha: Option<&str>,
    railway_deployment_id: Option<&str>,
) -> Option<String> {
    [
        explicit,
        railway_git_commit_sha,
        source_version,
        git_commit_sha,
        railway_deployment_id,
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(str::to_string)
}

fn deploy_fingerprint() -> Option<String> {
    deploy_fingerprint_from_env(
        std::env::var("MUNDUSX_DEPLOY_FINGERPRINT").ok().as_deref(),
        std::env::var("RAILWAY_GIT_COMMIT_SHA").ok().as_deref(),
        std::env::var("SOURCE_VERSION").ok().as_deref(),
        std::env::var("GIT_COMMIT_SHA").ok().as_deref(),
        std::env::var("RAILWAY_DEPLOYMENT_ID").ok().as_deref(),
    )
}

fn status_snapshot_with_deploy_fingerprint(
    mut snapshot: serde_json::Value,
    deploy_fingerprint: Option<String>,
) -> serde_json::Value {
    if let serde_json::Value::Object(fields) = &mut snapshot {
        fields.insert(
            "deploy_fingerprint".to_string(),
            deploy_fingerprint
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
    }
    snapshot
}

fn load_local_env() {
    let mut current = match std::env::current_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };

    loop {
        let env_path = current.join(".env");
        if env_path.exists() {
            if let Ok(raw) = std::fs::read_to_string(&env_path) {
                for line in raw.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        continue;
                    }
                    let Some((key, value)) = trimmed.split_once('=') else {
                        continue;
                    };
                    let key = key.trim();
                    let value = value.trim().trim_matches('"');
                    if !key.is_empty() && std::env::var_os(key).is_none() {
                        std::env::set_var(key, value);
                    }
                }
            }
            return;
        }

        if !current.pop() {
            return;
        }
    }
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn escape_query_value(input: &str) -> String {
    let mut escaped = String::new();
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                escaped.push(byte as char)
            }
            _ => escaped.push_str(&format!("%{byte:02X}")),
        }
    }
    escaped
}

fn state_badge(state: &str) -> (&'static str, &'static str) {
    match state {
        "ready" => ("#12351f", "#8ef0aa"),
        "busy" => ("#3d2b0f", "#ffd27f"),
        "paused" => ("#3a2610", "#ffbf7a"),
        "stopped" => ("#3b1515", "#ff9d9d"),
        _ => ("#22304c", "#b8c7e8"),
    }
}

fn policy_badge(allowed: bool) -> (&'static str, &'static str, &'static str) {
    if allowed {
        ("#12351f", "#8ef0aa", "allowed")
    } else {
        ("#3b1515", "#ff9d9d", "blocked")
    }
}

fn backend_badge(backend: &str) -> (&'static str, &'static str) {
    match backend {
        "cuda" => ("#12351f", "#8ef0aa"),
        "m" => ("#173255", "#9bd1ff"),
        "auto" => ("#22304c", "#b8c7e8"),
        _ => ("#22304c", "#b8c7e8"),
    }
}

fn trust_badge(trust_path: &str) -> (&'static str, &'static str, &'static str) {
    if is_trusted_identity_path(trust_path) {
        ("#12351f", "#8ef0aa", trust_path_label(trust_path))
    } else if trust_path == contracts::IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK {
        ("#3a2610", "#ffbf7a", trust_path_label(trust_path))
    } else {
        ("#22304c", "#b8c7e8", trust_path_label(trust_path))
    }
}

const TOPOLOGY_SLOTS: [(&str, &str); 8] = [
    ("50%", "12%"),
    ("70%", "22%"),
    ("85%", "50%"),
    ("71%", "78%"),
    ("50%", "88%"),
    ("29%", "78%"),
    ("15%", "50%"),
    ("30%", "22%"),
];

const TOPOLOGY_NODE_ICON: &str = r#"<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="5" width="14" height="5" rx="1"/><rect x="5" y="14" width="14" height="5" rx="1"/><path d="M8 7.5h5"/><path d="M8 16.5h5"/></svg>"#;

fn is_topology_live_node(node: &NodeRecord) -> bool {
    node.policy_allowed && matches!(node.state.as_str(), "ready" | "busy")
}

fn topology_node_tone(node: &NodeRecord) -> &'static str {
    if is_trusted_identity_path(&node.identity_trust_path) {
        "trusted"
    } else {
        "online"
    }
}

fn render_topology_slots(state: &ControlPlaneState) -> String {
    let mut live_nodes: Vec<&NodeRecord> = state
        .nodes
        .values()
        .filter(|node| is_topology_live_node(node))
        .collect();
    live_nodes.sort_by(|left, right| {
        let left_updated = left.updated_at.parse::<u64>().unwrap_or(0);
        let right_updated = right.updated_at.parse::<u64>().unwrap_or(0);
        right_updated.cmp(&left_updated)
    });

    let mut html = String::new();
    for (index, (left, top)) in TOPOLOGY_SLOTS.iter().enumerate() {
        if let Some(node) = live_nodes.get(index) {
            let label = if node.hostname.trim().is_empty() {
                node.node_id.as_str()
            } else {
                node.hostname.as_str()
            };
            html.push_str(&format!(
                r#"<a class="topo-node {tone}" href="/nodes?search={query}" style="left:{left};top:{top};" title="Open {title} in Nodes"><div class="node-hex">{icon}</div><span class="topo-label">{label}</span><span class="topo-id">{state} - {backend}</span></a>"#,
                tone = topology_node_tone(node),
                query = escape_query_value(&node.node_id),
                title = escape_html(&node.node_id),
                icon = TOPOLOGY_NODE_ICON,
                label = escape_html(label),
                state = escape_html(node.state.as_str()),
                backend = escape_html(node.backend.as_str()),
            ));
        } else {
            html.push_str(&format!(
                r#"<div class="topo-node offline" style="left:{left};top:{top};" aria-label="Offline topology slot {slot}"><div class="node-hex">{icon}</div><span class="topo-label">Offline</span><span class="topo-id">slot {slot}</span></div>"#,
                slot = index + 1,
                icon = TOPOLOGY_NODE_ICON,
            ));
        }
    }
    html
}

fn render_nodes(state: &ControlPlaneState) -> String {
    let nodes: Vec<_> = state.nodes.values().cloned().collect();
    if nodes.is_empty() {
        return r#"<div class="empty">No nodes have registered yet.</div>"#.to_string();
    }

    let mut html = String::from(
        r#"<div class="table">
        <div class="thead">
          <div>Node</div>
          <div>Host</div>
          <div>Trust</div>
          <div>Backend</div>
          <div>State</div>
          <div>Power</div>
          <div>Policy</div>
          <div>Updated</div>
        </div>"#,
    );

    for node in nodes {
        let (state_bg, state_fg) = state_badge(node.state.as_str());
        let (trust_bg, trust_fg, trust_label) = trust_badge(&node.identity_trust_path);
        let (policy_bg, policy_fg, policy_label) = policy_badge(node.policy_allowed);
        let backend = node.backend.to_string();
        let (backend_bg, backend_fg) = backend_badge(&backend);
        let battery = node
            .battery_percent
            .map(|value| format!("{value}%"))
            .unwrap_or_else(|| "unknown".to_string());
        let power = format!(
            "{} • {} • {}",
            node.power_source,
            if node.on_battery { "battery" } else { "AC" },
            battery
        );
        let worker_health = node
            .worker_health
            .as_ref()
            .map(|health| {
                let model_dir = health.model_dir.as_str();
                let model_name = health.model_name.as_deref().unwrap_or("none");
                let model_path = health.model_path.as_deref().unwrap_or("missing");
                let runtime_mode = health.runtime_mode.as_str();
                let checked_at = health.checked_at.as_str();
                let notes = if health.notes.is_empty() {
                    "no notes".to_string()
                } else {
                    health.notes.join(" • ")
                };
                format!(
                    r#"<div class="meta">worker: {} • model dir {} • model {} • {} • runtime {} • checked {} • llama-cli {} • BLAS {}</div><div class="meta">{}</div>"#,
                    if health.healthy { "healthy" } else { "degraded" },
                    escape_html(model_dir),
                    escape_html(model_name),
                    escape_html(model_path),
                    escape_html(runtime_mode),
                    escape_html(checked_at),
                    if health.llama_cli_available { "yes" } else { "no" },
                    if health.blas_device_available { "yes" } else { "no" },
                    escape_html(&notes)
                )
            })
            .unwrap_or_else(|| r#"<div class="meta">worker: unknown</div>"#.to_string());
        let policy_reason = node
            .policy_reason
            .as_ref()
            .map(|reason| format!(r#"<div class="meta">{}</div>"#, escape_html(reason)))
            .unwrap_or_default();

        html.push_str(&format!(
            r#"<div class="row">
              <div>
                <strong>{}</strong>
                <div class="meta">fingerprint {}</div>
                <div class="meta">cap {}% • {} GPU% free</div>
              </div>
              <div>
                <div>{}</div>
                <div class="meta">signed device</div>
              </div>
              <div>
                <span class="pill" style="background:{};color:{};">{}</span>
                <div class="meta">{}</div>
              </div>
              <div><span class="pill" style="background:{};color:{};">{}</span></div>
              <div>
                <span class="pill" style="background:{};color:{};">{}</span>
                <div class="meta" style="margin-top:6px;">{}</div>
              </div>
              <div>
                <div>{}</div>
                <div class="meta">{}</div>
                {}
              </div>
              <div>
                <span class="pill" style="background:{};color:{};">{}</span>
                {}
              </div>
              <div>{}</div>
            </div>"#,
            escape_html(&node.node_id),
            escape_html(&node.public_key_fingerprint),
            node.contribution_percent,
            node.available_gpu_percent,
            escape_html(&node.hostname),
            trust_bg,
            trust_fg,
            escape_html(trust_label),
            escape_html(&node.identity_trust_path),
            backend_bg,
            backend_fg,
            escape_html(&backend),
            state_bg,
            state_fg,
            escape_html(&node.state.to_string()),
            escape_html(&node.state.to_string()),
            escape_html(&power),
            escape_html(&node.public_key_fingerprint),
            worker_health,
            policy_bg,
            policy_fg,
            policy_label,
            policy_reason,
            escape_html(&node.updated_at)
        ));
    }

    html.push_str("</div>");
    html
}

#[derive(Clone, Copy)]
enum OperatorPage {
    Nodes,
    Jobs,
    Credits,
    Registry,
    Settings,
}

impl OperatorPage {
    fn from_path(path: &str) -> Option<Self> {
        match path {
            "/nodes" => Some(Self::Nodes),
            "/jobs" => Some(Self::Jobs),
            "/credits" => Some(Self::Credits),
            "/registry" => Some(Self::Registry),
            "/settings" => Some(Self::Settings),
            _ => None,
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Nodes => "Nodes",
            Self::Jobs => "Jobs",
            Self::Credits => "Credits",
            Self::Registry => "Registry & Trust",
            Self::Settings => "Operator Settings",
        }
    }

    fn path(self) -> &'static str {
        match self {
            Self::Nodes => "/nodes",
            Self::Jobs => "/jobs",
            Self::Credits => "/credits",
            Self::Registry => "/registry",
            Self::Settings => "/settings",
        }
    }
}

fn operator_nav_item(page: OperatorPage, current: OperatorPage) -> String {
    let active = if page.path() == current.path() {
        " active"
    } else {
        ""
    };
    format!(
        r#"<a class="nav-item{active}" href="{}">{}</a>"#,
        page.path(),
        page.title()
    )
}

fn control_plane_operator_page(
    state: &ControlPlaneState,
    storage_source: StorageSource,
    sync_status: &SupabaseSyncStatus,
    page: OperatorPage,
    nodes_search: Option<&str>,
) -> String {
    let snapshot = state.snapshot(storage_source.as_str());
    let nodes = snapshot["online_count"].as_u64().unwrap_or(0);
    let trusted = snapshot["trusted_count"].as_u64().unwrap_or(0);
    let paused = snapshot["paused_count"].as_u64().unwrap_or(0);
    let policy_blocked = snapshot["policy_blocked_count"].as_u64().unwrap_or(0);
    let queued = snapshot["queued_job_count"].as_u64().unwrap_or(0);
    let assigned = snapshot["assigned_job_count"].as_u64().unwrap_or(0);
    let completed = snapshot["completed_job_count"].as_u64().unwrap_or(0);
    let failed = snapshot["failed_job_count"].as_u64().unwrap_or(0);
    let credits_total = snapshot["credits_total"].as_f64().unwrap_or(0.0);
    let credits_ledger = snapshot["credits_ledger"].as_u64().unwrap_or(0);
    let supabase = sync_status.summary();
    let deploy_fingerprint = deploy_fingerprint().unwrap_or_else(|| "unavailable".to_string());
    let nodes_search_value = nodes_search.map(escape_html).unwrap_or_default();
    let body = match page {
        OperatorPage::Nodes => format!(
            r#"<section class="toolbar" aria-label="Node fleet controls">
              <input aria-label="Search nodes" placeholder="Search node id, host, model, backend" value="{nodes_search_value}" />
              <select aria-label="Filter node state"><option>All states</option><option>Online</option><option>Trusted</option><option>Paused</option><option>Policy blocked</option></select>
              <select aria-label="Sort nodes"><option>Sort by last heartbeat</option><option>Sort by assigned jobs</option><option>Sort by credits</option><option>Sort by trust</option></select>
              <a class="button" href="/v1/nodes">Nodes JSON</a>
            </section>
            <section class="grid four">
              <div class="metric"><span>Online</span><strong>{nodes}</strong></div>
              <div class="metric"><span>Trusted</span><strong>{trusted}</strong></div>
              <div class="metric"><span>Paused</span><strong>{paused}</strong></div>
              <div class="metric"><span>Policy blocked</span><strong>{policy_blocked}</strong></div>
            </section>
            <section class="panel">
              <h2>Fleet Browser</h2>
              <p class="meta">Large fleets should be controlled here with search, filters, sorting, and batched operator actions. The overview topology stays summarized so hundreds of nodes do not become visual noise.</p>
              {}
            </section>"#,
            render_nodes(state)
        ),
        OperatorPage::Jobs => format!(
            r#"<section class="grid four">
              <div class="metric"><span>Queued</span><strong>{queued}</strong></div>
              <div class="metric"><span>Assigned</span><strong>{assigned}</strong></div>
              <div class="metric"><span>Completed</span><strong>{completed}</strong></div>
              <div class="metric"><span>Failed</span><strong>{failed}</strong></div>
            </section>
            <section class="panel">
              <h2>Job Queue</h2>
              <p class="meta">Operator job review belongs on this page with status filters, node/model/runtime facets, and safe retry or cancel controls when those actions are enabled.</p>
              <a class="button" href="/v1/jobs">Jobs JSON</a>
              <a class="button" href="/v1/job-events">Job Events JSON</a>
            </section>"#
        ),
        OperatorPage::Credits => format!(
            r#"<section class="grid two">
              <div class="metric"><span>Total credits</span><strong>{credits_total:.2}</strong></div>
              <div class="metric"><span>Ledger entries</span><strong>{credits_ledger}</strong></div>
            </section>
            <section class="panel">
              <h2>Credits Ledger</h2>
              <p class="meta">Credit reconciliation should use ledger history, node-level totals, and exportable raw data. Keep the raw endpoint available for automation.</p>
              <a class="button" href="/v1/credits">Credits JSON</a>
            </section>"#
        ),
        OperatorPage::Registry => format!(
            r#"<section class="grid four">
              <div class="metric"><span>Registered</span><strong>{nodes}</strong></div>
              <div class="metric"><span>Trusted</span><strong>{trusted}</strong></div>
              <div class="metric"><span>Policy blocked</span><strong>{policy_blocked}</strong></div>
              <div class="metric"><span>Storage</span><strong>{}</strong></div>
            </section>
            <section class="panel">
              <h2>Registry & Trust</h2>
              <p class="meta">Signed registry snapshots, identity trust paths, and policy decisions should be reviewed here. Raw node data remains available for contract checks.</p>
              <a class="button" href="/v1/nodes">Registry JSON</a>
              <a class="button" href="/v1/status">Status JSON</a>
            </section>"#,
            escape_html(storage_source.as_str())
        ),
        OperatorPage::Settings => format!(
            r#"<section class="grid two">
              <div class="metric"><span>Supabase sync</span><strong>{}</strong></div>
              <div class="metric"><span>Deploy</span><strong>{}</strong></div>
            </section>
            <section class="panel">
              <h2>Operator Controls</h2>
              <p class="meta">Authentication state, runtime caps, policy overrides, fallback approvals, and environment health should be managed here. Mutating controls stay behind operator-authenticated API calls.</p>
              <a class="button" href="/health">Health JSON</a>
              <a class="button" href="/v1/status">Status JSON</a>
            </section>"#,
            escape_html(&supabase),
            escape_html(&deploy_fingerprint)
        ),
    };
    let nav = [
        OperatorPage::Nodes,
        OperatorPage::Jobs,
        OperatorPage::Credits,
        OperatorPage::Registry,
        OperatorPage::Settings,
    ]
    .into_iter()
    .map(|nav_page| operator_nav_item(nav_page, page))
    .collect::<String>();

    format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title} - NovusX</title>
    <style>
      :root {{ color-scheme: dark; --bg:#020711; --surface:#06101d; --line:rgba(73,159,255,.22); --line-strong:rgba(45,164,255,.48); --text:#f6fbff; --muted:#9baac0; --blue:#33a8ff; }}
      * {{ box-sizing: border-box; }}
      body {{ margin:0; min-height:100vh; background:linear-gradient(135deg,#020711,#050b16 52%,#01040b); color:var(--text); font-family:Inter,"Segoe UI",sans-serif; }}
      a {{ color:inherit; text-decoration:none; }}
      .shell {{ display:grid; grid-template-columns:250px minmax(0,1fr); min-height:100vh; }}
      .sidebar {{ border-right:1px solid var(--line); background:rgba(2,9,18,.96); padding:26px 16px; display:flex; flex-direction:column; gap:22px; }}
      .brand {{ display:flex; align-items:center; gap:12px; font-family:Georgia,"Times New Roman",serif; font-size:22px; }}
      .brand-mark {{ width:54px; height:54px; border-radius:50%; object-fit:contain; }}
      .nav {{ display:grid; gap:8px; }}
      .nav-item {{ min-height:46px; display:flex; align-items:center; border:1px solid transparent; border-radius:7px; padding:0 13px; color:#b9c5d6; }}
      .nav-item:hover,.nav-item.active {{ color:#ecf8ff; border-color:var(--line-strong); background:rgba(51,168,255,.1); }}
      main {{ padding:32px; }}
      .topbar {{ display:flex; justify-content:space-between; gap:18px; align-items:flex-start; margin-bottom:22px; }}
      h1 {{ margin:0; font-size:34px; letter-spacing:0; }}
      h2 {{ margin:0 0 10px; font-size:18px; }}
      .meta {{ color:var(--muted); line-height:1.55; }}
      .button {{ min-height:38px; display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:8px; padding:0 12px; background:rgba(4,12,23,.72); margin-right:8px; margin-top:10px; }}
      .toolbar {{ display:grid; grid-template-columns:minmax(260px,1fr) 190px 210px auto; gap:12px; margin-bottom:18px; }}
      input,select {{ min-height:42px; border:1px solid var(--line); border-radius:8px; background:#030b14; color:var(--text); padding:0 12px; }}
      .grid {{ display:grid; gap:14px; margin-bottom:18px; }}
      .grid.four {{ grid-template-columns:repeat(4,minmax(0,1fr)); }}
      .grid.two {{ grid-template-columns:repeat(2,minmax(0,1fr)); }}
      .metric,.panel {{ border:1px solid var(--line); background:linear-gradient(180deg,rgba(8,23,41,.92),rgba(3,10,19,.92)); border-radius:8px; padding:18px; }}
      .metric span {{ color:var(--muted); display:block; font-size:13px; text-transform:uppercase; }}
      .metric strong {{ display:block; margin-top:7px; font-size:28px; }}
      .table {{ display:grid; overflow-x:auto; }}
      .thead,.row {{ display:grid; grid-template-columns:minmax(210px,1.15fr) minmax(130px,.7fr) minmax(170px,.95fr) minmax(90px,.45fr) minmax(90px,.45fr) minmax(340px,1.8fr) minmax(130px,.7fr) minmax(110px,.55fr); gap:14px; min-width:1280px; padding:14px 0; border-bottom:1px solid var(--line); }}
      .thead {{ color:var(--muted); text-transform:uppercase; font-size:12px; }}
      .row > div {{ min-width:0; overflow-wrap:anywhere; }}
      .row strong {{ overflow-wrap:anywhere; }}
      .row .meta {{ display:block; overflow-wrap:anywhere; word-break:break-word; }}
      .node-health {{ display:grid; gap:4px; overflow-wrap:anywhere; word-break:break-word; }}
      .pill {{ display:inline-flex; align-items:center; max-width:100%; min-height:22px; border-radius:4px; padding:2px 6px; overflow-wrap:anywhere; }}
      .empty {{ border:1px dashed var(--line); border-radius:8px; padding:24px; color:var(--muted); }}
      .api-box {{ margin-top:auto; border:1px solid var(--line); border-radius:8px; padding:14px; color:var(--muted); }}
      @media (max-width: 900px) {{ .shell {{ grid-template-columns:1fr; }} .sidebar {{ position:relative; }} .toolbar,.grid.four,.grid.two {{ grid-template-columns:1fr; }} main {{ padding:22px; }} }}
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="/"><img class="brand-mark" alt="NovusX logo" src="{logo_path}" /> <span>NovusX</span></a>
        <nav class="nav"><a class="nav-item" href="/">Overview</a>{nav}</nav>
        <div class="api-box"><strong>Developer APIs</strong><br/><a href="/health">Health JSON</a><br/><a href="/v1/status">Status JSON</a><br/><a href="/v1/nodes">Nodes JSON</a><br/><a href="/v1/jobs">Jobs JSON</a></div>
      </aside>
      <main>
        <div class="topbar"><div><h1>{title}</h1><div class="meta">Operator-facing control page. Raw contracts stay grouped under Developer APIs.</div></div><a class="button" href="/">Overview</a></div>
        {body}
      </main>
    </div>
  </body>
</html>"#,
        title = page.title(),
        logo_path = CONTROL_PLANE_LOGO_PATH,
        nav = nav,
        body = body
    )
}

fn control_plane_home(
    state: &ControlPlaneState,
    storage_source: StorageSource,
    sync_status: &SupabaseSyncStatus,
) -> String {
    let snapshot = state.snapshot(storage_source.as_str());
    let nodes = snapshot["online_count"].as_u64().unwrap_or(0);
    let trusted = snapshot["trusted_count"].as_u64().unwrap_or(0);
    let _paused = snapshot["paused_count"].as_u64().unwrap_or(0);
    let policy_blocked = snapshot["policy_blocked_count"].as_u64().unwrap_or(0);
    let job_events = snapshot["job_events"].as_u64().unwrap_or(0);
    let credits_ledger = snapshot["credits_ledger"].as_u64().unwrap_or(0);
    let credits_total = snapshot["credits_total"].as_f64().unwrap_or(0.0);
    let queued = snapshot["queued_job_count"].as_u64().unwrap_or(0);
    let assigned = snapshot["assigned_job_count"].as_u64().unwrap_or(0);
    let completed = snapshot["completed_job_count"].as_u64().unwrap_or(0);
    let failed = snapshot["failed_job_count"].as_u64().unwrap_or(0);
    let healthy_tone = "green";
    let storage_tone = if storage_source.as_str() == "supabase" {
        "green"
    } else {
        "amber"
    };
    let supabase = sync_status.summary();
    let supabase_tone = sync_status.tone();
    let deploy_fingerprint = deploy_fingerprint();
    let deploy_badge = deploy_fingerprint
        .as_deref()
        .map(|value| {
            format!(
                r#"<span class="pill pill-blue">deploy: {}</span>"#,
                escape_html(value)
            )
        })
        .unwrap_or_else(|| {
            r#"<span class="pill pill-amber">deploy: unavailable</span>"#.to_string()
        });
    let topology_slots = render_topology_slots(state);

    format!(
        r##"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NovusX Control Plane</title>
    <style>
      :root {{
        color-scheme: dark;
        --bg: #020711;
        --surface: rgba(4, 13, 24, 0.92);
        --surface-2: rgba(8, 22, 39, 0.86);
        --panel: rgba(3, 10, 20, 0.86);
        --line: rgba(73, 159, 255, 0.22);
        --line-strong: rgba(45, 164, 255, 0.48);
        --text: #f6fbff;
        --muted: #9baac0;
        --blue: #33a8ff;
        --cyan: #25d7ff;
        --purple: #9b6cff;
        --green: #39d98a;
        --orange: #f18f3b;
        --amber: #edb73f;
        --red: #ff5c63;
        --motion-fast: 140ms ease;
        --motion-medium: 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
        --focus-ring: 0 0 0 3px rgba(37, 215, 255, 0.28);
      }}
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at 48% 32%, rgba(0, 136, 255, 0.18), transparent 28%),
          radial-gradient(circle at 78% 10%, rgba(40, 216, 255, 0.11), transparent 24%),
          linear-gradient(135deg, #020711 0%, #050b16 52%, #01040b 100%);
        color: var(--text);
        font-family: Inter, "SF Pro Text", "Segoe UI", sans-serif;
      }}
      a {{ color: inherit; text-decoration: none; }}
      a:focus-visible {{
        outline: 0;
        box-shadow: var(--focus-ring);
      }}
      .motion-lift {{
        transition:
          transform var(--motion-medium),
          border-color var(--motion-fast),
          background var(--motion-fast),
          box-shadow var(--motion-medium),
          color var(--motion-fast);
        will-change: transform;
      }}
      .motion-lift:hover,
      .motion-lift:focus-visible {{
        transform: translateY(-2px);
        border-color: var(--line-strong);
        box-shadow: 0 18px 42px rgba(0, 0, 0, 0.28), 0 0 28px rgba(37, 215, 255, 0.15);
      }}
      .motion-glow {{
        transition: transform var(--motion-medium), filter var(--motion-medium), box-shadow var(--motion-medium);
        will-change: transform;
      }}
      .motion-glow:hover,
      .motion-glow:focus-visible {{
        transform: scale(1.04);
        filter: drop-shadow(0 0 22px rgba(37, 215, 255, 0.52));
      }}
      code {{
        background: rgba(46, 132, 255, 0.16);
        border: 1px solid rgba(46, 132, 255, 0.2);
        border-radius: 8px;
        color: #d9edff;
        padding: 3px 8px;
      }}
      .app-shell {{
        display: grid;
        grid-template-columns: 250px minmax(0, 1fr);
        min-height: 100vh;
      }}
      .sidebar {{
        position: sticky;
        top: 0;
        height: 100vh;
        border-right: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(2, 9, 18, 0.96), rgba(2, 8, 16, 0.9));
        padding: 26px 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 22px;
      }}
      .brand {{
        display: flex;
        align-items: center;
        gap: 12px;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 22px;
        color: #fff;
        border-radius: 8px;
      }}
      .brand-mark {{
        width: 54px;
        height: 54px;
        border-radius: 50%;
        object-fit: contain;
        filter: drop-shadow(0 0 16px rgba(70, 174, 255, 0.34));
      }}
      .nav {{
        display: grid;
        gap: 8px;
      }}
      .nav-item {{
        display: flex;
        align-items: center;
        gap: 14px;
        min-height: 54px;
        padding: 0 13px;
        border: 1px solid transparent;
        border-radius: 7px;
        color: #b9c5d6;
      }}
      .nav-item:hover,
      .nav-item:focus-visible {{
        color: #ecf8ff;
        background: rgba(51, 168, 255, 0.1);
      }}
      .nav-item.active {{
        color: #55bdff;
        border-color: rgba(35, 161, 255, 0.7);
        background: linear-gradient(90deg, rgba(0, 106, 255, 0.26), rgba(0, 165, 255, 0.08));
        box-shadow: 0 0 24px rgba(0, 128, 255, 0.25), inset 0 0 22px rgba(0, 136, 255, 0.1);
      }}
      .icon {{
        width: 22px;
        height: 22px;
        color: var(--blue);
        flex: 0 0 auto;
      }}
      .sidebar-bottom {{
        margin-top: auto;
        display: grid;
        gap: 16px;
      }}
      .side-card {{
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(6, 18, 32, 0.78);
        padding: 16px;
      }}
      .status-dot {{
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--cyan);
        box-shadow: 0 0 16px rgba(37, 215, 255, 0.7);
      }}
      .operator {{
        display: flex;
        align-items: center;
        gap: 12px;
      }}
      .avatar {{
        width: 42px;
        height: 42px;
        border-radius: 12px;
        background: linear-gradient(135deg, #14539e, #071f3c);
        display: grid;
        place-items: center;
        font-weight: 700;
      }}
      .main {{
        padding: 30px 28px 34px;
        min-width: 0;
      }}
      .topbar {{
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 24px;
        margin-bottom: 24px;
      }}
      h1 {{
        margin: 0;
        font-size: 34px;
        line-height: 1.1;
        letter-spacing: 0;
      }}
      .title-line {{
        display: flex;
        align-items: center;
        gap: 10px;
      }}
      .shield-mini {{
        color: var(--blue);
        width: 22px;
        height: 22px;
      }}
      .sub {{
        color: #bac6d8;
        margin-top: 10px;
        line-height: 1.5;
      }}
      .actions {{
        display: flex;
        align-items: center;
        gap: 18px;
        color: var(--muted);
        white-space: nowrap;
      }}
      .endpoint-button,
      .refresh-button {{
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(4, 12, 23, 0.72);
        color: var(--text);
        min-height: 42px;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 0 14px;
      }}
      .refresh-button {{
        width: 44px;
        justify-content: center;
        padding: 0;
      }}
      .live-dot {{
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--cyan);
        box-shadow: 0 0 16px rgba(37, 215, 255, 0.75);
      }}
      .statusline {{
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 24px;
      }}
      .pill {{
        display: inline-flex;
        align-items: center;
        min-height: 34px;
        padding: 0 16px;
        border-radius: 999px;
        font-size: 13px;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        border: 1px solid transparent;
      }}
      .pill-green {{ background: rgba(57, 217, 138, 0.08); color: var(--green); border-color: rgba(57, 217, 138, 0.34); }}
      .pill-orange {{ background: rgba(241, 143, 59, 0.08); color: var(--orange); border-color: rgba(241, 143, 59, 0.34); }}
      .pill-amber {{ background: rgba(237, 183, 63, 0.08); color: var(--amber); border-color: rgba(237, 183, 63, 0.34); }}
      .pill-red {{ background: rgba(255, 92, 99, 0.08); color: var(--red); border-color: rgba(255, 92, 99, 0.34); }}
      .pill-blue {{ background: rgba(51, 168, 255, 0.08); color: var(--blue); border-color: rgba(51, 168, 255, 0.46); }}
      .pill-neutral {{ background: rgba(95, 107, 133, 0.08); color: var(--muted); border-color: rgba(95, 107, 133, 0.2); }}
      .primary-metrics {{
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 18px;
      }}
      .secondary-metrics {{
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 18px;
        margin-top: 18px;
      }}
      .card {{
        border: 1px solid var(--line);
        background:
          radial-gradient(circle at 86% 80%, rgba(0, 128, 255, 0.16), transparent 38%),
          linear-gradient(180deg, rgba(8, 23, 41, 0.92), rgba(3, 10, 19, 0.92));
        border-radius: 8px;
        padding: 22px;
        position: relative;
        min-height: 112px;
        overflow: hidden;
        transition: transform var(--motion-medium), border-color var(--motion-fast), box-shadow var(--motion-medium);
      }}
      .card:hover,
      .card:focus-within {{
        border-color: var(--line-strong);
        transform: translateY(-2px);
        box-shadow: 0 20px 44px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      }}
      .card.compact {{
        min-height: 88px;
        padding: 18px;
        display: flex;
        align-items: center;
        gap: 16px;
      }}
      .metric-icon {{
        width: 58px;
        height: 58px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: radial-gradient(circle, rgba(0, 115, 255, 0.34), rgba(0, 58, 117, 0.24));
        color: var(--cyan);
        flex: 0 0 auto;
      }}
      .card-label {{
        color: #d8e2ef;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 13px;
      }}
      .card-value {{
        margin-top: 6px;
        font-size: 31px;
        line-height: 1.1;
      }}
      .delta {{
        color: var(--muted);
        font-size: 13px;
        margin-top: 4px;
      }}
      .sparkline {{
        position: absolute;
        right: 10px;
        bottom: 10px;
        width: 128px;
        height: 48px;
        opacity: 0.95;
      }}
      .work-grid {{
        display: grid;
        grid-template-columns: minmax(0, 1.7fr) minmax(360px, 1fr);
        gap: 18px;
        margin-top: 18px;
      }}
      .section {{
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(5, 14, 25, 0.9), rgba(2, 9, 17, 0.92));
        border-radius: 8px;
        overflow: hidden;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
        transition: border-color var(--motion-fast);
      }}
      .section:hover {{
        border-color: rgba(73, 159, 255, 0.34);
      }}
      .section-head {{
        padding: 18px 22px 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }}
      .section-title-row {{
        display: flex;
        align-items: center;
        gap: 13px;
      }}
      .section-title {{
        margin: 0;
        font-size: 18px;
        letter-spacing: 0;
      }}
      .section-body {{
        padding: 22px;
      }}
      .topology {{
        position: relative;
        height: 360px;
        border-bottom: 1px solid rgba(73, 159, 255, 0.12);
        overflow: hidden;
      }}
      .orbit {{
        position: absolute;
        inset: 42px 86px 28px;
        border: 1px dashed rgba(51, 168, 255, 0.44);
        border-radius: 50%;
      }}
      .grid-ring {{
        position: absolute;
        inset: 82px 170px 68px;
        border: 1px solid rgba(51, 168, 255, 0.1);
        border-radius: 50%;
      }}
      .radial {{
        position: absolute;
        left: 50%;
        top: 50%;
        width: 43%;
        height: 1px;
        transform-origin: 0 0;
        background: linear-gradient(90deg, rgba(51, 168, 255, 0.66), transparent);
      }}
      .radial.r2 {{ transform: rotate(45deg); }}
      .radial.r3 {{ transform: rotate(90deg); }}
      .radial.r4 {{ transform: rotate(135deg); }}
      .radial.r5 {{ transform: rotate(180deg); }}
      .radial.r6 {{ transform: rotate(225deg); }}
      .radial.r7 {{ transform: rotate(270deg); }}
      .radial.r8 {{ transform: rotate(315deg); }}
      .topology-center {{
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 154px;
        height: 128px;
        display: grid;
        place-items: center;
        text-align: center;
        overflow: visible;
        isolation: isolate;
        transition: transform var(--motion-medium);
      }}
      .topology-center::before,
      .topology-center::after {{
        content: "";
        position: absolute;
        clip-path: polygon(50% 0, 94% 24%, 94% 76%, 50% 100%, 6% 76%, 6% 24%);
        pointer-events: none;
      }}
      .topology-center::before {{
        inset: 0;
        z-index: 2;
        background: linear-gradient(145deg, rgba(126, 220, 255, 0.98), rgba(44, 147, 255, 0.76) 42%, rgba(128, 86, 255, 0.72));
        filter: drop-shadow(0 0 16px rgba(45, 174, 255, 0.54));
      }}
      .topology-center::after {{
        inset: 2px;
        z-index: 3;
        background: radial-gradient(circle at 50% 45%, rgba(50, 161, 255, 0.42), rgba(5, 20, 36, 0.98) 66%);
        box-shadow: inset 0 0 24px rgba(51, 168, 255, 0.28);
      }}
      .topology-center:hover {{
        transform: translate(-50%, -50%) scale(1.03);
      }}
      .topology-center:hover::before {{
        filter: drop-shadow(0 0 24px rgba(45, 174, 255, 0.78));
      }}
      .center-logo {{
        position: relative;
        z-index: 5;
        width: 76px;
        height: 76px;
        border-radius: 50%;
        object-fit: contain;
        filter: drop-shadow(0 0 11px rgba(55, 169, 255, 0.48));
      }}
      .logo-signal {{
        position: absolute;
        inset: 0;
        z-index: 1;
        clip-path: polygon(50% 0, 94% 24%, 94% 76%, 50% 100%, 6% 76%, 6% 24%);
        pointer-events: none;
        background: linear-gradient(145deg, rgba(90, 198, 255, 0.34), rgba(122, 91, 255, 0.16));
        box-shadow: 0 0 0 1px rgba(91, 194, 255, 0.38), 0 0 28px rgba(41, 163, 255, 0.28);
        opacity: 0;
        transform: scale(0.92);
        animation: logo-signal-wave 4.4s ease-out infinite;
      }}
      .logo-signal.s2 {{
        animation-delay: 1.45s;
      }}
      .logo-signal.s3 {{
        animation-delay: 2.9s;
      }}
      @keyframes logo-signal-wave {{
        0% {{
          transform: scale(0.92);
          opacity: 0;
        }}
        12% {{
          opacity: 0.48;
        }}
        72% {{
          opacity: 0.12;
        }}
        100% {{
          transform: scale(1.72);
          opacity: 0;
        }}
      }}
      .topo-node {{
        position: absolute;
        transform: translate(-50%, -50%);
        display: grid;
        justify-items: center;
        gap: 7px;
        color: #cad6e7;
        font-size: 12px;
        min-width: 112px;
        text-align: center;
        text-decoration: none;
      }}
      .node-hex {{
        position: relative;
        width: 52px;
        height: 46px;
        clip-path: polygon(50% 0, 95% 25%, 95% 75%, 50% 100%, 5% 75%, 5% 25%);
        border: 0;
        background: linear-gradient(135deg, rgba(101, 190, 255, 0.92), rgba(36, 118, 205, 0.42));
        display: grid;
        place-items: center;
        color: #dcecff;
        box-shadow: 0 0 18px rgba(41, 163, 255, 0.26);
        transition: transform var(--motion-medium), background var(--motion-fast), box-shadow var(--motion-medium);
        isolation: isolate;
      }}
      .node-hex::before {{
        content: "";
        position: absolute;
        inset: 1px;
        clip-path: inherit;
        background: rgba(4, 16, 29, 0.95);
        z-index: 0;
      }}
      .node-hex .icon {{
        position: relative;
        z-index: 1;
      }}
      .topo-label,
      .topo-id {{
        max-width: 112px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }}
      .topo-label {{
        font-weight: 700;
      }}
      .topo-id {{
        color: var(--muted);
        font-size: 11px;
      }}
      .topo-node.trusted .node-hex {{
        background: linear-gradient(135deg, rgba(117, 198, 255, 0.96), rgba(58, 139, 218, 0.48));
        box-shadow: 0 0 19px rgba(111, 183, 255, 0.34);
      }}
      .topo-node.offline {{
        color: #70839b;
        pointer-events: none;
      }}
      .topo-node.offline .node-hex {{
        background: linear-gradient(135deg, rgba(101, 116, 139, 0.42), rgba(31, 41, 55, 0.22));
        color: #7f8da3;
        box-shadow: none;
        opacity: 0.58;
      }}
      .topo-node.offline .node-hex::before {{
        background: rgba(5, 13, 24, 0.98);
      }}
      a.topo-node:hover .node-hex {{
        transform: translateY(-3px) scale(1.04);
        background: linear-gradient(135deg, rgba(37, 215, 255, 0.98), rgba(116, 91, 255, 0.68));
        box-shadow: 0 0 26px rgba(41, 163, 255, 0.48);
      }}
      .legend {{
        display: flex;
        align-items: center;
        gap: 18px;
        color: var(--muted);
        font-size: 12px;
      }}
      .legend span {{
        display: inline-flex;
        align-items: center;
        gap: 7px;
      }}
      .legend-dot {{
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--blue);
      }}
      .legend-dot.trusted {{ background: #6fb7ff; }}
      .legend-dot.paused {{ background: var(--purple); }}
      .legend-dot.offline {{ background: #64748b; }}
      .panel-footer {{
        border: 1px solid rgba(73, 159, 255, 0.16);
        border-radius: 8px;
        min-height: 38px;
        display: grid;
        place-items: center;
        margin-top: 16px;
      }}
      .credits-layout {{
        display: grid;
        grid-template-columns: 1fr 180px;
        gap: 20px;
        align-items: center;
      }}
      .credit-total {{
        color: #57adff;
        font-size: 42px;
        line-height: 1.1;
        margin: 8px 0 18px;
      }}
      .info-box {{
        border: 1px solid rgba(73, 159, 255, 0.17);
        border-radius: 8px;
        padding: 18px;
        color: #c6d2e2;
        line-height: 1.55;
        margin-top: 22px;
      }}
      .node-panel {{
        margin-top: 18px;
      }}
      .node-tools {{
        display: flex;
        align-items: center;
        gap: 12px;
      }}
      .node-summary {{
        width: 280px;
        min-height: 42px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(2, 9, 17, 0.78);
        color: var(--muted);
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 13px;
      }}
      .node-details-body {{
        border-top: 1px solid rgba(73, 159, 255, 0.13);
        min-height: 118px;
        display: grid;
        grid-template-columns: minmax(220px, 1fr) minmax(280px, 420px) minmax(220px, 1fr);
        align-items: center;
        gap: 16px;
        color: #cbd5e1;
      }}
      .node-art {{
        opacity: 0.45;
        justify-self: center;
      }}
      .table .thead,
      .table .row {{
        display: grid;
        grid-template-columns: 1.3fr 1fr 0.7fr 0.7fr 1fr 1.1fr 0.7fr;
        gap: 14px;
        align-items: start;
      }}
      .table .thead {{
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
        padding-bottom: 12px;
        margin-bottom: 12px;
        border-bottom: 1px solid var(--line);
      }}
      .table .row {{
        padding: 14px 0;
        border-bottom: 1px solid rgba(73, 159, 255, 0.12);
        transition: background var(--motion-fast), border-color var(--motion-fast);
      }}
      .table .row:hover {{
        background: rgba(51, 168, 255, 0.05);
        border-color: rgba(73, 159, 255, 0.24);
      }}
      .table .row:last-child {{ border-bottom: 0; }}
      .meta {{
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }}
      .empty {{
        color: var(--muted);
        padding: 28px 0;
      }}
      .links {{
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }}
      .api-link {{
        color: #57adff;
        font-size: 13px;
        border-radius: 6px;
      }}
      .api-strip {{
        margin-top: 18px;
        border-radius: 8px;
        border: 1px solid var(--line);
        padding: 11px 14px;
        background: rgba(3, 11, 20, 0.74);
      }}
      .foot {{
        color: var(--muted);
        font-size: 12px;
        margin-top: 22px;
      }}
      @media (max-width: 1200px) {{
        .app-shell {{ grid-template-columns: 1fr; }}
        .sidebar {{
          position: relative;
          height: auto;
          border-right: 0;
          border-bottom: 1px solid var(--line);
        }}
        .nav {{ grid-template-columns: repeat(3, minmax(0, 1fr)); }}
        .sidebar-bottom {{ display: none; }}
        .primary-metrics {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
        .secondary-metrics {{ grid-template-columns: repeat(3, minmax(0, 1fr)); }}
        .work-grid {{ grid-template-columns: 1fr; }}
        .table .thead,
        .table .row {{ grid-template-columns: 1.1fr 0.9fr 0.7fr 0.7fr 1fr 1fr 0.7fr; }}
      }}
      @media (max-width: 820px) {{
        .main {{ padding: 22px 14px; }}
        .topbar,
        .actions {{ flex-direction: column; align-items: stretch; }}
        .nav {{ grid-template-columns: 1fr 1fr; }}
        .primary-metrics,
        .secondary-metrics,
        .credits-layout,
        .node-details-body {{ grid-template-columns: 1fr; }}
        h1 {{ font-size: 30px; }}
        .topology {{ height: 430px; }}
        .orbit {{ inset: 90px 20px 58px; }}
        .grid-ring {{ inset: 130px 74px 96px; }}
        .topo-node {{ font-size: 11px; }}
        .node-summary {{ width: 100%; }}
        .table .thead {{ display: none; }}
        .table .row {{
          grid-template-columns: 1fr;
          gap: 10px;
          padding: 16px 0;
        }}
      }}
      @media (prefers-reduced-motion: reduce) {{
        *, *::before, *::after {{
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          scroll-behavior: auto !important;
          transition-duration: 0.01ms !important;
        }}
        .motion-lift:hover,
        .motion-lift:focus-visible,
        .motion-glow:hover,
        .motion-glow:focus-visible,
        .card:hover,
        .card:focus-within,
        .topology-center:hover,
        .topo-node:hover .node-hex {{
          transform: none;
        }}
        .logo-signal {{
          opacity: 0.18;
          transform: none;
        }}
      }}
    </style>
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar" aria-label="Control plane navigation">
        <a class="brand motion-glow" href="/" aria-label="NovusX control plane home"><img class="brand-mark" alt="NovusX control plane logo" src="{logo_path}" /> <span>NovusX</span></a>
        <nav class="nav">
          <a class="nav-item motion-lift active" href="/"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg>Overview</a>
          <a class="nav-item motion-lift" href="/nodes"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/></svg>Nodes</a>
          <a class="nav-item motion-lift" href="/jobs"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16"/><path d="M4 17h16"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/></svg>Jobs</a>
          <a class="nav-item motion-lift" href="/credits"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>Credits</a>
          <a class="nav-item motion-lift" href="/registry"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/></svg>Registry</a>
          <a class="nav-item motion-lift" href="/settings"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>Settings</a>
        </nav>
        <div class="sidebar-bottom">
          <div class="side-card">
            <div style="display:flex;align-items:center;gap:12px;"><span class="status-dot"></span><span>Control Plane Status</span></div>
            <div style="color:#54b9ff;margin-top:10px;">Healthy</div>
          </div>
          <div class="side-card operator">
            <div class="avatar">NX</div>
            <div><strong>Operator</strong><div class="meta">operator@novusx.ai</div></div>
          </div>
          <div class="foot">NovusX Control Plane<br/>v1.0.0</div>
        </div>
      </aside>

      <main class="main">
        <header class="topbar">
          <div>
            <div class="title-line">
              <h1>NovusX Control Plane</h1>
              <svg class="shield-mini" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="M12 8v8"/><path d="M9 12h6"/></svg>
            </div>
            <div class="sub">Real-time overview of your compute network, security posture, jobs, storage, and audit trail.</div>
          </div>
          <div class="actions">
            <a class="endpoint-button motion-lift" href="/v1/status"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m8 9-3 3 3 3"/><path d="m16 9 3 3-3 3"/><path d="m14 5-4 14"/></svg>Status API</a>
            <span>Last updated <span class="live-dot" aria-hidden="true"></span> Just now</span>
            <a class="refresh-button motion-lift" href="/" aria-label="Refresh"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v4h-4"/><path d="M6 22v-4h4"/></svg></a>
          </div>
        </header>

        <div class="statusline">
          <span class="pill pill-{healthy_tone}">healthy</span>
          <span class="pill pill-{storage_tone}">storage: {storage_source}</span>
          <span class="pill pill-{supabase_tone}">supabase: {supabase}</span>
          {deploy_badge}
        </div>

        <section class="primary-metrics" aria-label="Primary metrics">
          <div class="card"><div class="metric-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="16" r="2.5"/><circle cx="19" cy="16" r="2.5"/><path d="M10 7 6.5 14"/><path d="m14 7 3.5 7"/><path d="M7.5 16h9"/></svg></div><div style="position:absolute;left:104px;top:22px;"><div class="card-label">Online nodes</div><div class="card-value">{nodes}</div><div class="delta">-- vs last 24h</div></div><svg class="sparkline" viewBox="0 0 120 44" fill="none"><path d="M0 33 C14 28 16 17 27 19 C36 21 35 34 47 31 C60 28 54 12 69 11 C82 11 77 25 89 22 C101 19 102 8 120 4" stroke="#188fff" stroke-width="2"/></svg></div>
          <div class="card"><div class="metric-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/></svg></div><div style="position:absolute;left:104px;top:22px;"><div class="card-label">Trusted nodes</div><div class="card-value">{trusted}</div><div class="delta">-- vs last 24h</div></div><svg class="sparkline" viewBox="0 0 120 44" fill="none"><path d="M0 30 C10 14 18 34 27 19 S41 23 50 16 S66 27 74 13 S92 19 120 3" stroke="#188fff" stroke-width="2"/></svg></div>
          <div class="card"><div class="metric-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/></svg></div><div style="position:absolute;left:104px;top:22px;"><div class="card-label">Queued jobs</div><div class="card-value">{queued}</div><div class="delta">-- vs last 24h</div></div><svg class="sparkline" viewBox="0 0 120 44" fill="none"><path d="M0 34 C12 33 12 13 27 9 C39 6 42 31 55 28 C68 25 69 11 82 15 C95 19 99 17 120 4" stroke="#188fff" stroke-width="2"/></svg></div>
          <div class="card"><div class="metric-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg></div><div style="position:absolute;left:104px;top:22px;"><div class="card-label">Total credits</div><div class="card-value">{credits_total:.2}</div><div class="delta">-- vs last 24h</div></div><svg class="sparkline" viewBox="0 0 120 44" fill="none"><path d="M0 30 C12 12 19 27 30 20 S44 26 55 16 S70 20 80 7 S99 32 120 18" stroke="#188fff" stroke-width="2"/></svg></div>
        </section>

        <section class="secondary-metrics" aria-label="Secondary metrics">
          <div class="card compact"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-5"/></svg><div><div class="card-label">Job events</div><div class="card-value">{job_events}</div></div></div>
          <div class="card compact"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg><div><div class="card-label">Credits ledger</div><div class="card-value">{credits_ledger}</div></div></div>
          <div class="card compact"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/></svg><div><div class="card-label">Assigned jobs</div><div class="card-value">{assigned}</div></div></div>
          <div class="card compact"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-5"/></svg><div><div class="card-label">Completed jobs</div><div class="card-value">{completed}</div></div></div>
          <div class="card compact"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg><div><div class="card-label">Failed jobs</div><div class="card-value">{failed}</div></div></div>
          <div class="card compact"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="M12 8v8"/><path d="M9 12h6"/></svg><div><div class="card-label">Policy blocked</div><div class="card-value">{policy_blocked}</div></div></div>
        </section>

        <section class="work-grid">
          <div class="section">
            <div class="section-head">
              <div class="section-title-row"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="16" r="2.5"/><circle cx="19" cy="16" r="2.5"/><path d="M10 7 6.5 14"/><path d="m14 7 3.5 7"/><path d="M7.5 16h9"/></svg><div><h2 class="section-title">Network Topology</h2><div class="meta">Live view of NovusX compute network</div></div></div>
              <div class="legend"><span><i class="legend-dot"></i>Online</span><span><i class="legend-dot trusted"></i>Trusted</span><span><i class="legend-dot paused"></i>Paused</span><span><i class="legend-dot offline"></i>Offline</span></div>
            </div>
            <div class="section-body">
              <div class="topology">
                <div class="orbit"></div><div class="grid-ring"></div>
                <div class="radial"></div><div class="radial r2"></div><div class="radial r3"></div><div class="radial r4"></div><div class="radial r5"></div><div class="radial r6"></div><div class="radial r7"></div><div class="radial r8"></div>
                <div class="topology-center motion-glow"><span class="logo-signal s1" aria-hidden="true"></span><span class="logo-signal s2" aria-hidden="true"></span><span class="logo-signal s3" aria-hidden="true"></span><img class="center-logo" alt="NovusX topology logo" src="{logo_path}" /></div>
                {topology_slots}
              </div>
              <div class="panel-footer">{nodes} nodes registered</div>
            </div>
          </div>

          <div class="section">
            <div class="section-head">
              <div class="section-title-row"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg><h2 class="section-title">Credits Overview</h2></div>
              <span class="endpoint-button" style="min-height:34px;">7D</span>
            </div>
            <div class="section-body">
              <div class="credits-layout">
                <div><div class="meta">Total Credits</div><div class="credit-total">{credits_total:.2}</div></div>
                <svg viewBox="0 0 180 82" fill="none"><path d="M0 56 C12 14 20 78 35 42 S51 70 64 18 S82 64 96 36 S118 46 130 22 S155 35 180 18" stroke="#248fff" stroke-width="2"/></svg>
              </div>
              <p class="meta" style="font-size:15px;line-height:1.7;">Credits are accrued through the append-only ledger and exposed at <code>/v1/credits</code>.</p>
              <div class="info-box">
                <div style="display:flex;gap:12px;align-items:flex-start;"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg><div>Policy-aware nodes stay visible in the registry, but quiet nodes are excluded from scheduling.<br/>Current startup storage source: <code>{storage_source}</code><br/>Supabase sync is <code>{supabase}</code></div></div>
              </div>
              <div class="api-strip links" aria-label="Developer APIs"><span class="meta">Developer APIs</span><a class="api-link" href="/health">health json</a><a class="api-link" href="/v1/status">status json</a><a class="api-link" href="/v1/nodes">nodes json</a><a class="api-link" href="/v1/jobs">jobs json</a><a class="api-link" href="/v1/credits">credits json</a></div>
            </div>
          </div>
        </section>

        <section class="section node-panel">
          <div class="section-head">
            <div class="section-title-row"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="6" rx="1"/><rect x="4" y="14" width="16" height="6" rx="1"/><path d="M8 7h7"/><path d="M8 17h7"/></svg><h2 class="section-title">Node Details</h2></div>
            <div class="node-tools"><span class="meta">{nodes} registered</span><div class="node-summary"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>Signed registry snapshot</div><a class="endpoint-button motion-lift" href="/v1/nodes">Nodes JSON</a></div>
          </div>
          <div class="section-body">
            <div class="node-details-body">
              <div>{node_rows}</div>
              <svg class="node-art" width="260" height="90" viewBox="0 0 260 90" fill="none"><path d="M54 67h152" stroke="#2d75bd" opacity=".5"/><rect x="92" y="10" width="76" height="22" rx="4" stroke="#2d75bd"/><rect x="92" y="39" width="76" height="22" rx="4" stroke="#2d75bd"/><path d="M104 21h32M104 50h32" stroke="#57adff"/><circle cx="151" cy="21" r="2" fill="#57adff"/><circle cx="158" cy="50" r="2" fill="#57adff"/><path d="M46 70c4-16 21-16 26-5 6-6 16-2 17 5M207 70c4-16 21-16 26-5 6-6 16-2 17 5" stroke="#2d75bd" opacity=".5"/><path d="M70 14h8M74 10v8M202 10h8M206 6v8" stroke="#57adff" opacity=".6"/></svg>
              <div></div>
            </div>
          </div>
        </section>
        <div class="foot">Deploy fingerprint is exposed on <code>/health</code> and <code>/v1/status</code> for post-merge verification.</div>
      </main>
    </div>
  </body>
</html>"##,
        node_rows = render_nodes(state),
        storage_source = escape_html(storage_source.as_str()),
        logo_path = CONTROL_PLANE_LOGO_PATH,
        deploy_badge = deploy_badge
    )
}

struct RequestParts {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: String,
}

const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Debug, Eq, PartialEq)]
struct HttpRequestReadError {
    status: &'static str,
    message: String,
}

impl HttpRequestReadError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: "400 Bad Request",
            message: message.into(),
        }
    }

    fn payload_too_large(message: impl Into<String>) -> Self {
        Self {
            status: "413 Payload Too Large",
            message: message.into(),
        }
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
}

fn content_length_from_header_bytes(headers: &[u8]) -> Result<Option<usize>, HttpRequestReadError> {
    let header_text = std::str::from_utf8(headers)
        .map_err(|_| HttpRequestReadError::bad_request("request headers must be utf-8"))?;

    for line in header_text.split("\r\n").skip(1) {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("content-length") {
            let length = value
                .trim()
                .parse::<usize>()
                .map_err(|_| HttpRequestReadError::bad_request("invalid Content-Length"))?;
            if length > MAX_BODY_BYTES {
                return Err(HttpRequestReadError::payload_too_large(format!(
                    "request body exceeds {MAX_BODY_BYTES} bytes"
                )));
            }
            return Ok(Some(length));
        }
    }

    Ok(None)
}

fn read_http_request<R: Read>(reader: &mut R) -> Result<String, HttpRequestReadError> {
    let mut buffer = Vec::with_capacity(16 * 1024);
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let bytes_read = reader
            .read(&mut chunk)
            .map_err(|error| HttpRequestReadError::bad_request(error.to_string()))?;
        if bytes_read == 0 {
            return Err(HttpRequestReadError::bad_request("empty request"));
        }
        buffer.extend_from_slice(&chunk[..bytes_read]);
        if buffer.len() > MAX_HEADER_BYTES + MAX_BODY_BYTES {
            return Err(HttpRequestReadError::payload_too_large(format!(
                "request exceeds {} bytes",
                MAX_HEADER_BYTES + MAX_BODY_BYTES
            )));
        }
        if let Some(header_end) = find_header_end(&buffer) {
            break header_end;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(HttpRequestReadError::payload_too_large(format!(
                "request headers exceed {MAX_HEADER_BYTES} bytes"
            )));
        }
    };

    let content_length =
        content_length_from_header_bytes(&buffer[..header_end])?.unwrap_or_default();
    let expected_len = header_end
        .checked_add(content_length)
        .ok_or_else(|| HttpRequestReadError::payload_too_large("request is too large"))?;
    if expected_len > MAX_HEADER_BYTES + MAX_BODY_BYTES {
        return Err(HttpRequestReadError::payload_too_large(format!(
            "request exceeds {} bytes",
            MAX_HEADER_BYTES + MAX_BODY_BYTES
        )));
    }

    while buffer.len() < expected_len {
        let bytes_read = reader
            .read(&mut chunk)
            .map_err(|error| HttpRequestReadError::bad_request(error.to_string()))?;
        if bytes_read == 0 {
            return Err(HttpRequestReadError::bad_request(
                "request body ended before Content-Length was satisfied",
            ));
        }
        buffer.extend_from_slice(&chunk[..bytes_read]);
    }

    if content_length == 0 && buffer.len() > header_end {
        return Err(HttpRequestReadError::bad_request(
            "request body requires Content-Length",
        ));
    }

    String::from_utf8(buffer[..expected_len].to_vec())
        .map_err(|_| HttpRequestReadError::bad_request("request must be utf-8"))
}

fn parse_request(request: &str) -> RequestParts {
    let mut lines = request.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = BTreeMap::new();
    for line in lines.by_ref() {
        if line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let body = request
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or_default()
        .to_string();
    RequestParts {
        method,
        path,
        headers,
        body,
    }
}

fn split_path_and_query(path: &str) -> (&str, Option<&str>) {
    if let Some((clean_path, query)) = path.split_once('?') {
        (clean_path, Some(query))
    } else {
        (path, None)
    }
}

fn query_param<'a>(query: Option<&'a str>, key: &str) -> Option<&'a str> {
    let query = query?;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let candidate_key = parts.next().unwrap_or_default();
        let candidate_value = parts.next().unwrap_or_default();
        if candidate_key == key {
            return Some(candidate_value);
        }
    }
    None
}

fn header_value<'a>(headers: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    headers
        .get(&key.to_ascii_lowercase())
        .map(|value| value.as_str())
}

fn requires_device_signature(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        ("POST", "/v1/register")
            | ("POST", "/v1/heartbeat")
            | ("GET", "/v1/jobs/next")
            | ("POST", "/v1/jobs/complete")
    )
}

fn requires_operator_auth(method: &str, path: &str) -> bool {
    if method == "GET" && path.starts_with("/v1/jobs/") {
        return true;
    }

    matches!(
        (method, path),
        ("GET", "/")
            | ("GET", "/v1/status")
            | ("GET", "/v1/nodes")
            | ("POST", "/v1/nodes/policy-override")
            | ("GET", "/v1/jobs")
            | ("GET", "/v1/job-events")
            | ("GET", "/v1/credits")
            | ("POST", "/v1/jobs")
            | ("POST", "/v1/chat/completions")
            | ("POST", "/v1/nodes/contribution-cap")
    )
}

fn node_public_key_hex(state: &Arc<Mutex<ControlPlaneState>>, node_id: &str) -> Option<String> {
    state
        .lock()
        .expect("state lock")
        .nodes
        .get(node_id)
        .map(|node| node.public_key_hex.clone())
}

fn verify_signature(
    public_key_hex: &str,
    method: &str,
    path: &str,
    timestamp: &str,
    body: &str,
    signature_hex: &str,
) -> Result<(), String> {
    let public_bytes = hex::decode(public_key_hex).map_err(|error| error.to_string())?;
    let message = format!("{method}\n{path}\n{timestamp}\n{body}");

    #[cfg(target_os = "macos")]
    if public_bytes.len() == 65 {
        let storage_dir = state_path()
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(".mundusx-control-plane"));
        let verified = macos_identity::verify_message(
            &storage_dir,
            public_key_hex,
            message.as_bytes(),
            signature_hex,
        )
        .map_err(|error| error.to_string())?;
        if verified {
            return Ok(());
        }
        return Err("signature verification failed".to_string());
    }

    let public_bytes: [u8; 32] = public_bytes.try_into().map_err(|_| {
        "public key must be 32 bytes or macOS secure-enclave public key".to_string()
    })?;
    let verifying_key =
        VerifyingKey::from_bytes(&public_bytes).map_err(|error| error.to_string())?;
    let signature_bytes = hex::decode(signature_hex).map_err(|error| error.to_string())?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| error.to_string())?;
    verifying_key
        .verify(message.as_bytes(), &signature)
        .map_err(|error| error.to_string())
}

fn authorize_device_request(
    method: &str,
    route_path: &str,
    request_path: &str,
    headers: &BTreeMap<String, String>,
    body: &str,
    state: &Arc<Mutex<ControlPlaneState>>,
) -> Result<(), String> {
    if !requires_device_signature(method, route_path) {
        return Ok(());
    }

    let node_id = header_value(headers, "x-mundusx-node-id")
        .ok_or_else(|| "missing x-mundusx-node-id".to_string())?;
    let timestamp = header_value(headers, "x-mundusx-timestamp")
        .ok_or_else(|| "missing x-mundusx-timestamp".to_string())?;
    let signature = header_value(headers, "x-mundusx-signature")
        .ok_or_else(|| "missing x-mundusx-signature".to_string())?;

    let timestamp_value = timestamp
        .parse::<i64>()
        .map_err(|_| "invalid x-mundusx-timestamp".to_string())?;
    let current = now_unix_seconds()
        .parse::<i64>()
        .map_err(|_| "invalid current timestamp".to_string())?;
    if current.abs_diff(timestamp_value) > 300 {
        return Err("signature timestamp expired".to_string());
    }

    let public_key_hex = if route_path == "/v1/register" {
        let registration: AgentRegistration =
            serde_json::from_str(body).map_err(|error| error.to_string())?;
        if registration.node_id != node_id {
            return Err("node id header mismatch".to_string());
        }
        registration.public_key_hex
    } else {
        node_public_key_hex(state, node_id).ok_or_else(|| "unknown node".to_string())?
    };

    verify_signature(
        &public_key_hex,
        method,
        request_path,
        timestamp,
        body,
        signature,
    )
}

fn operator_auth_token() -> Option<String> {
    operator_auth_token_from_env(
        std::env::var(OPERATOR_TOKEN_ENV).ok().as_deref(),
        std::env::var(LEGACY_OPERATOR_TOKEN_ENV).ok().as_deref(),
    )
}

fn operator_auth_token_from_env(
    operator_token: Option<&str>,
    legacy_operator_token: Option<&str>,
) -> Option<String> {
    operator_token
        .or(legacy_operator_token)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

fn auth_disabled_flag_enabled(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .map(|value| {
            value.eq_ignore_ascii_case("true")
                || value == "1"
                || value.eq_ignore_ascii_case("yes")
                || value.eq_ignore_ascii_case("on")
        })
        .unwrap_or(false)
}

fn operator_auth_mode_from_env(
    auth_disabled: Option<&str>,
    operator_token: Option<&str>,
    legacy_operator_token: Option<&str>,
) -> OperatorAuthMode {
    if auth_disabled_flag_enabled(auth_disabled) {
        return OperatorAuthMode::ExplicitlyDisabled;
    }

    match operator_auth_token_from_env(operator_token, legacy_operator_token) {
        Some(_) => OperatorAuthMode::Enforced,
        None => OperatorAuthMode::MissingTokenDisabled,
    }
}

fn operator_auth_mode() -> OperatorAuthMode {
    operator_auth_mode_from_env(
        std::env::var(AUTH_DISABLED_ENV).ok().as_deref(),
        std::env::var(OPERATOR_TOKEN_ENV).ok().as_deref(),
        std::env::var(LEGACY_OPERATOR_TOKEN_ENV).ok().as_deref(),
    )
}

fn control_plane_environment_from_env(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local")
        .to_ascii_lowercase()
}

fn auth_disabled_allowed_in_environment(environment: &str) -> bool {
    matches!(
        environment,
        "local" | "dev" | "development" | "test" | "uat"
    )
}

fn operator_auth_startup_config_error(
    auth_disabled: Option<&str>,
    environment: Option<&str>,
) -> Option<String> {
    if !auth_disabled_flag_enabled(auth_disabled) {
        return None;
    }

    let environment = control_plane_environment_from_env(environment);
    if auth_disabled_allowed_in_environment(&environment) {
        return None;
    }

    Some(format!(
        "{AUTH_DISABLED_ENV}=true is only allowed when {CONTROL_PLANE_ENVIRONMENT_ENV} is local, dev, development, test, or uat; current environment is {environment}"
    ))
}

fn operator_auth_startup_error() -> Option<String> {
    operator_auth_startup_config_error(
        std::env::var(AUTH_DISABLED_ENV).ok().as_deref(),
        std::env::var(CONTROL_PLANE_ENVIRONMENT_ENV).ok().as_deref(),
    )
}

fn legacy_operator_token_warning() -> Option<String> {
    let canonical_present = std::env::var(OPERATOR_TOKEN_ENV)
        .ok()
        .map(|token| !token.trim().is_empty())
        .unwrap_or(false);
    let legacy_present = std::env::var(LEGACY_OPERATOR_TOKEN_ENV)
        .ok()
        .map(|token| !token.trim().is_empty())
        .unwrap_or(false);

    if legacy_present && !canonical_present {
        Some(format!(
            "{LEGACY_OPERATOR_TOKEN_ENV} is deprecated; set {OPERATOR_TOKEN_ENV} instead. Using the legacy token for this process."
        ))
    } else {
        None
    }
}

fn authorize_operator_request(
    method: &str,
    route_path: &str,
    headers: &BTreeMap<String, String>,
) -> Result<(), String> {
    if !requires_operator_auth(method, route_path) {
        return Ok(());
    }

    if !operator_auth_mode().enforced() {
        return Ok(());
    }

    let expected_token =
        operator_auth_token().expect("operator auth mode requires a non-empty token");

    let authorization = header_value(headers, "authorization")
        .or_else(|| header_value(headers, "x-mundusx-operator-token"))
        .ok_or_else(|| "missing operator authorization".to_string())?;

    let presented = authorization
        .strip_prefix("Bearer ")
        .or_else(|| authorization.strip_prefix("bearer "))
        .unwrap_or(authorization)
        .trim();

    if presented
        .as_bytes()
        .ct_eq(expected_token.as_bytes())
        .unwrap_u8()
        == 0
    {
        return Err("invalid operator token".to_string());
    }

    Ok(())
}

fn note_supabase_failure(sync_status: &Arc<Mutex<SupabaseSyncStatus>>, error: String) {
    if let Ok(mut guard) = sync_status.lock() {
        guard.note_failure(error);
    }
}

fn handle_connection(
    mut stream: TcpStream,
    state: Arc<Mutex<ControlPlaneState>>,
    sync_status: Arc<Mutex<SupabaseSyncStatus>>,
    supabase: Option<&SupabaseMirror>,
    storage_source: StorageSource,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let request_text = match read_http_request(&mut stream) {
        Ok(request_text) => request_text,
        Err(error) => {
            let _ = stream.write_all(text_response(error.status, &error.message).as_bytes());
            return;
        }
    };

    let request = parse_request(&request_text);
    let (clean_path, query) = split_path_and_query(&request.path);

    if request.method == "GET" && clean_path == CONTROL_PLANE_LOGO_PATH {
        let _ = stream.write_all(&png_response("200 OK", CONTROL_PLANE_LOGO_PNG));
        return;
    }

    if let Err(error) = authorize_device_request(
        &request.method,
        clean_path,
        &request.path,
        &request.headers,
        &request.body,
        &state,
    ) {
        let _ = stream.write_all(
            json_response("401 Unauthorized", serde_json::json!({ "error": error })).as_bytes(),
        );
        return;
    }

    if let Err(error) = authorize_operator_request(&request.method, clean_path, &request.headers) {
        let _ = stream.write_all(
            json_response("401 Unauthorized", serde_json::json!({ "error": error })).as_bytes(),
        );
        return;
    }

    let response = match (request.method.as_str(), clean_path) {
        ("GET", "/") => {
            let snapshot = state.lock().expect("state lock");
            let sync_snapshot = sync_status.lock().expect("sync status lock").clone();
            html_response(
                "200 OK",
                &control_plane_home(&snapshot, storage_source, &sync_snapshot),
            )
        }
        ("GET", path) if OperatorPage::from_path(path).is_some() => {
            let page = OperatorPage::from_path(path).expect("operator page");
            let snapshot = state.lock().expect("state lock");
            let sync_snapshot = sync_status.lock().expect("sync status lock").clone();
            let nodes_search = query_param(query, "search");
            html_response(
                "200 OK",
                &control_plane_operator_page(
                    &snapshot,
                    storage_source,
                    &sync_snapshot,
                    page,
                    nodes_search,
                ),
            )
        }
        ("GET", "/health") => {
            let snapshot = state
                .lock()
                .expect("state lock")
                .snapshot(storage_source.as_str());
            let sync_snapshot = sync_status.lock().expect("sync status lock").clone();
            let deploy_fingerprint = deploy_fingerprint();
            let auth_mode = operator_auth_mode();
            let environment = control_plane_environment_from_env(
                std::env::var(CONTROL_PLANE_ENVIRONMENT_ENV).ok().as_deref(),
            );
            json_response(
                "200 OK",
                serde_json::json!({
                    "status": "ok",
                    "storage_source": storage_source.as_str(),
                    "supabase": sync_snapshot.summary(),
                    "supabase_sync": sync_snapshot,
                    "deploy_fingerprint": deploy_fingerprint,
                    "environment": environment,
                    "operator_auth_enforced": auth_mode.enforced(),
                    "operator_auth_mode": auth_mode.as_str(),
                    "snapshot": snapshot,
                }),
            )
        }
        ("GET", "/v1/status") => {
            let snapshot = state
                .lock()
                .expect("state lock")
                .snapshot(storage_source.as_str());
            json_response(
                "200 OK",
                status_snapshot_with_deploy_fingerprint(snapshot, deploy_fingerprint()),
            )
        }
        ("GET", "/v1/nodes") => {
            let snapshot = state.lock().expect("state lock").nodes_snapshot();
            json_response("200 OK", snapshot)
        }
        ("POST", "/v1/nodes/contribution-cap") => {
            match serde_json::from_str::<OperatorContributionPercentUpdate>(&request.body) {
                Ok(update) => {
                    let mut guard = state.lock().expect("state lock");
                    match guard.set_operator_contribution_percent(
                        &update.node_id,
                        update.contribution_percent,
                    ) {
                        Ok(record) => {
                            let event = guard.record_job_event(
                                Some(record.node_id.clone()),
                                None,
                                "operator_contribution_percent_updated",
                                serde_json::json!({
                                    "node_id": record.node_id,
                                    "contribution_percent": record.contribution_percent,
                                    "reported_contribution_percent": record.reported_contribution_percent,
                                    "operator_contribution_percent": record.operator_contribution_percent,
                                }),
                                now_unix_seconds(),
                            );
                            if let Err(error) = save_state(&guard) {
                                eprintln!("failed to save control-plane state: {error}");
                            }
                            if let Some(db) = supabase.as_ref() {
                                if let Err(error) = db.record_job_event(&event) {
                                    eprintln!("database operator cap event skipped: {error}");
                                    note_supabase_failure(&sync_status, error);
                                }
                            }
                            json_response("200 OK", serde_json::to_value(record).expect("json"))
                        }
                        Err(error) => {
                            json_response("400 Bad Request", serde_json::json!({ "error": error }))
                        }
                    }
                }
                Err(error) => json_response(
                    "400 Bad Request",
                    serde_json::json!({ "error": error.to_string() }),
                ),
            }
        }
        ("GET", "/v1/jobs") => {
            let snapshot = state.lock().expect("state lock").jobs_snapshot();
            json_response("200 OK", snapshot)
        }
        ("GET", "/v1/jobs/next") => {
            if let Some(node_id) = query_param(query, "node_id") {
                let mut guard = state.lock().expect("state lock");
                let claim = guard.claim_job(node_id, now_unix_seconds());
                if let Some(job) = claim.job.as_ref() {
                    let event = guard.record_job_event(
                        Some(node_id.to_string()),
                        Some(job.job_id.clone()),
                        "job_claimed",
                        serde_json::to_value(job).expect("json"),
                        now_unix_seconds(),
                    );
                    if let Some(db) = supabase.as_ref() {
                        if let Err(error) = db.record_job_event(&event) {
                            eprintln!("database claim sync skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                    }
                }
                if let Err(error) = save_state(&guard) {
                    eprintln!("failed to save control-plane state: {error}");
                }
                json_response("200 OK", serde_json::to_value(claim).expect("json"))
            } else {
                text_response("400 Bad Request", "missing node_id")
            }
        }
        ("GET", path) if path.starts_with("/v1/jobs/") => {
            let job_id = path.trim_start_matches("/v1/jobs/");
            if job_id.is_empty() || job_id.contains('/') {
                json_response(
                    "404 Not Found",
                    serde_json::json!({ "error": "job not found" }),
                )
            } else {
                let record = state.lock().expect("state lock").jobs.get(job_id).cloned();
                match record {
                    Some(record) => json_response("200 OK", job_async_payload(&record)),
                    None => json_response(
                        "404 Not Found",
                        serde_json::json!({ "error": "job not found" }),
                    ),
                }
            }
        }
        ("GET", "/v1/job-events") => {
            let snapshot = state.lock().expect("state lock").job_events_snapshot();
            json_response("200 OK", snapshot)
        }
        ("GET", "/v1/credits") => {
            let snapshot = state.lock().expect("state lock").credits_snapshot();
            json_response("200 OK", snapshot)
        }
        ("POST", "/v1/register") => {
            match serde_json::from_str::<AgentRegistration>(&request.body) {
                Ok(registration) => {
                    let registration_clone = registration.clone();
                    let mut guard = state.lock().expect("state lock");
                    let record = guard.register(registration);
                    let event = guard.record_job_event(
                        Some(record.node_id.clone()),
                        None,
                        "registration",
                        serde_json::to_value(&record).expect("json"),
                        now_unix_seconds(),
                    );
                    if let Err(error) = save_state(&guard) {
                        eprintln!("failed to save control-plane state: {error}");
                    }
                    if let Some(db) = supabase.as_ref() {
                        if let Err(error) = db.record_registration(&registration_clone) {
                            eprintln!("database registration sync skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                        if let Err(error) = db.record_job_event(&event) {
                            eprintln!("database registration event skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                    }
                    json_response("200 OK", serde_json::to_value(record).expect("json"))
                }
                Err(error) => json_response(
                    "400 Bad Request",
                    serde_json::json!({ "error": error.to_string() }),
                ),
            }
        }
        ("POST", "/v1/nodes/policy-override") => {
            match serde_json::from_str::<OperatorNodePolicyOverrideUpdate>(&request.body) {
                Ok(update) => {
                    let actor = update
                        .actor
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("operator")
                        .to_string();
                    let reason = update
                        .reason
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string);
                    let override_input = if let Some(target) = update.target {
                        if let Some(reason) = reason.clone() {
                            Some(NodePolicyOverrideInput {
                                target,
                                reason,
                                actor: actor.clone(),
                                updated_at: now_unix_seconds(),
                            })
                        } else {
                            return stream.write_all(
                                json_response(
                                    "400 Bad Request",
                                    serde_json::json!({ "error": "reason is required when setting a policy override" }),
                                )
                                .as_bytes(),
                            ).unwrap_or(());
                        }
                    } else {
                        None
                    };

                    let mut guard = state.lock().expect("state lock");
                    match guard.set_node_policy_override(&update.node_id, override_input) {
                        Ok(record) => {
                            let event = guard.record_job_event(
                                Some(record.node_id.clone()),
                                None,
                                "operator_policy_override_updated",
                                serde_json::json!({
                                    "node_id": record.node_id,
                                    "target": record.operator_policy_override.as_ref().map(|value| value.target.as_str()),
                                    "reason": reason,
                                    "actor": actor,
                                    "reported_state": record.reported_state,
                                    "state": record.state,
                                    "computed_policy_allowed": record.computed_policy_allowed,
                                    "computed_policy_reason": record.computed_policy_reason,
                                    "policy_allowed": record.policy_allowed,
                                    "policy_reason": record.policy_reason,
                                    "operator_policy_override": record.operator_policy_override,
                                }),
                                now_unix_seconds(),
                            );
                            if let Err(error) = save_state(&guard) {
                                eprintln!("failed to save control-plane state: {error}");
                            }
                            if let Some(db) = supabase.as_ref() {
                                if let Err(error) = db.record_node_snapshot(&record) {
                                    eprintln!("database node override sync skipped: {error}");
                                    note_supabase_failure(&sync_status, error);
                                }
                                if let Err(error) = db.record_job_event(&event) {
                                    eprintln!("database node override event skipped: {error}");
                                    note_supabase_failure(&sync_status, error);
                                }
                            }
                            json_response("200 OK", serde_json::to_value(record).expect("json"))
                        }
                        Err(error) => {
                            json_response("400 Bad Request", serde_json::json!({ "error": error }))
                        }
                    }
                }
                Err(error) => json_response(
                    "400 Bad Request",
                    serde_json::json!({ "error": error.to_string() }),
                ),
            }
        }
        ("POST", "/v1/heartbeat") => match serde_json::from_str::<Heartbeat>(&request.body) {
            Ok(heartbeat) => {
                let heartbeat_clone = heartbeat.clone();
                let mut guard = state.lock().expect("state lock");
                let record = guard.heartbeat(heartbeat, now_unix_seconds());
                let event = guard.record_job_event(
                    Some(record.node_id.clone()),
                    None,
                    "heartbeat",
                    serde_json::to_value(&record).expect("json"),
                    now_unix_seconds(),
                );
                if let Err(error) = save_state(&guard) {
                    eprintln!("failed to save control-plane state: {error}");
                }
                if let Some(db) = supabase.as_ref() {
                    if let Err(error) = db.record_heartbeat(&heartbeat_clone, &record) {
                        eprintln!("database heartbeat sync skipped: {error}");
                        note_supabase_failure(&sync_status, error);
                    }
                    if let Err(error) = db.record_job_event(&event) {
                        eprintln!("database heartbeat event skipped: {error}");
                        note_supabase_failure(&sync_status, error);
                    }
                }
                json_response("200 OK", serde_json::to_value(record).expect("json"))
            }
            Err(error) => json_response(
                "400 Bad Request",
                serde_json::json!({ "error": error.to_string() }),
            ),
        },
        ("POST", "/v1/jobs") => match serde_json::from_str::<JobRequest>(&request.body) {
            Ok(request) => {
                let mut guard = state.lock().expect("state lock");
                let record = guard.submit_job(request, now_unix_seconds());
                let event = guard.record_job_event(
                    None,
                    Some(record.job_id.clone()),
                    "job_submitted",
                    serde_json::to_value(&record).expect("json"),
                    now_unix_seconds(),
                );
                if let Err(error) = save_state(&guard) {
                    eprintln!("failed to save control-plane state: {error}");
                }
                if let Some(db) = supabase.as_ref() {
                    if let Err(error) = db.record_job(&record) {
                        eprintln!("database job sync skipped: {error}");
                        note_supabase_failure(&sync_status, error);
                    }
                    if let Err(error) = db.record_job_event(&event) {
                        eprintln!("database job event skipped: {error}");
                        note_supabase_failure(&sync_status, error);
                    }
                }
                json_response("202 Accepted", job_async_payload(&record))
            }
            Err(error) => json_response(
                "400 Bad Request",
                serde_json::json!({ "error": error.to_string() }),
            ),
        },
        ("POST", "/v1/chat/completions") => {
            match serde_json::from_str::<ChatCompletionRequest>(&request.body) {
                Ok(request_body) => {
                    if request_body.stream.unwrap_or(false) {
                        if let Err(error) = stream.write_all(
                            json_response(
                                "400 Bad Request",
                                serde_json::json!({
                                    "error": "streaming chat completions are not supported yet"
                                }),
                            )
                            .as_bytes(),
                        ) {
                            eprintln!("failed to write response: {error}");
                        }
                        return;
                    }

                    let (system_prompt, prompt) = chat_messages_to_prompt(&request_body.messages);
                    let job_request = JobRequest {
                        request_id: format!("chatcmpl-{}", Uuid::new_v4().simple()),
                        prompt,
                        preferred_backend: crate::contracts::Backend::Auto,
                        runtime_mode: RuntimeMode::Interactive,
                        stream: false,
                        model: Some(request_body.model.clone()),
                        system_prompt,
                        max_tokens: request_body.max_tokens,
                        temperature: request_body.temperature,
                        top_p: request_body.top_p,
                        seed: request_body.seed,
                    };

                    let mut guard = state.lock().expect("state lock");
                    let record = guard.submit_job(job_request, now_unix_seconds());
                    let event = guard.record_job_event(
                        None,
                        Some(record.job_id.clone()),
                        "chat_completion_submitted",
                        serde_json::to_value(&record).expect("json"),
                        now_unix_seconds(),
                    );
                    if let Err(error) = save_state(&guard) {
                        eprintln!("failed to save control-plane state: {error}");
                    }
                    if let Some(db) = supabase.as_ref() {
                        if let Err(error) = db.record_job(&record) {
                            eprintln!("database chat completion sync skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                        if let Err(error) = db.record_job_event(&event) {
                            eprintln!("database chat completion event skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                    }

                    let response = ChatCompletionResponse {
                        id: format!("chatcmpl-{}", Uuid::new_v4().simple()),
                        object: "chat.completion".to_string(),
                        created: now_unix_seconds_u64(),
                        model: request_body.model,
                        choices: vec![ChatCompletionChoice {
                            index: 0,
                            message: ChatCompletionChoiceMessage {
                                role: "assistant".to_string(),
                                content: String::new(),
                            },
                            finish_reason: "queued".to_string(),
                        }],
                        mundusx: ChatCompletionMundusX {
                            job_id: record.job_id.clone(),
                            request_id: record.request_id.clone(),
                            status: record.status.to_string(),
                        },
                    };

                    json_response("200 OK", serde_json::to_value(response).expect("json"))
                }
                Err(error) => json_response(
                    "400 Bad Request",
                    serde_json::json!({ "error": error.to_string() }),
                ),
            }
        }
        ("POST", "/v1/jobs/complete") => match serde_json::from_str::<JobCompletion>(&request.body)
        {
            Ok(completion) => {
                let completion_clone = completion.clone();
                let mut guard = state.lock().expect("state lock");
                let record = guard.complete_job(completion, now_unix_seconds());
                if let Some(job) = record.as_ref() {
                    let completed_at = job.completed_at.clone().unwrap_or_else(now_unix_seconds);
                    let event_type = if matches!(job.status, crate::contracts::JobStatus::Completed)
                    {
                        "job_completed"
                    } else {
                        "job_failed"
                    };
                    let event = guard.record_job_event(
                        job.assigned_node_id.clone(),
                        Some(job.job_id.clone()),
                        event_type,
                        serde_json::to_value(job).expect("json"),
                        now_unix_seconds(),
                    );
                    if let Some(db) = supabase.as_ref() {
                        if let Err(error) = db.record_job_event(&event) {
                            eprintln!("database completion event skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                    }
                    if matches!(job.status, crate::contracts::JobStatus::Completed) {
                        if let Some(award) = guard.award_job_reward(job, completed_at) {
                            let award_event = guard.record_job_event(
                                award.device_id.clone(),
                                award.job_id.clone(),
                                "credit_awarded",
                                serde_json::to_value(&award).expect("json"),
                                award.created_at.clone(),
                            );
                            if let Some(db) = supabase.as_ref() {
                                if let Err(error) = db.record_credit_award(&award) {
                                    eprintln!("database credit sync skipped: {error}");
                                    note_supabase_failure(&sync_status, error);
                                }
                                if let Err(error) = db.record_job_event(&award_event) {
                                    eprintln!("database credit event skipped: {error}");
                                    note_supabase_failure(&sync_status, error);
                                }
                            }
                        }
                    }
                }
                if let Err(error) = save_state(&guard) {
                    eprintln!("failed to save control-plane state: {error}");
                }
                if let Some(db) = supabase.as_ref() {
                    if let Some(job) = record.as_ref() {
                        if let Err(error) = db.record_job_completion(&completion_clone, job) {
                            eprintln!("database completion sync skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                    }
                }
                match record {
                    Some(record) => {
                        json_response("200 OK", serde_json::to_value(record).expect("json"))
                    }
                    None => json_response(
                        "404 Not Found",
                        serde_json::json!({ "error": "job not found" }),
                    ),
                }
            }
            Err(error) => json_response(
                "400 Bad Request",
                serde_json::json!({ "error": error.to_string() }),
            ),
        },
        _ => text_response("404 Not Found", "not found"),
    };

    let _ = stream.write_all(response.as_bytes());
}

fn main() {
    load_local_env();
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|arg| arg.as_str()) == Some("migrate") {
        match std::env::var("DATABASE_URL") {
            Ok(database_url) => match apply_migrations(&database_url) {
                Ok(applied) => {
                    if applied.is_empty() {
                        println!("no migrations to apply");
                    } else {
                        for migration in applied {
                            println!(
                                "applied {}_{} ({})",
                                migration.version,
                                migration.name,
                                migration.path.display()
                            );
                        }
                    }
                }
                Err(error) => {
                    eprintln!("migration failed: {error}");
                    std::process::exit(1);
                }
            },
            Err(_) => {
                eprintln!("DATABASE_URL is required for migrate");
                std::process::exit(1);
            }
        }
        return;
    }

    let supabase = SupabaseMirror::from_env();
    let bind_addr = control_plane_bind_addr().expect("resolve bind address");
    let listener = TcpListener::bind(&bind_addr).expect("bind control plane");
    let (restored_state, storage_source, sync_status) = match supabase.as_ref() {
        Some(db) => match db.restore_state() {
            Ok(state) => {
                println!("restore: supabase");
                (
                    state,
                    StorageSource::Supabase,
                    SupabaseSyncStatus::enabled(StorageSource::Supabase),
                )
            }
            Err(error) => {
                eprintln!("supabase restore skipped: {error}");
                let mut status = SupabaseSyncStatus::enabled(StorageSource::LocalJsonFallback);
                status.note_failure(format!("restore failed: {error}"));
                (
                    load_state().ok().flatten().unwrap_or_default(),
                    StorageSource::LocalJsonFallback,
                    status,
                )
            }
        },
        None => {
            println!("restore: local-json");
            (
                load_state().ok().flatten().unwrap_or_default(),
                StorageSource::LocalJsonOnly,
                SupabaseSyncStatus::disabled(StorageSource::LocalJsonOnly),
            )
        }
    };
    let state = Arc::new(Mutex::new(restored_state));
    let sync_status = Arc::new(Mutex::new(sync_status));

    println!("NovusX control plane listening on http://{bind_addr}");
    println!(
        "supabase: {}",
        sync_status.lock().expect("sync status lock").summary()
    );
    println!("storage_source: {}", storage_source.as_str());
    if let Ok(database_url) = std::env::var("DATABASE_URL") {
        match applied_migrations(&database_url) {
            Ok(applied) => println!("migrations: {} applied", applied.len()),
            Err(error) => eprintln!("migration status unavailable: {error}"),
        }
    }
    if let Some(error) = operator_auth_startup_error() {
        eprintln!("operatorAuth error: {error}");
        std::process::exit(1);
    }
    println!("operatorAuth: {}", operator_auth_mode().log_label());
    println!(
        "environment: {}",
        control_plane_environment_from_env(
            std::env::var(CONTROL_PLANE_ENVIRONMENT_ENV).ok().as_deref()
        )
    );
    if let Some(warning) = legacy_operator_token_warning() {
        eprintln!("operatorAuth warning: {warning}");
    }
    println!("home: GET /");
    println!("health: GET /health");
    println!("status: GET /v1/status");
    println!("nodes: GET /v1/nodes");
    println!("update cap: POST /v1/nodes/contribution-cap");
    println!("jobs: GET /v1/jobs");
    println!("register: POST /v1/register");
    println!("heartbeat: POST /v1/heartbeat");
    println!("submit job: POST /v1/jobs");
    println!("claim job: GET /v1/jobs/next?node_id=...");
    println!("complete job: POST /v1/jobs/complete");

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let state = Arc::clone(&state);
                let sync_status = Arc::clone(&sync_status);
                handle_connection(
                    stream,
                    state,
                    sync_status,
                    supabase.as_ref(),
                    storage_source,
                );
            }
            Err(error) => eprintln!("incoming connection error: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        auth_disabled_flag_enabled, control_plane_bind_addr_from_env, control_plane_home,
        deploy_fingerprint_from_env, job_async_payload, operator_auth_mode_from_env,
        operator_auth_startup_config_error, operator_auth_token_from_env, parse_request,
        read_http_request, requires_operator_auth, status_snapshot_with_deploy_fingerprint,
        HttpRequestReadError, OperatorAuthMode, StorageSource, SupabaseSyncStatus,
        AUTH_DISABLED_ENV, CONTROL_PLANE_ENVIRONMENT_ENV, CONTROL_PLANE_LOGO_PATH,
        LEGACY_OPERATOR_TOKEN_ENV, MAX_BODY_BYTES, OPERATOR_TOKEN_ENV,
    };
    use crate::contracts::{
        AgentRegistration, AgentState, Backend, Heartbeat, JobRequest, RuntimeMode,
        WorkerHealthReport,
    };
    use crate::state::ControlPlaneState;
    use std::io::{self, Read};

    struct ChunkedReader {
        chunks: Vec<Vec<u8>>,
        index: usize,
    }

    impl ChunkedReader {
        fn new(chunks: Vec<&[u8]>) -> Self {
            Self {
                chunks: chunks.into_iter().map(|chunk| chunk.to_vec()).collect(),
                index: 0,
            }
        }
    }

    impl Read for ChunkedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.index >= self.chunks.len() {
                return Ok(0);
            }
            let chunk = &self.chunks[self.index];
            let len = chunk.len().min(buffer.len());
            buffer[..len].copy_from_slice(&chunk[..len]);
            self.index += 1;
            Ok(len)
        }
    }

    fn healthy_worker_health(checked_at: &str) -> WorkerHealthReport {
        WorkerHealthReport {
            healthy: true,
            model_dir: "/tmp/models".to_string(),
            model_name: Some("demo".to_string()),
            model_path: Some("/tmp/models/demo.gguf".to_string()),
            llama_cli_available: true,
            blas_device_available: true,
            cuda_device_available: false,
            cuda_driver_available: false,
            cuda_device_name: None,
            power_source: "AC Power".to_string(),
            on_battery: false,
            battery_percent: Some(90),
            runtime_ready: true,
            runtime_mode: "local".to_string(),
            supported_runtime_modes: vec![RuntimeMode::Local],
            streaming_supported: false,
            checked_at: checked_at.to_string(),
            notes: vec!["local runtime ready".to_string()],
        }
    }

    fn register_ready_node(
        state: &mut ControlPlaneState,
        node_id: &str,
        hostname: &str,
        updated_at: &str,
    ) {
        state.register(AgentRegistration {
            node_id: node_id.to_string(),
            public_key_fingerprint: format!("fingerprint-{node_id}"),
            public_key_hex: format!("hex-{node_id}"),
            hostname: hostname.to_string(),
            identity_trust_path: crate::contracts::IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK
                .to_string(),
            backend: Backend::M,
            contribution_percent: 50,
            agent_version: "0.1.0".to_string(),
        });
        state.heartbeat(
            Heartbeat {
                node_id: node_id.to_string(),
                backend: Backend::M,
                agent_state: AgentState::Ready,
                available_memory_mb: 16_000,
                available_gpu_percent: 50,
                updated_at: updated_at.to_string(),
                contribution_percent: 50,
                hostname: hostname.to_string(),
                identity_trust_path: crate::contracts::IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK
                    .to_string(),
                power_source: "AC Power".to_string(),
                on_battery: false,
                battery_percent: Some(90),
                policy_allowed: true,
                policy_reason: None,
                worker_health: healthy_worker_health(updated_at),
            },
            updated_at.to_string(),
        );
    }

    #[test]
    fn defaults_to_localhost_when_port_is_missing() {
        let bind_addr = control_plane_bind_addr_from_env(None, None).expect("bind addr");
        assert_eq!(bind_addr, "127.0.0.1:8787");
    }

    #[test]
    fn uses_railway_friendly_bind_when_port_is_present() {
        let bind_addr = control_plane_bind_addr_from_env(Some("3000"), None).expect("bind addr");
        assert_eq!(bind_addr, "0.0.0.0:3000");
    }

    #[test]
    fn honors_explicit_host_override() {
        let bind_addr =
            control_plane_bind_addr_from_env(Some("8787"), Some("127.0.0.1")).expect("bind addr");
        assert_eq!(bind_addr, "127.0.0.1:8787");
    }

    #[test]
    fn prefers_explicit_deploy_fingerprint_over_host_metadata() {
        let fingerprint = deploy_fingerprint_from_env(
            Some("manual-fingerprint"),
            Some("railway-sha"),
            Some("source-version"),
            Some("git-sha"),
            Some("deploy-id"),
        );

        assert_eq!(fingerprint.as_deref(), Some("manual-fingerprint"));
    }

    #[test]
    fn falls_back_to_railway_commit_sha_for_deploy_fingerprint() {
        let fingerprint =
            deploy_fingerprint_from_env(None, Some("abcdef1234567890"), None, None, None);

        assert_eq!(fingerprint.as_deref(), Some("abcdef1234567890"));
    }

    #[test]
    fn returns_none_when_no_deploy_fingerprint_metadata_is_available() {
        let fingerprint = deploy_fingerprint_from_env(None, None, None, None, None);

        assert_eq!(fingerprint, None);
    }

    #[test]
    fn status_snapshot_exposes_deploy_fingerprint() {
        let snapshot = status_snapshot_with_deploy_fingerprint(
            serde_json::json!({
                "storage_source": "supabase",
                "queued_job_count": 0
            }),
            Some("abcdef1234567890".to_string()),
        );

        assert_eq!(snapshot["deploy_fingerprint"], "abcdef1234567890");
        assert_eq!(snapshot["storage_source"], "supabase");
    }

    #[test]
    fn home_page_renders_reference_dashboard_shell() {
        let mut state = ControlPlaneState::default();
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "Summarize operator state".to_string(),
                preferred_backend: Backend::Auto,
                runtime_mode: RuntimeMode::Local,
                stream: false,
                model: Some("HuggingFaceTB/SmolLM2-135M-Instruct".to_string()),
                system_prompt: None,
                max_tokens: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "123".to_string(),
        );

        let html = control_plane_home(
            &state,
            StorageSource::LocalJsonFallback,
            &SupabaseSyncStatus::enabled(StorageSource::LocalJsonFallback),
        );

        assert!(html.contains("NovusX Control Plane"));
        assert!(html.contains("NovusX control plane logo"));
        assert!(html.contains(CONTROL_PLANE_LOGO_PATH));
        assert!(html.contains("Status API"));
        assert!(html.contains("Network Topology"));
        assert!(html.contains("Credits Overview"));
        assert!(html.contains("Node Details"));
        assert!(html.contains(r#"href="/nodes""#));
        assert!(html.contains(r#"href="/jobs""#));
        assert!(html.contains(r#"href="/credits""#));
        assert!(html.contains(r#"href="/registry""#));
        assert!(html.contains(r#"href="/settings""#));
        assert!(html.contains(r#"aria-label="Developer APIs""#));
        assert!(html.contains(">Developer APIs</span>"));
        assert!(html.contains("Signed registry snapshot"));
        assert!(html.contains("Nodes JSON"));
        assert!(html.contains("Assigned jobs"));
        assert!(html.contains("color-scheme: dark"));
        assert!(html.contains("motion-lift"));
        assert!(html.contains("motion-glow"));
        assert!(html.contains("prefers-reduced-motion: reduce"));
        assert!(html.contains("node-hex::before"));
        assert!(html.contains("logo-signal-wave"));
        assert!(html.contains("logo-signal s1"));
        assert!(html.contains(r#"class="topo-node offline""#));
        assert!(html.contains("slot 8"));
        assert!(!html.contains(">No nodes</div>"));
        assert!(!html.contains("Search nodes..."));
        assert!(!html.contains("Control Plane</div></div></div>"));
    }

    #[test]
    fn home_topology_links_latest_live_nodes_to_nodes_search() {
        let mut state = ControlPlaneState::default();
        register_ready_node(&mut state, "node-old", "OLD", "10");
        register_ready_node(&mut state, "node-new", "DAVE", "20");

        let html = control_plane_home(
            &state,
            StorageSource::LocalJsonFallback,
            &SupabaseSyncStatus::enabled(StorageSource::LocalJsonFallback),
        );

        assert!(html.contains(r#"href="/nodes?search=node-new""#));
        assert!(html.contains(r#"href="/nodes?search=node-old""#));
        assert!(html.contains(">DAVE</span>"));
        assert!(html.contains(">OLD</span>"));
        assert!(html.contains(r#"class="topo-node offline""#));
    }

    #[test]
    fn operator_pages_separate_html_navigation_from_raw_api_links() {
        let state = ControlPlaneState::default();
        let html = crate::control_plane_operator_page(
            &state,
            StorageSource::LocalJsonFallback,
            &SupabaseSyncStatus::enabled(StorageSource::LocalJsonFallback),
            crate::OperatorPage::Nodes,
            Some("node-new"),
        );

        assert!(html.contains("Fleet Browser"));
        assert!(html.contains("Search node id, host, model, backend"));
        assert!(html.contains(r#"value="node-new""#));
        assert!(html.contains("Sort by last heartbeat"));
        assert!(html.contains("Large fleets should be controlled here"));
        assert!(html.contains("Developer APIs"));
        assert!(html.contains(r#"href="/nodes""#));
        assert!(html.contains(r#"href="/v1/nodes""#));
    }

    #[test]
    fn rejects_invalid_port_values() {
        let error = control_plane_bind_addr_from_env(Some("abc"), None).expect_err("invalid");
        assert_eq!(error, "invalid PORT value: abc");
    }

    #[test]
    fn detects_explicit_auth_disabled_flag() {
        assert!(auth_disabled_flag_enabled(Some("true")));
        assert!(auth_disabled_flag_enabled(Some("1")));
        assert!(!auth_disabled_flag_enabled(Some("false")));
        assert!(!auth_disabled_flag_enabled(None));
    }

    #[test]
    fn operator_auth_mode_honors_explicit_disable_over_token() {
        let mode = operator_auth_mode_from_env(Some("true"), Some("secret"), None);

        assert_eq!(mode, OperatorAuthMode::ExplicitlyDisabled);
        assert!(!mode.enforced());
        assert_eq!(mode.as_str(), "explicitly-disabled");
    }

    #[test]
    fn operator_auth_mode_enforces_when_token_is_present() {
        let mode = operator_auth_mode_from_env(None, Some("secret"), None);

        assert_eq!(mode, OperatorAuthMode::Enforced);
        assert!(mode.enforced());
        assert_eq!(mode.as_str(), "enforced");
    }

    #[test]
    fn operator_auth_mode_enforces_when_legacy_token_is_present() {
        let mode = operator_auth_mode_from_env(None, None, Some("legacy-secret"));

        assert_eq!(mode, OperatorAuthMode::Enforced);
        assert!(mode.enforced());
    }

    #[test]
    fn operator_auth_token_prefers_canonical_over_legacy() {
        let token =
            operator_auth_token_from_env(Some(" canonical "), Some(" legacy ")).expect("token");

        assert_eq!(token, "canonical");
    }

    #[test]
    fn operator_auth_token_falls_back_to_legacy() {
        let token =
            operator_auth_token_from_env(None, Some(" legacy-secret ")).expect("legacy token");

        assert_eq!(token, "legacy-secret");
    }

    #[test]
    fn readme_documents_operator_auth_env_names() {
        let readme = include_str!("../../../README.md");

        assert!(readme.contains(OPERATOR_TOKEN_ENV));
        assert!(readme.contains(LEGACY_OPERATOR_TOKEN_ENV));
        assert!(readme.contains("Deprecated"));
    }

    #[test]
    fn operator_auth_mode_reports_missing_token_disable() {
        let mode = operator_auth_mode_from_env(None, None, None);

        assert_eq!(mode, OperatorAuthMode::MissingTokenDisabled);
        assert!(!mode.enforced());
        assert_eq!(mode.as_str(), "missing-token-disabled");
    }

    #[test]
    fn auth_disabled_is_rejected_for_production_environment() {
        let error = operator_auth_startup_config_error(Some("true"), Some("production"))
            .expect("production should reject auth-disabled mode");

        assert!(error.contains(AUTH_DISABLED_ENV));
        assert!(error.contains(CONTROL_PLANE_ENVIRONMENT_ENV));
        assert!(error.contains("production"));
    }

    #[test]
    fn auth_disabled_is_allowed_for_local_and_uat() {
        assert_eq!(
            operator_auth_startup_config_error(Some("true"), Some("local")),
            None
        );
        assert_eq!(
            operator_auth_startup_config_error(Some("yes"), Some("uat")),
            None
        );
    }

    #[test]
    fn protects_operator_cap_update_route() {
        assert!(requires_operator_auth("POST", "/v1/nodes/contribution-cap"));
    }

    #[test]
    fn protects_operator_policy_override_route() {
        assert!(requires_operator_auth("POST", "/v1/nodes/policy-override"));
    }

    #[test]
    fn protects_single_job_status_route() {
        assert!(requires_operator_auth("GET", "/v1/jobs/job-1"));
    }

    #[test]
    fn request_reader_waits_for_full_content_length_body() {
        let mut reader = ChunkedReader::new(vec![
            b"POST /v1/register HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20\r\n\r\n{\"node_id\"",
            b":\"node-1\"}",
        ]);

        let request_text = read_http_request(&mut reader).expect("request");
        let request = parse_request(&request_text);

        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/v1/register");
        assert_eq!(request.body, "{\"node_id\":\"node-1\"}");
    }

    #[test]
    fn request_reader_rejects_incomplete_declared_body() {
        let mut reader = ChunkedReader::new(vec![
            b"POST /v1/register HTTP/1.1\r\nContent-Length: 25\r\n\r\n{\"node_id\":\"node-1\"}",
        ]);

        let error = read_http_request(&mut reader).expect_err("incomplete body");

        assert_eq!(
            error,
            HttpRequestReadError::bad_request(
                "request body ended before Content-Length was satisfied"
            )
        );
    }

    #[test]
    fn request_reader_rejects_invalid_content_length() {
        let mut reader = ChunkedReader::new(vec![
            b"POST /v1/register HTTP/1.1\r\nContent-Length: nope\r\n\r\n{}",
        ]);

        let error = read_http_request(&mut reader).expect_err("invalid length");

        assert_eq!(
            error,
            HttpRequestReadError::bad_request("invalid Content-Length")
        );
    }

    #[test]
    fn request_reader_rejects_oversized_declared_body() {
        let request = format!(
            "POST /v1/register HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY_BYTES + 1
        );
        let mut reader = ChunkedReader::new(vec![request.as_bytes()]);

        let error = read_http_request(&mut reader).expect_err("oversized");

        assert_eq!(error.status, "413 Payload Too Large");
    }

    #[test]
    fn async_job_payload_exposes_polling_contract() {
        let mut state = ControlPlaneState::default();
        let record = state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "summarize this".to_string(),
                preferred_backend: Backend::Auto,
                runtime_mode: RuntimeMode::Local,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "123".to_string(),
        );

        let payload = job_async_payload(&record);

        assert_eq!(payload["job_id"], "job-1");
        assert_eq!(payload["request_id"], "job-1");
        assert_eq!(payload["status"], "queued");
        assert_eq!(payload["status_url"], "/v1/jobs/job-1");
        assert_eq!(payload["polling"]["method"], "GET");
        assert_eq!(payload["polling"]["url"], "/v1/jobs/job-1");
        assert_eq!(payload["polling"]["recommended_interval_seconds"], 2);
        assert_eq!(payload["polling"]["default_timeout_seconds"], 300);
        assert_eq!(payload["job"]["status"], "queued");
        assert_eq!(payload["job"]["output"], serde_json::Value::Null);
        assert_eq!(payload["job"]["error"], serde_json::Value::Null);
    }
}
