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
    Vllm,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::M => "m",
            Self::Cuda => "cuda",
            Self::Vllm => "vllm",
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
    Mlx,
}

impl RuntimeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Interactive => "interactive",
            Self::Mlx => "mlx",
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoutingMode {
    Eco,
    Normal,
    Max,
}
impl Default for RoutingMode {
    fn default() -> Self {
        Self::Normal
    }
}
impl RoutingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Eco => "eco",
            Self::Normal => "normal",
            Self::Max => "max",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapacityClass {
    Micro,
    Standard,
    Performance,
    Heavy,
    Synthesis,
    Server,
}

impl Default for CapacityClass {
    fn default() -> Self {
        Self::Micro
    }
}
impl CapacityClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Micro => "micro",
            Self::Standard => "standard",
            Self::Performance => "performance",
            Self::Heavy => "heavy",
            Self::Synthesis => "synthesis",
            Self::Server => "server",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
pub struct StepWorkloadRequirements {
    #[serde(default)]
    pub minimum_capacity_class: CapacityClass,
    #[serde(default)]
    pub recommended_capacity_class: CapacityClass,
    #[serde(default)]
    pub context_budget_tokens: u32,
    #[serde(default)]
    pub expected_artifact_count: u32,
    #[serde(default)]
    pub expected_artifact_bytes: u64,
    #[serde(default)]
    pub model_quality_floor: String,
    #[serde(default)]
    pub required_tools: Vec<String>,
    #[serde(default)]
    pub requires_repository: bool,
    #[serde(default)]
    pub requires_compile: bool,
    #[serde(default)]
    pub requires_tests: bool,
    #[serde(default)]
    pub validation_level: String,
    #[serde(default = "default_step_parallelism")]
    pub allowed_parallelism: u32,
    #[serde(default)]
    pub reducer_credibility: String,
    #[serde(default)]
    pub synthesizer_credibility: String,
}
fn default_step_parallelism() -> u32 {
    1
}

