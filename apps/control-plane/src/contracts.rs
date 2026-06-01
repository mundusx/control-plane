use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

pub const IDENTITY_TRUST_KEYCHAIN: &str = "keychain";
pub const IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK: &str = "local-encrypted-fallback";

pub fn is_trusted_identity_path(identity_trust_path: &str) -> bool {
    identity_trust_path == IDENTITY_TRUST_KEYCHAIN
}

pub fn trust_path_label(identity_trust_path: &str) -> &'static str {
    match identity_trust_path {
        IDENTITY_TRUST_KEYCHAIN => "trusted",
        IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK => "encrypted fallback",
        _ => "unknown",
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Auto,
    M,
    Cuda,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::M => "m",
            Self::Cuda => "cuda",
        }
    }
}

impl fmt::Display for Backend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Default for Backend {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeMode {
    Local,
    Interactive,
}

impl RuntimeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Interactive => "interactive",
        }
    }
}

impl fmt::Display for RuntimeMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Default for RuntimeMode {
    fn default() -> Self {
        Self::Local
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Starting,
    Ready,
    Busy,
    Paused,
    Stopped,
}

impl AgentState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Busy => "busy",
            Self::Paused => "paused",
            Self::Stopped => "stopped",
        }
    }
}

impl fmt::Display for AgentState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Assigned,
    Completed,
    Failed,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Assigned => "assigned",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

impl fmt::Display for JobStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentRegistration {
    pub node_id: String,
    pub public_key_fingerprint: String,
    pub public_key_hex: String,
    pub hostname: String,
    pub identity_trust_path: String,
    pub backend: Backend,
    pub contribution_percent: u8,
    pub agent_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Heartbeat {
    pub node_id: String,
    pub backend: Backend,
    pub agent_state: AgentState,
    pub available_memory_mb: u32,
    pub available_gpu_percent: u32,
    pub updated_at: String,
    pub contribution_percent: u8,
    pub hostname: String,
    pub identity_trust_path: String,
    pub power_source: String,
    pub on_battery: bool,
    pub battery_percent: Option<u8>,
    pub policy_allowed: bool,
    pub policy_reason: Option<String>,
    pub worker_health: WorkerHealthReport,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobRequest {
    pub request_id: String,
    pub prompt: String,
    pub preferred_backend: Backend,
    #[serde(default)]
    pub runtime_mode: RuntimeMode,
    #[serde(default)]
    pub stream: bool,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub seed: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub top_p: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub seed: Option<u64>,
    #[serde(default)]
    pub stream: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatCompletionChoiceMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatCompletionChoice {
    pub index: u32,
    pub message: ChatCompletionChoiceMessage,
    pub finish_reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatCompletionMundusX {
    pub job_id: String,
    pub request_id: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatCompletionResponse {
    pub id: String,
    pub object: String,
    pub created: u64,
    pub model: String,
    pub choices: Vec<ChatCompletionChoice>,
    pub mundusx: ChatCompletionMundusX,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobRecord {
    pub job_id: String,
    pub request_id: String,
    pub prompt: String,
    pub preferred_backend: Backend,
    #[serde(default)]
    pub runtime_mode: RuntimeMode,
    #[serde(default)]
    pub stream: bool,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub seed: Option<u64>,
    pub status: JobStatus,
    pub submitted_at: String,
    pub assigned_node_id: Option<String>,
    pub assigned_at: Option<String>,
    pub completed_at: Option<String>,
    pub worker_id: Option<String>,
    pub backend: Option<Backend>,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobClaimResponse {
    pub job: Option<JobRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobCompletion {
    pub job_id: String,
    pub node_id: String,
    pub worker_id: String,
    pub backend: Backend,
    pub status: JobStatus,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkerHealthReport {
    pub healthy: bool,
    pub model_dir: String,
    pub model_name: Option<String>,
    pub model_path: Option<String>,
    pub llama_cli_available: bool,
    pub blas_device_available: bool,
    pub power_source: String,
    pub on_battery: bool,
    pub battery_percent: Option<u8>,
    #[serde(default = "default_true")]
    pub runtime_ready: bool,
    pub runtime_mode: String,
    #[serde(default)]
    pub supported_runtime_modes: Vec<RuntimeMode>,
    #[serde(default)]
    pub streaming_supported: bool,
    pub checked_at: String,
    pub notes: Vec<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobEventRecord {
    pub id: u64,
    #[serde(default)]
    pub source_event_id: Option<u64>,
    pub node_id: Option<String>,
    pub job_id: Option<String>,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreditsLedgerRecord {
    pub id: String,
    pub user_id: Option<String>,
    pub device_id: Option<String>,
    pub job_id: Option<String>,
    pub entry_type: String,
    pub amount: f64,
    pub currency: String,
    pub metadata: serde_json::Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeRecord {
    pub node_id: String,
    pub public_key_fingerprint: String,
    #[serde(default)]
    pub public_key_hex: String,
    #[serde(default)]
    pub hostname: String,
    pub backend: Backend,
    pub contribution_percent: u8,
    #[serde(default)]
    pub reported_contribution_percent: u8,
    #[serde(default)]
    pub operator_contribution_percent: Option<u8>,
    pub agent_version: String,
    pub state: AgentState,
    pub available_memory_mb: u32,
    pub available_gpu_percent: u32,
    pub identity_trust_path: String,
    pub power_source: String,
    pub on_battery: bool,
    pub battery_percent: Option<u8>,
    pub policy_allowed: bool,
    pub policy_reason: Option<String>,
    pub worker_health: Option<WorkerHealthReport>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OperatorContributionPercentUpdate {
    pub node_id: String,
    pub contribution_percent: Option<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ControlPlaneSnapshot {
    pub nodes: Vec<NodeRecord>,
    pub jobs: Vec<JobRecord>,
    pub job_events: usize,
    pub credits_ledger: usize,
    pub credits_total: f64,
    pub credits_by_node: BTreeMap<String, f64>,
    pub storage_source: String,
    pub online_count: usize,
    pub trusted_count: usize,
    pub paused_count: usize,
    pub policy_blocked_count: usize,
    pub stopped_count: usize,
    pub queued_job_count: usize,
    pub assigned_job_count: usize,
    pub completed_job_count: usize,
    pub failed_job_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_request_defaults_runtime_contract_for_legacy_payloads() {
        let request: JobRequest = serde_json::from_value(serde_json::json!({
            "request_id": "job-1",
            "prompt": "hello",
            "preferred_backend": "m"
        }))
        .expect("legacy job request");

        assert_eq!(request.runtime_mode, RuntimeMode::Local);
        assert!(!request.stream);
    }

    #[test]
    fn worker_health_report_serializes_runtime_capabilities() {
        let report = WorkerHealthReport {
            healthy: true,
            model_dir: "/tmp/models".to_string(),
            model_name: Some("demo".to_string()),
            model_path: Some("/tmp/models/demo.gguf".to_string()),
            llama_cli_available: true,
            blas_device_available: true,
            power_source: "AC Power".to_string(),
            on_battery: false,
            battery_percent: Some(90),
            runtime_ready: true,
            runtime_mode: "local".to_string(),
            supported_runtime_modes: vec![RuntimeMode::Local, RuntimeMode::Interactive],
            streaming_supported: false,
            checked_at: "1".to_string(),
            notes: vec!["ready".to_string()],
        };

        let json = serde_json::to_value(report).expect("worker health json");
        assert_eq!(json["runtime_ready"], true);
        assert_eq!(
            json["supported_runtime_modes"],
            serde_json::json!(["local", "interactive"])
        );
        assert_eq!(json["streaming_supported"], false);
    }
}
