use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const HARNESS_CONTRACT_VERSION: &str = "1.0";
const DEFAULT_TASK_TTL_SECONDS: u64 = 3_600;
const DEFAULT_TENANT_MAX_ACTIVE_ATTEMPTS: u32 = 4;
const DEFAULT_TENANT_MAX_QUEUED_TASKS: u32 = 25;
const DEFAULT_TENANT_MAX_ARTIFACT_BYTES: u64 = 104_857_600;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessExecutionMode {
    Sandbox,
    Hybrid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessTaskState {
    Created,
    Queued,
    Reserved,
    Preparing,
    Running,
    Validating,
    AwaitingApproval,
    RetryPending,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    Expired,
}

impl HarnessTaskState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Expired
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessAttemptState {
    Reserved,
    Preparing,
    Running,
    Validating,
    Succeeded,
    Failed,
    Cancelled,
    Expired,
}

impl HarnessAttemptState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Expired
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessVerificationLevel {
    Verified,
    PartiallyVerified,
    Unverified,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessApprovalScope {
    ExecuteUat,
    ApplyPatch,
    Merge,
    DeployUat,
    DeployProduction,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessBudgets {
    pub max_wall_time_ms: u64,
    pub max_cpu_time_ms: u64,
    pub max_memory_mb: u32,
    pub max_disk_mb: u32,
    pub max_output_bytes: u64,
    pub max_tool_calls: u32,
    pub max_model_turns: u32,
    pub max_repair_attempts: u32,
}

impl Default for HarnessBudgets {
    fn default() -> Self {
        Self {
            max_wall_time_ms: 900_000,
            max_cpu_time_ms: 600_000,
            max_memory_mb: 8_192,
            max_disk_mb: 4_096,
            max_output_bytes: 1_048_576,
            max_tool_calls: 80,
            max_model_turns: 24,
            max_repair_attempts: 2,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessTask {
    pub task_id: String,
    pub harness_contract_version: String,
    pub tenant_id: String,
    pub repository_source_id: String,
    #[serde(default)]
    pub requested_by_user_id: Option<String>,
    #[serde(default)]
    pub submitted_via: Option<String>,
    /// Bounded user-authored coding objective. It is never copied into audit metadata.
    pub objective: String,
    pub base_revision: String,
    pub allowed_path_prefixes: Vec<String>,
    pub execution_mode: HarnessExecutionMode,
    pub allowed_operations: Vec<String>,
    pub validation_profiles: Vec<String>,
    pub budgets: HarnessBudgets,
    pub state: HarnessTaskState,
    pub state_version: u64,
    pub current_attempt_id: Option<String>,
    pub verification_level: Option<HarnessVerificationLevel>,
    pub terminal_code: Option<String>,
    pub created_at_epoch: u64,
    pub updated_at_epoch: u64,
    pub expires_at_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessAttempt {
    pub attempt_id: String,
    pub task_id: String,
    #[serde(alias = "node_id")]
    pub runner_id: String,
    pub execution_mode: HarnessExecutionMode,
    pub state: HarnessAttemptState,
    pub state_version: u64,
    pub reserved_slots: u32,
    pub workspace_id: Option<String>,
    pub failure_code: Option<String>,
    pub created_at_epoch: u64,
    pub updated_at_epoch: u64,
    pub started_at_epoch: Option<u64>,
    pub finished_at_epoch: Option<u64>,
    #[serde(default)]
    pub model_turns: u32,
    #[serde(default)]
    pub tool_calls: u32,
    #[serde(default)]
    pub output_bytes: u64,
    #[serde(default)]
    pub repair_attempts: u32,
    #[serde(default)]
    pub last_progress_sha256: Option<String>,
    #[serde(default)]
    pub repeated_progress_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessCapacityReservation {
    pub reservation_id: String,
    pub task_id: String,
    pub attempt_id: String,
    #[serde(alias = "node_id")]
    pub runner_id: String,
    pub slots: u32,
    pub state: String,
    pub created_at_epoch: u64,
    pub expires_at_epoch: u64,
    pub released_at_epoch: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessApproval {
    pub approval_id: String,
    pub task_id: String,
    pub artifact_digest: Option<String>,
    pub target: String,
    pub scope: HarnessApprovalScope,
    pub approver: String,
    pub created_at_epoch: u64,
    pub expires_at_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessAuditEvent {
    pub event_id: String,
    pub task_id: String,
    pub attempt_id: Option<String>,
    pub actor: String,
    pub event_type: String,
    pub code: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessOperationalPolicy {
    pub kill_switch: bool,
    #[serde(alias = "drained_nodes")]
    pub drained_runners: Vec<String>,
    pub tenant_max_active_attempts: u32,
    pub tenant_max_queued_tasks: u32,
    pub tenant_max_artifact_bytes: u64,
}

impl Default for HarnessOperationalPolicy {
    fn default() -> Self {
        Self {
            kill_switch: false,
            drained_runners: Vec::new(),
            tenant_max_active_attempts: DEFAULT_TENANT_MAX_ACTIVE_ATTEMPTS,
            tenant_max_queued_tasks: DEFAULT_TENANT_MAX_QUEUED_TASKS,
            tenant_max_artifact_bytes: DEFAULT_TENANT_MAX_ARTIFACT_BYTES,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessOperationalEvent {
    pub event_id: String,
    pub actor: String,
    pub action: String,
    pub target: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessRunnerKind {
    LocalUser,
    EhdaHosted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessRunner {
    pub runner_id: String,
    pub device_id: String,
    pub public_key_hex: String,
    pub kind: HarnessRunnerKind,
    #[serde(default)]
    pub owner_user_id: Option<String>,
    #[serde(default)]
    pub tenant_ids: Vec<String>,
    #[serde(default)]
    pub repository_source_ids: Vec<String>,
    #[serde(default)]
    pub local_projects: Vec<String>,
    pub execution_modes: Vec<String>,
    pub supported_operations: Vec<String>,
    pub network_default_disabled: bool,
    pub max_workspace_mb: u32,
    pub usable_memory_mb: u32,
    pub parallel_slots: u32,
    pub trusted_identity: bool,
    pub ready: bool,
    pub last_seen_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RegisterHarnessRunnerRequest {
    pub runner_id: String,
    pub device_id: String,
    pub public_key_hex: String,
    pub kind: HarnessRunnerKind,
    #[serde(default)]
    pub owner_user_id: Option<String>,
    /// One-time MundusX Chat pairing secret. It is consumed before registration and
    /// is never persisted in runner state or returned in API responses.
    #[serde(default)]
    pub pairing_code: Option<String>,
    #[serde(default)]
    pub tenant_ids: Vec<String>,
    #[serde(default)]
    pub repository_source_ids: Vec<String>,
    #[serde(default)]
    pub local_projects: Vec<String>,
    pub execution_modes: Vec<String>,
    pub supported_operations: Vec<String>,
    pub network_default_disabled: bool,
    pub max_workspace_mb: u32,
    pub usable_memory_mb: u32,
    pub parallel_slots: u32,
    pub trusted_identity: bool,
    pub ready: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct UpdateHarnessOperationalPolicyRequest {
    pub kill_switch: Option<bool>,
    #[serde(alias = "drain_node_id")]
    pub drain_runner_id: Option<String>,
    #[serde(alias = "undrain_node_id")]
    pub undrain_runner_id: Option<String>,
    pub tenant_max_active_attempts: Option<u32>,
    pub tenant_max_queued_tasks: Option<u32>,
    pub tenant_max_artifact_bytes: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessToolCall {
    pub tool_call_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub operation: String,
    pub idempotency_key: Option<String>,
    pub input_sha256: String,
    pub output_sha256: Option<String>,
    pub status: String,
    pub code: Option<String>,
    pub duration_ms: Option<u64>,
    pub output_bytes: u64,
    pub created_at_epoch: u64,
    pub completed_at_epoch: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessValidation {
    pub validation_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub profile_id: String,
    pub profile_version: String,
    pub status: String,
    pub code: Option<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub output_sha256: Option<String>,
    #[serde(default)]
    pub artifact_sha256: String,
    #[serde(default)]
    pub base_revision: String,
    #[serde(default)]
    pub environment_sha256: String,
    pub output_truncated: bool,
    pub created_at_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessArtifact {
    pub artifact_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub kind: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub storage_reference: Option<String>,
    pub base_revision: String,
    pub changed_paths: Vec<String>,
    pub verification_level: HarnessVerificationLevel,
    pub created_at_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecordHarnessToolCallRequest {
    pub expected_attempt_state_version: u64,
    pub tool_call_id: String,
    pub operation: String,
    pub idempotency_key: Option<String>,
    pub input_sha256: String,
    pub output_sha256: Option<String>,
    pub status: String,
    pub code: Option<String>,
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub output_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecordHarnessValidationRequest {
    pub expected_attempt_state_version: u64,
    pub profile_id: String,
    pub profile_version: String,
    pub status: String,
    pub code: Option<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub output_sha256: Option<String>,
    pub artifact_sha256: String,
    pub base_revision: String,
    pub environment_sha256: String,
    #[serde(default)]
    pub output_truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PublishHarnessArtifactRequest {
    pub expected_attempt_state_version: u64,
    pub kind: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub storage_reference: Option<String>,
    pub base_revision: String,
    #[serde(default)]
    pub changed_paths: Vec<String>,
    pub verification_level: HarnessVerificationLevel,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecordHarnessModelTurnRequest {
    pub expected_attempt_state_version: u64,
    pub progress_sha256: String,
    #[serde(default)]
    pub output_bytes: u64,
    #[serde(default)]
    pub repair_attempt: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CreateHarnessTaskRequest {
    #[serde(default = "default_contract_version")]
    pub harness_contract_version: String,
    pub tenant_id: String,
    pub repository_source_id: String,
    #[serde(default)]
    pub requested_by_user_id: Option<String>,
    #[serde(default)]
    pub submitted_via: Option<String>,
    pub objective: String,
    pub base_revision: String,
    #[serde(default)]
    pub allowed_path_prefixes: Vec<String>,
    pub execution_mode: HarnessExecutionMode,
    #[serde(default)]
    pub allowed_operations: Vec<String>,
    #[serde(default)]
    pub validation_profiles: Vec<String>,
    #[serde(default)]
    pub budgets: HarnessBudgets,
    #[serde(default)]
    pub expires_at_epoch: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CreateHarnessApprovalRequest {
    pub scope: HarnessApprovalScope,
    pub target: String,
    pub approver: String,
    #[serde(default)]
    pub artifact_digest: Option<String>,
    pub expires_at_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessTransitionRequest {
    pub expected_state_version: u64,
    pub state: HarnessTaskState,
    #[serde(default)]
    pub verification_level: Option<HarnessVerificationLevel>,
    #[serde(default)]
    pub code: Option<String>,
    pub actor: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReserveHarnessAttemptRequest {
    pub expected_task_state_version: u64,
    #[serde(default, alias = "node_id")]
    pub runner_id: Option<String>,
    #[serde(default = "default_true")]
    pub allow_sandbox_fallback: bool,
    #[serde(default = "default_reserved_slots")]
    pub slots: u32,
    #[serde(default = "default_reservation_ttl_seconds")]
    pub reservation_ttl_seconds: u64,
    pub actor: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessAttemptTransitionRequest {
    pub expected_state_version: u64,
    pub state: HarnessAttemptState,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    pub actor: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HarnessReconciliation {
    pub task_id: String,
    pub attempt_id: String,
    pub expected_task_state_version: u64,
    pub expected_attempt_state_version: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HarnessState {
    #[serde(default)]
    pub operational_policy: HarnessOperationalPolicy,
    #[serde(default)]
    pub operational_events: Vec<HarnessOperationalEvent>,
    #[serde(default)]
    pub runners: BTreeMap<String, HarnessRunner>,
    #[serde(default)]
    pub tasks: BTreeMap<String, HarnessTask>,
    #[serde(default)]
    pub attempts: BTreeMap<String, HarnessAttempt>,
    #[serde(default)]
    pub reservations: BTreeMap<String, HarnessCapacityReservation>,
    #[serde(default)]
    pub tool_calls: BTreeMap<String, HarnessToolCall>,
    #[serde(default)]
    pub validations: BTreeMap<String, HarnessValidation>,
    #[serde(default)]
    pub artifacts: BTreeMap<String, HarnessArtifact>,
    #[serde(default)]
    pub approvals: BTreeMap<String, HarnessApproval>,
    #[serde(default)]
    pub audit_events: Vec<HarnessAuditEvent>,
}

impl HarnessState {
    pub fn register_runner(
        &mut self,
        request: RegisterHarnessRunnerRequest,
        now_epoch: u64,
    ) -> Result<HarnessRunner, HarnessError> {
        validate_identifier(&request.runner_id, "runner id")?;
        validate_identifier(&request.device_id, "device id")?;
        if self
            .runners
            .get(&request.runner_id)
            .is_some_and(|existing| {
                existing.device_id != request.device_id
                    || existing.public_key_hex != request.public_key_hex
                    || existing.kind != request.kind
                    || existing.owner_user_id != request.owner_user_id
            })
        {
            return Err(HarnessError::new(
                "HARNESS_RUNNER_IDENTITY_CONFLICT",
                "runner device, key, kind, and owner are immutable; pair a new runner id",
            ));
        }
        if request.public_key_hex.len() < 64
            || !request
                .public_key_hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || request.parallel_slots == 0
            || request.parallel_slots > 64
            || request.max_workspace_mb == 0
            || request.usable_memory_mb == 0
            || !request.network_default_disabled
        {
            return Err(HarnessError::new(
                "HARNESS_RUNNER_INVALID",
                "runner identity, isolation, or capacity is invalid",
            ));
        }
        if request.execution_modes.is_empty()
            || request
                .execution_modes
                .iter()
                .any(|mode| !matches!(mode.as_str(), "sandbox" | "hybrid"))
            || request.supported_operations.is_empty()
        {
            return Err(HarnessError::new(
                "HARNESS_RUNNER_INVALID",
                "runner modes and operations must be explicitly bounded",
            ));
        }
        if request.kind == HarnessRunnerKind::LocalUser && request.owner_user_id.is_none() {
            return Err(HarnessError::new(
                "HARNESS_RUNNER_OWNER_REQUIRED",
                "a local user runner must be bound to one authenticated user",
            ));
        }
        if request
            .owner_user_id
            .as_deref()
            .is_some_and(|value| Uuid::parse_str(value).is_err())
        {
            return Err(HarnessError::new(
                "HARNESS_RUNNER_OWNER_INVALID",
                "runner owner must be a UUID",
            ));
        }
        for value in request
            .tenant_ids
            .iter()
            .chain(request.repository_source_ids.iter())
        {
            validate_identifier(value, "runner scope")?;
        }
        if request.local_projects.len() > 100
            || request.local_projects.iter().any(|slug| {
                slug.is_empty()
                    || slug.len() > 80
                    || slug.starts_with('-')
                    || slug.ends_with('-')
                    || slug.contains("--")
                    || !slug.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
            })
        {
            return Err(HarnessError::new(
                "HARNESS_RUNNER_PROJECTS_INVALID",
                "runner local projects must be bounded lowercase slugs",
            ));
        }
        let runner = HarnessRunner {
            runner_id: request.runner_id.clone(),
            device_id: request.device_id,
            public_key_hex: request.public_key_hex,
            kind: request.kind,
            owner_user_id: request.owner_user_id,
            tenant_ids: normalized_list(request.tenant_ids),
            repository_source_ids: normalized_list(request.repository_source_ids),
            local_projects: normalized_list(request.local_projects),
            execution_modes: normalized_list(request.execution_modes),
            supported_operations: normalized_list(request.supported_operations),
            network_default_disabled: request.network_default_disabled,
            max_workspace_mb: request.max_workspace_mb,
            usable_memory_mb: request.usable_memory_mb,
            parallel_slots: request.parallel_slots,
            trusted_identity: request.trusted_identity,
            ready: request.ready,
            last_seen_epoch: now_epoch,
        };
        self.runners.insert(request.runner_id, runner.clone());
        Ok(runner)
    }

    pub fn update_operational_policy(
        &mut self,
        request: UpdateHarnessOperationalPolicyRequest,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessOperationalPolicy, HarnessError> {
        validate_identifier(actor, "actor")?;
        if request.drain_runner_id.is_some() && request.undrain_runner_id.is_some() {
            return Err(HarnessError::new(
                "HARNESS_POLICY_DENIED",
                "drain and undrain cannot be requested together",
            ));
        }
        if request
            .tenant_max_active_attempts
            .is_some_and(|value| value == 0 || value > 1_000)
            || request
                .tenant_max_queued_tasks
                .is_some_and(|value| value == 0 || value > 100_000)
            || request
                .tenant_max_artifact_bytes
                .is_some_and(|value| value == 0)
        {
            return Err(HarnessError::new(
                "HARNESS_POLICY_DENIED",
                "operational quota is outside supported bounds",
            ));
        }
        if let Some(value) = request.kill_switch {
            self.operational_policy.kill_switch = value;
        }
        if let Some(runner_id) = request.drain_runner_id.as_deref() {
            validate_identifier(runner_id, "runner id")?;
            self.operational_policy
                .drained_runners
                .push(runner_id.to_string());
        }
        if let Some(runner_id) = request.undrain_runner_id.as_deref() {
            validate_identifier(runner_id, "runner id")?;
            self.operational_policy
                .drained_runners
                .retain(|value| value != runner_id);
        }
        if let Some(value) = request.tenant_max_active_attempts {
            self.operational_policy.tenant_max_active_attempts = value;
        }
        if let Some(value) = request.tenant_max_queued_tasks {
            self.operational_policy.tenant_max_queued_tasks = value;
        }
        if let Some(value) = request.tenant_max_artifact_bytes {
            self.operational_policy.tenant_max_artifact_bytes = value;
        }
        self.operational_policy.drained_runners.sort();
        self.operational_policy.drained_runners.dedup();
        self.operational_events.push(HarnessOperationalEvent {
            event_id: format!("hop_{}", Uuid::new_v4().simple()),
            actor: actor.to_string(),
            action: "harness_operational_policy_updated".to_string(),
            target: request.drain_runner_id.or(request.undrain_runner_id),
            metadata: serde_json::json!({
                "kill_switch": self.operational_policy.kill_switch,
                "tenant_max_active_attempts": self.operational_policy.tenant_max_active_attempts,
                "tenant_max_queued_tasks": self.operational_policy.tenant_max_queued_tasks,
                "tenant_max_artifact_bytes": self.operational_policy.tenant_max_artifact_bytes,
            }),
            created_at_epoch: now_epoch,
        });
        Ok(self.operational_policy.clone())
    }

    pub fn record_model_turn(
        &mut self,
        attempt_id: &str,
        request: RecordHarnessModelTurnRequest,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessAttempt, HarnessError> {
        if self.operational_policy.kill_switch {
            return Err(HarnessError::new(
                "HARNESS_KILL_SWITCH_ACTIVE",
                "model execution is disabled by the operator kill switch",
            ));
        }
        if !is_sha256(&request.progress_sha256) {
            return Err(HarnessError::new(
                "HARNESS_MODEL_OUTPUT_INVALID",
                "model progress digest must be a SHA-256",
            ));
        }
        let attempt = self.attempts.get(attempt_id).cloned().ok_or_else(|| {
            HarnessError::new(
                "HARNESS_ATTEMPT_NOT_FOUND",
                "harness attempt does not exist",
            )
        })?;
        if attempt.state_version != request.expected_attempt_state_version {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "harness attempt state version changed",
            ));
        }
        let task = self.tasks.get(&attempt.task_id).ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        if attempt.state.is_terminal() || task.state == HarnessTaskState::Cancelling {
            return Err(HarnessError::new(
                "HARNESS_CANCELLED",
                "model turn is not allowed for a terminal or cancelling attempt",
            ));
        }
        let next_turns = attempt.model_turns.saturating_add(1);
        let next_output = attempt.output_bytes.saturating_add(request.output_bytes);
        let next_repairs = attempt
            .repair_attempts
            .saturating_add(u32::from(request.repair_attempt));
        if next_turns > task.budgets.max_model_turns
            || next_output > task.budgets.max_output_bytes
            || next_repairs > task.budgets.max_repair_attempts
        {
            return Err(HarnessError::new(
                "HARNESS_BUDGET_EXHAUSTED",
                "model turn, repair, or output budget is exhausted",
            ));
        }
        let attempt = self
            .attempts
            .get_mut(attempt_id)
            .expect("validated attempt");
        attempt.model_turns = next_turns;
        attempt.output_bytes = next_output;
        attempt.repair_attempts = next_repairs;
        if attempt.last_progress_sha256.as_deref() == Some(&request.progress_sha256) {
            attempt.repeated_progress_count = attempt.repeated_progress_count.saturating_add(1);
        } else {
            attempt.last_progress_sha256 = Some(request.progress_sha256.clone());
            attempt.repeated_progress_count = 0;
        }
        if attempt.repeated_progress_count >= 3 {
            return Err(HarnessError::new(
                "HARNESS_NO_PROGRESS",
                "model repeated the same progress state three times",
            ));
        }
        attempt.updated_at_epoch = now_epoch;
        attempt.state_version = attempt.state_version.saturating_add(1);
        let result = attempt.clone();
        self.audit(
            &result.task_id,
            Some(attempt_id),
            actor,
            "harness_model_turn_recorded",
            None,
            serde_json::json!({
                "model_turns": result.model_turns,
                "repair_attempts": result.repair_attempts,
                "output_bytes": result.output_bytes,
                "progress_sha256": request.progress_sha256,
            }),
            now_epoch,
        );
        Ok(result)
    }

    pub fn record_tool_call(
        &mut self,
        attempt_id: &str,
        request: RecordHarnessToolCallRequest,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessToolCall, HarnessError> {
        if self.operational_policy.kill_switch {
            return Err(HarnessError::new(
                "HARNESS_KILL_SWITCH_ACTIVE",
                "tool execution is disabled by the operator kill switch",
            ));
        }
        validate_identifier(&request.tool_call_id, "tool call id")?;
        if !is_sha256(&request.input_sha256)
            || request
                .output_sha256
                .as_deref()
                .is_some_and(|value| !is_sha256(value))
        {
            return Err(HarnessError::new(
                "HARNESS_TOOL_INPUT_INVALID",
                "tool input and output digests must be SHA-256 values",
            ));
        }
        if let Some(existing) = self.tool_calls.get(&request.tool_call_id) {
            if existing.attempt_id == attempt_id
                && existing.input_sha256 == request.input_sha256
                && existing.operation == request.operation
                && existing.idempotency_key == request.idempotency_key
            {
                return Ok(existing.clone());
            }
            return Err(HarnessError::new(
                "HARNESS_IDEMPOTENCY_CONFLICT",
                "tool call id was reused with different authority or input",
            ));
        }
        if let Some(idempotency_key) = request.idempotency_key.as_deref() {
            if let Some(existing) = self.tool_calls.values().find(|record| {
                record.attempt_id == attempt_id
                    && record.idempotency_key.as_deref() == Some(idempotency_key)
            }) {
                if existing.input_sha256 == request.input_sha256
                    && existing.operation == request.operation
                {
                    return Ok(existing.clone());
                }
                return Err(HarnessError::new(
                    "HARNESS_IDEMPOTENCY_CONFLICT",
                    "idempotency key was reused with different authority or input",
                ));
            }
        }
        let attempt = self.attempts.get(attempt_id).cloned().ok_or_else(|| {
            HarnessError::new(
                "HARNESS_ATTEMPT_NOT_FOUND",
                "harness attempt does not exist",
            )
        })?;
        if attempt.state_version != request.expected_attempt_state_version {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "harness attempt state version changed",
            ));
        }
        let task = self.tasks.get(&attempt.task_id).ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        if !task.allowed_operations.contains(&request.operation) {
            return Err(HarnessError::new(
                "HARNESS_OPERATION_UNSUPPORTED",
                "tool operation is outside task authority",
            ));
        }
        let side_effecting = matches!(
            request.operation.as_str(),
            "patch.apply" | "validation.run" | "artifact.publish"
        );
        if side_effecting
            && request
                .idempotency_key
                .as_deref()
                .is_none_or(|value| validate_identifier(value, "idempotency key").is_err())
        {
            return Err(HarnessError::new(
                "HARNESS_IDEMPOTENCY_REQUIRED",
                "side-effecting tool calls require a valid idempotency key",
            ));
        }
        if attempt.tool_calls.saturating_add(1) > task.budgets.max_tool_calls
            || attempt.output_bytes.saturating_add(request.output_bytes)
                > task.budgets.max_output_bytes
        {
            return Err(HarnessError::new(
                "HARNESS_BUDGET_EXHAUSTED",
                "tool-call or accumulated-output budget is exhausted",
            ));
        }
        if !["requested", "succeeded", "failed", "cancelled"].contains(&request.status.as_str()) {
            return Err(HarnessError::new(
                "HARNESS_TOOL_RESULT_INVALID",
                "tool status is not recognized",
            ));
        }
        let completed = request.status != "requested";
        let record = HarnessToolCall {
            tool_call_id: request.tool_call_id,
            task_id: attempt.task_id.clone(),
            attempt_id: attempt_id.to_string(),
            operation: request.operation,
            idempotency_key: request.idempotency_key,
            input_sha256: request.input_sha256,
            output_sha256: request.output_sha256,
            status: request.status,
            code: request.code,
            duration_ms: request.duration_ms,
            output_bytes: request.output_bytes,
            created_at_epoch: now_epoch,
            completed_at_epoch: completed.then_some(now_epoch),
        };
        let attempt = self
            .attempts
            .get_mut(attempt_id)
            .expect("validated attempt");
        attempt.tool_calls = attempt.tool_calls.saturating_add(1);
        attempt.output_bytes = attempt.output_bytes.saturating_add(record.output_bytes);
        attempt.updated_at_epoch = now_epoch;
        attempt.state_version = attempt.state_version.saturating_add(1);
        self.tool_calls
            .insert(record.tool_call_id.clone(), record.clone());
        self.audit(
            &record.task_id,
            Some(attempt_id),
            actor,
            "harness_tool_call_recorded",
            record.code.as_deref(),
            serde_json::json!({
                "tool_call_id": record.tool_call_id,
                "operation": record.operation,
                "status": record.status,
                "input_sha256": record.input_sha256,
                "output_sha256": record.output_sha256,
                "output_bytes": record.output_bytes,
            }),
            now_epoch,
        );
        Ok(record)
    }

    pub fn record_validation(
        &mut self,
        attempt_id: &str,
        request: RecordHarnessValidationRequest,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessValidation, HarnessError> {
        if self.operational_policy.kill_switch {
            return Err(HarnessError::new(
                "HARNESS_KILL_SWITCH_ACTIVE",
                "validation is disabled by the operator kill switch",
            ));
        }
        validate_identifier(&request.profile_id, "validation profile")?;
        validate_identifier(&request.profile_version, "validation profile version")?;
        if request
            .output_sha256
            .as_deref()
            .is_some_and(|value| !is_sha256(value))
            || !is_sha256(&request.artifact_sha256)
            || !is_sha256(&request.environment_sha256)
            || request.base_revision.len() != 40
            || !request
                .base_revision
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || !["passed", "failed", "timeout", "cancelled"].contains(&request.status.as_str())
        {
            return Err(HarnessError::new(
                "HARNESS_VALIDATION_FAILED",
                "validation result is malformed",
            ));
        }
        let attempt = self.attempts.get(attempt_id).ok_or_else(|| {
            HarnessError::new(
                "HARNESS_ATTEMPT_NOT_FOUND",
                "harness attempt does not exist",
            )
        })?;
        if attempt.state_version != request.expected_attempt_state_version {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "harness attempt state version changed",
            ));
        }
        let task = self.tasks.get(&attempt.task_id).ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        if !task.validation_profiles.contains(&request.profile_id) {
            return Err(HarnessError::new(
                "HARNESS_VALIDATION_PROFILE_DENIED",
                "validation profile is outside task authority",
            ));
        }
        let record = HarnessValidation {
            validation_id: format!("hvalidation_{}", Uuid::new_v4().simple()),
            task_id: attempt.task_id.clone(),
            attempt_id: attempt_id.to_string(),
            profile_id: request.profile_id,
            profile_version: request.profile_version,
            status: request.status,
            code: request.code,
            exit_code: request.exit_code,
            duration_ms: request.duration_ms,
            output_sha256: request.output_sha256,
            artifact_sha256: request.artifact_sha256,
            base_revision: request.base_revision,
            environment_sha256: request.environment_sha256,
            output_truncated: request.output_truncated,
            created_at_epoch: now_epoch,
        };
        self.validations
            .insert(record.validation_id.clone(), record.clone());
        if let Some(attempt) = self.attempts.get_mut(attempt_id) {
            attempt.state_version = attempt.state_version.saturating_add(1);
            attempt.updated_at_epoch = now_epoch;
        }
        self.audit(
            &record.task_id,
            Some(attempt_id),
            actor,
            "harness_validation_recorded",
            record.code.as_deref(),
            serde_json::json!({
                "validation_id": record.validation_id,
                "profile_id": record.profile_id,
                "profile_version": record.profile_version,
                "status": record.status,
                "exit_code": record.exit_code,
                "duration_ms": record.duration_ms,
                "output_sha256": record.output_sha256,
                "artifact_sha256": record.artifact_sha256,
                "base_revision": record.base_revision,
                "environment_sha256": record.environment_sha256,
                "output_truncated": record.output_truncated,
            }),
            now_epoch,
        );
        Ok(record)
    }

    pub fn publish_artifact(
        &mut self,
        attempt_id: &str,
        request: PublishHarnessArtifactRequest,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessArtifact, HarnessError> {
        if self.operational_policy.kill_switch {
            return Err(HarnessError::new(
                "HARNESS_KILL_SWITCH_ACTIVE",
                "artifact publication is disabled by the operator kill switch",
            ));
        }
        if request.kind != "patch"
            || !is_sha256(&request.sha256)
            || request.size_bytes == 0
            || request.changed_paths.is_empty()
        {
            return Err(HarnessError::new(
                "HARNESS_ARTIFACT_INVALID",
                "artifact must be a non-empty content-addressed patch",
            ));
        }
        let attempt = self.attempts.get(attempt_id).ok_or_else(|| {
            HarnessError::new(
                "HARNESS_ATTEMPT_NOT_FOUND",
                "harness attempt does not exist",
            )
        })?;
        if attempt.state_version != request.expected_attempt_state_version {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "harness attempt state version changed",
            ));
        }
        let task = self.tasks.get(&attempt.task_id).ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        let tenant_artifact_bytes = self
            .artifacts
            .values()
            .filter(|artifact| {
                self.tasks
                    .get(&artifact.task_id)
                    .is_some_and(|candidate| candidate.tenant_id == task.tenant_id)
            })
            .map(|artifact| artifact.size_bytes)
            .sum::<u64>();
        if tenant_artifact_bytes.saturating_add(request.size_bytes)
            > self.operational_policy.tenant_max_artifact_bytes
        {
            return Err(HarnessError::new(
                "HARNESS_TENANT_QUOTA_EXCEEDED",
                "tenant artifact-storage quota is exhausted",
            ));
        }
        if request.base_revision.to_ascii_lowercase() != task.base_revision
            || request.size_bytes > u64::from(task.budgets.max_disk_mb) * 1_048_576
            || request.changed_paths.iter().any(|path| {
                path.starts_with('/')
                    || path.contains("..")
                    || path.contains('\\')
                    || !task.allowed_path_prefixes.iter().any(|prefix| {
                        path == prefix
                            || path.starts_with(&format!("{}/", prefix.trim_end_matches('/')))
                    })
            })
        {
            return Err(HarnessError::new(
                "HARNESS_ARTIFACT_INVALID",
                "artifact base, size, or changed paths violate task authority",
            ));
        }
        if request
            .storage_reference
            .as_deref()
            .is_some_and(|reference| reference != format!("artifact://sha256/{}", request.sha256))
        {
            return Err(HarnessError::new(
                "HARNESS_ARTIFACT_INVALID",
                "artifact storage reference must be digest-derived",
            ));
        }
        let validation_passed = self
            .validations
            .values()
            .any(|validation| validation.attempt_id == attempt_id && validation.status == "passed");
        if request.verification_level == HarnessVerificationLevel::Verified && !validation_passed {
            return Err(HarnessError::new(
                "HARNESS_VALIDATION_FAILED",
                "verified artifact requires a passing validation result",
            ));
        }
        if let Some(existing) = self
            .artifacts
            .values()
            .find(|artifact| artifact.attempt_id == attempt_id && artifact.sha256 == request.sha256)
        {
            return Ok(existing.clone());
        }
        let record = HarnessArtifact {
            artifact_id: format!("hartifact_{}", Uuid::new_v4().simple()),
            task_id: attempt.task_id.clone(),
            attempt_id: attempt_id.to_string(),
            kind: request.kind,
            sha256: request.sha256,
            size_bytes: request.size_bytes,
            storage_reference: request.storage_reference,
            base_revision: request.base_revision.to_ascii_lowercase(),
            changed_paths: normalized_list(request.changed_paths),
            verification_level: request.verification_level,
            created_at_epoch: now_epoch,
        };
        self.artifacts
            .insert(record.artifact_id.clone(), record.clone());
        if let Some(attempt) = self.attempts.get_mut(attempt_id) {
            attempt.state_version = attempt.state_version.saturating_add(1);
            attempt.updated_at_epoch = now_epoch;
        }
        self.audit(
            &record.task_id,
            Some(attempt_id),
            actor,
            "harness_artifact_published",
            None,
            serde_json::json!({
                "artifact_id": record.artifact_id,
                "kind": record.kind,
                "sha256": record.sha256,
                "size_bytes": record.size_bytes,
                "base_revision": record.base_revision,
                "changed_paths": record.changed_paths,
                "verification_level": record.verification_level,
            }),
            now_epoch,
        );
        Ok(record)
    }

    pub fn reconcile_unavailable_runners(
        &mut self,
        unavailable_runner_ids: &[String],
        now_epoch: u64,
    ) -> Vec<HarnessReconciliation> {
        let candidates = self
            .attempts
            .values()
            .filter(|attempt| {
                !attempt.state.is_terminal() && unavailable_runner_ids.contains(&attempt.runner_id)
            })
            .map(|attempt| {
                let task_version = self
                    .tasks
                    .get(&attempt.task_id)
                    .map(|task| task.state_version)
                    .unwrap_or_default();
                (
                    attempt.attempt_id.clone(),
                    attempt.task_id.clone(),
                    task_version,
                    attempt.state_version,
                )
            })
            .collect::<Vec<_>>();
        let mut reconciled = Vec::new();
        for (attempt_id, task_id, task_version, attempt_version) in candidates {
            let cancelling = self
                .tasks
                .get(&task_id)
                .is_some_and(|task| task.state == HarnessTaskState::Cancelling);
            let next = if cancelling {
                HarnessAttemptState::Cancelled
            } else {
                HarnessAttemptState::Expired
            };
            if self
                .transition_attempt(
                    &attempt_id,
                    attempt_version,
                    next,
                    None,
                    Some(
                        if cancelling {
                            "HARNESS_CANCELLED"
                        } else {
                            "HARNESS_RUNNER_LOST"
                        }
                        .to_string(),
                    ),
                    "maintenance",
                    now_epoch,
                )
                .is_ok()
            {
                let attempts_used = self
                    .attempts
                    .values()
                    .filter(|attempt| attempt.task_id == task_id)
                    .count() as u32;
                if !cancelling {
                    if let Some(task) = self.tasks.get(&task_id).cloned() {
                        if attempts_used > task.budgets.max_repair_attempts {
                            let _ = self.transition_task(
                                &task_id,
                                task.state_version,
                                HarnessTaskState::Failed,
                                None,
                                Some("HARNESS_RETRY_EXHAUSTED".to_string()),
                                "maintenance",
                                now_epoch,
                            );
                        }
                    }
                }
                reconciled.push(HarnessReconciliation {
                    task_id,
                    attempt_id,
                    expected_task_state_version: task_version,
                    expected_attempt_state_version: attempt_version,
                });
            }
        }
        reconciled
    }

    pub fn record_routing_decision(
        &mut self,
        task_id: &str,
        attempt_id: Option<&str>,
        actor: &str,
        decision: serde_json::Value,
        now_epoch: u64,
    ) -> Result<(), HarnessError> {
        if !self.tasks.contains_key(task_id) {
            return Err(HarnessError::new(
                "HARNESS_TASK_NOT_FOUND",
                "harness task does not exist",
            ));
        }
        self.audit(
            task_id,
            attempt_id,
            actor,
            "harness_routing_decision",
            None,
            decision,
            now_epoch,
        );
        Ok(())
    }

    pub fn create_task(
        &mut self,
        request: CreateHarnessTaskRequest,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessTask, HarnessError> {
        if self.operational_policy.kill_switch {
            return Err(HarnessError::new(
                "HARNESS_KILL_SWITCH_ACTIVE",
                "new harness work is disabled by the operator kill switch",
            ));
        }
        validate_create_request(&request, now_epoch)?;
        let tenant_queued = self
            .tasks
            .values()
            .filter(|task| task.tenant_id == request.tenant_id && !task.state.is_terminal())
            .count() as u32;
        if tenant_queued >= self.operational_policy.tenant_max_queued_tasks {
            return Err(HarnessError::new(
                "HARNESS_TENANT_QUOTA_EXCEEDED",
                "tenant queued-task quota is exhausted",
            ));
        }
        let task_id = format!("htask_{}", Uuid::new_v4().simple());
        let task = HarnessTask {
            task_id: task_id.clone(),
            harness_contract_version: request.harness_contract_version,
            tenant_id: request.tenant_id.trim().to_string(),
            repository_source_id: request.repository_source_id.trim().to_string(),
            requested_by_user_id: request.requested_by_user_id,
            submitted_via: request.submitted_via,
            objective: request.objective.trim().to_string(),
            base_revision: request.base_revision.to_ascii_lowercase(),
            allowed_path_prefixes: normalized_list(request.allowed_path_prefixes),
            execution_mode: request.execution_mode,
            allowed_operations: normalized_list(request.allowed_operations),
            validation_profiles: normalized_list(request.validation_profiles),
            budgets: request.budgets,
            state: HarnessTaskState::Created,
            state_version: 1,
            current_attempt_id: None,
            verification_level: None,
            terminal_code: None,
            created_at_epoch: now_epoch,
            updated_at_epoch: now_epoch,
            expires_at_epoch: request
                .expires_at_epoch
                .unwrap_or(now_epoch.saturating_add(DEFAULT_TASK_TTL_SECONDS)),
        };
        self.tasks.insert(task_id.clone(), task.clone());
        self.audit(
            &task_id,
            None,
            actor,
            "harness_task_created",
            None,
            serde_json::json!({
                "execution_mode": task.execution_mode,
                "repository_source_id": task.repository_source_id,
                "base_revision": task.base_revision,
            }),
            now_epoch,
        );
        Ok(task)
    }

    pub fn add_approval(
        &mut self,
        task_id: &str,
        request: CreateHarnessApprovalRequest,
        now_epoch: u64,
    ) -> Result<HarnessApproval, HarnessError> {
        let task = self.tasks.get(task_id).ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        if task.state.is_terminal() || request.expires_at_epoch <= now_epoch {
            return Err(HarnessError::new(
                "HARNESS_APPROVAL_REQUIRED",
                "approval is expired or the task is terminal",
            ));
        }
        validate_identifier(&request.approver, "approver")?;
        validate_identifier(&request.target, "approval target")?;
        if request.scope != HarnessApprovalScope::ExecuteUat
            && request
                .artifact_digest
                .as_deref()
                .is_none_or(|value| !is_sha256(value))
        {
            return Err(HarnessError::new(
                "HARNESS_ARTIFACT_INVALID",
                "non-execution approval requires an exact artifact SHA-256",
            ));
        }
        let approval = HarnessApproval {
            approval_id: format!("happroval_{}", Uuid::new_v4().simple()),
            task_id: task_id.to_string(),
            artifact_digest: request
                .artifact_digest
                .map(|value| value.to_ascii_lowercase()),
            target: request.target,
            scope: request.scope,
            approver: request.approver,
            created_at_epoch: now_epoch,
            expires_at_epoch: request.expires_at_epoch,
        };
        self.approvals
            .insert(approval.approval_id.clone(), approval.clone());
        if approval.scope == HarnessApprovalScope::ExecuteUat {
            self.transition_task(
                task_id,
                self.tasks[task_id].state_version,
                HarnessTaskState::Queued,
                None,
                None,
                &approval.approver,
                now_epoch,
            )?;
        }
        self.audit(
            task_id,
            None,
            &approval.approver,
            "harness_approval_recorded",
            None,
            serde_json::json!({
                "approval_id": approval.approval_id,
                "scope": approval.scope,
                "target": approval.target,
                "artifact_digest": approval.artifact_digest,
            }),
            now_epoch,
        );
        Ok(approval)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reserve_attempt(
        &mut self,
        task_id: &str,
        expected_task_state_version: u64,
        runner_id: &str,
        execution_mode: HarnessExecutionMode,
        slots: u32,
        runner_total_slots: u32,
        reservation_ttl_seconds: u64,
        actor: &str,
        now_epoch: u64,
    ) -> Result<(HarnessAttempt, HarnessCapacityReservation), HarnessError> {
        validate_identifier(runner_id, "runner id")?;
        if self.operational_policy.kill_switch
            || self
                .operational_policy
                .drained_runners
                .iter()
                .any(|value| value == runner_id)
        {
            return Err(HarnessError::new(
                "HARNESS_RUNNER_DRAINED",
                "runner is drained or harness execution is disabled",
            ));
        }
        if slots == 0
            || slots > runner_total_slots
            || reservation_ttl_seconds == 0
            || reservation_ttl_seconds > 3_600
        {
            return Err(HarnessError::new(
                "HARNESS_RESOURCE_EXHAUSTED",
                "reservation slots or TTL are invalid for this runner",
            ));
        }
        let task = self.tasks.get(task_id).ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        let active_for_tenant = self
            .attempts
            .values()
            .filter(|attempt| {
                !attempt.state.is_terminal()
                    && self
                        .tasks
                        .get(&attempt.task_id)
                        .is_some_and(|candidate| candidate.tenant_id == task.tenant_id)
            })
            .count() as u32;
        if active_for_tenant >= self.operational_policy.tenant_max_active_attempts {
            return Err(HarnessError::new(
                "HARNESS_TENANT_QUOTA_EXCEEDED",
                "tenant active-attempt quota is exhausted",
            ));
        }
        if task.state != HarnessTaskState::Queued
            || task.state_version != expected_task_state_version
        {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "only the current queued task version can be reserved",
            ));
        }
        let approved = self.approvals.values().any(|approval| {
            approval.task_id == task_id
                && approval.scope == HarnessApprovalScope::ExecuteUat
                && approval.expires_at_epoch > now_epoch
        });
        if !approved {
            return Err(HarnessError::new(
                "HARNESS_APPROVAL_REQUIRED",
                "an unexpired execute_uat approval is required",
            ));
        }
        let active_slots = self
            .reservations
            .values()
            .filter(|reservation| {
                reservation.runner_id == runner_id
                    && reservation.state == "active"
                    && reservation.expires_at_epoch > now_epoch
            })
            .map(|reservation| reservation.slots)
            .sum::<u32>();
        if active_slots.saturating_add(slots) > runner_total_slots {
            return Err(HarnessError::new(
                "HARNESS_RESOURCE_EXHAUSTED",
                "runner does not have enough unreserved harness slots",
            ));
        }
        let attempt_id = format!("hattempt_{}", Uuid::new_v4().simple());
        let reservation = HarnessCapacityReservation {
            reservation_id: format!("hreservation_{}", Uuid::new_v4().simple()),
            task_id: task_id.to_string(),
            attempt_id: attempt_id.clone(),
            runner_id: runner_id.to_string(),
            slots,
            state: "active".to_string(),
            created_at_epoch: now_epoch,
            expires_at_epoch: now_epoch.saturating_add(reservation_ttl_seconds),
            released_at_epoch: None,
        };
        let attempt = HarnessAttempt {
            attempt_id: attempt_id.clone(),
            task_id: task_id.to_string(),
            runner_id: runner_id.to_string(),
            execution_mode,
            state: HarnessAttemptState::Reserved,
            state_version: 1,
            reserved_slots: slots,
            workspace_id: None,
            failure_code: None,
            created_at_epoch: now_epoch,
            updated_at_epoch: now_epoch,
            started_at_epoch: None,
            finished_at_epoch: None,
            model_turns: 0,
            tool_calls: 0,
            output_bytes: 0,
            repair_attempts: 0,
            last_progress_sha256: None,
            repeated_progress_count: 0,
        };
        self.attempts.insert(attempt_id.clone(), attempt.clone());
        self.reservations
            .insert(reservation.reservation_id.clone(), reservation.clone());
        let task = self.tasks.get_mut(task_id).expect("validated harness task");
        task.state = HarnessTaskState::Reserved;
        task.state_version = task.state_version.saturating_add(1);
        task.current_attempt_id = Some(attempt_id.clone());
        task.updated_at_epoch = now_epoch;
        self.audit(
            task_id,
            Some(&attempt_id),
            actor,
            "harness_capacity_reserved",
            None,
            serde_json::json!({
                "reservation_id": reservation.reservation_id,
                "runner_id": runner_id,
                "execution_mode": execution_mode,
                "slots": slots,
                "capacity_before": runner_total_slots.saturating_sub(active_slots),
                "capacity_after": runner_total_slots.saturating_sub(active_slots.saturating_add(slots)),
            }),
            now_epoch,
        );
        Ok((attempt, reservation))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transition_attempt(
        &mut self,
        attempt_id: &str,
        expected_state_version: u64,
        next: HarnessAttemptState,
        workspace_id: Option<String>,
        code: Option<String>,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessAttempt, HarnessError> {
        let attempt = self.attempts.get_mut(attempt_id).ok_or_else(|| {
            HarnessError::new(
                "HARNESS_ATTEMPT_NOT_FOUND",
                "harness attempt does not exist",
            )
        })?;
        if attempt.state_version != expected_state_version {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "harness attempt state version changed",
            ));
        }
        if attempt.state == next {
            return Ok(attempt.clone());
        }
        if !valid_attempt_transition(attempt.state, next) {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                format!(
                    "invalid harness attempt transition {:?} -> {:?}",
                    attempt.state, next
                ),
            ));
        }
        if next == HarnessAttemptState::Preparing {
            let value = workspace_id.as_deref().unwrap_or_default();
            validate_identifier(value, "workspace id")?;
            attempt.workspace_id = workspace_id;
        }
        attempt.state = next;
        attempt.state_version = attempt.state_version.saturating_add(1);
        attempt.updated_at_epoch = now_epoch;
        if next == HarnessAttemptState::Running && attempt.started_at_epoch.is_none() {
            attempt.started_at_epoch = Some(now_epoch);
        }
        if next.is_terminal() {
            attempt.finished_at_epoch = Some(now_epoch);
            attempt.failure_code = code.clone();
        }
        let result = attempt.clone();
        let task_id = result.task_id.clone();
        if let Some(task) = self.tasks.get_mut(&task_id) {
            let task_state = match next {
                HarnessAttemptState::Reserved => HarnessTaskState::Reserved,
                HarnessAttemptState::Preparing => HarnessTaskState::Preparing,
                HarnessAttemptState::Running => HarnessTaskState::Running,
                HarnessAttemptState::Validating => HarnessTaskState::Validating,
                HarnessAttemptState::Succeeded => HarnessTaskState::AwaitingApproval,
                HarnessAttemptState::Failed => HarnessTaskState::RetryPending,
                HarnessAttemptState::Cancelled => HarnessTaskState::Cancelled,
                HarnessAttemptState::Expired => HarnessTaskState::RetryPending,
            };
            if task.state != task_state {
                task.state = task_state;
                task.state_version = task.state_version.saturating_add(1);
                task.updated_at_epoch = now_epoch;
            }
        }
        if next.is_terminal() {
            for reservation in self.reservations.values_mut().filter(|reservation| {
                reservation.attempt_id == attempt_id && reservation.state == "active"
            }) {
                reservation.state = "released".to_string();
                reservation.released_at_epoch = Some(now_epoch);
            }
        }
        self.audit(
            &task_id,
            Some(attempt_id),
            actor,
            "harness_attempt_transitioned",
            code.as_deref(),
            serde_json::json!({
                "state": result.state,
                "state_version": result.state_version,
                "workspace_id": result.workspace_id,
            }),
            now_epoch,
        );
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transition_task(
        &mut self,
        task_id: &str,
        expected_state_version: u64,
        next: HarnessTaskState,
        verification_level: Option<HarnessVerificationLevel>,
        code: Option<String>,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessTask, HarnessError> {
        let task = self.tasks.get_mut(task_id).ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        if task.state_version != expected_state_version {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "harness task state version changed",
            ));
        }
        if task.state == next {
            return Ok(task.clone());
        }
        if !valid_task_transition(task.state, next) {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                format!("invalid harness transition {:?} -> {:?}", task.state, next),
            ));
        }
        if next == HarnessTaskState::Completed && verification_level.is_none() {
            return Err(HarnessError::new(
                "HARNESS_VALIDATION_FAILED",
                "completed task requires an explicit verification level",
            ));
        }
        task.state = next;
        task.state_version = task.state_version.saturating_add(1);
        task.updated_at_epoch = now_epoch;
        if next.is_terminal() {
            task.verification_level = verification_level;
            task.terminal_code = code.clone();
        }
        let result = task.clone();
        self.audit(
            task_id,
            result.current_attempt_id.as_deref(),
            actor,
            "harness_task_transitioned",
            code.as_deref(),
            serde_json::json!({
                "state": result.state,
                "state_version": result.state_version,
                "verification_level": result.verification_level,
            }),
            now_epoch,
        );
        Ok(result)
    }

    pub fn cancel_task(
        &mut self,
        task_id: &str,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessTask, HarnessError> {
        let task = self.tasks.get(task_id).cloned().ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        if task.state == HarnessTaskState::Cancelled {
            return Ok(task);
        }
        if task.state.is_terminal() {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "terminal harness task cannot be cancelled",
            ));
        }
        let next = if matches!(
            task.state,
            HarnessTaskState::Created | HarnessTaskState::Queued
        ) {
            HarnessTaskState::Cancelled
        } else {
            HarnessTaskState::Cancelling
        };
        self.transition_task(
            task_id,
            task.state_version,
            next,
            None,
            Some("HARNESS_CANCELLED".to_string()),
            actor,
            now_epoch,
        )
    }

    pub fn expire_tasks(&mut self, now_epoch: u64) -> Vec<HarnessTask> {
        let candidates = self
            .tasks
            .values()
            .filter(|task| !task.state.is_terminal() && task.expires_at_epoch <= now_epoch)
            .map(|task| (task.task_id.clone(), task.current_attempt_id.clone()))
            .collect::<Vec<_>>();
        let mut expired = Vec::new();
        for (task_id, attempt_id) in candidates {
            if let Some(attempt_id) = attempt_id {
                if let Some(attempt) = self.attempts.get(&attempt_id).cloned() {
                    if !attempt.state.is_terminal() {
                        let _ = self.transition_attempt(
                            &attempt_id,
                            attempt.state_version,
                            HarnessAttemptState::Expired,
                            None,
                            Some("HARNESS_TIMEOUT".to_string()),
                            "maintenance",
                            now_epoch,
                        );
                    }
                }
            }
            let version = self.tasks[&task_id].state_version;
            if let Ok(task) = self.transition_task(
                &task_id,
                version,
                HarnessTaskState::Expired,
                None,
                Some("HARNESS_TIMEOUT".to_string()),
                "maintenance",
                now_epoch,
            ) {
                expired.push(task);
            }
        }
        expired
    }

    #[allow(clippy::too_many_arguments)]
    fn audit(
        &mut self,
        task_id: &str,
        attempt_id: Option<&str>,
        actor: &str,
        event_type: &str,
        code: Option<&str>,
        metadata: serde_json::Value,
        now_epoch: u64,
    ) {
        self.audit_events.push(HarnessAuditEvent {
            event_id: format!("haudit_{}", Uuid::new_v4().simple()),
            task_id: task_id.to_string(),
            attempt_id: attempt_id.map(str::to_string),
            actor: actor.to_string(),
            event_type: event_type.to_string(),
            code: code.map(str::to_string),
            metadata,
            created_at_epoch: now_epoch,
        });
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessError {
    pub code: String,
    pub message: String,
}

impl HarnessError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

fn default_contract_version() -> String {
    HARNESS_CONTRACT_VERSION.to_string()
}

fn default_reserved_slots() -> u32 {
    1
}

fn default_reservation_ttl_seconds() -> u64 {
    900
}

fn default_true() -> bool {
    true
}

fn validate_create_request(
    request: &CreateHarnessTaskRequest,
    now_epoch: u64,
) -> Result<(), HarnessError> {
    if request.harness_contract_version != HARNESS_CONTRACT_VERSION {
        return Err(HarnessError::new(
            "HARNESS_VERSION_UNSUPPORTED",
            "only Coding Harness contract 1.0 is supported",
        ));
    }
    validate_identifier(&request.tenant_id, "tenant id")?;
    validate_identifier(&request.repository_source_id, "repository source id")?;
    if request
        .requested_by_user_id
        .as_deref()
        .is_some_and(|value| Uuid::parse_str(value).is_err())
    {
        return Err(HarnessError::new(
            "HARNESS_USER_ID_INVALID",
            "requesting user id must be a UUID",
        ));
    }
    if request.submitted_via.as_deref().is_some_and(|value| {
        !matches!(
            value,
            "mundusx-chat" | "chat-u" | "service" | "control-plane-ui"
        )
    }) {
        return Err(HarnessError::new(
            "HARNESS_SUBMISSION_SOURCE_INVALID",
            "submission source is not recognized",
        ));
    }
    if request.objective.trim().is_empty() || request.objective.len() > 16_384 {
        return Err(HarnessError::new(
            "HARNESS_OBJECTIVE_INVALID",
            "objective must contain 1 to 16384 bytes",
        ));
    }
    if request.base_revision.len() != 40
        || !request
            .base_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(HarnessError::new(
            "HARNESS_BASE_REVISION_INVALID",
            "base revision must be a full 40-character Git commit id",
        ));
    }
    if request
        .expires_at_epoch
        .is_some_and(|expires| expires <= now_epoch)
        || request.budgets.max_wall_time_ms == 0
        || request.budgets.max_cpu_time_ms == 0
        || request.budgets.max_cpu_time_ms > request.budgets.max_wall_time_ms
        || request.budgets.max_memory_mb == 0
        || request.budgets.max_disk_mb == 0
        || request.budgets.max_output_bytes == 0
        || request.budgets.max_tool_calls == 0
        || request.budgets.max_model_turns == 0
    {
        return Err(HarnessError::new(
            "HARNESS_POLICY_DENIED",
            "harness expiration or budgets are invalid",
        ));
    }
    for path in &request.allowed_path_prefixes {
        if path.trim().is_empty()
            || path.starts_with('/')
            || path.contains("..")
            || path.contains('\\')
        {
            return Err(HarnessError::new(
                "HARNESS_PATH_DENIED",
                "allowed path prefixes must be normalized relative paths",
            ));
        }
    }
    let allowed = [
        "repository.status",
        "repository.diff",
        "file.read",
        "file.search",
        "patch.apply",
        "validation.run",
        "artifact.publish",
    ];
    if request.allowed_operations.is_empty()
        || request
            .allowed_operations
            .iter()
            .any(|operation| !allowed.contains(&operation.as_str()))
    {
        return Err(HarnessError::new(
            "HARNESS_OPERATION_UNSUPPORTED",
            "task contains an unknown or empty operation set",
        ));
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), HarnessError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 160
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
    {
        return Err(HarnessError::new(
            "HARNESS_POLICY_DENIED",
            format!("{label} is invalid"),
        ));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn normalized_list(mut values: Vec<String>) -> Vec<String> {
    for value in &mut values {
        *value = value.trim().to_string();
    }
    values.sort();
    values.dedup();
    values
}

fn valid_task_transition(from: HarnessTaskState, to: HarnessTaskState) -> bool {
    use HarnessTaskState::*;
    matches!(
        (from, to),
        (Created, Queued | Cancelled | Expired)
            | (Queued, Reserved | Cancelled | Expired)
            | (
                Reserved,
                Preparing | Cancelling | RetryPending | Failed | Expired
            )
            | (
                Preparing,
                Running | Cancelling | RetryPending | Failed | Expired
            )
            | (
                Running,
                Validating | Cancelling | RetryPending | Failed | Expired
            )
            | (
                Validating,
                AwaitingApproval | Completed | Cancelling | RetryPending | Failed | Expired
            )
            | (AwaitingApproval, Completed | Cancelling | Failed | Expired)
            | (RetryPending, Queued | Cancelling | Failed | Expired)
            | (Cancelling, Cancelled | Failed)
    )
}

fn valid_attempt_transition(from: HarnessAttemptState, to: HarnessAttemptState) -> bool {
    use HarnessAttemptState::*;
    matches!(
        (from, to),
        (Reserved, Preparing | Failed | Cancelled | Expired)
            | (Preparing, Running | Failed | Cancelled | Expired)
            | (Running, Validating | Failed | Cancelled | Expired)
            | (Validating, Succeeded | Failed | Cancelled | Expired)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> CreateHarnessTaskRequest {
        CreateHarnessTaskRequest {
            harness_contract_version: HARNESS_CONTRACT_VERSION.to_string(),
            tenant_id: "tenant-1".to_string(),
            repository_source_id: "repo-1".to_string(),
            requested_by_user_id: None,
            submitted_via: None,
            objective: "Update the bounded test fixture.".to_string(),
            base_revision: "a".repeat(40),
            allowed_path_prefixes: vec!["src".to_string(), "tests".to_string()],
            execution_mode: HarnessExecutionMode::Sandbox,
            allowed_operations: vec!["file.read".to_string(), "validation.run".to_string()],
            validation_profiles: vec!["rust-default".to_string()],
            budgets: HarnessBudgets::default(),
            expires_at_epoch: Some(2_000),
        }
    }

    fn runner_registration() -> RegisterHarnessRunnerRequest {
        RegisterHarnessRunnerRequest {
            runner_id: "runner-user-1".to_string(),
            device_id: "device-user-1".to_string(),
            public_key_hex: "a".repeat(64),
            kind: HarnessRunnerKind::LocalUser,
            owner_user_id: Some("78a1c06a-861c-43b4-b7db-b54a51fc912d".to_string()),
            pairing_code: None,
            tenant_ids: vec!["tenant-1".to_string()],
            repository_source_ids: vec!["repo-1".to_string()],
            local_projects: vec!["alpha".to_string(), "beta".to_string()],
            execution_modes: vec!["sandbox".to_string()],
            supported_operations: vec!["file.read".to_string()],
            network_default_disabled: true,
            max_workspace_mb: 4_096,
            usable_memory_mb: 16_384,
            parallel_slots: 1,
            trusted_identity: true,
            ready: true,
        }
    }

    #[test]
    fn runner_registration_cannot_change_key_or_user_owner() {
        let mut state = HarnessState::default();
        state.register_runner(runner_registration(), 1_000).unwrap();

        let mut changed_key = runner_registration();
        changed_key.public_key_hex = "b".repeat(64);
        assert_eq!(
            state.register_runner(changed_key, 1_001).unwrap_err().code,
            "HARNESS_RUNNER_IDENTITY_CONFLICT"
        );

        let mut changed_owner = runner_registration();
        changed_owner.owner_user_id = Some("bc219dc4-a12c-4486-84be-73fe379db35d".to_string());
        assert_eq!(
            state
                .register_runner(changed_owner, 1_002)
                .unwrap_err()
                .code,
            "HARNESS_RUNNER_IDENTITY_CONFLICT"
        );
    }

    #[test]
    fn runner_registration_bounds_and_normalizes_local_projects() {
        let mut state = HarnessState::default();
        let runner = state.register_runner(runner_registration(), 1_000).unwrap();
        assert_eq!(runner.local_projects, vec!["alpha", "beta"]);

        let mut invalid = runner_registration();
        invalid.local_projects = vec!["../another-user".to_string()];
        assert_eq!(
            state.register_runner(invalid, 1_001).unwrap_err().code,
            "HARNESS_RUNNER_PROJECTS_INVALID"
        );
    }

    #[test]
    fn task_requires_independent_execute_approval_before_queueing() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        assert_eq!(task.state, HarnessTaskState::Created);
        let approval = state
            .add_approval(
                &task.task_id,
                CreateHarnessApprovalRequest {
                    scope: HarnessApprovalScope::ExecuteUat,
                    target: "uat".to_string(),
                    approver: "operator".to_string(),
                    artifact_digest: None,
                    expires_at_epoch: 1_500,
                },
                1_001,
            )
            .unwrap();
        assert_eq!(approval.scope, HarnessApprovalScope::ExecuteUat);
        assert_eq!(state.tasks[&task.task_id].state, HarnessTaskState::Queued);
    }

    #[test]
    fn task_objective_is_required_bounded_and_excluded_from_audit_metadata() {
        let mut state = HarnessState::default();
        let mut invalid = request();
        invalid.objective.clear();
        assert_eq!(
            state
                .create_task(invalid, "operator", 1_000)
                .unwrap_err()
                .code,
            "HARNESS_OBJECTIVE_INVALID"
        );

        let objective = "private coding objective marker";
        let mut valid = request();
        valid.objective = objective.to_string();
        let task = state.create_task(valid, "operator", 1_000).unwrap();
        assert_eq!(task.objective, objective);
        let audit = serde_json::to_string(&state.audit_events).unwrap();
        assert!(!audit.contains(objective));
    }

    #[test]
    fn uat_mixed_fifty_job_load_never_oversubscribes_and_is_reconstructable() {
        let mut state = HarnessState::default();
        state.operational_policy.tenant_max_queued_tasks = 100;
        state.operational_policy.tenant_max_active_attempts = 100;
        let mut queued = Vec::new();
        for index in 0..50 {
            let mut task_request = request();
            task_request.tenant_id = format!("tenant-{}", index % 5);
            task_request.repository_source_id = format!("fixture-{}", index % 3);
            task_request.execution_mode = if index % 2 == 0 {
                HarnessExecutionMode::Sandbox
            } else {
                HarnessExecutionMode::Hybrid
            };
            task_request.budgets.max_tool_calls = 8 + (index % 4) as u32;
            let task = state
                .create_task(task_request, "uat-load-generator", 1_000 + index)
                .unwrap();
            state
                .add_approval(
                    &task.task_id,
                    CreateHarnessApprovalRequest {
                        scope: HarnessApprovalScope::ExecuteUat,
                        target: "uat".to_string(),
                        approver: "uat-fixture".to_string(),
                        artifact_digest: None,
                        expires_at_epoch: 10_000,
                    },
                    1_001 + index,
                )
                .unwrap();
            queued.push(task.task_id);
        }

        let mut reserved = 0;
        for (index, task_id) in queued.iter().enumerate() {
            let task = state.tasks[task_id].clone();
            let node_id = format!("uat-node-{}", index % 5);
            match state.reserve_attempt(
                task_id,
                task.state_version,
                &node_id,
                task.execution_mode,
                1,
                4,
                900,
                "uat-scheduler",
                2_000,
            ) {
                Ok((attempt, _)) => {
                    state
                        .record_routing_decision(
                            task_id,
                            Some(&attempt.attempt_id),
                            "uat-scheduler",
                            serde_json::json!({"node_id": node_id, "fixture_index": index}),
                            2_000,
                        )
                        .unwrap();
                    reserved += 1;
                }
                Err(error) => assert_eq!(error.code, "HARNESS_RESOURCE_EXHAUSTED"),
            }
        }

        assert_eq!(reserved, 20);
        for node_index in 0..5 {
            let node_id = format!("uat-node-{node_index}");
            let active = state
                .reservations
                .values()
                .filter(|reservation| {
                    reservation.runner_id == node_id && reservation.state == "active"
                })
                .map(|reservation| reservation.slots)
                .sum::<u32>();
            assert_eq!(active, 4);
        }
        assert_eq!(
            state
                .audit_events
                .iter()
                .filter(|event| event.event_type == "harness_routing_decision")
                .count(),
            reserved
        );
        assert_eq!(state.tasks.len(), 50);
        assert_eq!(
            state
                .tasks
                .values()
                .filter(|task| task.state == HarnessTaskState::Queued)
                .count(),
            30
        );
    }

    #[test]
    fn optimistic_state_transitions_reject_stale_and_invalid_updates() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        state
            .add_approval(
                &task.task_id,
                CreateHarnessApprovalRequest {
                    scope: HarnessApprovalScope::ExecuteUat,
                    target: "uat".to_string(),
                    approver: "operator".to_string(),
                    artifact_digest: None,
                    expires_at_epoch: 1_500,
                },
                1_001,
            )
            .unwrap();
        let queued = state.tasks[&task.task_id].clone();
        assert_eq!(
            state
                .transition_task(
                    &task.task_id,
                    queued.state_version - 1,
                    HarnessTaskState::Reserved,
                    None,
                    None,
                    "scheduler",
                    1_002,
                )
                .unwrap_err()
                .code,
            "HARNESS_STATE_CONFLICT"
        );
        assert_eq!(
            state
                .transition_task(
                    &task.task_id,
                    queued.state_version,
                    HarnessTaskState::Completed,
                    Some(HarnessVerificationLevel::Verified),
                    None,
                    "scheduler",
                    1_002,
                )
                .unwrap_err()
                .code,
            "HARNESS_STATE_CONFLICT"
        );
    }

    #[test]
    fn cancellation_is_idempotent_and_expiry_is_terminal() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        let cancelled = state.cancel_task(&task.task_id, "operator", 1_001).unwrap();
        assert_eq!(cancelled.state, HarnessTaskState::Cancelled);
        assert_eq!(
            state
                .cancel_task(&task.task_id, "operator", 1_002)
                .unwrap()
                .state_version,
            cancelled.state_version
        );

        let mut expiring = request();
        expiring.expires_at_epoch = Some(1_010);
        let expiring = state.create_task(expiring, "operator", 1_000).unwrap();
        let expired = state.expire_tasks(1_010);
        assert_eq!(expired.len(), 1);
        assert_eq!(
            state.tasks[&expiring.task_id].state,
            HarnessTaskState::Expired
        );
    }

    fn approve_for_execution(state: &mut HarnessState, task_id: &str) {
        state
            .add_approval(
                task_id,
                CreateHarnessApprovalRequest {
                    scope: HarnessApprovalScope::ExecuteUat,
                    target: "uat".to_string(),
                    approver: "operator".to_string(),
                    artifact_digest: None,
                    expires_at_epoch: 1_900,
                },
                1_001,
            )
            .unwrap();
    }

    #[test]
    fn reservations_never_oversubscribe_node_slots() {
        let mut state = HarnessState::default();
        let first = state.create_task(request(), "operator", 1_000).unwrap();
        let second = state.create_task(request(), "operator", 1_000).unwrap();
        approve_for_execution(&mut state, &first.task_id);
        approve_for_execution(&mut state, &second.task_id);
        state
            .reserve_attempt(
                &first.task_id,
                state.tasks[&first.task_id].state_version,
                "node-1",
                HarnessExecutionMode::Sandbox,
                2,
                2,
                300,
                "scheduler",
                1_002,
            )
            .unwrap();
        assert_eq!(
            state
                .reserve_attempt(
                    &second.task_id,
                    state.tasks[&second.task_id].state_version,
                    "node-1",
                    HarnessExecutionMode::Sandbox,
                    1,
                    2,
                    300,
                    "scheduler",
                    1_002,
                )
                .unwrap_err()
                .code,
            "HARNESS_RESOURCE_EXHAUSTED"
        );
    }

    #[test]
    fn successful_attempt_releases_capacity_and_awaits_artifact_approval() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        approve_for_execution(&mut state, &task.task_id);
        let (mut attempt, reservation) = state
            .reserve_attempt(
                &task.task_id,
                state.tasks[&task.task_id].state_version,
                "node-1",
                HarnessExecutionMode::Sandbox,
                1,
                2,
                300,
                "scheduler",
                1_002,
            )
            .unwrap();
        for (next, workspace) in [
            (
                HarnessAttemptState::Preparing,
                Some("workspace-1".to_string()),
            ),
            (HarnessAttemptState::Running, None),
            (HarnessAttemptState::Validating, None),
            (HarnessAttemptState::Succeeded, None),
        ] {
            attempt = state
                .transition_attempt(
                    &attempt.attempt_id,
                    attempt.state_version,
                    next,
                    workspace,
                    None,
                    "node-1",
                    1_003 + attempt.state_version,
                )
                .unwrap();
        }
        assert_eq!(
            state.tasks[&task.task_id].state,
            HarnessTaskState::AwaitingApproval
        );
        assert_eq!(
            state.reservations[&reservation.reservation_id].state,
            "released"
        );
        assert!(attempt.finished_at_epoch.is_some());
    }

    #[test]
    fn task_expiry_terminates_attempt_and_releases_reservation() {
        let mut state = HarnessState::default();
        let mut expiring_request = request();
        expiring_request.expires_at_epoch = Some(1_010);
        let task = state
            .create_task(expiring_request, "operator", 1_000)
            .unwrap();
        approve_for_execution(&mut state, &task.task_id);
        let (attempt, reservation) = state
            .reserve_attempt(
                &task.task_id,
                state.tasks[&task.task_id].state_version,
                "node-1",
                HarnessExecutionMode::Sandbox,
                1,
                2,
                300,
                "scheduler",
                1_002,
            )
            .unwrap();
        state.expire_tasks(1_010);
        assert_eq!(state.tasks[&task.task_id].state, HarnessTaskState::Expired);
        assert_eq!(
            state.attempts[&attempt.attempt_id].state,
            HarnessAttemptState::Expired
        );
        assert_eq!(
            state.reservations[&reservation.reservation_id].state,
            "released"
        );
    }

    #[test]
    fn node_loss_reconciles_attempt_and_capacity_without_replaying_side_effects() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        approve_for_execution(&mut state, &task.task_id);
        let (attempt, reservation) = state
            .reserve_attempt(
                &task.task_id,
                state.tasks[&task.task_id].state_version,
                "node-1",
                HarnessExecutionMode::Sandbox,
                1,
                2,
                300,
                "scheduler",
                1_002,
            )
            .unwrap();
        let reconciled = state.reconcile_unavailable_runners(&["node-1".to_string()], 1_010);
        assert_eq!(reconciled.len(), 1);
        assert_eq!(
            state.attempts[&attempt.attempt_id].state,
            HarnessAttemptState::Expired
        );
        assert_eq!(
            state.tasks[&task.task_id].state,
            HarnessTaskState::RetryPending
        );
        assert_eq!(
            state.reservations[&reservation.reservation_id].state,
            "released"
        );
    }

    #[test]
    fn bounded_tool_validation_and_artifact_evidence_is_policy_enforced() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        approve_for_execution(&mut state, &task.task_id);
        let (mut attempt, _) = state
            .reserve_attempt(
                &task.task_id,
                state.tasks[&task.task_id].state_version,
                "node-1",
                HarnessExecutionMode::Sandbox,
                1,
                2,
                300,
                "scheduler",
                1_002,
            )
            .unwrap();
        attempt = state
            .transition_attempt(
                &attempt.attempt_id,
                attempt.state_version,
                HarnessAttemptState::Preparing,
                Some("workspace-1".to_string()),
                None,
                "node-1",
                1_003,
            )
            .unwrap();
        attempt = state
            .transition_attempt(
                &attempt.attempt_id,
                attempt.state_version,
                HarnessAttemptState::Running,
                None,
                None,
                "node-1",
                1_004,
            )
            .unwrap();
        attempt = state
            .record_model_turn(
                &attempt.attempt_id,
                RecordHarnessModelTurnRequest {
                    expected_attempt_state_version: attempt.state_version,
                    progress_sha256: "1".repeat(64),
                    output_bytes: 100,
                    repair_attempt: false,
                },
                "node-1",
                1_005,
            )
            .unwrap();
        let tool = state
            .record_tool_call(
                &attempt.attempt_id,
                RecordHarnessToolCallRequest {
                    expected_attempt_state_version: attempt.state_version,
                    tool_call_id: "tool-1".to_string(),
                    operation: "validation.run".to_string(),
                    idempotency_key: Some("validation-1".to_string()),
                    input_sha256: "2".repeat(64),
                    output_sha256: Some("3".repeat(64)),
                    status: "succeeded".to_string(),
                    code: None,
                    duration_ms: Some(50),
                    output_bytes: 200,
                },
                "node-1",
                1_006,
            )
            .unwrap();
        assert_eq!(tool.operation, "validation.run");
        attempt = state.attempts[&attempt.attempt_id].clone();
        let validation = state
            .record_validation(
                &attempt.attempt_id,
                RecordHarnessValidationRequest {
                    expected_attempt_state_version: attempt.state_version,
                    profile_id: "rust-default".to_string(),
                    profile_version: "1".to_string(),
                    status: "passed".to_string(),
                    code: None,
                    exit_code: Some(0),
                    duration_ms: Some(50),
                    output_sha256: Some("3".repeat(64)),
                    artifact_sha256: "4".repeat(64),
                    base_revision: "a".repeat(40),
                    environment_sha256: "5".repeat(64),
                    output_truncated: false,
                },
                "node-1",
                1_007,
            )
            .unwrap();
        assert_eq!(validation.status, "passed");
        attempt = state.attempts[&attempt.attempt_id].clone();
        let artifact = state
            .publish_artifact(
                &attempt.attempt_id,
                PublishHarnessArtifactRequest {
                    expected_attempt_state_version: attempt.state_version,
                    kind: "patch".to_string(),
                    sha256: "4".repeat(64),
                    size_bytes: 500,
                    storage_reference: Some(format!("artifact://sha256/{}", "4".repeat(64))),
                    base_revision: "a".repeat(40),
                    changed_paths: vec!["src/lib.rs".to_string()],
                    verification_level: HarnessVerificationLevel::Verified,
                },
                "node-1",
                1_008,
            )
            .unwrap();
        assert_eq!(
            artifact.verification_level,
            HarnessVerificationLevel::Verified
        );
        assert_eq!(state.tool_calls.len(), 1);
        assert_eq!(state.validations.len(), 1);
        assert_eq!(state.artifacts.len(), 1);
    }

    #[test]
    fn side_effecting_tool_requires_idempotency_and_out_of_scope_artifact_is_rejected() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        approve_for_execution(&mut state, &task.task_id);
        let (attempt, _) = state
            .reserve_attempt(
                &task.task_id,
                state.tasks[&task.task_id].state_version,
                "node-1",
                HarnessExecutionMode::Sandbox,
                1,
                2,
                300,
                "scheduler",
                1_002,
            )
            .unwrap();
        assert_eq!(
            state
                .record_tool_call(
                    &attempt.attempt_id,
                    RecordHarnessToolCallRequest {
                        expected_attempt_state_version: attempt.state_version,
                        tool_call_id: "tool-1".to_string(),
                        operation: "validation.run".to_string(),
                        idempotency_key: None,
                        input_sha256: "2".repeat(64),
                        output_sha256: None,
                        status: "requested".to_string(),
                        code: None,
                        duration_ms: None,
                        output_bytes: 0,
                    },
                    "node-1",
                    1_003,
                )
                .unwrap_err()
                .code,
            "HARNESS_IDEMPOTENCY_REQUIRED"
        );
        assert_eq!(
            state
                .publish_artifact(
                    &attempt.attempt_id,
                    PublishHarnessArtifactRequest {
                        expected_attempt_state_version: attempt.state_version,
                        kind: "patch".to_string(),
                        sha256: "4".repeat(64),
                        size_bytes: 500,
                        storage_reference: None,
                        base_revision: "a".repeat(40),
                        changed_paths: vec!["secrets.env".to_string()],
                        verification_level: HarnessVerificationLevel::Unverified,
                    },
                    "node-1",
                    1_004,
                )
                .unwrap_err()
                .code,
            "HARNESS_ARTIFACT_INVALID"
        );
    }

    #[test]
    fn operational_kill_switch_drain_and_tenant_queue_quota_are_enforced_and_audited() {
        let mut state = HarnessState::default();
        let policy = state
            .update_operational_policy(
                UpdateHarnessOperationalPolicyRequest {
                    kill_switch: Some(false),
                    drain_runner_id: Some("node-1".to_string()),
                    undrain_runner_id: None,
                    tenant_max_active_attempts: Some(1),
                    tenant_max_queued_tasks: Some(1),
                    tenant_max_artifact_bytes: Some(1_024),
                },
                "operator",
                1_000,
            )
            .unwrap();
        assert!(policy.drained_runners.contains(&"node-1".to_string()));
        let task = state.create_task(request(), "operator", 1_001).unwrap();
        assert_eq!(
            state
                .create_task(request(), "operator", 1_001)
                .unwrap_err()
                .code,
            "HARNESS_TENANT_QUOTA_EXCEEDED"
        );
        approve_for_execution(&mut state, &task.task_id);
        assert_eq!(
            state
                .reserve_attempt(
                    &task.task_id,
                    state.tasks[&task.task_id].state_version,
                    "node-1",
                    HarnessExecutionMode::Sandbox,
                    1,
                    2,
                    300,
                    "scheduler",
                    1_002,
                )
                .unwrap_err()
                .code,
            "HARNESS_RUNNER_DRAINED"
        );
        state
            .update_operational_policy(
                UpdateHarnessOperationalPolicyRequest {
                    kill_switch: Some(true),
                    drain_runner_id: None,
                    undrain_runner_id: Some("node-1".to_string()),
                    tenant_max_active_attempts: None,
                    tenant_max_queued_tasks: None,
                    tenant_max_artifact_bytes: None,
                },
                "operator",
                1_003,
            )
            .unwrap();
        assert_eq!(state.operational_events.len(), 2);
        assert_eq!(
            state
                .create_task(
                    {
                        let mut value = request();
                        value.tenant_id = "tenant-2".to_string();
                        value
                    },
                    "operator",
                    1_004
                )
                .unwrap_err()
                .code,
            "HARNESS_KILL_SWITCH_ACTIVE"
        );
    }
}