impl Default for ContextSize {
    fn default() -> Self {
        Self::Small
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
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
#[serde(default)]
pub struct JobSchedulingRequirements {
    pub task_type: RequestTaskType,
    pub context_size: ContextSize,
    pub privacy_level: PrivacyLevel,
    pub output_format: ExpectedOutputFormat,
    pub runtime_mode: RuntimeMode,
    pub stream: bool,
    pub model: Option<String>,
    pub language: Option<String>,
    #[serde(default)]
    pub preferred_roles: Vec<NodeRole>,
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
            preferred_roles: Vec::new(),
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
    #[serde(default)]
    pub recommended_max_tokens: Option<u32>,
    #[serde(default)]
    pub minimum_max_tokens: Option<u32>,
    #[serde(default)]
    pub workload: StepWorkloadRequirements,
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

impl Default for JobGraphNodeStatus {
    fn default() -> Self {
        Self::Waiting
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobResultVerificationStatus {
    Accepted,
    Rejected,
    Repairable,
    Unverifiable,
    FallbackNeeded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationEvidenceKind {
    PathSafety,
    PatchStructure,
    StructuredDataSyntax,
    OutputPresence,
    WorkerClaim,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationEvidenceProvenance {
    ControlPlane,
    WorkerReported,
    IndependentValidator,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactValidationEvidence {
    pub version: u32,
    pub kind: ValidationEvidenceKind,
    pub passed: bool,
    pub provenance: ValidationEvidenceProvenance,
    pub summary: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultArtifactKind {
    Text,
    Code,
    Patch,
    Command,
    TestReport,
    StructuredData,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SynthesisStatus {
    Collecting,
    Reducing,
    Synthesizing,
    Validating,
    CompletedPartial,
    Completed,
    Failed,
}

impl Default for SynthesisStatus {
    fn default() -> Self {
        Self::Collecting
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResultArtifact {
    pub artifact_id: String,
    pub result_node_id: String,
    pub sequence: u32,
    pub kind: ResultArtifactKind,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    pub media_type: String,
    pub content: String,
    pub byte_size: usize,
    pub checksum_sha256: String,
    #[serde(default)]
    pub base_checksum_sha256: Option<String>,
    pub verification_status: JobResultVerificationStatus,
    #[serde(default)]
    pub verification_reason: Option<String>,
    #[serde(default)]
    pub source_worker_id: Option<String>,
    #[serde(default)]
    pub source_node_id: Option<String>,
    #[serde(default)]
    pub validation_evidence: Vec<ArtifactValidationEvidence>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactBatch {
    pub batch_id: String,
    pub sequence: u32,
    pub artifact_ids: Vec<String>,
    pub byte_size: usize,
    pub complete: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactConflict {
    pub path: String,
    pub artifact_ids: Vec<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRepairPlan {
    pub repair_id: String,
    pub artifact_ids: Vec<String>,
    pub target_paths: Vec<String>,
    pub reason: String,
    pub attempt: u32,
    pub max_attempts: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OrchestrationTimelineEvent {
    pub sequence: u32,
    pub stage: String,
    pub status: String,
    #[serde(default)]
    pub graph_node_id: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct SynthesisManifest {
    pub version: u32,
    pub manifest_id: String,
    pub status: SynthesisStatus,
    pub artifacts: Vec<ResultArtifact>,
    pub batches: Vec<ArtifactBatch>,
    #[serde(default)]
    pub conflicts: Vec<ArtifactConflict>,
    #[serde(default)]
    pub repair_plans: Vec<ArtifactRepairPlan>,
    #[serde(default)]
    pub timeline: Vec<OrchestrationTimelineEvent>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub omitted_dependency_ids: Vec<String>,
    #[serde(default)]
    pub final_text: Option<String>,
    pub complete: bool,
    pub checksum_sha256: String,
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
    #[serde(default)]
    pub recommended_max_tokens: Option<u32>,
    #[serde(default)]
    pub minimum_max_tokens: Option<u32>,
    #[serde(default)]
    pub workload: StepWorkloadRequirements,
    #[serde(default)]
    pub status: JobGraphNodeStatus,
    pub blocked_by: Vec<String>,
    #[serde(default)]
    pub assigned_node_id: Option<String>,
    #[serde(default)]
    pub assigned_at: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub worker_id: Option<String>,
    #[serde(default)]
    pub backend: Option<Backend>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub runtime_mode: Option<String>,
    #[serde(default)]
    pub effective_max_tokens: Option<u32>,
    #[serde(default)]
    pub queue_wait_ms: Option<u64>,
    #[serde(default)]
    pub runtime_ms: Option<u64>,
    #[serde(default)]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub output_chars: Option<usize>,
    #[serde(default)]
    pub estimated_output_tokens: Option<usize>,
    #[serde(default)]
    pub attempt_count: u32,
    #[serde(default = "default_graph_node_max_attempts")]
    pub max_attempts: u32,
    #[serde(default)]
    pub failed_node_ids: Vec<String>,
    pub output: Option<String>,
    pub error: Option<String>,
}

fn default_graph_node_max_attempts() -> u32 {
    3
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct JobResultRecord {
    pub node_id: String,
    pub name: String,
    pub responsibility: String,
    #[serde(default)]
    pub status: JobGraphNodeStatus,
    pub output: Option<String>,
    pub error: Option<String>,
    pub source_worker_id: Option<String>,
    pub source_node_id: Option<String>,
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub assigned_at: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub backend: Option<Backend>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub runtime_mode: Option<String>,
    #[serde(default)]
    pub effective_max_tokens: Option<u32>,
    #[serde(default)]
    pub queue_wait_ms: Option<u64>,
    #[serde(default)]
    pub runtime_ms: Option<u64>,
    #[serde(default)]
    pub output_chars: Option<usize>,
    #[serde(default)]
    pub estimated_output_tokens: Option<usize>,
    #[serde(default)]
    pub verification_status: JobResultVerificationStatus,
    #[serde(default)]
    pub verification_reason: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<ResultArtifact>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
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
    #[serde(default)]
    pub synthesis_status: SynthesisStatus,
    #[serde(default)]
    pub final_manifest: Option<SynthesisManifest>,
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
            synthesis_status: SynthesisStatus::Collecting,
            final_manifest: None,
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
    pub routing_mode: RoutingMode,
    #[serde(default)]
    pub runtime_mode: RuntimeMode,
    #[serde(default)]
    pub execution_mode: JobExecutionMode,
    #[serde(default)]
    pub stream: bool,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub max_tokens_source: Option<String>,
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
    #[serde(default)]
    pub model: Option<String>,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub mode: Option<String>,
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
    pub routing_mode: RoutingMode,
    #[serde(default)]
    pub runtime_mode: RuntimeMode,
    #[serde(default)]
    pub stream: bool,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub max_tokens_source: Option<String>,
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
    #[serde(default)]
    pub cuda_memory_mb: Option<u32>,
    pub power_source: String,
    pub on_battery: bool,
    pub battery_percent: Option<u8>,
    #[serde(default = "default_true")]
    pub runtime_ready: bool,
    pub runtime_mode: String,
    #[serde(default = "default_parallel_slots")]
    pub parallel_slots: u8,
    #[serde(default)]
    pub supported_runtime_modes: Vec<RuntimeMode>,
    #[serde(default)]
    pub streaming_supported: bool,
    #[serde(default)]
    pub capabilities: NodeCapabilityProfile,
    pub checked_at: String,
    pub notes: Vec<String>,
}

fn default_parallel_slots() -> u8 {
    1
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeRole {
    Chat,
    Coding,
    Vision,
    Embedding,
    ToolUse,
    ChunkAnalysis,
    Reducer,
    Synthesizer,
    Batch,
}

impl NodeRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Coding => "coding",
            Self::Vision => "vision",
            Self::Embedding => "embedding",
            Self::ToolUse => "tool_use",
            Self::ChunkAnalysis => "chunk_analysis",
            Self::Reducer => "reducer",
            Self::Synthesizer => "synthesizer",
            Self::Batch => "batch",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
pub struct ModelCapability {
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub context_tokens: Option<u32>,
    #[serde(default)]
    pub quantization: Option<String>,
    #[serde(default)]
    pub estimated_vram_mb: Option<u32>,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub supports_embeddings: bool,
    #[serde(default)]
    pub supports_tools: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeCapabilityProfile {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub models: Vec<ModelCapability>,
    #[serde(default)]
    pub physical_memory_mb: Option<u32>,
    #[serde(default)]
    pub usable_memory_mb: Option<u32>,
    #[serde(default)]
    pub available_memory_mb: Option<u32>,
    #[serde(default)]
    pub capacity_class: String,
    #[serde(default)]
    pub max_context_tokens: Option<u32>,
    #[serde(default)]
    pub total_vram_mb: Option<u32>,
    #[serde(default)]
    pub available_vram_mb: Option<u32>,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub supports_embeddings: bool,
    #[serde(default)]
    pub supports_tools: bool,
    #[serde(default = "default_parallel_jobs")]
    pub max_parallel_jobs: u32,
    #[serde(default)]
    pub current_load_percent: Option<u8>,
    #[serde(default)]
    pub roles: Vec<NodeRole>,
    #[serde(default)]
    pub skill_tags: Vec<String>,
    #[serde(default)]
    pub supported_tools: Vec<String>,
}

impl Default for NodeCapabilityProfile {
    fn default() -> Self {
        Self {
            schema_version: 0,
            models: Vec::new(),
            physical_memory_mb: None,
            usable_memory_mb: None,
            available_memory_mb: None,
            capacity_class: String::new(),
            max_context_tokens: None,
            total_vram_mb: None,
            available_vram_mb: None,
            supports_vision: false,
            supports_embeddings: false,
            supports_tools: false,
            max_parallel_jobs: 1,
            current_load_percent: None,
            roles: Vec::new(),
            skill_tags: Vec::new(),
            supported_tools: Vec::new(),
        }
    }
}

fn default_parallel_jobs() -> u32 {
    1
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
    #[serde(default)]
    pub parent_job_id: Option<String>,
    #[serde(default)]
    pub graph_node_id: Option<String>,
    pub entry_type: String,
    pub amount: f64,
    pub currency: String,
    pub metadata: serde_json::Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolRewardRequest {
    pub job_id: String,
    pub tool: String,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub prompt_chars: Option<usize>,
    #[serde(default)]
    pub output_chars: Option<usize>,
    #[serde(default)]
    pub units: Option<f64>,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessageRecord {
    #[serde(default)]
    pub id: Option<u64>,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppendChatMessageRequest {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessagesResponse {
    pub conversation_id: String,
    pub messages: Vec<ChatMessageRecord>,
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeTrustRecord {
    pub score: u8,
    pub completed_jobs: u32,
    pub failed_jobs: u32,
    pub consecutive_failures: u32,
    pub total_latency_ms: u64,
    pub accepted_results: u32,
    pub rejected_results: u32,
    pub last_success_at: Option<String>,
    pub last_failure_at: Option<String>,
    pub last_failure_reason: Option<String>,
}

impl Default for NodeTrustRecord {
    fn default() -> Self {
        Self {
            score: 50,
            completed_jobs: 0,
            failed_jobs: 0,
            consecutive_failures: 0,
            total_latency_ms: 0,
            accepted_results: 0,
            rejected_results: 0,
            last_success_at: None,
            last_failure_at: None,
            last_failure_reason: None,
        }
    }
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
    #[serde(default)]
    pub trust: NodeTrustRecord,
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AdmissionPolicy {
    pub enabled: bool,
    pub require_trusted_identity: bool,
    pub require_healthy_runtime: bool,
    pub min_memory_mb: u32,
    pub min_cuda_vram_mb: u32,
    pub allowed_backends: Vec<Backend>,
    #[serde(default)]
    pub enforce_model_policy: bool,
    #[serde(default = "official_model_names")]
    pub allowed_models: Vec<String>,
    pub updated_at: Option<String>,
    pub updated_by: Option<String>,
}

impl Default for AdmissionPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            require_trusted_identity: false,
            require_healthy_runtime: true,
            min_memory_mb: 0,
            min_cuda_vram_mb: 0,
            allowed_backends: vec![Backend::Auto, Backend::M, Backend::Cuda, Backend::Vllm],
            enforce_model_policy: false,
            allowed_models: official_model_names(),
            updated_at: None,
            updated_by: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdmissionPolicyUpdate {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub require_trusted_identity: bool,
    #[serde(default)]
    pub require_healthy_runtime: bool,
    #[serde(default)]
    pub min_memory_mb: u32,
    #[serde(default)]
    pub min_cuda_vram_mb: u32,
    #[serde(default)]
    pub allowed_backends: Vec<Backend>,
    #[serde(default)]
    pub enforce_model_policy: bool,
    #[serde(default = "official_model_names")]
    pub allowed_models: Vec<String>,
    pub actor: Option<String>,
}

pub const OFFICIAL_MODELS: &[(&str, &str)] = &[
    ("HuggingFaceTB/SmolLM2-135M-Instruct", "SmolLM2 135M"),
    ("Qwen/Qwen2.5-0.5B-Instruct", "Qwen 2.5 0.5B"),
    ("Qwen/Qwen2.5-1.5B-Instruct", "Qwen 2.5 1.5B"),
    ("mlx-community/Qwen2.5-3B-Instruct-4bit", "Qwen 2.5 3B MLX"),
    ("mlx-community/Qwen2.5-7B-Instruct-4bit", "Qwen 2.5 7B MLX"),
    ("Qwen/Qwen2.5-7B-Instruct-AWQ", "Qwen 2.5 7B AWQ"),
    ("Qwen/Qwen2.5-14B-Instruct-AWQ", "Qwen 2.5 14B AWQ"),
    ("Qwen/Qwen2.5-32B-Instruct-AWQ", "Qwen 2.5 32B AWQ"),
    ("Qwen/Qwen2.5-72B-Instruct-AWQ", "Qwen 2.5 72B AWQ"),
    ("Qwen/Qwen3-Coder-30B-A3B-Instruct", "Qwen3 Coder 30B-A3B"),
];

pub fn official_model_names() -> Vec<String> {
    OFFICIAL_MODELS
        .iter()
        .map(|(name, _)| (*name).to_string())
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ControlPlaneSnapshot {
    pub nodes: Vec<NodeRecord>,
    pub jobs: Vec<JobRecord>,
    pub admission_policy: AdmissionPolicy,
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
    fn registration_accepts_vllm_backend() {
        let registration: AgentRegistration = serde_json::from_value(serde_json::json!({
            "node_id": "node-vllm",
            "public_key_fingerprint": "fingerprint",
            "public_key_hex": "hex",
            "hostname": "gx10",
            "identity_trust_path": "local-encrypted-fallback",
            "backend": "vllm",
            "contribution_percent": 65,
            "agent_version": "0.1.0"
        }))
        .expect("vLLM registration");

        assert_eq!(registration.backend, Backend::Vllm);
        assert!(AdmissionPolicy::default()
            .allowed_backends
            .contains(&Backend::Vllm));
    }

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
    fn append_chat_message_request_defaults_optional_fields() {
        let request: AppendChatMessageRequest = serde_json::from_value(serde_json::json!({
            "role": "user",
            "content": "hello"
        }))
        .expect("minimal chat message request");

        assert_eq!(request.role, "user");
        assert_eq!(request.content, "hello");
        assert_eq!(request.job_id, None);
        assert_eq!(request.tool, None);
        assert_eq!(request.metadata, None);
    }

    #[test]
    fn append_chat_message_request_accepts_optional_fields() {
        let request: AppendChatMessageRequest = serde_json::from_value(serde_json::json!({
            "role": "assistant",
            "content": "hi there",
            "job_id": "job-1",
            "tool": "web_search",
            "metadata": {"sources": []}
        }))
        .expect("full chat message request");

        assert_eq!(request.job_id, Some("job-1".to_string()));
        assert_eq!(request.tool, Some("web_search".to_string()));
        assert_eq!(request.metadata, Some(serde_json::json!({"sources": []})));
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
            cuda_memory_mb: None,
            power_source: "AC Power".to_string(),
            on_battery: false,
            battery_percent: Some(90),
            runtime_ready: true,
            runtime_mode: "local".to_string(),
            parallel_slots: 1,
            supported_runtime_modes: vec![RuntimeMode::Local, RuntimeMode::Interactive],
            streaming_supported: false,
            capabilities: NodeCapabilityProfile::default(),
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

    #[test]
    fn worker_health_report_accepts_mlx_runtime_capability() {
        let report: WorkerHealthReport = serde_json::from_value(serde_json::json!({
            "healthy": true,
            "model_dir": "/tmp/models",
            "model_name": "demo",
            "model_path": "/tmp/models/demo",
            "llama_cli_available": false,
            "blas_device_available": false,
            "power_source": "AC Power",
            "on_battery": false,
            "battery_percent": null,
            "runtime_ready": true,
            "runtime_mode": "mlx",
            "supported_runtime_modes": ["local", "mlx"],
            "streaming_supported": false,
            "capabilities": {
                "roles": ["chat", "chunk_analysis", "reducer", "synthesizer"],
                "max_parallel_jobs": 2
            },
            "checked_at": "1",
            "notes": []
        }))
        .expect("mlx worker health payload");

        assert_eq!(report.runtime_mode, "mlx");
        assert_eq!(
            report.supported_runtime_modes,
            vec![RuntimeMode::Local, RuntimeMode::Mlx]
        );
        assert_eq!(
            report.capabilities.roles,
            vec![
                NodeRole::Chat,
                NodeRole::ChunkAnalysis,
                NodeRole::Reducer,
                NodeRole::Synthesizer
            ]
        );
    }

    #[test]
    fn legacy_empty_job_metadata_uses_safe_defaults() {
        let classification: RequestClassification =
            serde_json::from_value(serde_json::json!({})).expect("legacy classification");
        let scheduling: JobSchedulingRequirements =
            serde_json::from_value(serde_json::json!({})).expect("legacy scheduling metadata");

        assert_eq!(classification.task_type, RequestTaskType::Inference);
        assert_eq!(classification.context_size, ContextSize::Small);
        assert_eq!(scheduling.task_type, RequestTaskType::Inference);
        assert_eq!(scheduling.runtime_mode, RuntimeMode::Local);

        let graph: JobGraph =
            serde_json::from_value(serde_json::json!({})).expect("legacy graph metadata");
        assert_eq!(graph.status, JobGraphStatus::Created);
        assert_eq!(graph.synthesis_status, SynthesisStatus::Collecting);

        let node: JobGraphNode = serde_json::from_value(serde_json::json!({
            "id": "legacy-node",
            "name": "Legacy node",
            "responsibility": "chat",
            "depends_on": [],
            "required_output": "text",
            "blocked_by": [],
            "output": null,
            "error": null
        }))
        .expect("legacy graph node");
        assert_eq!(node.status, JobGraphNodeStatus::Waiting);

        let result: JobResultRecord = serde_json::from_value(serde_json::json!({
            "node_id": "legacy-node",
            "name": "Legacy node",
            "responsibility": "chat",
            "output": null,
            "error": null,
            "source_worker_id": null,
            "source_node_id": null,
            "latency_ms": null
        }))
        .expect("legacy graph result");
        assert_eq!(result.status, JobGraphNodeStatus::Waiting);
    }
}
