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

impl Default for AgentState {
    fn default() -> Self {
        Self::Starting
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobExecutionMode {
    Single,
    Auto,
    Decompose,
}

impl Default for JobExecutionMode {
    fn default() -> Self {
        Self::Single
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestTaskType {
    Chat,
    Coding,
    Document,
    Inference,
}

impl RequestTaskType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Coding => "coding",
            Self::Document => "document",
            Self::Inference => "inference",
        }
    }
}

impl Default for RequestTaskType {
    fn default() -> Self {
        Self::Inference
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestComplexity {
    Low,
    Medium,
    High,
}

impl Default for RequestComplexity {
    fn default() -> Self {
        Self::Low
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyLevel {
    Public,
    Internal,
    Sensitive,
}

impl Default for PrivacyLevel {
    fn default() -> Self {
        Self::Internal
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExpectedOutputFormat {
    Text,
    Markdown,
    Json,
    Code,
}

impl Default for ExpectedOutputFormat {
    fn default() -> Self {
        Self::Text
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSize {
    Small,
    Medium,
    Large,
}

impl Default for ContextSize {
    fn default() -> Self {
        Self::Small
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
pub struct RequestClassification {
    pub task_type: RequestTaskType,
    pub complexity: RequestComplexity,
    pub privacy_level: PrivacyLevel,
    pub output_format: ExpectedOutputFormat,
    pub context_size: ContextSize,
    pub execution_constraints: Vec<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct JobSchedulingRequirements {
    pub task_type: RequestTaskType,
    pub context_size: ContextSize,
    pub privacy_level: PrivacyLevel,
    pub output_format: ExpectedOutputFormat,
    pub runtime_mode: RuntimeMode,
    pub stream: bool,
    pub model: Option<String>,
    pub language: Option<String>,
    pub constraints: Vec<String>,
}

impl Default for JobSchedulingRequirements {
    fn default() -> Self {
        Self {
            task_type: RequestTaskType::Inference,
            context_size: ContextSize::Small,
            privacy_level: PrivacyLevel::Internal,
            output_format: ExpectedOutputFormat::Text,
            runtime_mode: RuntimeMode::Local,
            stream: false,
            model: None,
            language: None,
            constraints: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
pub struct SchedulerDecision {
    pub node_id: String,
    pub score: i32,
    pub reasons: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackProvider {
    OperatorApprovedStrongerModel,
}

impl FallbackProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OperatorApprovedStrongerModel => "operator_approved_stronger_model",
        }
    }
}

impl fmt::Display for FallbackProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackDecisionStatus {
    NotNeeded,
    Eligible,
    RequiresApproval,
    Blocked,
}

impl Default for FallbackDecisionStatus {
    fn default() -> Self {
        Self::NotNeeded
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FallbackPolicy {
    pub provider: FallbackProvider,
    pub max_cost_cents: u32,
    pub requires_operator_approval: bool,
    pub allowed_privacy_levels: Vec<PrivacyLevel>,
    pub allowed_triggers: Vec<String>,
}

impl Default for FallbackPolicy {
    fn default() -> Self {
        Self {
            provider: FallbackProvider::OperatorApprovedStrongerModel,
            max_cost_cents: 25,
            requires_operator_approval: true,
            allowed_privacy_levels: vec![PrivacyLevel::Public, PrivacyLevel::Internal],
            allowed_triggers: vec![
                "large_context".to_string(),
                "streaming_requested".to_string(),
                "quality_or_format_verification_failed".to_string(),
                "local_capacity_unavailable".to_string(),
            ],
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
pub struct FallbackDecision {
    pub status: FallbackDecisionStatus,
    pub provider: Option<FallbackProvider>,
    pub triggers: Vec<String>,
    pub blocked_reasons: Vec<String>,
    pub requires_operator_approval: bool,
    pub max_cost_cents: Option<u32>,
    pub audit_reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PlannedJob {
    pub id: String,
    pub name: String,
    pub responsibility: String,
    pub depends_on: Vec<String>,
    pub required_output: String,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct JobPlan {
    pub plan_id: String,
    pub strategy: String,
    pub summary: String,
    pub jobs: Vec<PlannedJob>,
}

impl Default for JobPlan {
    fn default() -> Self {
        Self {
            plan_id: "legacy-single-job".to_string(),
            strategy: "single_job".to_string(),
            summary: "Legacy job without an explicit planner result.".to_string(),
            jobs: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobGraphStatus {
    Created,
    InProgress,
    Completed,
    Failed,
}

impl Default for JobGraphStatus {
    fn default() -> Self {
        Self::Created
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobGraphNodeStatus {
    Ready,
    Waiting,
    Running,
    Completed,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobResultVerificationStatus {
    Accepted,
    Rejected,
    FallbackNeeded,
}

impl Default for JobResultVerificationStatus {
    fn default() -> Self {
        Self::Accepted
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct JobGraphNode {
    pub id: String,
    pub name: String,
    pub responsibility: String,
    pub depends_on: Vec<String>,
    pub required_output: String,
    pub status: JobGraphNodeStatus,
    pub blocked_by: Vec<String>,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct JobResultRecord {
    pub node_id: String,
    pub name: String,
    pub responsibility: String,
    pub status: JobGraphNodeStatus,
    pub output: Option<String>,
    pub error: Option<String>,
    pub source_worker_id: Option<String>,
    pub source_node_id: Option<String>,
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub verification_status: JobResultVerificationStatus,
    #[serde(default)]
    pub verification_reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct JobGraph {
    pub graph_id: String,
    pub request_id: String,
    pub plan_id: String,
    pub status: JobGraphStatus,
    pub nodes: Vec<JobGraphNode>,
    #[serde(default)]
    pub results: Vec<JobResultRecord>,
    #[serde(default)]
    pub final_output: Option<String>,
    #[serde(default)]
    pub merge_error: Option<String>,
    pub final_node_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for JobGraph {
    fn default() -> Self {
        Self {
            graph_id: "legacy-single-job-graph".to_string(),
            request_id: String::new(),
            plan_id: "legacy-single-job".to_string(),
            status: JobGraphStatus::Created,
            nodes: Vec::new(),
            results: Vec::new(),
            final_output: None,
            merge_error: None,
            final_node_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
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
    pub execution_mode: JobExecutionMode,
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
    #[serde(default)]
    pub classification: RequestClassification,
    #[serde(default)]
    pub scheduling_requirements: JobSchedulingRequirements,
    #[serde(default)]
    pub scheduler_decision: Option<SchedulerDecision>,
    #[serde(default)]
    pub fallback_decision: FallbackDecision,
    #[serde(default)]
    pub plan: JobPlan,
    #[serde(default)]
    pub graph: JobGraph,
    #[serde(default)]
    pub execution_mode: JobExecutionMode,
    #[serde(default)]
    pub graph_execution_enabled: bool,
    #[serde(default)]
    pub active_graph_node_id: Option<String>,
    #[serde(default)]
    pub last_completed_graph_node_id: Option<String>,
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
    #[serde(default)]
    pub latency_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkerHealthReport {
    pub healthy: bool,
    pub model_dir: String,
    pub model_name: Option<String>,
    pub model_path: Option<String>,
    pub llama_cli_available: bool,
    pub blas_device_available: bool,
    #[serde(default)]
    pub cuda_device_available: bool,
    #[serde(default)]
    pub cuda_driver_available: bool,
    #[serde(default)]
    pub cuda_device_name: Option<String>,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodePolicyOverrideTarget {
    Allowed,
    Paused,
    Blocked,
}

impl NodePolicyOverrideTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::Paused => "paused",
            Self::Blocked => "blocked",
        }
    }
}

impl fmt::Display for NodePolicyOverrideTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodePolicyOverride {
    pub target: NodePolicyOverrideTarget,
    pub reason: String,
    pub actor: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodePolicyOverrideInput {
    pub target: NodePolicyOverrideTarget,
    pub reason: String,
    pub actor: String,
    pub updated_at: String,
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
    #[serde(default)]
    pub reported_state: AgentState,
    pub available_memory_mb: u32,
    pub available_gpu_percent: u32,
    pub identity_trust_path: String,
    pub power_source: String,
    pub on_battery: bool,
    pub battery_percent: Option<u8>,
    pub policy_allowed: bool,
    pub policy_reason: Option<String>,
    #[serde(default)]
    pub computed_policy_allowed: bool,
    #[serde(default)]
    pub computed_policy_reason: Option<String>,
    #[serde(default)]
    pub operator_policy_override: Option<NodePolicyOverride>,
    pub worker_health: Option<WorkerHealthReport>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OperatorContributionPercentUpdate {
    pub node_id: String,
    pub contribution_percent: Option<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OperatorNodePolicyOverrideUpdate {
    pub node_id: String,
    pub target: Option<NodePolicyOverrideTarget>,
    pub reason: Option<String>,
    pub actor: Option<String>,
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
            cuda_device_available: false,
            cuda_driver_available: false,
            cuda_device_name: None,
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
