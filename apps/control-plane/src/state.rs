use crate::contracts::{
    is_trusted_identity_path, AdmissionPolicy, AdmissionPolicyUpdate, AgentRegistration,
    AgentState, ArtifactBatch, ArtifactConflict, ArtifactRepairPlan, ArtifactValidationEvidence,
    Backend, CapacityClass, ContextSize, ControlPlaneSnapshot, CreditsLedgerRecord,
    ExpectedOutputFormat, FallbackDecision, FallbackDecisionStatus, FallbackPolicy, Heartbeat,
    JobClaimResponse, JobCompletion, JobEventRecord, JobExecutionMode, JobGraph, JobGraphNode,
    JobGraphNodeStatus, JobGraphStatus, JobPlan, JobRecord, JobRequest, JobResultRecord,
    JobResultVerificationStatus, JobSchedulingRequirements, JobStatus, NodePolicyOverride,
    NodePolicyOverrideInput, NodePolicyOverrideTarget, NodeRecord, NodeRole, NodeTrustRecord,
    OrchestrationTimelineEvent, PlannedJob, PrivacyLevel, RequestClassification, RequestComplexity,
    RequestTaskType, ResultArtifact, ResultArtifactKind, RoutingMode, RuntimeMode,
    SchedulerDecision, StepWorkloadRequirements, SynthesisManifest, SynthesisStatus,
    ToolRewardRequest, ValidationEvidenceKind, ValidationEvidenceProvenance, WorkerHealthReport,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const DEFAULT_GRAPH_NODE_MAX_ATTEMPTS: u32 = 3;
const DEFAULT_GRAPH_NODE_LEASE_SECONDS: u64 = 600;
const CODING_GRAPH_NODE_LEASE_SECONDS: u64 = 1_800;
const DEFAULT_QUEUED_JOB_TIMEOUT_SECONDS: u64 = 600;
const DEFAULT_CRITICAL_ROLE_WAIT_SECONDS: u64 = 60;
const DEFAULT_NODE_HEARTBEAT_STALE_SECONDS: u64 = 60;
const REDUCER_SECTION_CHARS_COMPACT: usize = 1_200;
const REDUCER_SECTION_CHARS_STANDARD: usize = 4_000;
const REDUCER_SECTION_CHARS_STRONG: usize = 6_000;
const ARTIFACT_BATCH_MAX_BYTES: usize = 64 * 1024;
const ARTIFACT_BATCH_MAX_ITEMS: usize = 20;
const GRAPH_NODE_LEASE_SECONDS_ENV: &str = "MUNDUSX_GRAPH_NODE_LEASE_SECONDS";
const QUEUED_JOB_TIMEOUT_SECONDS_ENV: &str = "MUNDUSX_QUEUED_JOB_TIMEOUT_SECONDS";
const CRITICAL_ROLE_WAIT_SECONDS_ENV: &str = "MUNDUSX_CRITICAL_ROLE_WAIT_SECONDS";
const NODE_HEARTBEAT_STALE_SECONDS_ENV: &str = "MUNDUSX_NODE_HEARTBEAT_STALE_SECONDS";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReducerProfile {
    Compact,
    Standard,
    Strong,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ControlPlaneState {
    #[serde(default)]
    pub admission_policy: AdmissionPolicy,
    pub nodes: BTreeMap<String, NodeRecord>,
    pub jobs: BTreeMap<String, JobRecord>,
    pub job_events: Vec<JobEventRecord>,
    pub credits_ledger: Vec<CreditsLedgerRecord>,
}

#[derive(Clone, Debug, Default)]
pub struct MaintenanceResult {
    pub changed_jobs: Vec<JobRecord>,
    pub changed_nodes: Vec<NodeRecord>,
}

impl ControlPlaneState {
    fn apply_policy_override(node: &mut NodeRecord) {
        node.state = node.reported_state;
        node.policy_allowed = node.computed_policy_allowed;
        node.policy_reason = node.computed_policy_reason.clone();

        if let Some(policy_override) = node.operator_policy_override.as_ref() {
            node.policy_reason = Some(format!("operator override: {}", policy_override.reason));
            match policy_override.target {
                NodePolicyOverrideTarget::Allowed => {
                    node.policy_allowed = true;
                }
                NodePolicyOverrideTarget::Paused => {
                    node.state = AgentState::Paused;
                    node.policy_allowed = false;
                }
                NodePolicyOverrideTarget::Blocked => {
                    node.policy_allowed = false;
                }
            }
        }
    }

    pub fn snapshot(&self, storage_source: &str) -> serde_json::Value {
        let nodes: Vec<NodeRecord> = self.nodes.values().cloned().collect();
        let jobs: Vec<JobRecord> = self.jobs.values().cloned().collect();
        let job_events = self.job_events.len();
        let credits_ledger = self.credits_ledger.len();
        let credits_total = self.credits_total();
        let credits_by_node = self.credits_by_node();
        let online_count = nodes
            .iter()
            .filter(|node| node.state == AgentState::Ready || node.state == AgentState::Busy)
            .count();
        let paused_count = nodes
            .iter()
            .filter(|node| node.state == AgentState::Paused)
            .count();
        let trusted_count = nodes
            .iter()
            .filter(|node| is_trusted_identity_path(&node.identity_trust_path))
            .count();
        let policy_blocked_count = nodes.iter().filter(|node| !node.policy_allowed).count();
        let stopped_count = nodes
            .iter()
            .filter(|node| node.state == AgentState::Stopped)
            .count();
        let queued_job_count = jobs
            .iter()
            .filter(|job| job.status == JobStatus::Queued)
            .count();
        let assigned_job_count = jobs
            .iter()
            .filter(|job| job.status == JobStatus::Assigned)
            .count();
        let completed_job_count = jobs
            .iter()
            .filter(|job| job.status == JobStatus::Completed)
            .count();
        let failed_job_count = jobs
            .iter()
            .filter(|job| job.status == JobStatus::Failed)
            .count();

        serde_json::to_value(ControlPlaneSnapshot {
            nodes,
            jobs,
            admission_policy: self.admission_policy.clone(),
            job_events,
            credits_ledger,
            credits_total,
            credits_by_node,
            storage_source: storage_source.to_string(),
            online_count,
            trusted_count,
            paused_count,
            policy_blocked_count,
            stopped_count,
            queued_job_count,
            assigned_job_count,
            completed_job_count,
            failed_job_count,
        })
        .expect("snapshot json")
    }

    pub fn nodes_snapshot(&self) -> serde_json::Value {
        serde_json::to_value(self.nodes.values().cloned().collect::<Vec<_>>()).expect("nodes json")
    }

    pub fn jobs_snapshot(&self) -> serde_json::Value {
        serde_json::to_value(self.jobs.values().cloned().collect::<Vec<_>>()).expect("jobs json")
    }

    pub fn job_events_snapshot(&self) -> serde_json::Value {
        serde_json::to_value(self.job_events.clone()).expect("job events json")
    }

    pub fn credits_snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "ledger": self.credits_ledger.clone(),
            "total": self.credits_total(),
            "by_node": self.credits_by_node(),
        })
    }

    pub fn record_job_event(
        &mut self,
        node_id: Option<String>,
        job_id: Option<String>,
        event_type: impl Into<String>,
        payload: serde_json::Value,
        created_at: String,
    ) -> JobEventRecord {
        let record = JobEventRecord {
            id: self.job_events.len() as u64 + 1,
            source_event_id: Some(self.job_events.len() as u64 + 1),
            node_id,
            job_id,
            event_type: event_type.into(),
            payload,
            created_at,
        };
        self.job_events.push(record.clone());
        record
    }

    pub fn record_credit_award(
        &mut self,
        device_id: Option<String>,
        job_id: Option<String>,
        parent_job_id: Option<String>,
        graph_node_id: Option<String>,
        entry_type: &str,
        amount: f64,
        currency: &str,
        metadata: serde_json::Value,
        created_at: String,
    ) -> Option<CreditsLedgerRecord> {
        let entry_type = entry_type.trim();
        let job_id_ref = job_id.as_deref();
        let parent_job_id_ref = parent_job_id.as_deref();
        let graph_node_id_ref = graph_node_id.as_deref();
        if self.credits_ledger.iter().any(|entry| {
            entry.entry_type == entry_type
                && entry.job_id.as_deref() == job_id_ref
                && entry.parent_job_id.as_deref() == parent_job_id_ref
                && entry.graph_node_id.as_deref() == graph_node_id_ref
        }) {
            return None;
        }

        let record = CreditsLedgerRecord {
            id: uuid::Uuid::new_v4().to_string(),
            user_id: None,
            device_id,
            job_id,
            parent_job_id,
            graph_node_id,
            entry_type: entry_type.to_string(),
            amount,
            currency: currency.to_string(),
            metadata,
            created_at,
        };
        self.credits_ledger.push(record.clone());
        Some(record)
    }

    pub fn credits_total(&self) -> f64 {
        let total = self
            .credits_ledger
            .iter()
            .map(|entry| entry.amount)
            .sum::<f64>();
        normalize_amount(total)
    }

    pub fn credits_by_node(&self) -> BTreeMap<String, f64> {
        let mut by_node = BTreeMap::new();
        for entry in &self.credits_ledger {
            if let Some(device_id) = entry.device_id.as_ref() {
                *by_node.entry(device_id.clone()).or_insert(0.0) += entry.amount;
            }
        }
        for value in by_node.values_mut() {
            *value = normalize_amount(*value);
        }
        by_node
    }

    pub fn award_job_reward(
        &mut self,
        job: &JobRecord,
        completed_at: String,
    ) -> Option<CreditsLedgerRecord> {
        let graph_node = job
            .last_completed_graph_node_id
            .as_ref()
            .and_then(|graph_node_id| {
                job.graph
                    .nodes
                    .iter()
                    .find(|node| &node.id == graph_node_id)
            });
        if graph_node
            .map(|node| node.status != JobGraphNodeStatus::Completed)
            .unwrap_or(false)
        {
            return None;
        }
        let node_id = graph_node
            .and_then(|node| node.assigned_node_id.clone())
            .or_else(|| job.assigned_node_id.clone())?;
        let node = self.nodes.get(&node_id)?;
        let prompt_text = graph_node
            .map(|node| node.responsibility.as_str())
            .unwrap_or(job.prompt.as_str());
        let output_text = if let Some(node) = graph_node {
            node.output.as_deref()
        } else {
            job.output.as_deref()
        };
        let prompt_chars = prompt_text.chars().count() as f64;
        let output_chars = output_text
            .map(|output| output.chars().count() as f64)
            .unwrap_or(0.0);
        let work_units = ((prompt_chars + output_chars) / 400.0).ceil().max(1.0);
        let amount = (work_units * 100.0).round() / 100.0;
        let graph_node_id = graph_node.map(|node| node.id.clone());
        let graph_node_name = graph_node.map(|node| node.name.clone());
        let parent_job_id = graph_node_id.as_ref().map(|_| job.job_id.clone());
        let metadata = serde_json::json!({
            "formula": "ceil((prompt_chars + output_chars) / 400)",
            "prompt_chars": prompt_chars,
            "output_chars": output_chars,
            "contribution_percent": node.contribution_percent,
            "contribution_percent_role": "routing_budget_only",
            "backend": node.backend,
            "job_status": job.status,
            "parent_job_id": job.job_id,
            "graph_node_id": graph_node_id.clone(),
            "graph_node_name": graph_node_name,
            "reward_scope": if graph_node_id.is_some() { "graph_node" } else { "job" },
        });
        self.record_credit_award(
            Some(node_id),
            Some(job.job_id.clone()),
            parent_job_id,
            graph_node_id,
            "job_reward",
            amount,
            "credits",
            metadata,
            completed_at,
        )
    }

    pub fn award_tool_reward(
        &mut self,
        request: ToolRewardRequest,
        completed_at: String,
    ) -> Option<CreditsLedgerRecord> {
        let tool = normalize_tool_name(&request.tool);
        let job_id = request.job_id.trim().to_string();
        if tool.is_empty() || job_id.is_empty() {
            return None;
        }
        let units = request.units.unwrap_or(1.0).clamp(1.0, 100.0);
        let amount = normalize_amount(tool_reward_base_amount(&tool) * units);
        let device_id = request
            .device_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{tool}-tool"));
        let metadata = serde_json::json!({
            "formula": "tool_base_amount * units",
            "tool": tool,
            "work_type": tool_reward_work_type(&tool),
            "base_amount": tool_reward_base_amount(&tool),
            "units": units,
            "prompt_chars": request.prompt_chars,
            "output_chars": request.output_chars,
            "reported_metadata": request.metadata,
        });
        self.record_credit_award(
            Some(device_id),
            Some(job_id),
            None,
            None,
            "tool_reward",
            amount,
            "credits",
            metadata,
            completed_at,
        )
    }

    pub fn register(&mut self, registration: AgentRegistration) -> NodeRecord {
        let record = NodeRecord {
            node_id: registration.node_id.clone(),
            public_key_fingerprint: registration.public_key_fingerprint,
            public_key_hex: registration.public_key_hex,
            hostname: registration.hostname,
            identity_trust_path: registration.identity_trust_path,
            backend: registration.backend,
            contribution_percent: registration.contribution_percent,
            reported_contribution_percent: registration.contribution_percent,
            operator_contribution_percent: None,
            agent_version: registration.agent_version,
            state: AgentState::Starting,
            reported_state: AgentState::Starting,
            available_memory_mb: 0,
            available_gpu_percent: 0,
            power_source: "unknown".to_string(),
            on_battery: false,
            battery_percent: None,
            policy_allowed: false,
            policy_reason: None,
            computed_policy_allowed: false,
            computed_policy_reason: None,
            operator_policy_override: None,
            trust: NodeTrustRecord::default(),
            worker_health: None,
            updated_at: String::new(),
        };

        self.nodes.insert(registration.node_id, record.clone());
        self.reevaluate_queued_jobs();
        record
    }

    pub fn submit_job(&mut self, request: JobRequest, submitted_at: String) -> JobRecord {
        self.submit_job_with_mode(request, None, submitted_at)
    }

    pub fn submit_job_with_mode(
        &mut self,
        request: JobRequest,
        mode: Option<String>,
        submitted_at: String,
    ) -> JobRecord {
        let job_id = request.request_id.clone();
        let classification = classify_job_request(&request);
        let mut scheduling_requirements = scheduling_requirements_for(&request, &classification);
        let compatible_ready_nodes = self.compatible_ready_node_count_for_request(&request);
        let (compatible_research_nodes, research_context_budget) =
            self.compatible_ready_research_profile(&request);
        let mut plan =
            plan_job_request_for_submission(&request, &classification, compatible_ready_nodes);
        if request.execution_mode != JobExecutionMode::Single {
            match crate::planner_client::plan_from_env(
                &request,
                &classification,
                &scheduling_requirements,
            ) {
                Ok(Some(external)) if !external.plan.jobs.is_empty() => {
                    scheduling_requirements = external.requirements;
                    scheduling_requirements
                        .constraints
                        .push(format!("planner_provider:{}", external.provider));
                    scheduling_requirements
                        .constraints
                        .push(format!("planner_status:{}", external.status));
                    if let Some(reason) = external.degraded_reason {
                        scheduling_requirements
                            .constraints
                            .push(format!("planner_degraded:{reason}"));
                    }
                    if external_plan_preserves_explicit_decomposition(
                        &request,
                        &plan,
                        &external.plan,
                    ) {
                        plan = external.plan;
                    } else {
                        scheduling_requirements.constraints.push(
                            "planner_fallback:external_plan_collapsed_explicit_decomposition"
                                .to_string(),
                        );
                    }
                }
                Ok(_) => {}
                Err(error) => scheduling_requirements
                    .constraints
                    .push(format!("planner_fallback:{error}")),
            }
        }
        let credible_synthesizer_context = self
            .nodes
            .values()
            .filter(|node| {
                Self::node_is_schedulable_state(node)
                    && node.policy_allowed
                    && Self::capacity_class_for(node) >= CapacityClass::Performance
                    && node.worker_health.as_ref().is_some_and(|health| {
                        health.healthy
                            && health.runtime_ready
                            && Self::capability_has_role(health, NodeRole::Synthesizer)
                    })
            })
            .filter_map(|node| {
                node.worker_health
                    .as_ref()
                    .and_then(|health| health.capabilities.max_context_tokens)
            })
            .max();
        plan = dynamically_shape_research_plan_with_context(
            &request,
            &classification,
            compatible_research_nodes,
            research_context_budget,
            credible_synthesizer_context,
            plan,
        );
        let fallback_decision = fallback_decision_for(&scheduling_requirements);
        if request.execution_mode == JobExecutionMode::Single
            && plan.strategy == "complete_code_generation"
        {
            plan = single_execution_plan(
                &request,
                &classification,
                "Explicit single execution requested; decomposition plan suppressed.",
                "Single mode must run the submitted prompt as one direct response, not expose advisory chunks.",
            );
        }
        let graph = build_job_graph(&request.request_id, &plan, &submitted_at);
        let graph_execution_enabled = graph_execution_allowed(&request, &classification, &plan);
        let record = JobRecord {
            job_id: job_id.clone(),
            request_id: request.request_id,
            prompt: request.prompt,
            preferred_backend: request.preferred_backend,
            routing_mode: request.routing_mode,
            runtime_mode: request.runtime_mode,
            execution_mode: request.execution_mode,
            stream: request.stream,
            model: request.model,
            mode,
            system_prompt: request.system_prompt,
            max_tokens: request.max_tokens,
            max_tokens_source: request.max_tokens_source,
            temperature: request.temperature,
            top_p: request.top_p,
            seed: request.seed,
            classification,
            scheduling_requirements,
            scheduler_decision: None,
            fallback_decision,
            plan,
            graph,
            graph_execution_enabled,
            active_graph_node_id: None,
            last_completed_graph_node_id: None,
            status: JobStatus::Queued,
            submitted_at,
            assigned_node_id: None,
            assigned_at: None,
            completed_at: None,
            worker_id: None,
            backend: None,
            output: None,
            error: None,
        };

        self.jobs.insert(job_id.clone(), record);
        self.reevaluate_queued_jobs();
        self.jobs
            .get(&job_id)
            .cloned()
            .expect("submitted job is stored")
    }

    pub fn set_operator_contribution_percent(
        &mut self,
        node_id: &str,
        contribution_percent: Option<u8>,
    ) -> Result<NodeRecord, String> {
        let node = self
            .nodes
            .get_mut(node_id)
            .ok_or_else(|| "unknown node".to_string())?;

        if let Some(percent) = contribution_percent {
            if percent > 100 {
                return Err("contribution_percent must be between 0 and 100".to_string());
            }
        }

        node.operator_contribution_percent = contribution_percent;
        node.contribution_percent =
            contribution_percent.unwrap_or(node.reported_contribution_percent);
        let updated = node.clone();
        self.reevaluate_queued_jobs();
        Ok(updated)
    }

    pub fn set_node_policy_override(
        &mut self,
        node_id: &str,
        policy_override: Option<NodePolicyOverrideInput>,
    ) -> Result<NodeRecord, String> {
        let node = self
            .nodes
            .get_mut(node_id)
            .ok_or_else(|| "unknown node".to_string())?;

        node.operator_policy_override = policy_override.map(|value| NodePolicyOverride {
            target: value.target,
            reason: value.reason.trim().to_string(),
            actor: value.actor.trim().to_string(),
            updated_at: value.updated_at,
        });
        Self::apply_policy_override(node);
        let updated = node.clone();
        self.reevaluate_queued_jobs();
        Ok(updated)
    }

    pub fn set_admission_policy(
        &mut self,
        update: AdmissionPolicyUpdate,
        updated_at: String,
    ) -> AdmissionPolicy {
        let policy = AdmissionPolicy {
            enabled: update.enabled,
            require_trusted_identity: update.require_trusted_identity,
            require_healthy_runtime: update.require_healthy_runtime,
            min_memory_mb: update.min_memory_mb,
            min_cuda_vram_mb: update.min_cuda_vram_mb,
            allowed_backends: normalize_admission_backends(update.allowed_backends),
            enforce_model_policy: update.enforce_model_policy,
            allowed_models: update.allowed_models,
            updated_at: Some(updated_at),
            updated_by: update
                .actor
                .map(|actor| actor.trim().to_string())
                .filter(|actor| !actor.is_empty()),
        };
        self.admission_policy = policy.clone();

        for node in self.nodes.values_mut() {
            if let Some(worker_health) = node.worker_health.as_ref() {
                let (policy_allowed, policy_reason) = evaluate_policy(
                    node.reported_state,
                    node.power_source.as_str(),
                    node.on_battery,
                    node.battery_percent,
                    worker_health,
                );
                let (policy_allowed, policy_reason) = evaluate_admission_policy(
                    policy_allowed,
                    policy_reason,
                    &self.admission_policy,
                    node.backend,
                    node.identity_trust_path.as_str(),
                    node.available_memory_mb,
                    worker_health,
                );
                node.computed_policy_allowed = policy_allowed;
                node.computed_policy_reason = policy_reason;
                Self::apply_policy_override(node);
            }
        }

        self.reevaluate_queued_jobs();
        policy
    }

    fn node_backend_matches(
        job: &JobRecord,
        node_backend: Backend,
        ready_m_exists: bool,
        ready_cuda_exists: bool,
        ready_vllm_exists: bool,
    ) -> bool {
        match job.preferred_backend {
            Backend::Auto if job.graph_execution_enabled => {
                matches!(
                    node_backend,
                    Backend::Auto | Backend::M | Backend::Cuda | Backend::Vllm
                )
            }
            Backend::Auto => {
                if ready_m_exists {
                    node_backend == Backend::M
                } else if ready_vllm_exists {
                    node_backend == Backend::Vllm
                } else if ready_cuda_exists {
                    node_backend == Backend::Cuda
                } else {
                    node_backend == Backend::Auto
                }
            }
            Backend::M => {
                if ready_m_exists {
                    node_backend == Backend::M
                } else {
                    node_backend == Backend::Auto
                }
            }
            Backend::Cuda => {
                if ready_cuda_exists {
                    node_backend == Backend::Cuda
                } else {
                    node_backend == Backend::Auto
                }
            }
            Backend::Vllm => {
                if ready_vllm_exists {
                    node_backend == Backend::Vllm
                } else {
                    node_backend == Backend::Auto
                }
            }
        }
    }

    fn reported_runtime_modes(worker_health: &WorkerHealthReport) -> Vec<RuntimeMode> {
        if !worker_health.supported_runtime_modes.is_empty() {
            return worker_health.supported_runtime_modes.clone();
        }

        match worker_health
            .runtime_mode
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "local" | "mlx" | "blas" | "cuda" => vec![RuntimeMode::Local],
            "interactive" => vec![RuntimeMode::Interactive],
            _ => Vec::new(),
        }
    }

    /// True for runtimes that serve models from their own endpoint rather than
    /// from a MundusX-managed `llama-cli` process: MLX, vLLM, and a contributed
    /// cluster the contributor already runs.
    fn serves_models_remotely(worker_health: &WorkerHealthReport) -> bool {
        let runtime_mode = worker_health.runtime_mode.trim();
        runtime_mode.eq_ignore_ascii_case("mlx")
            || runtime_mode.eq_ignore_ascii_case("vllm")
            || runtime_mode.eq_ignore_ascii_case("contributed-cluster")
    }

    fn worker_runtime_dependencies_ready(worker_health: &WorkerHealthReport) -> bool {
        Self::serves_models_remotely(worker_health) || worker_health.llama_cli_available
    }

    fn compatible_ready_node_count_for_request(&self, request: &JobRequest) -> usize {
        self.nodes
            .values()
            .filter(|node| {
                Self::node_is_schedulable_state(node)
                    && node.policy_allowed
                    && Self::node_backend_can_run_request(node.backend, request.preferred_backend)
                    && Self::node_worker_can_run_request(node, request)
            })
            .count()
    }

    fn compatible_ready_research_profile(&self, request: &JobRequest) -> (usize, u32) {
        let desired_context = dynamic_research_context_budget(request);
        let mut contexts = self
            .nodes
            .values()
            .filter_map(|node| {
                (Self::node_is_schedulable_state(node)
                    && node.policy_allowed
                    && Self::node_backend_can_run_request(node.backend, request.preferred_backend)
                    && Self::node_worker_can_run_request(node, request))
                .then_some(node)
                .and_then(|node| node.worker_health.as_ref())
                .filter(|health| Self::capability_has_role(health, NodeRole::ChunkAnalysis))
                .map(|health| {
                    health
                        .capabilities
                        .max_context_tokens
                        .unwrap_or(desired_context)
                        .min(desired_context)
                })
                .filter(|context| *context >= 1_536)
            })
            .collect::<Vec<_>>();
        contexts.sort_unstable_by(|left, right| right.cmp(left));
        let context_budget = if contexts.len() >= 2 {
            contexts[1]
        } else {
            contexts.first().copied().unwrap_or(desired_context)
        };
        let eligible = contexts
            .iter()
            .filter(|context| **context >= context_budget)
            .count();
        (eligible, context_budget)
    }

    fn node_is_schedulable_state(node: &NodeRecord) -> bool {
        matches!(node.state, AgentState::Ready | AgentState::Busy)
    }

    fn node_has_available_slot_for_job(&self, node: &NodeRecord, job: &JobRecord) -> bool {
        if !Self::node_is_schedulable_state(node) || !node.policy_allowed {
            return false;
        }

        let active_assignments = self.active_assignment_count_for_node(&node.node_id);
        let capacity = Self::node_parallel_capacity_for_job(node, job);
        match node.state {
            AgentState::Ready => active_assignments < capacity,
            AgentState::Busy => active_assignments > 0 && active_assignments < capacity,
            _ => false,
        }
    }

    fn active_assignment_count_for_node(&self, node_id: &str) -> usize {
        self.jobs
            .values()
            .map(|job| {
                if job.graph_execution_enabled {
                    job.graph
                        .nodes
                        .iter()
                        .filter(|graph_node| {
                            graph_node.status == JobGraphNodeStatus::Running
                                && graph_node.assigned_node_id.as_deref() == Some(node_id)
                        })
                        .count()
                } else if job.status == JobStatus::Assigned
                    && job.assigned_node_id.as_deref() == Some(node_id)
                {
                    1
                } else {
                    0
                }
            })
            .sum()
    }

    fn node_parallel_capacity_for_job(node: &NodeRecord, job: &JobRecord) -> usize {
        let Some(worker_health) = node.worker_health.as_ref() else {
            return 1;
        };

        if !worker_health.healthy
            || !worker_health.runtime_ready
            || (!matches!(node.backend, Backend::M | Backend::Vllm)
                && !Self::serves_models_remotely(worker_health)
                && !worker_health.llama_cli_available)
        {
            return 1;
        }

        let runtime_mode = worker_health.runtime_mode.to_ascii_lowercase();
        let warm_persistent_runtime = runtime_mode.contains("persistent")
            || runtime_mode.contains("warm")
            || runtime_mode == "contributed-cluster"
            || node.backend == Backend::Vllm;
        if node.backend == Backend::Cuda && !warm_persistent_runtime {
            return 1;
        }

        if node.backend == Backend::Cuda {
            let usable_vram_mb = worker_health
                .cuda_memory_mb
                .unwrap_or_default()
                .saturating_mul(u32::from(node.contribution_percent))
                .saturating_add(99)
                / 100;
            if usable_vram_mb <= 8_192 {
                return 1;
            }
            let mut capacity = usize::from(worker_health.parallel_slots.max(1));
            let heavy_job = job.scheduling_requirements.context_size == ContextSize::Large
                || job.scheduling_requirements.task_type == RequestTaskType::Coding;
            if heavy_job {
                capacity = capacity.min(if usable_vram_mb >= 49_152 {
                    3
                } else if usable_vram_mb >= 24_576 {
                    2
                } else {
                    1
                });
            }
            return capacity.max(1);
        }

        if node.backend == Backend::M {
            let usable_memory_mb = node
                .available_memory_mb
                .saturating_mul(u32::from(node.contribution_percent))
                .saturating_add(99)
                / 100;
            let mut capacity = usize::from(worker_health.parallel_slots.max(1));
            let heavy_job = job.scheduling_requirements.context_size == ContextSize::Large
                || job.scheduling_requirements.task_type == RequestTaskType::Coding;
            if heavy_job {
                capacity = capacity.min(if usable_memory_mb >= 65_536 {
                    3
                } else if usable_memory_mb >= 32_769 {
                    2
                } else {
                    1
                });
            }
            return capacity.max(1);
        }

        if !warm_persistent_runtime {
            return 1;
        }

        let memory_mb = node.available_memory_mb;
        let mut capacity = match memory_mb {
            0..=12_287 => 1,
            12_288..=24_575 => 2,
            24_576..=32_767 => 3,
            32_768..=49_151 => 4,
            49_152..=65_535 => 6,
            _ => 8,
        };

        if let Some(model_name) = worker_health.model_name.as_deref() {
            let lower_model = model_name.to_ascii_lowercase();
            if contains_any(&lower_model, &["70b", "72b", "65b", "64b"]) {
                capacity = capacity.min(if memory_mb >= 131_072 { 2 } else { 1 });
            } else if contains_any(&lower_model, &["32b", "34b"]) {
                capacity = capacity.min(if memory_mb >= 131_072 { 3 } else { 1 });
            } else if contains_any(&lower_model, &["14b", "13b"]) {
                capacity = capacity.min(if memory_mb >= 65_536 { 3 } else { 2 });
            } else if contains_any(&lower_model, &["7b", "8b"]) {
                capacity = capacity.min(3);
            }
        }

        let heavy_job = job.scheduling_requirements.context_size == ContextSize::Large
            || job.scheduling_requirements.task_type == RequestTaskType::Coding;
        if heavy_job {
            capacity = capacity.min(if memory_mb >= 65_536 {
                3
            } else if memory_mb >= 32_768 {
                2
            } else {
                1
            });
        }

        capacity.max(1)
    }

    fn node_backend_can_run_request(node_backend: Backend, preferred_backend: Backend) -> bool {
        match preferred_backend {
            Backend::Auto => matches!(
                node_backend,
                Backend::Auto | Backend::M | Backend::Cuda | Backend::Vllm
            ),
            Backend::M => matches!(node_backend, Backend::Auto | Backend::M),
            Backend::Cuda => matches!(node_backend, Backend::Auto | Backend::Cuda),
            Backend::Vllm => matches!(node_backend, Backend::Auto | Backend::Vllm),
        }
    }

    fn node_worker_can_run_request(node: &NodeRecord, request: &JobRequest) -> bool {
        let Some(worker_health) = node.worker_health.as_ref() else {
            return false;
        };

        if !worker_health.healthy
            || !worker_health.runtime_ready
            || !Self::worker_runtime_dependencies_ready(worker_health)
        {
            return false;
        }

        let runtime_modes = Self::reported_runtime_modes(worker_health);
        if !runtime_modes.contains(&request.runtime_mode) {
            return false;
        }

        if request.stream && !worker_health.streaming_supported {
            return false;
        }

        if let Some(required_model) = request
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let model_matches = worker_health
                .model_name
                .as_deref()
                .map(|available| available.eq_ignore_ascii_case(required_model))
                .unwrap_or(false);
            if !model_matches {
                return false;
            }
        }

        true
    }

    fn node_can_run_job(node: &NodeRecord, job: &JobRecord) -> bool {
        let Some(worker_health) = node.worker_health.as_ref() else {
            return false;
        };

        if !worker_health.healthy
            || !worker_health.runtime_ready
            || !Self::worker_runtime_dependencies_ready(worker_health)
        {
            return false;
        }

        let runtime_modes = Self::reported_runtime_modes(worker_health);
        let runtime_matches = runtime_modes.contains(&job.runtime_mode)
            || (job.runtime_mode == RuntimeMode::Local
                && runtime_modes.contains(&RuntimeMode::Mlx));
        if !runtime_matches {
            return false;
        }

        if job.stream && !worker_health.streaming_supported {
            return false;
        }

        let model_was_explicitly_requested = job.scheduling_requirements.model.is_some();
        if let Some(required_model) = job.model.as_deref().map(str::trim).filter(|value| {
            !value.is_empty() && (!job.graph_execution_enabled || model_was_explicitly_requested)
        }) {
            let model_matches = worker_health
                .model_name
                .as_deref()
                .map(|available| available.eq_ignore_ascii_case(required_model))
                .unwrap_or(false);
            if !model_matches {
                return false;
            }
        }

        true
    }

    fn graph_node_role(job: &JobRecord, active_graph_node_id: Option<&str>) -> Option<NodeRole> {
        graph_node_required_role(&job.graph, active_graph_node_id)
    }

    fn capacity_class_for(node: &NodeRecord) -> CapacityClass {
        let Some(health) = node.worker_health.as_ref() else {
            return CapacityClass::Micro;
        };
        match health
            .capabilities
            .capacity_class
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "server" => return CapacityClass::Server,
            "synthesis" => return CapacityClass::Synthesis,
            "heavy" => return CapacityClass::Heavy,
            "performance" => return CapacityClass::Performance,
            "standard" => return CapacityClass::Standard,
            "micro" => return CapacityClass::Micro,
            _ => {}
        }
        let memory = health
            .capabilities
            .usable_memory_mb
            .or(health.capabilities.available_memory_mb)
            .unwrap_or(node.available_memory_mb);
        let vram = health.capabilities.available_vram_mb.unwrap_or(0);
        if node.backend == Backend::Vllm {
            CapacityClass::Server
        } else if memory >= 65_536 || vram >= 49_152 {
            CapacityClass::Synthesis
        } else if memory >= 32_768 || vram >= 24_576 {
            CapacityClass::Heavy
        } else if memory >= 16_384 || vram >= 12_288 {
            CapacityClass::Performance
        } else if memory >= 8_192 || vram >= 6_144 {
            CapacityClass::Standard
        } else {
            CapacityClass::Micro
        }
    }

    fn graph_workload<'a>(
        job: &'a JobRecord,
        active_graph_node_id: Option<&str>,
    ) -> Option<&'a StepWorkloadRequirements> {
        let id = active_graph_node_id?;
        job.graph
            .nodes
            .iter()
            .find(|node| node.id == id)
            .map(|node| &node.workload)
    }

    fn capability_has_role(worker_health: &WorkerHealthReport, required: NodeRole) -> bool {
        let roles = &worker_health.capabilities.roles;
        match required {
            NodeRole::ChunkAnalysis => {
                roles.is_empty()
                    || roles.contains(&NodeRole::ChunkAnalysis)
                    || roles.contains(&NodeRole::Batch)
            }
            NodeRole::Reducer => roles.contains(&NodeRole::Reducer),
            NodeRole::Synthesizer => roles.contains(&NodeRole::Synthesizer),
            role => roles.is_empty() || roles.contains(&role),
        }
    }

    fn node_can_run_graph_role(
        node: &NodeRecord,
        job: &JobRecord,
        active_graph_node_id: Option<&str>,
    ) -> bool {
        // Reducer strength already accounts for runtime health and acceleration. A healthy
        // strong reducer can synthesize a merge even when an older worker registration did not
        // advertise the explicit synthesizer role yet.
        if graph_node_is_merge(&job.graph, active_graph_node_id)
            && reducer_profile(node) == ReducerProfile::Strong
        {
            return true;
        }
        // A compact node cannot credibly regenerate a reducer/synthesizer answer, but it can
        // safely trigger the deterministic section-preserving fallback below. Keep this path
        // claimable so completed graph work is returned instead of expiring in the queue.
        if graph_node_is_merge(&job.graph, active_graph_node_id)
            && reducer_profile(node) == ReducerProfile::Compact
        {
            return true;
        }
        if let Some(workload) = Self::graph_workload(job, active_graph_node_id) {
            if Self::capacity_class_for(node) < workload.minimum_capacity_class
                && !graph_node_allows_degraded_capacity_retry(job, active_graph_node_id)
            {
                return false;
            }
            if let Some(health) = node.worker_health.as_ref() {
                if health
                    .capabilities
                    .max_context_tokens
                    .is_some_and(|limit| limit < workload.context_budget_tokens)
                {
                    return false;
                }
                if health.capabilities.schema_version >= 2 {
                    if workload
                        .required_tools
                        .iter()
                        .any(|tool| !health.capabilities.supported_tools.contains(tool))
                    {
                        return false;
                    }
                    if workload.requires_repository
                        && !health
                            .capabilities
                            .supported_tools
                            .iter()
                            .any(|tool| tool == "repository")
                    {
                        return false;
                    }
                }
            }
        }
        let Some(required) = Self::graph_node_role(job, active_graph_node_id) else {
            return true;
        };
        node.worker_health
            .as_ref()
            .map(|health| Self::capability_has_role(health, required))
            .unwrap_or(false)
    }

    fn node_meets_graph_capacity_strict(
        node: &NodeRecord,
        job: &JobRecord,
        active_graph_node_id: Option<&str>,
    ) -> bool {
        Self::graph_workload(job, active_graph_node_id)
            .map(|workload| Self::capacity_class_for(node) >= workload.minimum_capacity_class)
            .unwrap_or(true)
    }

    fn scheduler_score(
        &self,
        node: &NodeRecord,
        job: &JobRecord,
        active_graph_node_id: Option<&str>,
    ) -> SchedulerDecision {
        let mut score = 0;
        let mut reasons = Vec::new();
        let requirements = &job.scheduling_requirements;
        let capacity = Self::capacity_class_for(node);
        reasons.push(format!("capacity_class:{}", capacity.as_str()));
        reasons.push(format!("routing_mode:{}", job.routing_mode.as_str()));
        let weight = match capacity {
            CapacityClass::Micro => 1,
            CapacityClass::Standard => 2,
            CapacityClass::Performance => 3,
            CapacityClass::Heavy => 4,
            CapacityClass::Synthesis => 5,
            CapacityClass::Server => 6,
        };
        match job.routing_mode {
            RoutingMode::Eco => {
                score -= weight * 8;
                reasons.push("eco prefers smallest capable node".to_string());
            }
            RoutingMode::Normal => {
                score += weight * 2;
                reasons.push("normal balances capacity and fit".to_string());
            }
            RoutingMode::Max => {
                score += weight * 12;
                reasons.push("max prefers strongest eligible node".to_string());
            }
        }

        match (requirements.task_type, node.backend) {
            (RequestTaskType::Coding, Backend::Cuda | Backend::Vllm) => {
                score += 20;
                reasons.push("task:coding prefers cuda throughput".to_string());
            }
            (RequestTaskType::Document | RequestTaskType::Chat, Backend::M) => {
                score += 15;
                reasons.push("task favors local M-series interactive execution".to_string());
            }
            (_, Backend::M) => {
                score += 10;
                reasons.push("M-series node is eligible".to_string());
            }
            (_, Backend::Cuda) => {
                score += 8;
                reasons.push("CUDA node is eligible".to_string());
            }
            (_, Backend::Vllm) => {
                score += 12;
                reasons.push("vLLM node is eligible".to_string());
            }
            (_, Backend::Auto) => {
                score += 2;
                reasons.push("auto backend fallback is eligible".to_string());
            }
        }

        match requirements.context_size {
            ContextSize::Large => {
                score += (node.available_memory_mb / 4096).min(12) as i32;
                reasons.push(format!("memory:{}MB", node.available_memory_mb));
            }
            ContextSize::Medium => {
                score += (node.available_memory_mb / 8192).min(6) as i32;
                reasons.push(format!(
                    "medium-context memory:{}MB",
                    node.available_memory_mb
                ));
            }
            ContextSize::Small => {
                score += 3;
                reasons.push("small context fits baseline capacity".to_string());
            }
        }

        score += (node.available_gpu_percent / 10).min(10) as i32;
        reasons.push(format!("gpu_available:{}%", node.available_gpu_percent));

        if requirements.privacy_level == PrivacyLevel::Sensitive
            && is_trusted_identity_path(&node.identity_trust_path)
        {
            score += 15;
            reasons.push("sensitive request matched trusted identity path".to_string());
        } else if requirements.privacy_level != PrivacyLevel::Sensitive {
            score += 5;
            reasons.push(format!("privacy:{:?}", requirements.privacy_level));
        }

        if let Some(worker_health) = node.worker_health.as_ref() {
            if let Some(required_role) = Self::graph_node_role(job, active_graph_node_id) {
                if Self::capability_has_role(worker_health, required_role) {
                    score += 12;
                    reasons.push(format!("graph_role:{}", required_role.as_str()));
                }
            }
            if requirements
                .model
                .as_deref()
                .zip(worker_health.model_name.as_deref())
                .map(|(required, available)| required.eq_ignore_ascii_case(available))
                .unwrap_or(false)
            {
                score += 20;
                reasons.push("requested model is already present".to_string());
            }

            if requirements.model.is_none() {
                if let Some(model_name) = worker_health.model_name.as_deref() {
                    let tier = model_tier_for_name(model_name);
                    let (tier_score, tier_reason) = model_tier_score_for_job(job, tier);
                    score += tier_score;
                    reasons.push(format!(
                        "model routing:{} tier {} ({})",
                        model_name,
                        tier.as_str(),
                        tier_reason
                    ));
                }
            }

            if worker_health.streaming_supported {
                score += 3;
                reasons.push("streaming capable".to_string());
            }

            if worker_health.llama_cli_available && worker_health.blas_device_available {
                score += 5;
                reasons.push("local runtime dependencies ready".to_string());
            }
        }

        let active_assignments = self.active_assignment_count_for_node(&node.node_id);
        let parallel_capacity = Self::node_parallel_capacity_for_job(node, job);
        score += parallel_capacity.saturating_sub(active_assignments).min(4) as i32;
        score -= (active_assignments.min(4) * 4) as i32;
        reasons.push(format!(
            "parallel_slots:{active_assignments}/{parallel_capacity}"
        ));

        let trust_bonus = node.trust.score as i32 / 5 - 10;
        score += trust_bonus;
        reasons.push(format!(
            "trust:{} completed:{} failed:{} consecutive_failures:{}",
            node.trust.score,
            node.trust.completed_jobs,
            node.trust.failed_jobs,
            node.trust.consecutive_failures
        ));

        let mut decision = SchedulerDecision {
            node_id: node.node_id.clone(),
            score,
            reasons,
        };
        self.apply_node_performance_score(&mut decision, node, job, active_graph_node_id);
        decision
    }

    fn best_scheduler_decision_for_job(&self, job: &JobRecord) -> SchedulerDecision {
        let ready_m_exists = self.nodes.values().any(|candidate| {
            Self::node_is_schedulable_state(candidate)
                && candidate.policy_allowed
                && candidate.backend == Backend::M
        });
        let ready_cuda_exists = self.nodes.values().any(|candidate| {
            Self::node_is_schedulable_state(candidate)
                && candidate.policy_allowed
                && candidate.backend == Backend::Cuda
        });
        let ready_vllm_exists = self.nodes.values().any(|candidate| {
            Self::node_is_schedulable_state(candidate)
                && candidate.policy_allowed
                && candidate.backend == Backend::Vllm
        });

        self.nodes
            .values()
            .filter(|node| {
                let active_graph_node_id = if job.graph_execution_enabled {
                    next_ready_graph_node_id_for_node(&job.graph, &node.node_id)
                } else {
                    None
                };
                self.node_has_available_slot_for_job(node, job)
                    && (!job.graph_execution_enabled || active_graph_node_id.is_some())
                    && Self::node_backend_matches(
                        job,
                        node.backend,
                        ready_m_exists,
                        ready_cuda_exists,
                        ready_vllm_exists,
                    )
                    && Self::node_can_run_job(node, job)
                    && Self::node_can_run_graph_role(
                        node,
                        job,
                        active_graph_node_id.as_deref(),
                    )
            })
            .map(|node| {
                let active_graph_node_id = if job.graph_execution_enabled {
                    next_ready_graph_node_id_for_node(&job.graph, &node.node_id)
                } else {
                    None
                };
                self.scheduler_score(node, job, active_graph_node_id.as_deref())
            })
            .max_by(|left, right| {
                left.score
                    .cmp(&right.score)
                    .then_with(|| right.node_id.cmp(&left.node_id))
            })
            .unwrap_or_else(|| {
                let role_reason = next_ready_graph_node_id(&job.graph)
                    .and_then(|node_id| {
                        graph_node_required_role(&job.graph, Some(node_id.as_str()))
                    })
                    .map(|role| {
                        format!(
                            "waiting_for_role:{}; no credible {} is currently available",
                            role.as_str(),
                            role.as_str()
                        )
                    });
                SchedulerDecision {
                    node_id: String::new(),
                    score: 0,
                    reasons: vec![role_reason.unwrap_or_else(|| {
                        format!(
                            "queued: no compatible node slot available for backend {:?}, runtime {:?}, model {}",
                            job.preferred_backend,
                            job.runtime_mode,
                            job.model.as_deref().unwrap_or("any")
                        )
                    })],
                }
            })
    }

    fn reevaluate_queued_jobs(&mut self) {
        let updates: Vec<(String, SchedulerDecision)> = self
            .jobs
            .iter()
            .filter(|(_, job)| self.job_can_be_claimed(job))
            .map(|(job_id, job)| (job_id.clone(), self.best_scheduler_decision_for_job(job)))
            .collect();

        for (job_id, scheduler_decision) in updates {
            if let Some(job) = self.jobs.get_mut(&job_id) {
                job.scheduler_decision = Some(scheduler_decision);
            }
        }
    }

    pub fn claim_job(&mut self, node_id: &str, claimed_at: String) -> JobClaimResponse {
        self.run_maintenance(&claimed_at);

        let Some(node) = self.nodes.get(node_id) else {
            return JobClaimResponse { job: None };
        };

        if !Self::node_is_schedulable_state(node) || !node.policy_allowed {
            return JobClaimResponse { job: None };
        }

        let claiming_node = node.clone();
        let node_backend = node.backend;
        let ready_m_exists = self.nodes.values().any(|candidate| {
            Self::node_is_schedulable_state(candidate)
                && candidate.policy_allowed
                && candidate.backend == Backend::M
        });
        let ready_cuda_exists = self.nodes.values().any(|candidate| {
            Self::node_is_schedulable_state(candidate)
                && candidate.policy_allowed
                && candidate.backend == Backend::Cuda
        });
        let ready_vllm_exists = self.nodes.values().any(|candidate| {
            Self::node_is_schedulable_state(candidate)
                && candidate.policy_allowed
                && candidate.backend == Backend::Vllm
        });
        let schedulable_retry_nodes = self
            .nodes
            .values()
            .filter(|candidate| {
                Self::node_is_schedulable_state(candidate) && candidate.policy_allowed
            })
            .map(|candidate| candidate.node_id.clone())
            .collect::<Vec<_>>();
        let selected = self
            .jobs
            .iter()
            .filter_map(|(job_id, job)| {
                let mut active_graph_node_id = if job.graph_execution_enabled {
                    next_claimable_graph_node_id_for_node(
                        &job.graph,
                        node_id,
                        &schedulable_retry_nodes,
                    )
                } else {
                    None
                };
                if active_graph_node_id.is_none() && job.graph_execution_enabled {
                    if let Some(ready_node_id) = next_ready_graph_node_id(&job.graph) {
                        if graph_node_is_merge(&job.graph, Some(ready_node_id.as_str()))
                            && best_reducer_node_id_for_job(self, job).as_deref() == Some(node_id)
                        {
                            active_graph_node_id = Some(ready_node_id);
                        }
                    }
                }
                if graph_node_is_merge(&job.graph, active_graph_node_id.as_deref()) {
                    if let Some(best_node_id) = best_reducer_node_id_for_job(self, job) {
                        if best_node_id != node.node_id {
                            return None;
                        }
                    }
                }
                let degraded_capacity = !Self::node_meets_graph_capacity_strict(
                    node,
                    job,
                    active_graph_node_id.as_deref(),
                );
                let qualified_slot_available = degraded_capacity
                    && active_graph_node_id
                        .as_deref()
                        .is_some_and(|graph_node_id| {
                            self.nodes.values().any(|candidate| {
                                candidate.node_id != node.node_id
                                    && next_claimable_graph_node_id_for_node(
                                        &job.graph,
                                        &candidate.node_id,
                                        &schedulable_retry_nodes,
                                    )
                                    .as_deref()
                                        == Some(graph_node_id)
                                    && self.node_has_available_slot_for_job(candidate, job)
                                    && Self::node_backend_matches(
                                        job,
                                        candidate.backend,
                                        ready_m_exists,
                                        ready_cuda_exists,
                                        ready_vllm_exists,
                                    )
                                    && Self::node_can_run_job(candidate, job)
                                    && Self::node_meets_graph_capacity_strict(
                                        candidate,
                                        job,
                                        Some(graph_node_id),
                                    )
                                    && Self::node_can_run_graph_role(
                                        candidate,
                                        job,
                                        Some(graph_node_id),
                                    )
                            })
                        });
                if self.job_can_be_claimed(job)
                    && self.node_has_available_slot_for_job(node, job)
                    && (!job.graph_execution_enabled || active_graph_node_id.is_some())
                    && Self::node_backend_matches(
                        job,
                        node_backend,
                        ready_m_exists,
                        ready_cuda_exists,
                        ready_vllm_exists,
                    )
                    && Self::node_can_run_job(node, job)
                    && Self::node_can_run_graph_role(node, job, active_graph_node_id.as_deref())
                    && !qualified_slot_available
                {
                    let mut decision =
                        self.scheduler_score(node, job, active_graph_node_id.as_deref());
                    if degraded_capacity {
                        decision.reasons.push(
                            "capacity_degraded_retry:no fully qualified retry node claimed the work"
                                .to_string(),
                        );
                    }
                    if graph_node_is_merge(&job.graph, active_graph_node_id.as_deref()) {
                        apply_reducer_scheduler_score(&mut decision, node);
                    }
                    if !graph_node_is_merge(&job.graph, active_graph_node_id.as_deref())
                        && graph_node_latency_weight(&job.graph, active_graph_node_id.as_deref())
                            > 1
                    {
                        if let Some(best_decision) = self
                            .best_scheduler_decision_for_active_graph_node(
                                job,
                                active_graph_node_id.as_deref(),
                            )
                        {
                            if best_decision.node_id != node.node_id
                                && best_decision.score > decision.score + 8
                            {
                                return None;
                            }
                        }
                    }
                    Some((job_id.clone(), decision, active_graph_node_id))
                } else {
                    None
                }
            })
            .max_by(
                |(left_id, left_decision, _), (right_id, right_decision, _)| {
                    left_decision
                        .score
                        .cmp(&right_decision.score)
                        .then_with(|| right_id.cmp(left_id))
                },
            );

        let Some((job_id, scheduler_decision, selected_graph_node_id)) = selected else {
            return JobClaimResponse { job: None };
        };

        if let Some(job) = self.jobs.get_mut(&job_id) {
            if !job.graph_execution_enabled && job.model.is_none() {
                if let Some(selected_model) = claiming_node
                    .worker_health
                    .as_ref()
                    .and_then(|health| health.model_name.clone())
                    .filter(|model| !model.trim().is_empty())
                {
                    job.model = Some(selected_model);
                }
            }

            let active_graph_node_id = selected_graph_node_id;
            if active_graph_node_id.is_none() {
                job.max_tokens = Some(job_max_tokens_for_node(job, &claiming_node));
            }
            if graph_node_is_merge(&job.graph, active_graph_node_id.as_deref())
                && reducer_profile(&claiming_node) == ReducerProfile::Compact
                && complete_compact_reducer_fallback(job, node_id, node_backend, claimed_at.clone())
            {
                self.reevaluate_queued_jobs();
                return JobClaimResponse { job: None };
            }
            if let Some(active_node_id) = active_graph_node_id.as_ref() {
                let effective_max_tokens =
                    graph_node_max_tokens(job, active_node_id, Some(&claiming_node));
                let ready_at = graph_node_ready_at(job, active_node_id);
                let queue_wait_ms = elapsed_ms_between(&ready_at, &claimed_at);
                let model = claiming_node
                    .worker_health
                    .as_ref()
                    .and_then(|health| health.model_name.clone())
                    .or_else(|| job.model.clone());
                let runtime_mode = Some(job.runtime_mode.as_str().to_string());
                if let Some(graph_node) = job
                    .graph
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == *active_node_id)
                {
                    graph_node.status = JobGraphNodeStatus::Running;
                    graph_node.blocked_by.clear();
                    graph_node.assigned_node_id = Some(node_id.to_string());
                    graph_node.assigned_at = Some(claimed_at.clone());
                    graph_node.started_at = Some(claimed_at.clone());
                    graph_node.completed_at = None;
                    graph_node.worker_id = None;
                    graph_node.backend = Some(node_backend);
                    graph_node.model = model;
                    graph_node.runtime_mode = runtime_mode;
                    graph_node.effective_max_tokens = Some(effective_max_tokens);
                    graph_node.queue_wait_ms = queue_wait_ms;
                    graph_node.runtime_ms = None;
                    graph_node.latency_ms = None;
                    graph_node.output_chars = None;
                    graph_node.estimated_output_tokens = None;
                    graph_node.output = None;
                    graph_node.error = None;
                    graph_node.attempt_count = graph_node.attempt_count.saturating_add(1);
                }
            }

            job.status = JobStatus::Assigned;
            job.assigned_node_id = Some(node_id.to_string());
            job.assigned_at = Some(claimed_at);
            job.backend = Some(node_backend);
            job.worker_id = None;
            job.output = None;
            job.error = None;
            job.active_graph_node_id = active_graph_node_id.clone();
            job.last_completed_graph_node_id = None;
            job.scheduler_decision = Some(scheduler_decision);
            job.graph.status = JobGraphStatus::InProgress;
            job.graph.updated_at = job.assigned_at.clone().unwrap_or_default();

            if let Some(node) = self.nodes.get_mut(node_id) {
                node.reported_state = AgentState::Busy;
                node.updated_at = job.assigned_at.clone().unwrap_or_default();
                Self::apply_policy_override(node);
            }

            refresh_job_graph(&mut job.graph);
            let mut claim_job = job.clone();
            if let Some(active_node_id) = active_graph_node_id.as_deref() {
                claim_job.prompt =
                    graph_node_execution_prompt(job, active_node_id, Some(&claiming_node));
                claim_job.max_tokens = job
                    .graph
                    .nodes
                    .iter()
                    .find(|node| node.id == active_node_id)
                    .and_then(|node| node.effective_max_tokens)
                    .or_else(|| {
                        Some(graph_node_max_tokens(
                            job,
                            active_node_id,
                            Some(&claiming_node),
                        ))
                    });
            } else {
                claim_job.prompt = direct_job_execution_prompt(job);
            }

            let claimed = JobClaimResponse {
                job: Some(claim_job),
            };
            self.reevaluate_queued_jobs();
            return claimed;
        }

        JobClaimResponse { job: None }
    }

    fn best_scheduler_decision_for_active_graph_node(
        &self,
        job: &JobRecord,
        active_graph_node_id: Option<&str>,
    ) -> Option<SchedulerDecision> {
        let active_graph_node_id = active_graph_node_id?;
        let ready_m_exists = self.nodes.values().any(|candidate| {
            Self::node_is_schedulable_state(candidate)
                && candidate.policy_allowed
                && candidate.backend == Backend::M
        });
        let ready_cuda_exists = self.nodes.values().any(|candidate| {
            Self::node_is_schedulable_state(candidate)
                && candidate.policy_allowed
                && candidate.backend == Backend::Cuda
        });
        let ready_vllm_exists = self.nodes.values().any(|candidate| {
            Self::node_is_schedulable_state(candidate)
                && candidate.policy_allowed
                && candidate.backend == Backend::Vllm
        });

        self.nodes
            .values()
            .filter(|node| {
                self.node_has_available_slot_for_job(node, job)
                    && next_ready_graph_node_id_for_node(&job.graph, &node.node_id).as_deref()
                        == Some(active_graph_node_id)
                    && Self::node_backend_matches(
                        job,
                        node.backend,
                        ready_m_exists,
                        ready_cuda_exists,
                        ready_vllm_exists,
                    )
                    && Self::node_can_run_job(node, job)
                    && Self::node_can_run_graph_role(node, job, Some(active_graph_node_id))
            })
            .map(|node| {
                let mut decision = self.scheduler_score(node, job, Some(active_graph_node_id));
                if graph_node_is_merge(&job.graph, Some(active_graph_node_id)) {
                    apply_reducer_scheduler_score(&mut decision, node);
                }
                decision
            })
            .max_by(|left, right| {
                left.score
                    .cmp(&right.score)
                    .then_with(|| right.node_id.cmp(&left.node_id))
            })
    }

    fn apply_node_performance_score(
        &self,
        decision: &mut SchedulerDecision,
        node: &NodeRecord,
        job: &JobRecord,
        active_graph_node_id: Option<&str>,
    ) {
        let stats = self.recent_graph_node_performance(&node.node_id);
        if stats.completed_samples == 0 && stats.failed_samples == 0 {
            decision
                .reasons
                .push("performance:no recent chunk telemetry".to_string());
            return;
        }

        let latency_weight = graph_node_latency_weight(&job.graph, active_graph_node_id);
        if stats.latency_samples > 0 {
            let avg_latency_ms = stats.total_latency_ms / u64::from(stats.latency_samples);
            let latency_delta = performance_latency_score(avg_latency_ms) * latency_weight;
            decision.score += latency_delta;
            decision.reasons.push(format!(
                "performance:avg_chunk_latency_ms:{} samples:{} score_delta:{}",
                avg_latency_ms, stats.latency_samples, latency_delta
            ));
        }

        if stats.failed_samples > 0 {
            let failure_penalty = (i32::from(stats.failed_samples).min(5) * 12) * latency_weight;
            decision.score -= failure_penalty;
            decision.reasons.push(format!(
                "performance:recent_chunk_failures:{} score_delta:-{}",
                stats.failed_samples, failure_penalty
            ));
        }
    }

    fn recent_graph_node_performance(&self, node_id: &str) -> NodePerformanceStats {
        let mut stats = NodePerformanceStats::default();
        for graph_node in self
            .jobs
            .values()
            .flat_map(|job| job.graph.nodes.iter())
            .filter(|graph_node| graph_node.assigned_node_id.as_deref() == Some(node_id))
        {
            match graph_node.status {
                JobGraphNodeStatus::Completed => {
                    stats.completed_samples = stats.completed_samples.saturating_add(1);
                    if let Some(latency_ms) = graph_node.latency_ms {
                        stats.latency_samples = stats.latency_samples.saturating_add(1);
                        stats.total_latency_ms = stats.total_latency_ms.saturating_add(latency_ms);
                    }
                }
                JobGraphNodeStatus::Failed => {
                    stats.failed_samples = stats.failed_samples.saturating_add(1);
                }
                _ => {}
            }
        }
        stats
    }

    pub fn run_maintenance(&mut self, now: &str) -> Vec<JobRecord> {
        self.run_maintenance_with_nodes(now).changed_jobs
    }

    pub fn run_maintenance_with_nodes(&mut self, now: &str) -> MaintenanceResult {
        let changed_nodes = self.mark_stale_nodes_stopped(now);
        let mut changed_jobs = self.release_expired_queued_jobs(now);
        changed_jobs.extend(self.release_stale_graph_claims(now));
        MaintenanceResult {
            changed_jobs,
            changed_nodes,
        }
    }

    pub fn complete_job(
        &mut self,
        completion: JobCompletion,
        completed_at: String,
    ) -> Option<JobRecord> {
        let compact_reducer_node = self
            .nodes
            .get(&completion.node_id)
            .map(|node| reducer_profile(node) == ReducerProfile::Compact)
            .unwrap_or(false);
        let updated_job = {
            let job = self.jobs.get_mut(&completion.job_id)?;

            if job.graph_execution_enabled {
                complete_graph_execution_job(
                    job,
                    completion.clone(),
                    completed_at.clone(),
                    compact_reducer_node,
                )
            } else {
                if job.assigned_node_id.as_deref() != Some(completion.node_id.as_str()) {
                    return Some(job.clone());
                }
                let output = clean_direct_job_output(job, completion.output.clone());
                job.status = completion.status;
                job.worker_id = Some(completion.worker_id.clone());
                job.backend = Some(completion.backend);
                job.output = output;
                job.error = completion.error.clone();
                job.completed_at = Some(completed_at.clone());
                apply_job_completion_to_graph(job, &completion);
                job.graph.updated_at = completed_at.clone();
                job.clone()
            }
        };

        let remaining_assignments = self.active_assignment_count_for_node(&completion.node_id);
        if let Some(node) = self.nodes.get_mut(&completion.node_id) {
            if node.reported_state == AgentState::Busy {
                node.reported_state = if remaining_assignments > 0 {
                    AgentState::Busy
                } else {
                    AgentState::Ready
                };
            }
            node.backend = completion.backend;
            node.updated_at = completed_at;
            update_node_trust(&mut node.trust, &completion, node.updated_at.clone());
            Self::apply_policy_override(node);
        }

        self.reevaluate_queued_jobs();
        Some(updated_job)
    }

    fn job_can_be_claimed(&self, job: &JobRecord) -> bool {
        if !job.graph_execution_enabled {
            return job.status == JobStatus::Queued;
        }
        matches!(job.status, JobStatus::Queued | JobStatus::Assigned)
            && next_ready_graph_node_id(&job.graph).is_some()
    }

    fn release_expired_queued_jobs(&mut self, now: &str) -> Vec<JobRecord> {
        let Some(now_seconds) = parse_unix_seconds(now) else {
            return Vec::new();
        };
        let timeout_seconds = queued_job_timeout_seconds();
        let mut changed_jobs = Vec::new();

        for job in self.jobs.values_mut() {
            if job.status != JobStatus::Queued {
                continue;
            }

            let no_eligible_node = job
                .scheduler_decision
                .as_ref()
                .map(|decision| decision.node_id.trim().is_empty())
                .unwrap_or(true);
            if !no_eligible_node {
                continue;
            }

            let required_role = if job.graph_execution_enabled {
                next_ready_graph_node_id(&job.graph).and_then(|node_id| {
                    graph_node_required_role(&job.graph, Some(node_id.as_str()))
                })
            } else {
                None
            };
            let critical_role = required_role
                .filter(|role| matches!(role, NodeRole::Reducer | NodeRole::Synthesizer));
            let timeout_seconds = if critical_role.is_some() {
                critical_role_wait_seconds()
            } else {
                timeout_seconds
            };
            let wait_started_at = if critical_role.is_some() {
                job.graph.updated_at.as_str()
            } else {
                job.submitted_at.as_str()
            };
            let Some(submitted_at) = parse_unix_seconds(wait_started_at) else {
                continue;
            };
            if now_seconds.saturating_sub(submitted_at) < timeout_seconds {
                continue;
            }

            let scheduler_reason = job
                .scheduler_decision
                .as_ref()
                .and_then(|decision| decision.reasons.first())
                .cloned()
                .unwrap_or_else(|| "no compatible node slot available".to_string());
            let error = if let Some(role) = critical_role {
                format!(
                    "NO_CREDIBLE_{}: completed outputs were preserved after waiting {timeout_seconds}s; {scheduler_reason}",
                    role.as_str().to_ascii_uppercase()
                )
            } else {
                format!(
                    "queued job expired after {timeout_seconds}s without an eligible worker; {scheduler_reason}"
                )
            };

            job.status = JobStatus::Failed;
            job.completed_at = Some(now.to_string());
            job.assigned_node_id = None;
            job.assigned_at = None;
            job.worker_id = None;
            job.backend = None;
            job.output = None;
            job.error = Some(error.clone());
            job.active_graph_node_id = None;

            if job.graph_execution_enabled {
                for node in &mut job.graph.nodes {
                    if matches!(
                        node.status,
                        JobGraphNodeStatus::Ready
                            | JobGraphNodeStatus::Waiting
                            | JobGraphNodeStatus::Running
                    ) {
                        node.status = JobGraphNodeStatus::Failed;
                        node.error = Some(error.clone());
                        node.output = None;
                        node.assigned_node_id = None;
                        node.assigned_at = None;
                        node.worker_id = None;
                        node.backend = None;
                    }
                }
                refresh_job_graph(&mut job.graph);
                job.graph.updated_at = now.to_string();
                job.graph.merge_error = Some(error.clone());
            }

            changed_jobs.push(job.clone());
        }

        if !changed_jobs.is_empty() {
            self.reevaluate_queued_jobs();
        }
        changed_jobs
    }

    fn mark_stale_nodes_stopped(&mut self, now: &str) -> Vec<NodeRecord> {
        let Some(now_seconds) = parse_unix_seconds(now) else {
            return Vec::new();
        };
        let stale_seconds = node_heartbeat_stale_seconds();
        let mut changed_nodes = Vec::new();

        for node in self.nodes.values_mut() {
            if matches!(node.state, AgentState::Paused | AgentState::Stopped)
                || matches!(
                    node.reported_state,
                    AgentState::Paused | AgentState::Stopped
                )
            {
                continue;
            }
            let Some(last_seen_seconds) = parse_unix_seconds(&node.updated_at) else {
                continue;
            };
            if now_seconds.saturating_sub(last_seen_seconds) < stale_seconds {
                continue;
            }

            node.state = AgentState::Stopped;
            node.policy_allowed = false;
            node.policy_reason = Some(format!(
                "heartbeat stale: last seen {}s ago",
                now_seconds.saturating_sub(last_seen_seconds)
            ));
            changed_nodes.push(node.clone());
        }

        if !changed_nodes.is_empty() {
            self.reevaluate_queued_jobs();
        }
        changed_nodes
    }

    fn release_stale_graph_claims(&mut self, now: &str) -> Vec<JobRecord> {
        let Some(now) = parse_unix_seconds(now) else {
            return Vec::new();
        };
        let mut changed_jobs = Vec::new();

        for job in self.jobs.values_mut() {
            if !job.graph_execution_enabled || !matches!(job.status, JobStatus::Assigned) {
                continue;
            }
            let lease_seconds = graph_node_lease_seconds_for(job.scheduling_requirements.task_type);

            let mut changed = false;
            for node in &mut job.graph.nodes {
                if node.status != JobGraphNodeStatus::Running {
                    continue;
                }
                let Some(assigned_at) = node.assigned_at.as_deref().and_then(parse_unix_seconds)
                else {
                    continue;
                };
                if now.saturating_sub(assigned_at) < lease_seconds {
                    continue;
                }

                let stale_node_id = node.assigned_node_id.clone();
                if let Some(node_id) = stale_node_id.as_ref() {
                    if !node.failed_node_ids.iter().any(|failed| failed == node_id) {
                        node.failed_node_ids.push(node_id.clone());
                    }
                }
                let stale_error = format!(
                    "stale assignment timed out after {lease_seconds}s on {}",
                    stale_node_id.as_deref().unwrap_or("unknown node")
                );
                node.error = Some(stale_error);
                node.output = None;
                node.assigned_node_id = None;
                node.assigned_at = None;
                node.worker_id = None;
                node.backend = None;
                node.status = if node.attempt_count >= node.max_attempts {
                    JobGraphNodeStatus::Failed
                } else {
                    JobGraphNodeStatus::Ready
                };
                changed = true;
            }

            if !changed {
                continue;
            }

            refresh_job_graph(&mut job.graph);
            refresh_graph_results(
                &mut job.graph,
                job.classification.output_format,
                None,
                None,
                None,
            );
            job.graph.updated_at = now.to_string();
            job.active_graph_node_id = next_ready_graph_node_id(&job.graph);
            job.assigned_node_id = None;
            job.assigned_at = None;
            job.worker_id = None;
            job.backend = None;
            job.output = job.graph.final_output.clone();
            job.error = job.graph.merge_error.clone();
            if job.graph.status == JobGraphStatus::Failed {
                job.status = JobStatus::Failed;
                job.completed_at = Some(now.to_string());
            } else if graph_has_running_nodes(&job.graph) {
                job.status = JobStatus::Assigned;
                job.completed_at = None;
            } else {
                job.status = JobStatus::Queued;
                job.completed_at = None;
            }
            changed_jobs.push(job.clone());
        }

        if !changed_jobs.is_empty() {
            self.reevaluate_queued_jobs();
        }
        changed_jobs
    }

    pub fn update_graph_node(
        &mut self,
        job_id: &str,
        node_id: &str,
        status: JobGraphNodeStatus,
        output: Option<String>,
        error: Option<String>,
        updated_at: String,
    ) -> Result<JobGraph, String> {
        let job = self
            .jobs
            .get_mut(job_id)
            .ok_or_else(|| "unknown job".to_string())?;
        let node = job
            .graph
            .nodes
            .iter_mut()
            .find(|node| node.id == node_id)
            .ok_or_else(|| "unknown graph node".to_string())?;

        if matches!(status, JobGraphNodeStatus::Running)
            && !matches!(
                node.status,
                JobGraphNodeStatus::Ready | JobGraphNodeStatus::Running
            )
        {
            return Err("graph node dependencies are not satisfied".to_string());
        }

        node.status = status;
        node.output = output;
        node.error = error;
        job.graph.updated_at = updated_at;
        refresh_job_graph(&mut job.graph);
        refresh_graph_results(
            &mut job.graph,
            job.classification.output_format,
            None,
            None,
            None,
        );
        Ok(job.graph.clone())
    }

    pub fn heartbeat(&mut self, heartbeat: Heartbeat, updated_at: String) -> NodeRecord {
        let (policy_allowed, policy_reason) = evaluate_policy(
            heartbeat.agent_state,
            heartbeat.power_source.as_str(),
            heartbeat.on_battery,
            heartbeat.battery_percent,
            &heartbeat.worker_health,
        );
        let (policy_allowed, policy_reason) = evaluate_admission_policy(
            policy_allowed,
            policy_reason,
            &self.admission_policy,
            heartbeat.backend,
            heartbeat.identity_trust_path.as_str(),
            heartbeat.available_memory_mb,
            &heartbeat.worker_health,
        );
        let existing_override = self
            .nodes
            .get(&heartbeat.node_id)
            .and_then(|node| node.operator_contribution_percent);
        let existing_policy_override = self
            .nodes
            .get(&heartbeat.node_id)
            .and_then(|node| node.operator_policy_override.clone());
        let existing_trust = self
            .nodes
            .get(&heartbeat.node_id)
            .map(|node| node.trust.clone())
            .unwrap_or_default();
        let reported_contribution_percent = heartbeat.contribution_percent;
        let mut record = NodeRecord {
            node_id: heartbeat.node_id.clone(),
            public_key_fingerprint: self
                .nodes
                .get(&heartbeat.node_id)
                .map(|node| node.public_key_fingerprint.clone())
                .unwrap_or_default(),
            public_key_hex: self
                .nodes
                .get(&heartbeat.node_id)
                .map(|node| node.public_key_hex.clone())
                .unwrap_or_default(),
            hostname: self
                .nodes
                .get(&heartbeat.node_id)
                .map(|node| node.hostname.clone())
                .unwrap_or_default(),
            identity_trust_path: heartbeat.identity_trust_path.clone(),
            backend: heartbeat.backend,
            contribution_percent: existing_override.unwrap_or(reported_contribution_percent),
            reported_contribution_percent,
            operator_contribution_percent: existing_override,
            agent_version: self
                .nodes
                .get(&heartbeat.node_id)
                .map(|node| node.agent_version.clone())
                .unwrap_or_else(|| "0.1.0".to_string()),
            state: heartbeat.agent_state,
            reported_state: heartbeat.agent_state,
            available_memory_mb: heartbeat.available_memory_mb,
            available_gpu_percent: heartbeat.available_gpu_percent,
            power_source: heartbeat.power_source,
            on_battery: heartbeat.on_battery,
            battery_percent: heartbeat.battery_percent,
            policy_allowed,
            policy_reason: policy_reason.clone(),
            computed_policy_allowed: policy_allowed,
            computed_policy_reason: policy_reason,
            operator_policy_override: existing_policy_override,
            trust: existing_trust,
            worker_health: Some(heartbeat.worker_health),
            updated_at: updated_at.clone(),
        };
        Self::apply_policy_override(&mut record);

        self.nodes.insert(heartbeat.node_id, record.clone());
        self.reevaluate_queued_jobs();
        record
    }
}

fn external_plan_preserves_explicit_decomposition(
    request: &JobRequest,
    deterministic_plan: &JobPlan,
    external_plan: &JobPlan,
) -> bool {
    request.execution_mode != JobExecutionMode::Decompose
        || deterministic_plan.jobs.len() <= 1
        || external_plan.jobs.len() > 1
}

fn graph_execution_allowed(
    request: &JobRequest,
    classification: &RequestClassification,
    plan: &JobPlan,
) -> bool {
    if request.stream || plan.jobs.len() <= 1 {
        return false;
    }

    match request.execution_mode {
        JobExecutionMode::Single => false,
        JobExecutionMode::Decompose => true,
        JobExecutionMode::Auto => {
            classification.privacy_level != PrivacyLevel::Sensitive
                && (classification.complexity == RequestComplexity::High
                    || looks_sectionable_prompt(&request.prompt))
        }
    }
}

fn parse_unix_seconds(value: &str) -> Option<u64> {
    value.parse::<u64>().ok()
}

#[derive(Clone, Copy, Debug, Default)]
struct NodePerformanceStats {
    completed_samples: u8,
    latency_samples: u8,
    failed_samples: u8,
    total_latency_ms: u64,
}

fn performance_latency_score(avg_latency_ms: u64) -> i32 {
    match avg_latency_ms {
        0..=15_000 => 18,
        15_001..=30_000 => 10,
        30_001..=60_000 => 2,
        60_001..=120_000 => -12,
        _ => -24,
    }
}

fn graph_node_latency_weight(graph: &JobGraph, graph_node_id: Option<&str>) -> i32 {
    let Some(graph_node_id) = graph_node_id else {
        return 1;
    };
    let Some(graph_node) = graph.nodes.iter().find(|node| node.id == graph_node_id) else {
        return 1;
    };

    if graph.final_node_id.as_deref() == Some(graph_node_id)
        || graph_node.responsibility == "merge"
        || graph_node_is_long_running_stage(graph_node)
        || graph_node.effective_max_tokens.unwrap_or_default() >= 512
    {
        2
    } else {
        1
    }
}

fn graph_node_is_long_running_stage(graph_node: &JobGraphNode) -> bool {
    matches!(
        graph_node.responsibility.as_str(),
        "backend" | "frontend" | "implementation" | "code" | "tests" | "validation"
    ) || graph_node.id.contains("implementation")
        || graph_node.id.contains("backend")
        || graph_node.id.contains("frontend")
        || graph_node.id.contains("code_file")
        || graph_node.id.contains("code_main")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ModelTier {
    Tiny,
    Small,
    Normal,
    Strong,
}

impl ModelTier {
    fn as_str(self) -> &'static str {
        match self {
            Self::Tiny => "tiny",
            Self::Small => "small",
            Self::Normal => "normal",
            Self::Strong => "strong",
        }
    }
}

fn model_tier_for_name(model_name: &str) -> ModelTier {
    let lower = model_name.to_ascii_lowercase();
    if contains_any(&lower, &["135m", "0.1b", "0.2b", "tiny", "smollm"]) {
        ModelTier::Tiny
    } else if contains_any(&lower, &["0.5b", "500m", "0_5b"]) {
        ModelTier::Small
    } else if contains_any(&lower, &["3b", "4b", "7b", "8b", "14b", "32b"]) {
        ModelTier::Strong
    } else {
        ModelTier::Normal
    }
}

fn model_tier_score_for_job(job: &JobRecord, tier: ModelTier) -> (i32, &'static str) {
    let requirements = &job.scheduling_requirements;
    let latency_sensitive_simple = requirements.context_size == ContextSize::Small
        && matches!(
            requirements.task_type,
            RequestTaskType::Chat | RequestTaskType::Inference
        )
        && !looks_sectionable_prompt(&job.prompt);
    let needs_stronger_model = requirements.context_size == ContextSize::Large
        || requirements.task_type == RequestTaskType::Coding
        || looks_sectionable_prompt(&job.prompt)
        || job.graph_execution_enabled;

    if latency_sensitive_simple {
        return match tier {
            ModelTier::Tiny | ModelTier::Small => {
                (12, "lightweight model preferred for simple request")
            }
            ModelTier::Normal => (6, "normal model acceptable for simple request"),
            ModelTier::Strong => (-4, "strong model deprioritized for simple request"),
        };
    }

    if needs_stronger_model {
        return match tier {
            ModelTier::Strong => (14, "strong model preferred for long or code work"),
            ModelTier::Normal => (8, "normal model acceptable for long or code work"),
            ModelTier::Small => (-8, "small model deprioritized for long or code work"),
            ModelTier::Tiny => (-14, "tiny model avoided for long or code work"),
        };
    }

    match tier {
        ModelTier::Tiny | ModelTier::Small => (6, "lightweight model acceptable"),
        ModelTier::Normal => (8, "normal model preferred"),
        ModelTier::Strong => (2, "strong model available"),
    }
}

fn elapsed_ms_between(start: &str, end: &str) -> Option<u64> {
    let start = parse_unix_seconds(start)?;
    let end = parse_unix_seconds(end)?;
    Some(end.saturating_sub(start).saturating_mul(1_000))
}

fn graph_node_ready_at(job: &JobRecord, graph_node_id: &str) -> String {
    let Some(graph_node) = job.graph.nodes.iter().find(|node| node.id == graph_node_id) else {
        return job.submitted_at.clone();
    };
    if graph_node.attempt_count > 0 {
        if let Some(completed_at) = graph_node.completed_at.as_ref() {
            return completed_at.clone();
        }
    }
    if graph_node.depends_on.is_empty() {
        return job.graph.created_at.clone();
    }

    graph_node
        .depends_on
        .iter()
        .filter_map(|dependency_id| {
            job.graph
                .nodes
                .iter()
                .find(|node| node.id == *dependency_id)
                .and_then(|node| node.completed_at.as_deref())
        })
        .max_by_key(|completed_at| parse_unix_seconds(completed_at).unwrap_or_default())
        .unwrap_or(job.graph.created_at.as_str())
        .to_string()
}

fn estimate_tokens_from_chars(chars: usize) -> usize {
    chars.saturating_add(3) / 4
}

fn graph_node_lease_seconds() -> u64 {
    std::env::var(GRAPH_NODE_LEASE_SECONDS_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_GRAPH_NODE_LEASE_SECONDS)
}

fn minimum_graph_node_lease_seconds(task_type: RequestTaskType) -> u64 {
    match task_type {
        RequestTaskType::Coding => CODING_GRAPH_NODE_LEASE_SECONDS,
        _ => DEFAULT_GRAPH_NODE_LEASE_SECONDS,
    }
}

fn graph_node_lease_seconds_for(task_type: RequestTaskType) -> u64 {
    graph_node_lease_seconds().max(minimum_graph_node_lease_seconds(task_type))
}

fn queued_job_timeout_seconds() -> u64 {
    std::env::var(QUEUED_JOB_TIMEOUT_SECONDS_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_QUEUED_JOB_TIMEOUT_SECONDS)
}

fn critical_role_wait_seconds() -> u64 {
    std::env::var(CRITICAL_ROLE_WAIT_SECONDS_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CRITICAL_ROLE_WAIT_SECONDS)
}

fn node_heartbeat_stale_seconds() -> u64 {
    std::env::var(NODE_HEARTBEAT_STALE_SECONDS_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_NODE_HEARTBEAT_STALE_SECONDS)
}

fn update_node_trust(
    trust: &mut NodeTrustRecord,
    completion: &JobCompletion,
    completed_at: String,
) {
    match completion.status {
        JobStatus::Completed => {
            trust.completed_jobs = trust.completed_jobs.saturating_add(1);
            trust.accepted_results = trust.accepted_results.saturating_add(1);
            trust.consecutive_failures = 0;
            trust.last_success_at = Some(completed_at);
            trust.last_failure_reason = None;
        }
        JobStatus::Failed => {
            trust.failed_jobs = trust.failed_jobs.saturating_add(1);
            trust.rejected_results = trust.rejected_results.saturating_add(1);
            trust.consecutive_failures = trust.consecutive_failures.saturating_add(1);
            trust.last_failure_at = Some(completed_at);
            trust.last_failure_reason = completion.error.clone();
        }
        _ => {}
    }

    if let Some(latency_ms) = completion.latency_ms {
        trust.total_latency_ms = trust.total_latency_ms.saturating_add(latency_ms);
    }
    trust.score = calculate_node_trust_score(trust);
}

fn calculate_node_trust_score(trust: &NodeTrustRecord) -> u8 {
    let mut score: i32 = 50;
    score += (trust.completed_jobs.min(20) as i32) * 2;
    score -= (trust.failed_jobs.min(20) as i32) * 5;
    score -= (trust.consecutive_failures.min(10) as i32) * 4;
    score += (trust.accepted_results.min(20) as i32) * 2;
    score -= (trust.rejected_results.min(20) as i32) * 4;
    score.clamp(0, 100) as u8
}

fn looks_sectionable_prompt(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    contains_any(
        &lower,
        &[
            "history of",
            "explain",
            "comprehensive",
            "detailed",
            "report",
            "overview",
            "timeline",
            "compare",
            "research",
            "analyze",
        ],
    )
}

fn explicit_split_sections(prompt: &str) -> Vec<String> {
    let lower = prompt.to_ascii_lowercase();
    let Some(index) = lower.find("split by") else {
        return Vec::new();
    };
    let mut section_text = prompt[index + "split by".len()..]
        .split(['.', '?', '!', '\n'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    section_text = section_text.replace(" and ", ", ");
    section_text = section_text.replace(" then ", ", ");
    section_text
        .split([',', ';'])
        .filter_map(|part| {
            let cleaned = part
                .trim()
                .trim_matches(|ch: char| ch == '-' || ch == ':' || ch == '.')
                .trim();
            if cleaned.len() < 2 || cleaned.len() > 64 {
                return None;
            }
            if cleaned
                .chars()
                .all(|ch| ch.is_ascii_punctuation() || ch.is_ascii_whitespace())
            {
                return None;
            }
            Some(title_case_section(cleaned))
        })
        .take(8)
        .collect()
}

fn title_case_section(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            let lower = word.to_ascii_lowercase();
            match lower.as_str() {
                "ai" => "AI".to_string(),
                "api" => "API".to_string(),
                "ui" => "UI".to_string(),
                "ux" => "UX".to_string(),
                _ => {
                    let mut chars = lower.chars();
                    match chars.next() {
                        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                        None => String::new(),
                    }
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn section_job_id(section: &str, index: usize) -> String {
    let mut slug = section
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>();
    while slug.contains("__") {
        slug = slug.replace("__", "_");
    }
    slug = slug.trim_matches('_').to_string();
    if slug.is_empty() {
        slug = format!("section_{}", index + 1);
    }
    format!("job.{slug}")
}

fn looks_product_plan_prompt(lower_prompt: &str) -> bool {
    let matches = [
        "product description",
        "technical architecture",
        "launch plan",
        "go-to-market",
        "positioning",
        "pricing",
    ]
    .iter()
    .filter(|needle| lower_prompt.contains(**needle))
    .count();
    matches >= 2
}

fn looks_like_comparison_prompt(lower_prompt: &str) -> bool {
    contains_any(lower_prompt, &["compare", "versus", " vs "])
        && contains_any(
            lower_prompt,
            &[
                "architecture",
                "performance",
                "developer",
                "ecosystem",
                "cost",
                "risk",
                "recommendation",
            ],
        )
}

fn looks_like_deployment_procedure_prompt(lower_prompt: &str) -> bool {
    contains_any(lower_prompt, &["deploy", "deployment"])
        && (contains_any(
            lower_prompt,
            &["smart contract", "mainnet", "mainet", "production"],
        ) || contains_any(
            lower_prompt,
            &["step by step", "step-by-step", "detailed step", "how to"],
        ))
}

fn deployment_procedure_jobs() -> Vec<PlannedJob> {
    let mut jobs = Vec::new();
    push_planned_job(
        &mut jobs,
        "job.prerequisites",
        "Prerequisites and network setup",
        "section",
        Vec::new(),
        "List the required wallet, network, funds, tools, RPC access, explorer, source files, and environment configuration before deployment.",
        "Deployment must establish the target network and operator prerequisites first.",
    );
    push_planned_job(
        &mut jobs,
        "job.contract_readiness",
        "Contract readiness and security",
        "section",
        vec!["job.prerequisites".to_string()],
        "Explain compilation, constructor arguments, permissions, secret handling, audits, and final security checks required before deployment.",
        "Mainnet deployment should not proceed until the artifact and security configuration are ready.",
    );
    push_planned_job(
        &mut jobs,
        "job.testnet_validation",
        "Testnet deployment and validation",
        "section",
        vec!["job.contract_readiness".to_string()],
        "Provide the testnet deployment, interaction tests, gas estimate, failure checks, and release approval steps.",
        "A production procedure needs a rehearsal using the same artifact and parameters.",
    );
    push_planned_job(
        &mut jobs,
        "job.mainnet_deployment",
        "Mainnet deployment",
        "section",
        vec!["job.testnet_validation".to_string()],
        "Give the ordered mainnet deployment commands and checks, including signer confirmation, network verification, transaction monitoring, and address capture.",
        "The mainnet transaction follows successful testnet validation.",
    );
    push_planned_job(
        &mut jobs,
        "job.verification_operations",
        "Verification and operations",
        "section",
        vec!["job.mainnet_deployment".to_string()],
        "Cover source verification, ownership or role checks, monitoring, documentation, upgrade or emergency procedures, and safe handoff.",
        "Deployment is incomplete until the contract is verified and operational controls are confirmed.",
    );
    append_section_synthesis(&mut jobs);
    jobs
}

fn comparison_plan_jobs() -> Vec<PlannedJob> {
    let sections = [
        (
            "job.architecture",
            "Architecture",
            "Compare architecture and execution model. Return only the user-facing architecture section.",
        ),
        (
            "job.performance",
            "Performance",
            "Compare throughput, latency, scaling behavior, and practical performance tradeoffs. Return only the user-facing performance section.",
        ),
        (
            "job.developer_ecosystem",
            "Developer ecosystem",
            "Compare tooling, libraries, documentation, community, and developer adoption. Return only the user-facing developer ecosystem section.",
        ),
        (
            "job.costs",
            "Costs",
            "Compare transaction costs, operational costs, and cost predictability. Return only the user-facing costs section.",
        ),
        (
            "job.risks",
            "Risks",
            "Compare technical, governance, reliability, security, and ecosystem risks. Return only the user-facing risks section.",
        ),
        (
            "job.recommendation",
            "Recommendation",
            "Give a concise recommendation based on the comparison criteria and likely dApp use cases. Return only the user-facing recommendation section.",
        ),
    ];

    let mut jobs = Vec::new();
    for (id, name, required_output) in sections {
        push_planned_job(
            &mut jobs,
            id,
            name,
            "section",
            Vec::new(),
            required_output,
            "Comparison prompts should be split by evaluation criteria, not historical chronology.",
        );
    }
    jobs
}

fn append_section_synthesis(jobs: &mut Vec<PlannedJob>) {
    let dependencies = jobs.iter().map(|job| job.id.clone()).collect::<Vec<_>>();
    push_planned_job(
        jobs,
        "job.final_synthesis",
        "Final synthesis",
        "merge",
        dependencies,
        "Synthesize the completed sections into one accurate, coherent final answer. Preserve the requested section order, resolve repetition and contradictions, and use plain-text section titles without Markdown heading markers.",
        "The strongest compatible node performs final quality control across all section outputs.",
    );
}

fn looks_like_document_summary_prompt(lower_prompt: &str) -> bool {
    contains_any(
        lower_prompt,
        &[
            "summarize",
            "summary",
            "explain",
            "overview",
            "document",
            "documentation",
            "architecture",
            "how does",
            "what is",
        ],
    )
}

fn contains_ordered_implementation_work(lower_prompt: &str) -> bool {
    contains_any(
        lower_prompt,
        &[
            "implement",
            "build",
            "create",
            "code",
            "backend",
            "frontend",
            "api",
            "tests",
            "test",
            "regression",
            "security review",
            "migration",
            "refactor",
            "update docs",
            "update documentation",
        ],
    )
}

fn looks_like_complete_code_prompt(lower_prompt: &str) -> bool {
    contains_any(
        lower_prompt,
        &[
            "complete program",
            "complete source",
            "complete code",
            "full program",
            "full source",
            "entire program",
            "detailed program",
            "deatailed program",
            "working program",
            "turbo c program",
        ],
    ) || (contains_any(
        lower_prompt,
        &[
            "write a program",
            "create a program",
            "create me a program",
            "make a program",
            "make me a program",
            "need a program",
            "program in c",
            "program in java",
            "java program",
        ],
    ) && contains_any(
        lower_prompt,
        &[
            "c program",
            "program in c",
            "program in java",
            "java program",
            "turbo c",
            "source",
            "code",
            "binary file",
            "file handling",
        ],
    ))
}

fn next_ready_graph_node_id(graph: &JobGraph) -> Option<String> {
    graph
        .nodes
        .iter()
        .find(|node| node.status == JobGraphNodeStatus::Ready)
        .map(|node| node.id.clone())
}

fn next_ready_graph_node_id_for_node(graph: &JobGraph, node_id: &str) -> Option<String> {
    graph
        .nodes
        .iter()
        .find(|node| {
            node.status == JobGraphNodeStatus::Ready
                && !node.failed_node_ids.iter().any(|failed| failed == node_id)
                && node
                    .assigned_node_id
                    .as_deref()
                    .map_or(true, |assigned| assigned == node_id)
        })
        .map(|node| node.id.clone())
}

fn next_claimable_graph_node_id_for_node(
    graph: &JobGraph,
    node_id: &str,
    schedulable_node_ids: &[String],
) -> Option<String> {
    next_ready_graph_node_id_for_node(graph, node_id).or_else(|| {
        graph
            .nodes
            .iter()
            .find(|node| {
                node.status == JobGraphNodeStatus::Ready
                    && node.attempt_count > 0
                    && node.failed_node_ids.iter().any(|failed| failed == node_id)
                    && schedulable_node_ids.iter().all(|candidate| {
                        node.failed_node_ids
                            .iter()
                            .any(|failed| failed == candidate)
                    })
                    && node
                        .assigned_node_id
                        .as_deref()
                        .map_or(true, |assigned| assigned == node_id)
            })
            .map(|node| node.id.clone())
    })
}

fn graph_node_allows_degraded_capacity_retry(
    job: &JobRecord,
    active_graph_node_id: Option<&str>,
) -> bool {
    let Some(active_graph_node_id) = active_graph_node_id else {
        return false;
    };
    job.graph
        .nodes
        .iter()
        .find(|node| node.id == active_graph_node_id)
        .map(|_| {
            matches!(
                graph_node_required_role(&job.graph, Some(active_graph_node_id)),
                Some(NodeRole::ChunkAnalysis | NodeRole::Batch)
            )
        })
        .unwrap_or(false)
}

fn complete_graph_execution_job(
    job: &mut JobRecord,
    completion: JobCompletion,
    completed_at: String,
    compact_reducer_node: bool,
) -> JobRecord {
    let automatic_budget = !job_has_explicit_max_tokens(job);
    let compact_reviewed_code = job.plan.strategy == "compact_reviewed_code_delivery";
    let active_node_id = graph_node_assigned_to_node(&job.graph, &completion.node_id);
    let compact_final_reducer_fallback_output =
        if completion.status == JobStatus::Failed && compact_reducer_node {
            active_node_id.as_deref().and_then(|active_node_id| {
                if job.graph.final_node_id.as_deref() == Some(active_node_id) {
                    merge_completed_graph_outputs(&job.graph)
                } else {
                    None
                }
            })
        } else {
            None
        };
    if let Some(active_node_id) = active_node_id.as_deref() {
        if let Some(graph_node) = job
            .graph
            .nodes
            .iter_mut()
            .find(|node| node.id == active_node_id)
        {
            match completion.status {
                JobStatus::Completed => {
                    let unusable_section_output = graph_node.responsibility == "section"
                        && completion
                            .output
                            .as_deref()
                            .map(|output| clean_section_output(&graph_node.name, output).is_empty())
                            .unwrap_or(true);
                    let stage_hint = format!(
                        "{} {} {}",
                        graph_node.id, graph_node.name, graph_node.responsibility
                    )
                    .to_ascii_lowercase();
                    let is_final_synthesis = job.graph.final_node_id.as_deref()
                        == Some(active_node_id)
                        && (stage_hint.contains("synth")
                            || stage_hint.contains("merge")
                            || stage_hint.contains("final"));
                    let truncated_synthesis = automatic_budget
                        && is_final_synthesis
                        && completion
                            .output
                            .as_deref()
                            .zip(graph_node.effective_max_tokens)
                            .map(|(output, budget)| output_appears_token_limited(output, budget))
                            .unwrap_or(false)
                        && graph_node.attempt_count < graph_node.max_attempts;
                    let invalid_compact_implementation = compact_reviewed_code
                        .then(|| graph_node.id == "job.backend")
                        .filter(|is_backend| *is_backend)
                        .and_then(|_| {
                            compact_code_output_failure_reason(
                                completion.output.as_deref().unwrap_or_default(),
                                graph_node.effective_max_tokens.unwrap_or(2_048),
                            )
                        });
                    if let Some(reason) = invalid_compact_implementation {
                        if !graph_node
                            .failed_node_ids
                            .iter()
                            .any(|node_id| node_id == &completion.node_id)
                        {
                            graph_node.failed_node_ids.push(completion.node_id.clone());
                        }
                        graph_node.output = None;
                        if graph_node.attempt_count >= graph_node.max_attempts {
                            graph_node.status = JobGraphNodeStatus::Failed;
                            graph_node.error = Some(format!(
                                "implementation output failed structural validation after {} attempts: {}",
                                graph_node.attempt_count, reason
                            ));
                        } else {
                            let previous_budget = graph_node.effective_max_tokens.unwrap_or(2_048);
                            graph_node.recommended_max_tokens = Some(
                                previous_budget
                                    .saturating_mul(3)
                                    .saturating_div(2)
                                    .min(4_096),
                            );
                            graph_node.status = JobGraphNodeStatus::Ready;
                            graph_node.error = Some(format!(
                                "automatic retry: implementation output failed structural validation: {}",
                                reason
                            ));
                        }
                    } else if truncated_synthesis {
                        let previous_budget = graph_node.effective_max_tokens.unwrap_or(1_024);
                        graph_node.recommended_max_tokens =
                            Some(previous_budget.saturating_mul(2).min(8_192));
                        graph_node.status = JobGraphNodeStatus::Ready;
                        graph_node.output = None;
                        graph_node.error = Some(format!(
                            "automatic retry: synthesis output reached its {} token budget and appears incomplete",
                            previous_budget
                        ));
                    } else if unusable_section_output {
                        if !graph_node
                            .failed_node_ids
                            .iter()
                            .any(|node_id| node_id == &completion.node_id)
                        {
                            graph_node.failed_node_ids.push(completion.node_id.clone());
                        }
                        graph_node.output = None;
                        graph_node.error = Some(
                            "section output contained only prompt echo or boilerplate".to_string(),
                        );
                        graph_node.status = if graph_node.attempt_count >= graph_node.max_attempts {
                            JobGraphNodeStatus::Failed
                        } else {
                            JobGraphNodeStatus::Ready
                        };
                    } else {
                        graph_node.status = JobGraphNodeStatus::Completed;
                        graph_node.output = completion.output.clone();
                        graph_node.error = None;
                    }
                }
                JobStatus::Failed => {
                    let is_final_node = job.graph.final_node_id.as_deref() == Some(active_node_id);
                    if is_final_node {
                        if let Some(fallback_output) = compact_final_reducer_fallback_output.clone()
                        {
                            graph_node.status = JobGraphNodeStatus::Completed;
                            graph_node.output = Some(fallback_output);
                            graph_node.error = None;
                        } else {
                            graph_node.status = JobGraphNodeStatus::Failed;
                            graph_node.output = completion.output.clone();
                            graph_node.error = completion.error.clone();
                        }
                    } else {
                        let retry_needs_more_output_budget = automatic_budget
                            && completion
                                .error
                                .as_deref()
                                .map(|error| {
                                    let error = error.to_ascii_lowercase();
                                    error.contains("whole budget")
                                        || error.contains("token budget")
                                        || error.contains("returned no content")
                                })
                                .unwrap_or(false);
                        if !graph_node
                            .failed_node_ids
                            .iter()
                            .any(|node_id| node_id == &completion.node_id)
                        {
                            graph_node.failed_node_ids.push(completion.node_id.clone());
                        }

                        if graph_node.attempt_count >= graph_node.max_attempts {
                            graph_node.status = JobGraphNodeStatus::Failed;
                            graph_node.output = completion.output.clone();
                            graph_node.error = completion.error.clone();
                        } else {
                            if retry_needs_more_output_budget {
                                let previous_budget = graph_node
                                    .effective_max_tokens
                                    .or(graph_node.recommended_max_tokens)
                                    .unwrap_or(512);
                                graph_node.recommended_max_tokens =
                                    Some(previous_budget.saturating_mul(2).min(8_192));
                            }
                            graph_node.status = JobGraphNodeStatus::Ready;
                            graph_node.output = None;
                            graph_node.error = completion.error.clone();
                        }
                    }
                }
                _ => {}
            }
            graph_node.worker_id = Some(completion.worker_id.clone());
            graph_node.backend = Some(completion.backend);
            graph_node.completed_at = Some(completed_at.clone());
            graph_node.latency_ms = completion.latency_ms;
            graph_node.runtime_ms = completion.latency_ms;
            let output_chars = graph_node
                .output
                .as_ref()
                .map(|output| output.chars().count());
            graph_node.output_chars = output_chars;
            graph_node.estimated_output_tokens = output_chars.map(estimate_tokens_from_chars);
        }
    } else {
        return job.clone();
    }

    refresh_job_graph(&mut job.graph);
    refresh_graph_results(
        &mut job.graph,
        job.classification.output_format,
        Some(completion.worker_id.as_str()),
        Some(completion.node_id.as_str()),
        completion.latency_ms,
    );
    let completion_was_requeued = active_node_id
        .as_deref()
        .and_then(|node_id| job.graph.nodes.iter().find(|node| node.id == node_id))
        .map(|node| {
            node.status == JobGraphNodeStatus::Ready
                && node
                    .error
                    .as_deref()
                    .map(|error| error.starts_with("automatic retry:"))
                    .unwrap_or(false)
        })
        .unwrap_or(false);

    job.worker_id = Some(completion.worker_id);
    job.backend = Some(completion.backend);
    job.output = if completion_was_requeued {
        job.graph.final_output.clone()
    } else {
        completion.output
    };
    job.error = if job.graph.status == JobGraphStatus::Failed {
        completion.error.or_else(|| job.graph.merge_error.clone())
    } else {
        job.graph.merge_error.clone()
    };
    job.last_completed_graph_node_id = active_node_id.clone();

    if job.graph.status == JobGraphStatus::Completed {
        job.status = JobStatus::Completed;
        job.output = job
            .graph
            .final_output
            .clone()
            .or_else(|| job.output.clone());
        job.error = job.graph.merge_error.clone();
        job.completed_at = Some(completed_at.clone());
    } else if job.graph.status == JobGraphStatus::Failed {
        job.status = JobStatus::Failed;
        job.completed_at = Some(completed_at.clone());
    } else {
        job.status = if graph_has_running_nodes(&job.graph) {
            JobStatus::Assigned
        } else {
            JobStatus::Queued
        };
        if job.status == JobStatus::Queued {
            job.assigned_node_id = None;
            job.assigned_at = None;
            job.worker_id = None;
            job.backend = None;
        }
        job.completed_at = None;
    }
    if job.status == JobStatus::Assigned {
        if let Some(running_node) = job
            .graph
            .nodes
            .iter()
            .find(|node| node.status == JobGraphNodeStatus::Running)
        {
            job.active_graph_node_id = Some(running_node.id.clone());
            job.assigned_node_id = running_node.assigned_node_id.clone();
            job.assigned_at = running_node.assigned_at.clone();
            job.worker_id = running_node.worker_id.clone();
            job.backend = running_node.backend;
        }
    } else {
        job.active_graph_node_id = next_ready_graph_node_id(&job.graph);
    }

    job.graph.updated_at = completed_at;
    job.clone()
}

fn output_appears_token_limited(output: &str, effective_max_tokens: u32) -> bool {
    let trimmed = output.trim();
    if trimmed.is_empty() || effective_max_tokens < 64 {
        return false;
    }
    let estimated_tokens = estimate_tokens_from_chars(trimmed.chars().count()) as u32;
    let near_budget =
        estimated_tokens.saturating_mul(100) >= effective_max_tokens.saturating_mul(80);
    let structurally_complete =
        trimmed.ends_with(['.', '!', '?', ':', ';', '"', '\'', ')', ']', '}', '>', '`']);
    near_budget && !structurally_complete
}

fn compact_code_output_failure_reason(output: &str, effective_max_tokens: u32) -> Option<String> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Some("completed implementation did not include output".to_string());
    }

    let fence_count = trimmed
        .lines()
        .filter(|line| line.trim_start().starts_with("```"))
        .count();
    if fence_count == 0 {
        return Some("missing a fenced source file".to_string());
    }
    if fence_count % 2 != 0 {
        return Some("has an unmatched Markdown code fence".to_string());
    }
    if output_appears_token_limited(trimmed, effective_max_tokens) {
        return Some(format!(
            "reached its {} token budget and appears incomplete",
            effective_max_tokens
        ));
    }

    let mut declarations = std::collections::BTreeMap::<String, usize>::new();
    for line in trimmed.lines().map(str::trim) {
        let declaration = line.starts_with("function ")
            || line.starts_with("class ")
            || line.starts_with("public class ")
            || line.starts_with("def ")
            || line.starts_with("fn ");
        if declaration && line.len() >= 12 {
            *declarations.entry(line.to_string()).or_default() += 1;
        }
    }
    if declarations.values().any(|count| *count >= 3) {
        return Some("contains repeated source declarations".to_string());
    }

    None
}

fn graph_node_assigned_to_node(graph: &JobGraph, node_id: &str) -> Option<String> {
    graph
        .nodes
        .iter()
        .find(|node| {
            node.status == JobGraphNodeStatus::Running
                && node.assigned_node_id.as_deref() == Some(node_id)
        })
        .map(|node| node.id.clone())
}

fn graph_has_running_nodes(graph: &JobGraph) -> bool {
    graph
        .nodes
        .iter()
        .any(|node| node.status == JobGraphNodeStatus::Running)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TranslationRequest {
    target_language: &'static str,
    source_text: String,
}

fn direct_job_execution_prompt(job: &JobRecord) -> String {
    if let Some(translation) = parse_translation_request(&job.prompt) {
        return format!(
            "Translate the source text to {}.\nReturn only the translated text in {}.\nDo not add labels, explanations, alternatives, quotes, greetings, or the source text.\n\nSource text:\n{}",
            translation.target_language, translation.target_language, translation.source_text
        );
    }

    job.prompt.clone()
}

fn graph_node_execution_prompt(
    job: &JobRecord,
    active_node_id: &str,
    assigned_node: Option<&NodeRecord>,
) -> String {
    let Some(node) = job
        .graph
        .nodes
        .iter()
        .find(|node| node.id == active_node_id)
    else {
        return job.prompt.clone();
    };

    if graph_node_is_merge(&job.graph, Some(active_node_id)) {
        let completed_dependency_count = node
            .depends_on
            .iter()
            .filter(|dependency_id| {
                job.graph.results.iter().any(|result| {
                    result.node_id == **dependency_id
                        && result.status == JobGraphNodeStatus::Completed
                        && result.verification_status == JobResultVerificationStatus::Accepted
                })
            })
            .count()
            .max(1);
        let max_section_chars = assigned_node
            .map(|assigned_node| {
                reducer_section_char_limit(assigned_node).min(
                    reducer_total_input_char_budget(
                        assigned_node,
                        graph_node_max_tokens(job, active_node_id, Some(assigned_node)),
                    ) / completed_dependency_count,
                )
            })
            .unwrap_or(REDUCER_SECTION_CHARS_STANDARD);
        let sections = node
            .depends_on
            .iter()
            .filter_map(|dependency_id| {
                job.graph.results.iter().find(|result| {
                    result.node_id == *dependency_id
                        && result.status == JobGraphNodeStatus::Completed
                        && result.verification_status == JobResultVerificationStatus::Accepted
                })
            })
            .map(|result| {
                let artifact_refs = result
                    .artifacts
                    .iter()
                    .map(|artifact| {
                        format!(
                            "{}:{}:{}",
                            artifact.artifact_id,
                            artifact.path.as_deref().unwrap_or("inline"),
                            artifact.checksum_sha256
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "## {} [{}]\n{}",
                    result.name,
                    artifact_refs,
                    reducer_section_text_with_limit(
                        result.output.as_deref().unwrap_or_default(),
                        max_section_chars
                    )
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        if job.classification.task_type == RequestTaskType::Coding {
            return format!(
                "Original user request:\n{}\n\nCompleted section notes and accepted dependency artifacts, in required order:\n{}\n\nWrite one accurate, coherent final answer as a complete implementation result. Preserve every required accepted artifact and reconcile names and interfaces across work units. Return explanatory text only when needed, then return each file change as its own fenced unified diff block using workspace-relative a/path and b/path headers. Return shell commands only in separate fenced shell blocks. Never combine two target files into an unlabeled code block, never silently choose between conflicting edits, never truncate a file or patch, and never claim completion when a required artifact is missing. If two accepted artifacts conflict, state the conflict explicitly before the affected patch blocks.",
                job.prompt, sections
            );
        }

        return format!(
            "Original user request:\n{}\n\nCompleted section notes:\n{}\n\nWrite one accurate, coherent final answer. Preserve the requested section order and every relevant, nonduplicated fact or detail from the completed notes; do not shorten the answer into a highlights summary. Use plain-text section titles without # Markdown markers. Resolve contradictions in favor of well-established facts, remove only genuine duplication, ignore repeated instructions or boilerplate, omit uncertain claims, and finish every sentence. Return only the final answer.",
            job.prompt, sections
        );
    }

    if job.classification.task_type == RequestTaskType::Coding {
        let accepted_dependencies = node
            .depends_on
            .iter()
            .filter_map(|dependency_id| {
                job.graph.results.iter().find(|result| {
                    result.node_id == *dependency_id
                        && result.status == JobGraphNodeStatus::Completed
                        && result.verification_status == JobResultVerificationStatus::Accepted
                })
            })
            .collect::<Vec<_>>();
        let dependency_char_limit = assigned_node
            .map(|assigned_node| {
                reducer_total_input_char_budget(
                    assigned_node,
                    graph_node_max_tokens(job, active_node_id, Some(assigned_node)),
                ) / accepted_dependencies.len().max(1)
            })
            .unwrap_or(REDUCER_SECTION_CHARS_STANDARD);
        let dependency_context = accepted_dependencies
            .iter()
            .map(|result| {
                format!(
                    "## {}\n{}",
                    result.name,
                    reducer_section_text_with_limit(
                        result.output.as_deref().unwrap_or_default(),
                        dependency_char_limit,
                    )
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let dependency_block = if dependency_context.is_empty() {
            "No completed dependency output is required for this work unit.".to_string()
        } else {
            format!(
                "Accepted dependency output; use it as the source of truth:\n{}",
                dependency_context
            )
        };
        let retry_guidance = if node.attempt_count > 1 {
            "\n\nThis is a structural-validation retry. Start with a complete source file in a language-tagged Markdown fence and close every fence. Do not repeat declarations, functions, classes, paragraphs, or sections. Finish the source before adding concise documentation."
        } else {
            ""
        };
        return format!(
            "Original user request:\n{}\n\nYou are completing one code work unit for a larger answer.\nWork unit title: {}\nWork unit type: {}\nDeliverable: {}\n\n{}\n\nReturn only the deliverable for this work unit. Do not repeat these instructions, do not describe other work units, and do not continue the user's prompt. Keep names consistent with accepted dependency output. You may introduce private helper functions only when they are needed by this work unit; list any helper names you introduce.{}",
            job.prompt,
            node.name,
            node.responsibility,
            node.required_output,
            dependency_block,
            retry_guidance,
        );
    }

    let all_section_titles = job
        .graph
        .nodes
        .iter()
        .filter(|candidate| candidate.responsibility != "merge")
        .map(|candidate| candidate.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let other_section_titles = job
        .graph
        .nodes
        .iter()
        .filter(|candidate| candidate.id != node.id)
        .filter(|candidate| candidate.responsibility != "merge")
        .map(|candidate| candidate.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "Original user request:\n{}\n\nYou are completing exactly one section for a larger answer.\nAll requested section titles, in order: {}\nCurrent section title: {}\nSection type: {}\nSection goal: {}\n\nReturn only the user-facing body for the current section; the system adds the heading. Do not print or repeat any section heading. Do not repeat these instructions, describe the plan, or continue the user's prompt. Do not write content for these other sections: {}. Stop before the next section begins. Accuracy matters more than coverage: use only well-established facts you are confident are correct, never invent a person, date, event, or technical detail, and omit uncertain claims. Use complete sentences in plain prose or compact bullets.",
        job.prompt,
        all_section_titles,
        node.name,
        node.responsibility,
        node.required_output,
        other_section_titles
    )
}

fn job_uses_auto_max_tokens(job: &JobRecord) -> bool {
    job.max_tokens_source
        .as_deref()
        .map(|source| source.eq_ignore_ascii_case("auto"))
        .unwrap_or(false)
}

fn job_has_explicit_max_tokens(job: &JobRecord) -> bool {
    job.max_tokens_source
        .as_deref()
        .map(|source| source.eq_ignore_ascii_case("explicit"))
        .unwrap_or(false)
}

fn model_generation_ceiling(model_name: Option<&str>) -> u32 {
    let Some(model_name) = model_name.map(str::to_ascii_lowercase) else {
        return 4_096;
    };

    if model_name.contains("70b") || model_name.contains("72b") || model_name.contains("64b") {
        8_192
    } else if model_name.contains("32b") || model_name.contains("34b") {
        8_192
    } else if model_name.contains("14b") || model_name.contains("13b") || model_name.contains("12b")
    {
        6_144
    } else if model_name.contains("8b") || model_name.contains("7b") {
        4_096
    } else if model_name.contains("3b") {
        3_072
    } else if model_name.contains("1.5b")
        || model_name.contains("1_5b")
        || model_name.contains("0.5b")
        || model_name.contains("0_5b")
        || model_name.contains("135m")
    {
        2_048
    } else {
        4_096
    }
}

fn memory_generation_ceiling(available_memory_mb: u32) -> u32 {
    match available_memory_mb {
        48_000.. => 8_192,
        24_000.. => 6_144,
        16_000.. => 4_096,
        8_000.. => 3_072,
        _ => 2_048,
    }
}

fn node_generation_ceiling(node: Option<&NodeRecord>) -> u32 {
    let Some(node) = node else {
        return 4_096;
    };
    let model_ceiling = model_generation_ceiling(
        node.worker_health
            .as_ref()
            .and_then(|health| health.model_name.as_deref()),
    );
    let memory_ceiling = memory_generation_ceiling(node.available_memory_mb);
    let context_ceiling = node
        .worker_health
        .as_ref()
        .and_then(|health| health.capabilities.max_context_tokens)
        .map(|limit| limit.saturating_sub(512).max(1))
        .unwrap_or(u32::MAX);
    model_ceiling.min(memory_ceiling).min(context_ceiling)
}

fn scale_auto_generation_budget(baseline: u32, ceiling: u32) -> u32 {
    if baseline <= 16 {
        return baseline.max(1);
    }

    let target = match baseline {
        17..=512 => 1_024,
        513..=1_536 => 3_072,
        1_537..=2_048 => 4_096,
        _ => 8_192,
    };
    target.max(baseline).min(ceiling).max(1)
}

fn job_max_tokens_for_node(job: &JobRecord, claiming_node: &NodeRecord) -> u32 {
    let requested = job.max_tokens.unwrap_or_else(|| {
        match (
            job.classification.output_format,
            job.classification.complexity,
            job.classification.context_size,
        ) {
            (ExpectedOutputFormat::Code, _, _) => 2_048,
            (_, RequestComplexity::High, _) | (_, _, ContextSize::Large) => 1_536,
            (_, RequestComplexity::Medium, _) | (_, _, ContextSize::Medium) => 1_024,
            _ => 512,
        }
    });

    if job_uses_auto_max_tokens(job) {
        scale_auto_generation_budget(requested, node_generation_ceiling(Some(claiming_node)))
    } else {
        requested.max(1)
    }
}

fn graph_node_max_tokens(
    job: &JobRecord,
    active_node_id: &str,
    claiming_node: Option<&NodeRecord>,
) -> u32 {
    let requested = job.max_tokens.unwrap_or(0);
    let Some(node) = job
        .graph
        .nodes
        .iter()
        .find(|node| node.id == active_node_id)
    else {
        return requested.max(384);
    };

    let stage_hint =
        format!("{} {} {}", node.id, node.name, node.responsibility).to_ascii_lowercase();
    let is_synthesis = stage_hint.contains("synth")
        || stage_hint.contains("final answer")
        || stage_hint.contains("final merge");
    let is_reduction = !is_synthesis
        && (stage_hint.contains("reduc") || node.responsibility.eq_ignore_ascii_case("merge"));
    let dependency_tokens = node
        .depends_on
        .iter()
        .filter_map(|dependency_id| {
            job.graph
                .nodes
                .iter()
                .find(|candidate| candidate.id == *dependency_id)
        })
        .filter(|dependency| dependency.status == JobGraphNodeStatus::Completed)
        .map(|dependency| {
            dependency.estimated_output_tokens.unwrap_or_else(|| {
                dependency
                    .output
                    .as_deref()
                    .map(|output| estimate_tokens_from_chars(output.chars().count()))
                    .unwrap_or(0)
            }) as u32
        })
        .sum::<u32>();

    let strategy_budget = match job.plan.strategy.as_str() {
        "single_job" => requested.max(512),
        "sectioned_research" | "deployment_procedure" => {
            if is_synthesis {
                requested.max(2_048)
            } else if is_reduction {
                requested.max(1_536)
            } else if requested > 1_024 {
                768
            } else {
                384
            }
        }
        "complete_code_generation" => match node.id.as_str() {
            "job.code_contract" => 512,
            "job.code_types" => 768,
            "job.code_file_write" | "job.code_file_read" | "job.code_helpers" | "job.code_main" => {
                1_024
            }
            "job.final_merge" => 3_072,
            "job.compile_notes" => 384,
            _ => 768,
        },
        "code_with_explanation" => match node.id.as_str() {
            "job.complete_source" => 1_280,
            "job.code_explanation" => 512,
            _ => 768,
        },
        "compact_reviewed_code_delivery" => match node.id.as_str() {
            "job.backend" => match node.attempt_count {
                0 => 2_048,
                1 => 3_072,
                _ => 4_096,
            },
            "job.code_review" => 512,
            _ => 512,
        },
        _ => match node.responsibility.as_str() {
            "synthesize" => requested.max(2_048),
            "reduce" | "merge" => requested.max(1_024),
            "analysis" | "scope" => 256,
            "backend" | "frontend" | "implementation" => 768,
            "tests" | "documentation" | "security" | "validation" => 512,
            _ => 384,
        },
    };

    let volume_budget = if is_synthesis {
        requested
            .max(dependency_tokens.saturating_mul(3).saturating_div(2))
            .clamp(1_024, 4_096)
    } else if is_reduction {
        dependency_tokens
            .saturating_mul(2)
            .saturating_div(3)
            .clamp(768, 3_072)
    } else {
        0
    };
    let stage_budget = strategy_budget
        .max(node.recommended_max_tokens.unwrap_or(0))
        .max(node.minimum_max_tokens.unwrap_or(0))
        .max(volume_budget);
    let adaptive_critical_stage =
        (is_synthesis || is_reduction) && !job_has_explicit_max_tokens(job);

    let budget = if requested > 0 && !job_uses_auto_max_tokens(job) && !adaptive_critical_stage {
        requested
            .min(stage_budget)
            .max(node.minimum_max_tokens.unwrap_or(1).min(requested))
    } else if job_uses_auto_max_tokens(job) || adaptive_critical_stage {
        let baseline = requested.max(stage_budget);
        scale_auto_generation_budget(baseline, node_generation_ceiling(claiming_node))
    } else {
        stage_budget
    };
    let budget = if is_synthesis || is_reduction {
        let context_output_ceiling = claiming_node
            .and_then(|node| node.worker_health.as_ref())
            .and_then(|health| health.capabilities.max_context_tokens)
            .map(|limit| limit.saturating_div(2).max(1))
            .unwrap_or(u32::MAX);
        budget.min(context_output_ceiling)
    } else {
        budget
    };
    let budget = if job.plan.strategy == "compact_reviewed_code_delivery" {
        let stage_ceiling = match node.id.as_str() {
            "job.backend" => 2_048,
            "job.code_review" => 512,
            _ => 512,
        };
        budget.min(stage_ceiling)
    } else {
        budget
    };
    if job.plan.strategy == "dynamic_research"
        && node.responsibility == "chunk_analysis"
        && node.workload.context_budget_tokens <= 2_047
    {
        budget.min(512).max(1)
    } else {
        budget
    }
}

fn complete_compact_reducer_fallback(
    job: &mut JobRecord,
    node_id: &str,
    backend: Backend,
    completed_at: String,
) -> bool {
    let Some(final_node_id) = job.graph.final_node_id.clone() else {
        return false;
    };
    let Some(fallback_output) = merge_completed_graph_outputs(&job.graph) else {
        return false;
    };

    let Some(graph_node) = job
        .graph
        .nodes
        .iter_mut()
        .find(|node| node.id == final_node_id)
    else {
        return false;
    };

    graph_node.status = JobGraphNodeStatus::Completed;
    graph_node.blocked_by.clear();
    graph_node.assigned_node_id = Some(node_id.to_string());
    graph_node.assigned_at = Some(completed_at.clone());
    graph_node.worker_id = Some("control-plane-fallback".to_string());
    graph_node.backend = Some(backend);
    graph_node.output = Some(fallback_output);
    graph_node.error = None;
    graph_node.attempt_count = graph_node.attempt_count.saturating_add(1);

    refresh_job_graph(&mut job.graph);
    refresh_graph_results(
        &mut job.graph,
        job.classification.output_format,
        Some("control-plane-fallback"),
        Some(node_id),
        None,
    );

    job.status = JobStatus::Completed;
    job.assigned_node_id = Some(node_id.to_string());
    job.assigned_at = Some(completed_at.clone());
    job.worker_id = Some("control-plane-fallback".to_string());
    job.backend = Some(backend);
    job.output = job.graph.final_output.clone();
    job.error = job.graph.merge_error.clone();
    job.completed_at = Some(completed_at.clone());
    job.active_graph_node_id = None;
    job.last_completed_graph_node_id = Some(final_node_id);
    job.scheduler_decision = Some(SchedulerDecision {
        node_id: node_id.to_string(),
        score: 0,
        reasons: vec!["reducer: compact node triggered deterministic section fallback".to_string()],
    });
    job.graph.updated_at = completed_at;
    true
}

fn reducer_section_text_with_limit(output: &str, max_section_chars: usize) -> String {
    let cleaned = clean_worker_output(output);
    truncate_chars(cleaned.trim(), max_section_chars)
}

fn clean_worker_output(output: &str) -> String {
    let without_metadata = output
        .rsplit_once("response=")
        .map(|(_, response)| response)
        .unwrap_or(output);
    without_metadata
        .replace("[end of text]", "")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !is_reducer_boilerplate_line(line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn clean_section_output(section_name: &str, output: &str) -> String {
    let cleaned = clean_worker_output(output);
    let mut body = cleaned.trim();

    loop {
        let had_markdown_heading = body.starts_with('#');
        let candidate = body.trim_start_matches('#').trim_start();
        let Some(remainder) = strip_ascii_case_prefix(candidate, section_name) else {
            break;
        };
        let trimmed_remainder = remainder.trim_start();
        let has_title_separator = trimmed_remainder.starts_with(':')
            || trimmed_remainder.starts_with('-')
            || remainder.starts_with('\n');
        let repeats_title = strip_ascii_case_prefix(trimmed_remainder, section_name).is_some();
        if !had_markdown_heading && !has_title_separator && !repeats_title {
            break;
        }
        body = remainder
            .trim_start_matches(|character: char| character == ':' || character == '-')
            .trim_start();
    }

    if let Some(next_heading) = body.find("\n## ") {
        body = body[..next_heading].trim_end();
    }

    body.trim().to_string()
}

fn strip_ascii_case_prefix<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let candidate = value.get(..prefix.len())?;
    if candidate.eq_ignore_ascii_case(prefix) {
        value.get(prefix.len()..)
    } else {
        None
    }
}

fn clean_direct_job_output(job: &JobRecord, output: Option<String>) -> Option<String> {
    let output = output?;
    let Some(translation) = parse_translation_request(&job.prompt) else {
        return Some(output);
    };
    let trimmed = output.trim();
    let lower = trimmed.to_ascii_lowercase();
    let target_prefix = format!("{}:", translation.target_language.to_ascii_lowercase());
    if lower.starts_with(&target_prefix) {
        return Some(trimmed[target_prefix.len()..].trim().to_string());
    }
    Some(trimmed.to_string())
}

fn is_reducer_boilerplate_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.starts_with("calling `python -m mlx_lm")
        || lower.starts_with("avoid jargon and technical language")
        || lower.starts_with("provide the most relevant, specific information")
        || lower.starts_with("provide a clear, concise, and direct answer")
        || lower.starts_with("the answer should be short")
        || lower.starts_with("the answer should be specific")
        || lower.starts_with("the answer should be concise")
        || lower.starts_with("the answer should be clear")
        || lower.starts_with("expand on the major ")
        || lower.starts_with("include details such as ")
        || lower.starts_with("include information about ")
        || lower.starts_with("provide a comprehensive overview ")
        || lower.starts_with("use a clear and concise language")
        || lower.starts_with("do not ")
        || lower.starts_with("don't ")
        || lower.starts_with("not return ")
        || lower.starts_with("return \"output")
        || lower.starts_with("return only ")
        || lower.starts_with("you are executing ")
        || lower.starts_with("original user request:")
        || lower.starts_with("mundusx subjob:")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{}...", truncated.trim_end())
    } else {
        truncated
    }
}

fn graph_node_is_merge(graph: &JobGraph, graph_node_id: Option<&str>) -> bool {
    let Some(graph_node_id) = graph_node_id else {
        return false;
    };
    graph.nodes.iter().any(|node| {
        if node.id != graph_node_id {
            return false;
        }
        let hint =
            format!("{} {} {}", node.id, node.name, node.responsibility).to_ascii_lowercase();
        contains_any(&hint, &["merge", "reduce", "synth"])
            || graph.final_node_id.as_deref() == Some(graph_node_id)
    })
}

pub(crate) fn graph_node_required_role(
    graph: &JobGraph,
    graph_node_id: Option<&str>,
) -> Option<NodeRole> {
    let graph_node_id = graph_node_id?;
    let node = graph.nodes.iter().find(|node| node.id == graph_node_id)?;
    let id = node.id.to_ascii_lowercase();
    let name = node.name.to_ascii_lowercase();
    let responsibility = node.responsibility.to_ascii_lowercase();

    if responsibility.contains("synth")
        || id.contains("synth")
        || name.contains("synth")
        || graph.final_node_id.as_deref() == Some(graph_node_id)
        || responsibility == "merge"
    {
        Some(NodeRole::Synthesizer)
    } else if responsibility.contains("reduc") || id.contains("reduc") || name.contains("reduc") {
        Some(NodeRole::Reducer)
    } else if responsibility.contains("chunk")
        || id.contains("chunk")
        || name.contains("chunk")
        || responsibility == "section"
    {
        Some(NodeRole::ChunkAnalysis)
    } else {
        None
    }
}

fn best_reducer_node_id_for_job(state: &ControlPlaneState, job: &JobRecord) -> Option<String> {
    let active_merge_node_id = next_ready_graph_node_id(&job.graph)
        .filter(|node_id| graph_node_is_merge(&job.graph, Some(node_id.as_str())))?;
    let ready_m_exists = state.nodes.values().any(|candidate| {
        ControlPlaneState::node_is_schedulable_state(candidate)
            && candidate.policy_allowed
            && candidate.backend == Backend::M
    });
    let ready_cuda_exists = state.nodes.values().any(|candidate| {
        ControlPlaneState::node_is_schedulable_state(candidate)
            && candidate.policy_allowed
            && candidate.backend == Backend::Cuda
    });
    let ready_vllm_exists = state.nodes.values().any(|candidate| {
        ControlPlaneState::node_is_schedulable_state(candidate)
            && candidate.policy_allowed
            && candidate.backend == Backend::Vllm
    });

    state
        .nodes
        .values()
        .filter(|candidate| {
            state.node_has_available_slot_for_job(candidate, job)
                && ControlPlaneState::node_backend_matches(
                    job,
                    candidate.backend,
                    ready_m_exists,
                    ready_cuda_exists,
                    ready_vllm_exists,
                )
                && ControlPlaneState::node_can_run_job(candidate, job)
                && ControlPlaneState::node_can_run_graph_role(
                    candidate,
                    job,
                    Some(active_merge_node_id.as_str()),
                )
        })
        .map(|candidate| {
            let mut decision =
                state.scheduler_score(candidate, job, Some(active_merge_node_id.as_str()));
            apply_reducer_scheduler_score(&mut decision, candidate);
            let profile_rank = match reducer_profile(candidate) {
                ReducerProfile::Strong => 3,
                ReducerProfile::Standard => 2,
                ReducerProfile::Compact => 1,
            };
            (
                profile_rank,
                node_generation_ceiling(Some(candidate)),
                candidate.available_memory_mb,
                decision,
            )
        })
        .max_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.cmp(&right.1))
                .then_with(|| left.2.cmp(&right.2))
                .then_with(|| left.3.score.cmp(&right.3.score))
                .then_with(|| right.3.node_id.cmp(&left.3.node_id))
        })
        .map(|(_, _, _, decision)| decision.node_id)
}

fn apply_reducer_scheduler_score(decision: &mut SchedulerDecision, node: &NodeRecord) {
    match reducer_profile(node) {
        ReducerProfile::Strong => {
            decision.score += 35;
            decision
                .reasons
                .push("reducer: strong node selected for final synthesis".to_string());
        }
        ReducerProfile::Standard => {
            decision.score += 8;
            decision
                .reasons
                .push("reducer: standard node can attempt compact synthesis".to_string());
        }
        ReducerProfile::Compact => {
            decision.score -= 10;
            decision.reasons.push(
                "reducer: compact fallback because no strong reducer is available".to_string(),
            );
        }
    }
}

fn reducer_section_char_limit(node: &NodeRecord) -> usize {
    match reducer_profile(node) {
        ReducerProfile::Strong => REDUCER_SECTION_CHARS_STRONG,
        ReducerProfile::Standard => REDUCER_SECTION_CHARS_STANDARD,
        ReducerProfile::Compact => REDUCER_SECTION_CHARS_COMPACT,
    }
}

fn reducer_total_input_char_budget(node: &NodeRecord, output_tokens: u32) -> usize {
    const SYNTHESIS_INSTRUCTION_RESERVE_TOKENS: u32 = 768;
    const APPROX_CHARS_PER_TOKEN: u32 = 3;
    node.worker_health
        .as_ref()
        .and_then(|health| health.capabilities.max_context_tokens)
        .map(|context_tokens| {
            context_tokens
                .saturating_sub(output_tokens)
                .saturating_sub(SYNTHESIS_INSTRUCTION_RESERVE_TOKENS)
                .saturating_mul(APPROX_CHARS_PER_TOKEN) as usize
        })
        .unwrap_or(REDUCER_SECTION_CHARS_STANDARD * 4)
        .max(256)
}

fn reducer_profile(node: &NodeRecord) -> ReducerProfile {
    let Some(worker_health) = node.worker_health.as_ref() else {
        return ReducerProfile::Compact;
    };
    if !worker_health.runtime_ready || !worker_health.healthy {
        return ReducerProfile::Compact;
    }

    if node.backend == Backend::M
        && (worker_health.blas_device_available
            || worker_health.runtime_mode.eq_ignore_ascii_case("mlx"))
    {
        return ReducerProfile::Strong;
    }

    if worker_health
        .notes
        .iter()
        .any(|note| note.to_ascii_lowercase().contains("low-vram"))
        || worker_health
            .cuda_device_name
            .as_deref()
            .map(is_low_vram_cuda_device_name)
            .unwrap_or(false)
    {
        return ReducerProfile::Compact;
    }

    if node.backend == Backend::Cuda
        && worker_health.cuda_driver_available
        && worker_health.cuda_device_available
        && node.available_gpu_percent >= 30
    {
        return ReducerProfile::Strong;
    }

    ReducerProfile::Standard
}

fn is_low_vram_cuda_device_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["gtx 1050", "gtx 1060", "gtx 1650", "gtx 1660"]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn normalize_amount(value: f64) -> f64 {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded.abs() < 0.005 {
        0.0
    } else {
        rounded
    }
}

fn normalize_tool_name(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn tool_reward_base_amount(tool: &str) -> f64 {
    match tool {
        "weather" => 0.05,
        "assistant_identity" => 0.02,
        "linear_equation"
        | "polynomial_derivative"
        | "polynomial_integral"
        | "polynomial_subtraction"
        | "rate_distance" => 0.03,
        "mundusx_knowledge" | "factual_summary" | "current_office_holder" => 0.10,
        "web_search" => 0.15,
        "compound_tools" => 0.05,
        _ => 0.05,
    }
}

fn tool_reward_work_type(tool: &str) -> &'static str {
    match tool {
        "weather" => "tool_weather",
        "assistant_identity" => "tool_identity",
        "linear_equation"
        | "polynomial_derivative"
        | "polynomial_integral"
        | "polynomial_subtraction"
        | "rate_distance" => "tool_math",
        "mundusx_knowledge" | "factual_summary" | "current_office_holder" => "tool_facts",
        "web_search" => "tool_web_search",
        "compound_tools" => "tool_compound",
        _ => "tool_generic",
    }
}

pub fn classify_job_request(request: &JobRequest) -> RequestClassification {
    let lower = request.prompt.to_ascii_lowercase();
    let prompt_chars = request.prompt.chars().count();
    let complete_code_prompt = looks_like_complete_code_prompt(&lower);

    let task_type = if complete_code_prompt
        || contains_any(
            &lower,
            &[
                "code",
                "bug",
                "test",
                "rust",
                "javascript",
                "typescript",
                "python",
                "turbo c",
                "#include",
                "struct",
                "function",
                "api",
                "stack trace",
                "compile",
            ],
        ) {
        RequestTaskType::Coding
    } else if contains_any(
        &lower,
        &[
            "document",
            "draft",
            "memo",
            "report",
            "proposal",
            "contract",
            "article",
            "summarize",
            "markdown",
        ],
    ) {
        RequestTaskType::Document
    } else if request.runtime_mode == RuntimeMode::Interactive
        || contains_any(&lower, &["chat", "conversation", "assistant", "reply"])
    {
        RequestTaskType::Chat
    } else {
        RequestTaskType::Inference
    };

    let complexity = if prompt_chars > 4_000
        || complete_code_prompt
        || contains_any(
            &lower,
            &[
                "architecture",
                "multi-step",
                "end-to-end",
                "refactor",
                "security review",
                "migration",
            ],
        ) {
        RequestComplexity::High
    } else if prompt_chars > 800
        || contains_any(
            &lower,
            &["analyze", "compare", "implement", "plan", "debug", "design"],
        )
    {
        RequestComplexity::Medium
    } else {
        RequestComplexity::Low
    };

    let privacy_level = if contains_any(
        &lower,
        &[
            "secret",
            "token",
            "password",
            "private key",
            "credential",
            "ssn",
            "passport",
            "payment",
            "medical",
        ],
    ) {
        PrivacyLevel::Sensitive
    } else if contains_any(
        &lower,
        &[
            "internal",
            "customer",
            "confidential",
            "proprietary",
            "company",
            "roadmap",
        ],
    ) {
        PrivacyLevel::Internal
    } else {
        PrivacyLevel::Public
    };

    let output_format =
        if contains_any(&lower, &["json", "schema", "object"]) && !complete_code_prompt {
            ExpectedOutputFormat::Json
        } else if task_type == RequestTaskType::Coding
            || contains_any(&lower, &["code block", "patch", "diff"])
        {
            ExpectedOutputFormat::Code
        } else if contains_any(
            &lower,
            &[
                "markdown",
                "table",
                "bullets",
                "checklist",
                "report",
                "memo",
            ],
        ) {
            ExpectedOutputFormat::Markdown
        } else {
            ExpectedOutputFormat::Text
        };

    let context_size = if prompt_chars > 4_000 || request.max_tokens.unwrap_or_default() > 4_096 {
        ContextSize::Large
    } else if prompt_chars > 800
        || complete_code_prompt
        || request.max_tokens.unwrap_or_default() > 1_024
    {
        ContextSize::Medium
    } else {
        ContextSize::Small
    };

    let mut execution_constraints = vec![
        format!("backend:{}", request.preferred_backend),
        format!("runtime:{}", request.runtime_mode),
    ];
    if request.stream {
        execution_constraints.push("requires_streaming".to_string());
    }
    if matches!(privacy_level, PrivacyLevel::Sensitive) {
        execution_constraints.push("sensitive_data".to_string());
    }
    if matches!(complexity, RequestComplexity::High) {
        execution_constraints.push("planner_recommended".to_string());
    }
    if complete_code_prompt {
        execution_constraints.push("complete_code_output".to_string());
    }

    RequestClassification {
        task_type,
        complexity,
        privacy_level,
        output_format,
        context_size,
        execution_constraints,
        reason: format!(
            "deterministic classifier matched {} task with {:?} complexity and {:?} context",
            task_type.as_str(),
            complexity,
            context_size
        ),
    }
}

pub fn plan_job_request(request: &JobRequest, classification: &RequestClassification) -> JobPlan {
    let lower = request.prompt.to_ascii_lowercase();

    let decomposition_needed = classification.complexity == RequestComplexity::High
        || (classification.task_type == RequestTaskType::Coding
            && looks_like_complete_code_prompt(&lower))
        || looks_product_plan_prompt(&lower)
        || looks_sectionable_prompt(&request.prompt)
        || contains_any(
            &lower,
            &[
                "frontend",
                "backend",
                "tests",
                "security",
                "documentation",
                "docs",
                "review",
            ],
        );

    if !decomposition_needed {
        return JobPlan {
            plan_id: format!("plan-{}", request.request_id),
            strategy: "single_job".to_string(),
            summary: "Single execution unit is sufficient for this request.".to_string(),
            jobs: vec![PlannedJob {
                id: "job.direct_response".to_string(),
                name: "Direct response".to_string(),
                responsibility: classification.task_type.as_str().to_string(),
                depends_on: Vec::new(),
                required_output: format!(
                    "Produce the requested {:?} output for the submitted prompt.",
                    classification.output_format
                ),
                reason:
                    "Request is low or medium complexity without separate responsibility areas."
                        .to_string(),
                recommended_max_tokens: None,
                minimum_max_tokens: None,
                workload: StepWorkloadRequirements::default(),
            }],
        };
    }

    if looks_like_deployment_procedure_prompt(&lower) {
        let jobs = deployment_procedure_jobs();
        return JobPlan {
            plan_id: format!("plan-{}", request.request_id),
            strategy: "deployment_procedure".to_string(),
            summary: "Planned an ordered deployment procedure followed by strongest-node final synthesis."
                .to_string(),
            jobs,
        };
    }

    if looks_product_plan_prompt(&lower) && classification.task_type != RequestTaskType::Coding {
        let mut jobs = Vec::new();
        push_planned_job(
            &mut jobs,
            "job.product_description",
            "Product description",
            "section",
            Vec::new(),
            "Write the user-facing product description, audience, value proposition, and key capabilities.",
            "Product planning prompts should return the product section directly.",
        );
        push_planned_job(
            &mut jobs,
            "job.technical_architecture",
            "Technical architecture",
            "section",
            Vec::new(),
            "Describe the system architecture, main components, data flow, integrations, and operational assumptions.",
            "Architecture can be drafted independently as a user-facing section.",
        );
        push_planned_job(
            &mut jobs,
            "job.launch_plan",
            "Launch plan",
            "section",
            Vec::new(),
            "Create the launch plan with phases, target users, readiness checks, rollout steps, and success metrics.",
            "Launch planning is a separate deliverable section and does not require a reducer by default.",
        );

        return JobPlan {
            plan_id: format!("plan-{}", request.request_id),
            strategy: "sectioned_product_plan".to_string(),
            summary: format!(
                "Planned {} product-plan sections. Sections are returned directly; final synthesis is optional.",
                jobs.len()
            ),
            jobs,
        };
    }

    if looks_like_comparison_prompt(&lower) && classification.task_type != RequestTaskType::Coding {
        let jobs = comparison_plan_jobs();
        return JobPlan {
            plan_id: format!("plan-{}", request.request_id),
            strategy: "sectioned_comparison".to_string(),
            summary: format!(
                "Planned {} comparison sections. Sections are returned directly; final synthesis is optional.",
                jobs.len()
            ),
            jobs,
        };
    }

    if looks_sectionable_prompt(&request.prompt)
        && classification.task_type != RequestTaskType::Coding
    {
        let mut jobs = Vec::new();
        let requested_sections = explicit_split_sections(&request.prompt);
        if requested_sections.len() >= 2 {
            for (index, section) in requested_sections.iter().enumerate() {
                push_planned_job(
                    &mut jobs,
                    &section_job_id(section, index),
                    section,
                    "section",
                    Vec::new(),
                    &format!(
                        "Write only the {section} section requested by the user. Do not include any other requested section."
                    ),
                    "The user explicitly requested this split section.",
                );
            }
            append_section_synthesis(&mut jobs);

            return JobPlan {
                plan_id: format!("plan-{}", request.request_id),
                strategy: "sectioned_research".to_string(),
                summary: format!(
                    "Planned {} user-requested sections followed by strongest-node final synthesis.",
                    jobs.len().saturating_sub(1)
                ),
                jobs,
            };
        }

        push_planned_job(
            &mut jobs,
            "job.origins",
            "Origins and founders",
            "section",
            Vec::new(),
            "Explain the origins, founders, and historical setup for the requested topic.",
            "Sectionable research prompts benefit from parallel source-area drafting.",
        );
        push_planned_job(
            &mut jobs,
            "job.early_development",
            "Early development",
            "section",
            Vec::new(),
            "Cover the early brand, product, or organizational development.",
            "The planner separated early chronology from later expansion.",
        );
        push_planned_job(
            &mut jobs,
            "job.expansion",
            "Expansion and milestones",
            "section",
            Vec::new(),
            "Cover major growth periods, milestones, and changes in scale or influence.",
            "Milestones can be drafted independently as a user-facing section.",
        );
        push_planned_job(
            &mut jobs,
            "job.modern_era",
            "Modern era",
            "section",
            Vec::new(),
            "Cover recent developments, current positioning, and future-facing themes.",
            "Modern context should be isolated from historical background as a user-facing section.",
        );
        append_section_synthesis(&mut jobs);

        return JobPlan {
            plan_id: format!("plan-{}", request.request_id),
            strategy: "sectioned_research".to_string(),
            summary: format!(
                "Planned {} sectioned research units followed by strongest-node final synthesis.",
                jobs.len().saturating_sub(1)
            ),
            jobs,
        };
    }

    if classification.task_type == RequestTaskType::Coding
        && classification.complexity != RequestComplexity::High
        && contains_any(
            &lower,
            &["code review", "review the code", "review my code"],
        )
        && contains_any(
            &lower,
            &[
                "documentation",
                "docs",
                "readme",
                "markdown",
                "md documentation",
            ],
        )
    {
        let jobs = compact_reviewed_code_plan_jobs();
        return JobPlan {
            plan_id: format!("plan-{}", request.request_id),
            strategy: "compact_reviewed_code_delivery".to_string(),
            summary: "Planned one coherent implementation with matching documentation, followed by an independent review; accepted outputs are assembled deterministically without a reducer call.".to_string(),
            jobs,
        };
    }

    if classification.task_type == RequestTaskType::Coding
        && looks_like_complete_code_prompt(&lower)
    {
        if looks_like_code_explanation_prompt(&lower) && looks_like_small_code_prompt(&lower) {
            let jobs = code_with_explanation_plan_jobs();
            return JobPlan {
                plan_id: format!("plan-{}", request.request_id),
                strategy: "code_with_explanation".to_string(),
                summary: "Planned complete source code first, followed by a concise explanation."
                    .to_string(),
                jobs,
            };
        }

        let jobs = complete_code_plan_jobs();
        return JobPlan {
            plan_id: format!("plan-{}", request.request_id),
            strategy: "complete_code_generation".to_string(),
            summary: "Planned a complete code deliverable with outline, implementation, validation notes, and final assembly.".to_string(),
            jobs,
        };
    }

    if classification.task_type == RequestTaskType::Document
        && looks_like_document_summary_prompt(&lower)
        && !contains_ordered_implementation_work(&lower)
    {
        return JobPlan {
            plan_id: format!("plan-{}", request.request_id),
            strategy: "documentation_summary".to_string(),
            summary: "Single documentation summary selected; no implementation or test dependencies are required.".to_string(),
            jobs: vec![PlannedJob {
                id: "job.documentation_summary".to_string(),
                name: "Documentation summary".to_string(),
                responsibility: "documentation".to_string(),
                depends_on: Vec::new(),
                required_output:
                    "Summarize the requested documentation or architecture topic directly for the user."
                        .to_string(),
                reason: "Documentation summary prompts do not need scope, implementation, test, or reducer dependencies."
                    .to_string(),
                recommended_max_tokens: None,
                minimum_max_tokens: None,
            workload: StepWorkloadRequirements::default(),
            }],
        };
    }

    let mut jobs = Vec::new();
    push_planned_job(
        &mut jobs,
        "job.scope",
        "Scope and constraints",
        "analysis",
        Vec::new(),
        "Identify request boundaries, constraints, and deliverable shape.",
        "Every decomposed request needs a shared scope before specialized work starts.",
    );

    if classification.task_type == RequestTaskType::Coding
        || contains_any(&lower, &["backend", "api", "rust"])
    {
        push_planned_job(
            &mut jobs,
            "job.backend",
            "Backend implementation",
            "backend",
            vec!["job.scope".to_string()],
            "Implement backend or API changes needed by the request.",
            "The classifier detected coding/backend responsibility.",
        );
    }

    if contains_any(&lower, &["frontend", "dashboard", "ui", "client"]) {
        push_planned_job(
            &mut jobs,
            "job.frontend",
            "Frontend implementation",
            "frontend",
            vec!["job.scope".to_string()],
            "Implement user-facing or dashboard changes needed by the request.",
            "The prompt references frontend or operator-facing UI work.",
        );
    }

    if contains_any(&lower, &["security", "privacy", "policy", "permission"]) {
        push_planned_job(
            &mut jobs,
            "job.security_review",
            "Security review",
            "security",
            vec!["job.scope".to_string()],
            "Review privacy, policy, and permission risks before final synthesis.",
            "The request carries security or privacy-sensitive constraints.",
        );
    }

    if contains_any(
        &lower,
        &["code review", "review the code", "review my code"],
    ) {
        let implementation_dependencies = jobs
            .iter()
            .filter(|job| job.responsibility == "backend" || job.responsibility == "frontend")
            .map(|job| job.id.clone())
            .collect::<Vec<_>>();
        push_planned_job(
            &mut jobs,
            "job.code_review",
            "Code review",
            "validation",
            if implementation_dependencies.is_empty() {
                vec!["job.scope".to_string()]
            } else {
                implementation_dependencies
            },
            "Review the completed implementation for correctness, contract coverage, maintainability, and concrete defects. Do not rewrite unrelated code.",
            "Code review is a validation responsibility and must wait for implementation output.",
        );
    }

    if classification.task_type == RequestTaskType::Document
        || contains_any(&lower, &["docs", "documentation", "readme"])
    {
        push_planned_job(
            &mut jobs,
            "job.documentation",
            "Documentation",
            "documentation",
            vec!["job.scope".to_string()],
            "Update operator or user documentation for the planned change.",
            "The request includes documentation responsibility.",
        );
    }

    if classification.task_type == RequestTaskType::Coding
        || contains_any(&lower, &["test", "tests", "coverage"])
    {
        let implementation_dependencies = jobs
            .iter()
            .filter(|job| job.responsibility == "backend" || job.responsibility == "frontend")
            .map(|job| job.id.clone())
            .collect::<Vec<_>>();
        push_planned_job(
            &mut jobs,
            "job.tests",
            "Regression tests",
            "tests",
            if implementation_dependencies.is_empty() {
                vec!["job.scope".to_string()]
            } else {
                implementation_dependencies
            },
            "Cover the planned behavior with focused regression checks.",
            "Responsibility-based plans keep validation separate from implementation.",
        );
    }

    let final_dependencies = jobs
        .iter()
        .map(|job| job.id.clone())
        .filter(|id| *id != "job.final_merge")
        .collect::<Vec<_>>();
    push_planned_job(
        &mut jobs,
        "job.final_merge",
        "Final synthesis",
        "merge",
        final_dependencies,
        "Merge partial outputs into one coherent final response or implementation result.",
        "Multi-job work needs one final responsibility to combine partial outputs.",
    );

    JobPlan {
        plan_id: format!("plan-{}", request.request_id),
        strategy: "responsibility_based".to_string(),
        summary: format!(
            "Planned {} responsibility-based execution units from a {:?} {:?} request.",
            jobs.len(),
            classification.complexity,
            classification.task_type
        ),
        jobs,
    }
}

fn single_execution_plan(
    request: &JobRequest,
    classification: &RequestClassification,
    summary: &str,
    reason: &str,
) -> JobPlan {
    JobPlan {
        plan_id: format!("plan-{}", request.request_id),
        strategy: "single_job".to_string(),
        summary: summary.to_string(),
        jobs: vec![PlannedJob {
            id: "job.direct_response".to_string(),
            name: "Direct response".to_string(),
            responsibility: classification.task_type.as_str().to_string(),
            depends_on: Vec::new(),
            required_output: format!(
                "Produce the requested {:?} output for the submitted prompt.",
                classification.output_format
            ),
            reason: reason.to_string(),
            recommended_max_tokens: None,
            minimum_max_tokens: None,
            workload: StepWorkloadRequirements::default(),
        }],
    }
}

fn plan_job_request_for_submission(
    request: &JobRequest,
    classification: &RequestClassification,
    compatible_ready_nodes: usize,
) -> JobPlan {
    if request.execution_mode == JobExecutionMode::Auto
        && looks_sectionable_prompt(&request.prompt)
        && !looks_like_deployment_procedure_prompt(&request.prompt.to_ascii_lowercase())
        && classification.task_type != RequestTaskType::Coding
        && compatible_ready_nodes < 2
        && !sectionable_prompt_warrants_single_node_decomposition(request, classification)
    {
        return JobPlan {
            plan_id: format!("plan-{}", request.request_id),
            strategy: "single_job_latency_optimized".to_string(),
            summary: format!(
                "Single execution selected for latency: {compatible_ready_nodes} compatible node slot(s); sectioned research is reserved for multi-node fan-out, explicit decomposition, or larger context."
            ),
            jobs: vec![PlannedJob {
                id: "job.direct_response".to_string(),
                name: "Direct response".to_string(),
                responsibility: classification.task_type.as_str().to_string(),
                depends_on: Vec::new(),
                required_output: format!(
                    "Produce the requested {:?} output for the submitted prompt.",
                    classification.output_format
                ),
                reason:
                    "Auto mode avoided sectioned decomposition because it would run sequentially on the current available node slot set."
                        .to_string(),
                recommended_max_tokens: None,
                minimum_max_tokens: None,
            workload: StepWorkloadRequirements::default(),
            }],
        };
    }

    let mut plan = plan_job_request(request, classification);
    if request.execution_mode == JobExecutionMode::Auto
        && plan.strategy == "sectioned_research"
        && compatible_ready_nodes >= 2
    {
        plan.summary = format!(
            "{} Auto decomposition enabled because {compatible_ready_nodes} compatible node slots can fan out independent sections.",
            plan.summary
        );
    }
    plan
}

fn dynamically_shape_research_plan(
    request: &JobRequest,
    classification: &RequestClassification,
    compatible_ready_nodes: usize,
    credible_synthesizer_context: Option<u32>,
    original: JobPlan,
) -> JobPlan {
    dynamically_shape_research_plan_with_context(
        request,
        classification,
        compatible_ready_nodes,
        dynamic_research_context_budget(request),
        credible_synthesizer_context,
        original,
    )
}

fn dynamically_shape_research_plan_with_context(
    request: &JobRequest,
    classification: &RequestClassification,
    compatible_ready_nodes: usize,
    research_context_budget: u32,
    credible_synthesizer_context: Option<u32>,
    original: JobPlan,
) -> JobPlan {
    let lower = request.prompt.to_ascii_lowercase();
    let dynamic_history_requested = lower.contains("to date")
        || lower.starts_with("brief history")
        || lower.starts_with("a brief history");
    if request.execution_mode == JobExecutionMode::Single
        || classification.task_type == RequestTaskType::Coding
        || !dynamic_history_requested
    {
        return original;
    }

    let explicit_sections = explicit_split_sections(&request.prompt);
    let detailed = contains_any(
        &lower,
        &["detailed", "complete", "comprehensive", "to date", "today"],
    );
    let requested_output = request
        .max_tokens
        .unwrap_or(if detailed { 3_072 } else { 1_024 });
    let meaningful_limit = if explicit_sections.len() >= 2 {
        explicit_sections.len().min(10)
    } else if detailed {
        6
    } else {
        2
    };
    let capacity_width = compatible_ready_nodes.max(1).min(6);
    let research_count = if explicit_sections.len() >= 2 {
        meaningful_limit
    } else if detailed {
        capacity_width.max(2).min(meaningful_limit)
    } else {
        1
    };

    let default_sections = [
        "Origins and founding context",
        "Early development and strategy",
        "Major research and product milestones",
        "Growth, partnerships, and market impact",
        "Governance, leadership, and controversies",
        "Current position and developments to date",
    ];
    let sections = if explicit_sections.len() >= 2 {
        explicit_sections
            .into_iter()
            .take(research_count)
            .collect::<Vec<_>>()
    } else {
        default_sections
            .iter()
            .take(research_count)
            .map(|section| (*section).to_string())
            .collect::<Vec<_>>()
    };
    let section_tokens = requested_output
        .saturating_add(research_count as u32 - 1)
        .checked_div(research_count as u32)
        .unwrap_or(512)
        .clamp(512, 1_536);
    let context_tokens = research_context_budget;
    let mut jobs = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        push_planned_job(
            &mut jobs,
            &format!("research.{:02}", index + 1),
            section,
            "chunk_analysis",
            Vec::new(),
            &format!("Research only the {section} responsibility with factual chronology and evidence appropriate to the request."),
            "The dynamic research planner selected an independent, meaningful responsibility that fits current qualified parallel capacity.",
        );
        let job = jobs.last_mut().expect("dynamic research job");
        job.recommended_max_tokens = Some(section_tokens);
        job.minimum_max_tokens = Some(section_tokens.min(512));
        job.workload.minimum_capacity_class = CapacityClass::Standard;
        job.workload.recommended_capacity_class = CapacityClass::Performance;
        job.workload.context_budget_tokens = context_tokens;
        job.workload.allowed_parallelism = compatible_ready_nodes.max(1) as u32;
    }

    let synthesis_context_required = if detailed { 8_192 } else { 4_096 };
    let synthesis_available = credible_synthesizer_context
        .is_some_and(|available| available >= synthesis_context_required);
    if research_count > 1 && synthesis_available {
        let dependencies = jobs.iter().map(|job| job.id.clone()).collect::<Vec<_>>();
        push_planned_job(
            &mut jobs,
            "research.synthesize",
            "Synthesize research answer",
            "synthesize",
            dependencies,
            "Combine the completed research responsibilities into one coherent, chronological answer without duplication.",
            "Multiple independent research outputs require one context-aware synthesis stage.",
        );
        let synthesis = jobs.last_mut().expect("research synthesis");
        synthesis.recommended_max_tokens = Some(requested_output.clamp(1_024, 4_096));
        synthesis.minimum_max_tokens = Some(1_024);
        synthesis.workload.minimum_capacity_class = CapacityClass::Performance;
        synthesis.workload.recommended_capacity_class = CapacityClass::Synthesis;
        synthesis.workload.context_budget_tokens = synthesis_context_required;
    }

    JobPlan {
        plan_id: format!("plan-{}", request.request_id),
        strategy: "dynamic_research".to_string(),
        summary: format!(
            "Dynamically planned {research_count} research responsibility unit(s) for {compatible_ready_nodes} currently compatible node slot(s); per-section output target {section_tokens} tokens; synthesis {}.",
            if research_count <= 1 {
                "unnecessary"
            } else if synthesis_available {
                "assigned to a context-capable synthesizer"
            } else {
                "omitted because no current synthesizer meets the required context budget; verified sections are returned directly"
            }
        ),
        jobs,
    }
}

fn dynamic_research_context_budget(request: &JobRequest) -> u32 {
    let lower = request.prompt.to_ascii_lowercase();
    if contains_any(
        &lower,
        &["detailed", "complete", "comprehensive", "to date", "today"],
    ) {
        8_192
    } else {
        4_096
    }
}

fn sectionable_prompt_warrants_single_node_decomposition(
    request: &JobRequest,
    classification: &RequestClassification,
) -> bool {
    classification.context_size == ContextSize::Large
        || request.prompt.chars().count() > 1_800
        || request.max_tokens.unwrap_or_default() > 2_048
        || (classification.complexity == RequestComplexity::High
            && contains_any(
                &request.prompt.to_ascii_lowercase(),
                &["multi-step", "architecture", "security review", "migration"],
            ))
}

pub fn build_job_graph(request_id: &str, plan: &JobPlan, created_at: &str) -> JobGraph {
    let mut graph = JobGraph {
        graph_id: format!("graph-{request_id}"),
        request_id: request_id.to_string(),
        plan_id: plan.plan_id.clone(),
        status: JobGraphStatus::Created,
        nodes: plan
            .jobs
            .iter()
            .map(|job| JobGraphNode {
                id: job.id.clone(),
                name: job.name.clone(),
                responsibility: job.responsibility.clone(),
                depends_on: job.depends_on.clone(),
                required_output: job.required_output.clone(),
                recommended_max_tokens: job.recommended_max_tokens,
                minimum_max_tokens: job.minimum_max_tokens,
                workload: job.workload.clone(),
                status: JobGraphNodeStatus::Waiting,
                blocked_by: job.depends_on.clone(),
                assigned_node_id: None,
                assigned_at: None,
                started_at: None,
                completed_at: None,
                worker_id: None,
                backend: None,
                model: None,
                runtime_mode: None,
                effective_max_tokens: None,
                queue_wait_ms: None,
                runtime_ms: None,
                latency_ms: None,
                output_chars: None,
                estimated_output_tokens: None,
                attempt_count: 0,
                max_attempts: DEFAULT_GRAPH_NODE_MAX_ATTEMPTS,
                failed_node_ids: Vec::new(),
                output: None,
                error: None,
            })
            .collect(),
        final_node_id: plan
            .jobs
            .iter()
            .rev()
            .find(|job| {
                let hint =
                    format!("{} {} {}", job.id, job.name, job.responsibility).to_ascii_lowercase();
                contains_any(&hint, &["merge", "synth"])
            })
            .map(|job| job.id.clone()),
        results: Vec::new(),
        final_output: None,
        merge_error: None,
        synthesis_status: SynthesisStatus::Collecting,
        final_manifest: None,
        created_at: created_at.to_string(),
        updated_at: created_at.to_string(),
    };
    refresh_job_graph(&mut graph);
    refresh_graph_results(&mut graph, ExpectedOutputFormat::Text, None, None, None);
    graph
}

fn refresh_job_graph(graph: &mut JobGraph) {
    let failed_ids = graph
        .nodes
        .iter()
        .filter(|node| node.status == JobGraphNodeStatus::Failed)
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    let completed_ids = graph
        .nodes
        .iter()
        .filter(|node| node.status == JobGraphNodeStatus::Completed)
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();

    for node in &mut graph.nodes {
        if matches!(
            node.status,
            JobGraphNodeStatus::Running
                | JobGraphNodeStatus::Completed
                | JobGraphNodeStatus::Failed
        ) {
            continue;
        }

        let blocked_by = node
            .depends_on
            .iter()
            .filter(|dependency| !completed_ids.contains(dependency))
            .cloned()
            .collect::<Vec<_>>();
        node.blocked_by = blocked_by;
        node.status = if node.blocked_by.is_empty() {
            JobGraphNodeStatus::Ready
        } else {
            JobGraphNodeStatus::Waiting
        };
        node.assigned_node_id = None;
        node.assigned_at = None;
        node.started_at = None;
        node.completed_at = None;
        node.worker_id = None;
        node.backend = None;
        node.model = None;
        node.runtime_mode = None;
        node.effective_max_tokens = None;
        node.queue_wait_ms = None;
        node.runtime_ms = None;
        node.latency_ms = None;
        node.output_chars = None;
        node.estimated_output_tokens = None;
    }

    graph.status = if !failed_ids.is_empty() {
        JobGraphStatus::Failed
    } else if graph.nodes.is_empty()
        || graph
            .nodes
            .iter()
            .all(|node| node.status == JobGraphNodeStatus::Completed)
    {
        JobGraphStatus::Completed
    } else if graph.nodes.iter().any(|node| {
        matches!(
            node.status,
            JobGraphNodeStatus::Running | JobGraphNodeStatus::Completed
        )
    }) {
        JobGraphStatus::InProgress
    } else {
        JobGraphStatus::Created
    };
}

fn apply_job_completion_to_graph(job: &mut JobRecord, completion: &JobCompletion) {
    if !job.graph_execution_enabled {
        refresh_job_graph(&mut job.graph);
        return;
    }

    match completion.status {
        JobStatus::Completed => {
            if let Some(final_node_id) = job.graph.final_node_id.clone() {
                if let Some(final_node) = job
                    .graph
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == final_node_id)
                {
                    final_node.status = JobGraphNodeStatus::Completed;
                    final_node.output = completion.output.clone();
                    final_node.error = None;
                }
            }
        }
        JobStatus::Failed => {
            if let Some(final_node_id) = job.graph.final_node_id.clone() {
                if let Some(final_node) = job
                    .graph
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == final_node_id)
                {
                    final_node.status = JobGraphNodeStatus::Failed;
                    final_node.output = completion.output.clone();
                    final_node.error = completion.error.clone();
                }
            }
        }
        _ => {}
    }

    refresh_job_graph(&mut job.graph);
    if completion.status == JobStatus::Completed && job.graph.status != JobGraphStatus::Failed {
        job.graph.status = JobGraphStatus::Completed;
    } else if completion.status == JobStatus::Failed {
        job.graph.status = JobGraphStatus::Failed;
    }
    refresh_graph_results(
        &mut job.graph,
        job.classification.output_format,
        Some(completion.worker_id.as_str()),
        Some(completion.node_id.as_str()),
        completion.latency_ms,
    );
    job.output = job.graph.final_output.clone();
    if job.graph.merge_error.is_some() && job.error.is_none() {
        job.error = job.graph.merge_error.clone();
    }
}

fn refresh_graph_results(
    graph: &mut JobGraph,
    expected_format: ExpectedOutputFormat,
    _source_worker_id: Option<&str>,
    _source_node_id: Option<&str>,
    _latency_ms: Option<u64>,
) {
    graph.results = graph
        .nodes
        .iter()
        .filter(|node| {
            matches!(
                node.status,
                JobGraphNodeStatus::Completed | JobGraphNodeStatus::Failed
            )
        })
        .map(|node| {
            let (verification_status, verification_reason) =
                verify_graph_result(node, expected_format);
            let artifacts =
                extract_result_artifacts(node, verification_status, verification_reason.as_deref());
            JobResultRecord {
                node_id: node.id.clone(),
                name: node.name.clone(),
                responsibility: node.responsibility.clone(),
                status: node.status,
                output: node.output.clone(),
                error: node.error.clone(),
                source_worker_id: node.worker_id.clone(),
                source_node_id: node.assigned_node_id.clone(),
                latency_ms: node.latency_ms,
                assigned_at: node.assigned_at.clone(),
                started_at: node.started_at.clone(),
                completed_at: node.completed_at.clone(),
                backend: node.backend,
                model: node.model.clone(),
                runtime_mode: node.runtime_mode.clone(),
                effective_max_tokens: node.effective_max_tokens,
                queue_wait_ms: node.queue_wait_ms,
                runtime_ms: node.runtime_ms,
                output_chars: node.output_chars,
                estimated_output_tokens: node.estimated_output_tokens,
                verification_status,
                verification_reason,
                artifacts,
            }
        })
        .collect();

    graph.final_output = merge_completed_graph_outputs(graph);
    graph.merge_error = merge_graph_error(graph);
    if graph.merge_error.is_some() {
        if reducer_failed_with_section_fallback(graph) {
            graph.status = JobGraphStatus::Completed;
            return;
        }
        graph.status = JobGraphStatus::Failed;
    }
    graph.synthesis_status = synthesis_status_for_graph(graph);
    graph.final_manifest = Some(build_synthesis_manifest(graph));
}

fn synthesis_status_for_graph(graph: &JobGraph) -> SynthesisStatus {
    if graph.status == JobGraphStatus::Failed {
        return SynthesisStatus::Failed;
    }
    let final_completed = graph.final_node_id.as_deref().is_some_and(|final_id| {
        graph
            .nodes
            .iter()
            .any(|node| node.id == final_id && node.status == JobGraphNodeStatus::Completed)
    });
    let deterministic_assembly_completed = graph.final_node_id.is_none()
        && graph
            .final_output
            .as_deref()
            .is_some_and(|output| !output.trim().is_empty());
    if graph.status == JobGraphStatus::Completed {
        return if (final_completed || deterministic_assembly_completed)
            && graph.merge_error.is_none()
        {
            SynthesisStatus::Completed
        } else {
            SynthesisStatus::CompletedPartial
        };
    }
    let active = graph.nodes.iter().find(|node| {
        matches!(
            node.status,
            JobGraphNodeStatus::Ready | JobGraphNodeStatus::Running
        )
    });
    match active.map(|node| node.responsibility.as_str()) {
        Some("merge" | "synthesize") => SynthesisStatus::Synthesizing,
        Some("reduce") => SynthesisStatus::Reducing,
        _ => SynthesisStatus::Collecting,
    }
}

fn extract_result_artifacts(
    node: &JobGraphNode,
    verification_status: JobResultVerificationStatus,
    verification_reason: Option<&str>,
) -> Vec<ResultArtifact> {
    let Some(output) = node
        .output
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Vec::new();
    };
    let blocks = fenced_output_blocks(output);
    let values = if blocks.is_empty() {
        vec![("text".to_string(), output.to_string())]
    } else {
        blocks
    };
    values
        .into_iter()
        .enumerate()
        .map(|(index, (language, content))| {
            let kind = artifact_kind_for_language(&language);
            let path = artifact_path(kind, &content);
            let media_type = artifact_media_type(kind, &language).to_string();
            let checksum_sha256 = sha256_hex(content.as_bytes());
            let validation_evidence = validate_artifact(kind, path.as_deref(), &content);
            let structurally_valid = validation_evidence.iter().all(|item| item.passed);
            let artifact_status = if verification_status == JobResultVerificationStatus::Accepted
                && structurally_valid
            {
                JobResultVerificationStatus::Accepted
            } else if !structurally_valid {
                JobResultVerificationStatus::Repairable
            } else {
                verification_status
            };
            let artifact_reason = if structurally_valid {
                verification_reason.map(str::to_string)
            } else {
                Some("artifact failed control-plane structural validation".to_string())
            };
            ResultArtifact {
                artifact_id: format!("{}-{:04}-{}", node.id, index + 1, &checksum_sha256[..12]),
                result_node_id: node.id.clone(),
                sequence: index as u32,
                kind,
                path,
                language: (!language.is_empty() && language != "text").then_some(language),
                media_type,
                byte_size: content.len(),
                content,
                checksum_sha256,
                base_checksum_sha256: None,
                verification_status: artifact_status,
                verification_reason: artifact_reason,
                source_worker_id: node.worker_id.clone(),
                source_node_id: node.assigned_node_id.clone(),
                validation_evidence,
            }
        })
        .collect()
}

fn validation_evidence(
    kind: ValidationEvidenceKind,
    passed: bool,
    summary: &str,
) -> ArtifactValidationEvidence {
    ArtifactValidationEvidence {
        version: 1,
        kind,
        passed,
        provenance: ValidationEvidenceProvenance::ControlPlane,
        summary: summary.to_string(),
    }
}

fn validate_artifact(
    kind: ResultArtifactKind,
    path: Option<&str>,
    content: &str,
) -> Vec<ArtifactValidationEvidence> {
    let mut evidence = vec![validation_evidence(
        ValidationEvidenceKind::OutputPresence,
        !content.trim().is_empty(),
        "artifact output is non-empty",
    )];
    match kind {
        ResultArtifactKind::Patch => {
            evidence.push(validation_evidence(
                ValidationEvidenceKind::PathSafety,
                path.is_some_and(safe_artifact_path),
                "patch target is a safe workspace-relative path",
            ));
            let has_old_header = content.lines().any(|line| line.starts_with("--- "));
            let has_new_header = content.lines().any(|line| line.starts_with("+++ "));
            let has_hunk = content.lines().any(|line| line.starts_with("@@"));
            evidence.push(validation_evidence(
                ValidationEvidenceKind::PatchStructure,
                has_old_header && has_new_header && has_hunk,
                "patch contains old/new file headers and at least one hunk",
            ));
        }
        ResultArtifactKind::StructuredData => evidence.push(validation_evidence(
            ValidationEvidenceKind::StructuredDataSyntax,
            serde_json::from_str::<serde_json::Value>(content).is_ok(),
            "structured data parses as JSON",
        )),
        _ => {}
    }
    evidence
}

fn fenced_output_blocks(output: &str) -> Vec<(String, String)> {
    let mut blocks = Vec::new();
    let mut language: Option<String> = None;
    let mut content = Vec::new();
    for line in output.lines() {
        if let Some(fence) = line.trim_start().strip_prefix("```") {
            if let Some(open_language) = language.take() {
                blocks.push((open_language, content.join("\n").trim().to_string()));
                content.clear();
            } else {
                language = Some(fence.trim().to_ascii_lowercase());
            }
            continue;
        }
        if language.is_some() {
            content.push(line);
        }
    }
    if let Some(open_language) = language {
        if !content.is_empty() {
            blocks.push((open_language, content.join("\n").trim().to_string()));
        }
    }
    blocks.retain(|(_, content)| !content.is_empty());
    blocks
}

fn artifact_kind_for_language(language: &str) -> ResultArtifactKind {
    match language {
        "diff" | "patch" => ResultArtifactKind::Patch,
        "sh" | "bash" | "shell" | "powershell" | "ps1" | "terminal" => ResultArtifactKind::Command,
        "json" => ResultArtifactKind::StructuredData,
        "test" | "tests" | "tap" | "junit" => ResultArtifactKind::TestReport,
        "" | "text" | "txt" | "markdown" | "md" => ResultArtifactKind::Text,
        _ => ResultArtifactKind::Code,
    }
}

fn artifact_media_type(kind: ResultArtifactKind, language: &str) -> &'static str {
    match kind {
        ResultArtifactKind::Patch => "text/x-diff",
        ResultArtifactKind::Command => "text/x-shellscript",
        ResultArtifactKind::StructuredData => "application/json",
        ResultArtifactKind::TestReport => "text/plain",
        ResultArtifactKind::Code => match language {
            "typescript" | "ts" | "tsx" => "text/typescript",
            "javascript" | "js" | "jsx" => "text/javascript",
            "python" | "py" => "text/x-python",
            "rust" | "rs" => "text/x-rust",
            _ => "text/plain",
        },
        ResultArtifactKind::Text => "text/plain",
    }
}

fn artifact_path(kind: ResultArtifactKind, content: &str) -> Option<String> {
    if kind != ResultArtifactKind::Patch {
        return None;
    }
    content.lines().find_map(|line| {
        let value = line.strip_prefix("+++ ")?.trim();
        if value == "/dev/null" {
            return None;
        }
        let normalized = value.strip_prefix("b/").unwrap_or(value);
        safe_artifact_path(normalized).then(|| normalized.to_string())
    })
}

fn safe_artifact_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains("../")
        && !path.contains("..\\")
        && !path.split(['/', '\\']).any(|part| part == "..")
        && !path.chars().nth(1).is_some_and(|value| value == ':')
}

fn build_synthesis_manifest(graph: &JobGraph) -> SynthesisManifest {
    let mut artifacts = graph
        .results
        .iter()
        .flat_map(|result| result.artifacts.clone())
        .filter(|artifact| artifact.verification_status == JobResultVerificationStatus::Accepted)
        .collect::<Vec<_>>();
    artifacts.sort_by(|left, right| {
        left.path
            .as_deref()
            .unwrap_or("")
            .cmp(right.path.as_deref().unwrap_or(""))
            .then(left.checksum_sha256.cmp(&right.checksum_sha256))
            .then(left.artifact_id.cmp(&right.artifact_id))
    });
    artifacts.dedup_by(|left, right| left.checksum_sha256 == right.checksum_sha256);
    let conflicts = artifact_conflicts(&artifacts);
    let repair_plans = artifact_repair_plans(graph, &conflicts);
    let timeline = orchestration_timeline(graph, &repair_plans);
    let batches = artifact_batches(&graph.graph_id, &artifacts);
    let omitted_dependency_ids = graph
        .nodes
        .iter()
        .filter(|node| node.status == JobGraphNodeStatus::Failed)
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    let mut warnings = Vec::new();
    if !conflicts.is_empty() {
        warnings.push("Conflicting artifacts require client review before apply.".to_string());
    }
    if !omitted_dependency_ids.is_empty() {
        warnings
            .push("One or more graph dependencies did not produce an accepted result.".to_string());
    }
    if let Some(error) = graph.merge_error.as_ref() {
        warnings.push(error.clone());
    }
    let complete = graph.synthesis_status == SynthesisStatus::Completed
        && conflicts.is_empty()
        && omitted_dependency_ids.is_empty();
    let checksum_input = artifacts
        .iter()
        .map(|artifact| artifact.checksum_sha256.as_str())
        .collect::<Vec<_>>()
        .join(":");
    SynthesisManifest {
        version: 1,
        manifest_id: format!("manifest-{}", graph.graph_id),
        status: if complete {
            SynthesisStatus::Completed
        } else if graph.synthesis_status == SynthesisStatus::Completed {
            SynthesisStatus::CompletedPartial
        } else {
            graph.synthesis_status
        },
        artifacts,
        batches,
        conflicts,
        repair_plans,
        timeline,
        warnings,
        omitted_dependency_ids,
        final_text: graph.final_output.clone(),
        complete,
        checksum_sha256: sha256_hex(checksum_input.as_bytes()),
    }
}

fn artifact_repair_plans(
    graph: &JobGraph,
    conflicts: &[ArtifactConflict],
) -> Vec<ArtifactRepairPlan> {
    let mut plans = conflicts
        .iter()
        .enumerate()
        .map(|(index, conflict)| ArtifactRepairPlan {
            repair_id: format!("repair-{}-conflict-{:04}", graph.graph_id, index + 1),
            artifact_ids: conflict.artifact_ids.clone(),
            target_paths: vec![conflict.path.clone()],
            reason: conflict.reason.clone(),
            attempt: 0,
            max_attempts: DEFAULT_GRAPH_NODE_MAX_ATTEMPTS,
        })
        .collect::<Vec<_>>();
    for result in &graph.results {
        let rejected = result
            .artifacts
            .iter()
            .filter(|artifact| {
                artifact.verification_status != JobResultVerificationStatus::Accepted
            })
            .collect::<Vec<_>>();
        if rejected.is_empty() {
            continue;
        }
        plans.push(ArtifactRepairPlan {
            repair_id: format!("repair-{}-{}", graph.graph_id, result.node_id),
            artifact_ids: rejected
                .iter()
                .map(|item| item.artifact_id.clone())
                .collect(),
            target_paths: rejected
                .iter()
                .filter_map(|item| item.path.clone())
                .collect(),
            reason: rejected
                .iter()
                .filter_map(|item| item.verification_reason.clone())
                .next()
                .unwrap_or_else(|| "artifact validation was rejected or unverifiable".to_string()),
            attempt: result
                .source_node_id
                .as_deref()
                .and_then(|_| graph.nodes.iter().find(|node| node.id == result.node_id))
                .map(|node| node.attempt_count)
                .unwrap_or_default(),
            max_attempts: graph
                .nodes
                .iter()
                .find(|node| node.id == result.node_id)
                .map(|node| node.max_attempts)
                .unwrap_or(DEFAULT_GRAPH_NODE_MAX_ATTEMPTS),
        });
    }
    plans.sort_by(|left, right| left.repair_id.cmp(&right.repair_id));
    plans
}

fn orchestration_timeline(
    graph: &JobGraph,
    repairs: &[ArtifactRepairPlan],
) -> Vec<OrchestrationTimelineEvent> {
    let mut events = graph
        .nodes
        .iter()
        .enumerate()
        .map(|(index, node)| OrchestrationTimelineEvent {
            sequence: index as u32,
            stage: node.responsibility.clone(),
            status: format!("{:?}", node.status).to_ascii_lowercase(),
            graph_node_id: Some(node.id.clone()),
            summary: format!(
                "{}; capacity={:?}; assigned={}",
                node.name,
                node.workload.minimum_capacity_class,
                node.assigned_node_id.as_deref().unwrap_or("unassigned")
            ),
        })
        .collect::<Vec<_>>();
    for repair in repairs {
        events.push(OrchestrationTimelineEvent {
            sequence: events.len() as u32,
            stage: "repair".to_string(),
            status: if repair.attempt >= repair.max_attempts {
                "exhausted".to_string()
            } else {
                "planned".to_string()
            },
            graph_node_id: None,
            summary: format!("{}: {}", repair.repair_id, repair.reason),
        });
    }
    events.truncate(256);
    events
}

fn artifact_batches(graph_id: &str, artifacts: &[ResultArtifact]) -> Vec<ArtifactBatch> {
    let mut batches = Vec::new();
    let mut artifact_ids = Vec::new();
    let mut byte_size = 0usize;
    for artifact in artifacts {
        let would_overflow = !artifact_ids.is_empty()
            && (artifact_ids.len() >= ARTIFACT_BATCH_MAX_ITEMS
                || byte_size.saturating_add(artifact.byte_size) > ARTIFACT_BATCH_MAX_BYTES);
        if would_overflow {
            let sequence = batches.len() as u32;
            batches.push(ArtifactBatch {
                batch_id: format!("{}-batch-{:04}", graph_id, sequence + 1),
                sequence,
                artifact_ids: std::mem::take(&mut artifact_ids),
                byte_size,
                complete: true,
            });
            byte_size = 0;
        }
        artifact_ids.push(artifact.artifact_id.clone());
        byte_size = byte_size.saturating_add(artifact.byte_size);
    }
    if !artifact_ids.is_empty() {
        let sequence = batches.len() as u32;
        batches.push(ArtifactBatch {
            batch_id: format!("{}-batch-{:04}", graph_id, sequence + 1),
            sequence,
            artifact_ids,
            byte_size,
            complete: true,
        });
    }
    batches
}

fn artifact_conflicts(artifacts: &[ResultArtifact]) -> Vec<ArtifactConflict> {
    let mut by_path: BTreeMap<&str, Vec<&ResultArtifact>> = BTreeMap::new();
    for artifact in artifacts.iter().filter(|artifact| artifact.path.is_some()) {
        by_path
            .entry(artifact.path.as_deref().expect("filtered"))
            .or_default()
            .push(artifact);
    }
    by_path
        .into_iter()
        .filter_map(|(path, values)| {
            let distinct = values
                .iter()
                .map(|artifact| artifact.checksum_sha256.as_str())
                .collect::<std::collections::BTreeSet<_>>();
            (distinct.len() > 1).then(|| ArtifactConflict {
                path: path.to_string(),
                artifact_ids: values
                    .iter()
                    .map(|artifact| artifact.artifact_id.clone())
                    .collect(),
                reason: "multiple accepted artifacts target the same path with different content"
                    .to_string(),
            })
        })
        .collect()
}

fn sha256_hex(content: &[u8]) -> String {
    hex::encode(Sha256::digest(content))
}

fn merge_completed_graph_outputs(graph: &JobGraph) -> Option<String> {
    if let Some(final_node_id) = graph.final_node_id.as_deref() {
        if let Some(output) = graph
            .results
            .iter()
            .find(|result| {
                result.node_id == final_node_id
                    && result.status == JobGraphNodeStatus::Completed
                    && result.verification_status == JobResultVerificationStatus::Accepted
            })
            .and_then(|result| result.output.as_ref())
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            return Some(output.to_string());
        }
    }

    let mut parts = Vec::new();
    for result in graph.results.iter().filter(|result| {
        result.status == JobGraphNodeStatus::Completed
            && result.verification_status == JobResultVerificationStatus::Accepted
    }) {
        let Some(output) = result.output.as_ref().map(|value| value.trim()) else {
            continue;
        };
        if output.is_empty() {
            continue;
        }
        let section = clean_section_output(&result.name, output);
        if !section.is_empty() {
            parts.push(format!("{}\n{}", result.name, section));
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

fn reducer_failed_with_section_fallback(graph: &JobGraph) -> bool {
    let Some(final_node_id) = graph.final_node_id.as_deref() else {
        return false;
    };

    let final_node_failed = graph
        .nodes
        .iter()
        .any(|node| node.id == final_node_id && node.status == JobGraphNodeStatus::Failed);
    let non_final_failed = graph
        .nodes
        .iter()
        .any(|node| node.id != final_node_id && node.status == JobGraphNodeStatus::Failed);

    final_node_failed && !non_final_failed && graph.final_output.is_some()
}

fn merge_graph_error(graph: &JobGraph) -> Option<String> {
    let mut errors = graph
        .nodes
        .iter()
        .filter(|node| node.status == JobGraphNodeStatus::Failed)
        .filter_map(|node| {
            node.error
                .as_ref()
                .map(|error| format!("{}: {}", node.name, error))
        })
        .collect::<Vec<_>>();

    errors.extend(
        graph
            .results
            .iter()
            .filter(|result| {
                result.status != JobGraphNodeStatus::Failed
                    && result.verification_status != JobResultVerificationStatus::Accepted
            })
            .map(|result| {
                format!(
                    "{} verification {}: {}",
                    result.name,
                    verification_status_label(result.verification_status),
                    result
                        .verification_reason
                        .as_deref()
                        .unwrap_or("result did not pass verification")
                )
            }),
    );

    if errors.is_empty() {
        None
    } else {
        Some(errors.join("; "))
    }
}

fn verify_graph_result(
    node: &JobGraphNode,
    expected_format: ExpectedOutputFormat,
) -> (JobResultVerificationStatus, Option<String>) {
    if node.status == JobGraphNodeStatus::Failed {
        return (
            JobResultVerificationStatus::Rejected,
            Some(
                node.error
                    .as_ref()
                    .map(|error| format!("worker reported failure: {error}"))
                    .unwrap_or_else(|| "worker reported failure".to_string()),
            ),
        );
    }

    let Some(output) = node.output.as_ref().map(|value| value.trim()) else {
        return (
            JobResultVerificationStatus::Rejected,
            Some("completed result did not include output".to_string()),
        );
    };

    if output.is_empty() {
        return (
            JobResultVerificationStatus::Rejected,
            Some("completed result output was empty".to_string()),
        );
    }

    if node.responsibility == "section" && clean_section_output(&node.name, output).is_empty() {
        return (
            JobResultVerificationStatus::Rejected,
            Some("section output contained only prompt echo or boilerplate".to_string()),
        );
    }

    if output
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return (
            JobResultVerificationStatus::Rejected,
            Some("output contains unsupported control characters".to_string()),
        );
    }

    if expected_format == ExpectedOutputFormat::Json
        && serde_json::from_str::<serde_json::Value>(output).is_err()
    {
        return (
            JobResultVerificationStatus::FallbackNeeded,
            Some("output is not valid JSON for the expected format".to_string()),
        );
    }

    (JobResultVerificationStatus::Accepted, None)
}

fn verification_status_label(status: JobResultVerificationStatus) -> &'static str {
    match status {
        JobResultVerificationStatus::Accepted => "accepted",
        JobResultVerificationStatus::Rejected => "rejected",
        JobResultVerificationStatus::Repairable => "repairable",
        JobResultVerificationStatus::Unverifiable => "unverifiable",
        JobResultVerificationStatus::FallbackNeeded => "fallback_needed",
    }
}

fn push_planned_job(
    jobs: &mut Vec<PlannedJob>,
    id: &str,
    name: &str,
    responsibility: &str,
    depends_on: Vec<String>,
    required_output: &str,
    reason: &str,
) {
    jobs.push(PlannedJob {
        id: id.to_string(),
        name: name.to_string(),
        responsibility: responsibility.to_string(),
        depends_on,
        required_output: required_output.to_string(),
        reason: reason.to_string(),
        recommended_max_tokens: None,
        minimum_max_tokens: None,
        workload: StepWorkloadRequirements::default(),
    });
}

fn compact_reviewed_code_plan_jobs() -> Vec<PlannedJob> {
    let mut jobs = Vec::new();
    push_planned_job(
        &mut jobs,
        "job.backend",
        "Complete implementation and documentation",
        "backend",
        Vec::new(),
        "Produce one complete runnable implementation that satisfies the requested API and data-model contract. Include input validation, error handling, and focused executable checks where appropriate. After the code, include concise Markdown setup, run, endpoint, request-field, and example documentation. Do not emit placeholders, TODOs, or review prose.",
        "A low-complexity code project is faster and more coherent when one worker owns the implementation contract without a separate scope-generation call.",
    );
    let implementation = jobs.last_mut().expect("implementation job");
    implementation.recommended_max_tokens = Some(2_048);
    implementation.minimum_max_tokens = Some(1_536);
    implementation.workload.context_budget_tokens = 4_096;
    push_planned_job(
        &mut jobs,
        "job.code_review",
        "Independent code review",
        "validation",
        vec!["job.backend".to_string()],
        "Review the completed implementation for correctness, requested contract coverage, validation, error handling, maintainability, and concrete defects. Report concise findings and do not rewrite or repeat the full source code.",
        "Independent review must see the completed implementation and documentation, but it does not need to trigger another model synthesis.",
    );
    let review = jobs.last_mut().expect("review job");
    review.recommended_max_tokens = Some(512);
    review.minimum_max_tokens = Some(384);
    review.workload.context_budget_tokens = 4_096;
    jobs
}

fn complete_code_plan_jobs() -> Vec<PlannedJob> {
    let mut jobs = Vec::new();
    push_planned_job(
        &mut jobs,
        "job.code_contract",
        "Code contract",
        "contract",
        Vec::new(),
        "Define the shared program contract: language/toolchain, data model, filename, required public function names, function signatures, and allowed private helper policy.",
        "Complete program chunks need one stable contract before source generation.",
    );
    push_planned_job(
        &mut jobs,
        "job.code_types",
        "Structs, constants, and prototypes",
        "implementation",
        vec!["job.code_contract".to_string()],
        "Produce the include directives, constants, Student struct, and all public function prototypes required by the contract.",
        "Shared declarations must be generated before implementation chunks.",
    );
    push_planned_job(
        &mut jobs,
        "job.code_file_write",
        "Binary write functions",
        "implementation",
        vec!["job.code_types".to_string()],
        "Implement the binary-file create/append/write functions required by the contract. Include only private helpers needed for this responsibility.",
        "File-write logic can be generated independently once shared types are fixed.",
    );
    push_planned_job(
        &mut jobs,
        "job.code_file_read",
        "Binary search and read functions",
        "implementation",
        vec!["job.code_types".to_string()],
        "Implement binary-file read/search-by-id functions required by the contract. Include only private helpers needed for this responsibility.",
        "Read/search logic can be generated independently once shared types are fixed.",
    );
    push_planned_job(
        &mut jobs,
        "job.code_helpers",
        "Input and display helpers",
        "implementation",
        vec!["job.code_types".to_string()],
        "Implement input validation, prompt, cleanup, and display helper functions required by the contract.",
        "User interaction helpers should be isolated from file I/O chunks.",
    );
    push_planned_job(
        &mut jobs,
        "job.code_main",
        "Main menu and demo flow",
        "implementation",
        vec![
            "job.code_file_write".to_string(),
            "job.code_file_read".to_string(),
            "job.code_helpers".to_string(),
        ],
        "Implement main() and the menu or demo flow that calls the generated public functions consistently.",
        "The entrypoint depends on file I/O and helper functions.",
    );
    push_planned_job(
        &mut jobs,
        "job.compile_notes",
        "Compile and usage notes",
        "validation",
        vec!["job.code_main".to_string()],
        "Add concise compiler, runtime, and file-handling notes relevant to the requested language/toolchain.",
        "Legacy or file-based programs need usage notes so the answer is actionable.",
    );
    push_planned_job(
        &mut jobs,
        "job.final_merge",
        "Final answer",
        "merge",
        vec![
            "job.code_contract".to_string(),
            "job.code_types".to_string(),
            "job.code_file_write".to_string(),
            "job.code_file_read".to_string(),
            "job.code_helpers".to_string(),
            "job.code_main".to_string(),
            "job.compile_notes".to_string(),
        ],
        "Assemble one complete compile-ready source file in the correct order, then add concise compile/run notes. Preserve all required functions and avoid duplicate definitions.",
        "The reducer must combine contract-driven code chunks into one coherent source file.",
    );
    jobs
}

fn code_with_explanation_plan_jobs() -> Vec<PlannedJob> {
    let mut jobs = Vec::new();
    push_planned_job(
        &mut jobs,
        "job.complete_source",
        "Complete source code",
        "code",
        Vec::new(),
        "Return only one complete compilable source file in a fenced code block. Include required imports, classes, methods, and runnable entrypoint. Do not include explanation in this chunk.",
        "For small educational code requests, the user can inspect the source before waiting for explanation.",
    );
    push_planned_job(
        &mut jobs,
        "job.code_explanation",
        "Code explanation",
        "documentation",
        vec!["job.complete_source".to_string()],
        "Explain how the generated program works in concise prose or bullets. Refer to the source code chunk; do not repeat the full code.",
        "Explanation depends on the source code and should be returned as a separate, smaller chunk.",
    );
    jobs
}

fn looks_like_code_explanation_prompt(lower: &str) -> bool {
    contains_any(
        lower,
        &[
            "explain",
            "explanation",
            "how it works",
            "how it is generated",
            "understand",
            "walkthrough",
            "describe the code",
            "detailed explanation",
        ],
    )
}

fn looks_like_small_code_prompt(lower: &str) -> bool {
    !contains_any(
        lower,
        &[
            "binary file",
            "property file",
            "properties file",
            "file handling",
            "database",
            "api",
            "backend",
            "frontend",
            "authentication",
            "menu",
            "save",
            "delete",
            "update",
            "student",
            "enrollment",
            "record",
        ],
    ) && (lower.len() <= 240
        || contains_any(
            lower,
            &[
                "magic square",
                "calculator",
                "sort",
                "factorial",
                "fibonacci",
                "prime",
                "palindrome",
                "simple",
                "3x3",
                "three by three",
                "5x5",
            ],
        ))
}

fn contains_any(input: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| input.contains(needle))
}

fn parse_translation_request(prompt: &str) -> Option<TranslationRequest> {
    let trimmed = prompt.trim();
    let lower = trimmed.to_ascii_lowercase();
    let rest = lower.strip_prefix("translate to ")?;
    let original_rest = &trimmed["translate to ".len()..];

    let languages = [
        ("german", "German"),
        ("english", "English"),
        ("spanish", "Spanish"),
        ("french", "French"),
        ("italian", "Italian"),
        ("portuguese", "Portuguese"),
        ("dutch", "Dutch"),
        ("polish", "Polish"),
        ("arabic", "Arabic"),
        ("japanese", "Japanese"),
        ("korean", "Korean"),
        ("chinese", "Chinese"),
        ("tagalog", "Tagalog"),
        ("filipino", "Filipino"),
    ];

    for (language_key, language_label) in languages {
        let Some(after_language_lower) = rest.strip_prefix(language_key) else {
            continue;
        };
        if after_language_lower
            .chars()
            .next()
            .map(|ch| ch.is_ascii_alphabetic())
            .unwrap_or(false)
        {
            continue;
        }

        let after_language = &original_rest[language_key.len()..];
        let source_text = clean_translation_source(after_language);
        if source_text.chars().count() >= 2 {
            return Some(TranslationRequest {
                target_language: language_label,
                source_text,
            });
        }
    }

    None
}

fn clean_translation_source(value: &str) -> String {
    let mut source = value.trim();
    if let Some(next) = source.strip_prefix("only") {
        source = next.trim();
    }
    if let Some(next) = source.strip_prefix("the following") {
        source = next.trim();
    }
    source = source
        .trim_start_matches(|ch: char| ch == ':' || ch == '-' || ch == '>' || ch.is_whitespace())
        .trim();
    source.to_string()
}

pub fn scheduling_requirements_for(
    request: &JobRequest,
    classification: &RequestClassification,
) -> JobSchedulingRequirements {
    let prompt = request.prompt.to_ascii_lowercase();
    let language = if contains_any(&prompt, &["rust", "cargo", "crate"]) {
        Some("rust".to_string())
    } else if contains_any(&prompt, &["javascript", "typescript", "node", "npm"]) {
        Some("typescript".to_string())
    } else if contains_any(&prompt, &["python", "pytest", "django", "fastapi"]) {
        Some("python".to_string())
    } else {
        None
    };

    JobSchedulingRequirements {
        task_type: classification.task_type,
        context_size: classification.context_size,
        privacy_level: classification.privacy_level,
        output_format: classification.output_format,
        runtime_mode: request.runtime_mode,
        stream: request.stream,
        model: request.model.clone(),
        language,
        preferred_roles: match classification.task_type {
            RequestTaskType::Chat => vec![NodeRole::Chat],
            RequestTaskType::Coding => vec![NodeRole::Coding],
            RequestTaskType::Document | RequestTaskType::Inference => vec![NodeRole::Batch],
        },
        constraints: classification.execution_constraints.clone(),
    }
}

pub fn fallback_decision_for(requirements: &JobSchedulingRequirements) -> FallbackDecision {
    let policy = FallbackPolicy::default();
    fallback_decision_for_policy(requirements, &policy)
}

pub fn fallback_decision_for_policy(
    requirements: &JobSchedulingRequirements,
    policy: &FallbackPolicy,
) -> FallbackDecision {
    let mut triggers = Vec::new();

    if requirements.context_size == ContextSize::Large {
        triggers.push("large_context".to_string());
    }

    if requirements.stream {
        triggers.push("streaming_requested".to_string());
    }

    if requirements.output_format == ExpectedOutputFormat::Json {
        triggers.push("quality_or_format_verification_failed".to_string());
    }

    if requirements.constraints.iter().any(|constraint| {
        let normalized = constraint.to_ascii_lowercase();
        normalized.contains("latency")
            || normalized.contains("availability")
            || normalized.contains("local capacity")
    }) {
        triggers.push("local_capacity_unavailable".to_string());
    }

    triggers.sort();
    triggers.dedup();

    if triggers.is_empty() {
        return FallbackDecision {
            status: FallbackDecisionStatus::NotNeeded,
            audit_reason: "Local execution remains the primary route for this request.".to_string(),
            ..FallbackDecision::default()
        };
    }

    let mut blocked_reasons = Vec::new();
    if !policy
        .allowed_privacy_levels
        .contains(&requirements.privacy_level)
    {
        blocked_reasons.push(format!(
            "privacy level {:?} is not eligible for fallback",
            requirements.privacy_level
        ));
    }

    for trigger in &triggers {
        if !policy.allowed_triggers.contains(trigger) {
            blocked_reasons.push(format!(
                "trigger {trigger} is not allowed by fallback policy"
            ));
        }
    }

    if !blocked_reasons.is_empty() {
        return FallbackDecision {
            status: FallbackDecisionStatus::Blocked,
            provider: None,
            triggers,
            blocked_reasons,
            requires_operator_approval: false,
            max_cost_cents: None,
            audit_reason: "Fallback is blocked by privacy or policy constraints.".to_string(),
        };
    }

    let status = if policy.requires_operator_approval {
        FallbackDecisionStatus::RequiresApproval
    } else {
        FallbackDecisionStatus::Eligible
    };
    let audit_reason = if policy.requires_operator_approval {
        "Fallback is eligible only after an operator approves the stronger-model route."
    } else {
        "Fallback is eligible under the configured policy."
    };

    FallbackDecision {
        status,
        provider: Some(policy.provider),
        triggers,
        blocked_reasons,
        requires_operator_approval: policy.requires_operator_approval,
        max_cost_cents: Some(policy.max_cost_cents),
        audit_reason: audit_reason.to_string(),
    }
}

pub fn evaluate_policy(
    agent_state: AgentState,
    _power_source: &str,
    on_battery: bool,
    battery_percent: Option<u8>,
    worker_health: &WorkerHealthReport,
) -> (bool, Option<String>) {
    let mut reasons = Vec::new();

    match agent_state {
        AgentState::Ready | AgentState::Busy => {}
        AgentState::Starting => reasons.push("agent is still starting".to_string()),
        AgentState::Paused => reasons.push("agent is paused".to_string()),
        AgentState::Stopped => reasons.push("agent is stopped".to_string()),
    }

    if on_battery {
        let battery_detail = battery_percent
            .map(|value| format!("{value}%"))
            .unwrap_or_else(|| "unknown battery level".to_string());
        reasons.push(format!(
            "node is running on battery power ({battery_detail})"
        ));
    }

    if !worker_health.healthy {
        reasons.push("worker health probe reported unhealthy".to_string());
    }

    if !worker_health.runtime_ready {
        reasons.push("runtime capability report is not ready".to_string());
    }

    if worker_health.model_dir.trim().is_empty() {
        reasons.push("model directory is missing".to_string());
    }

    if worker_health
        .model_name
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        reasons.push("model name is missing".to_string());
    }

    // A contributed cluster is a local LLM runtime the contributor already runs.
    // The node routes to its endpoint, so it has no MundusX model file, no
    // llama-cli, and no accelerator of its own to report.
    let contributed_cluster_runtime = worker_health
        .runtime_mode
        .eq_ignore_ascii_case("contributed-cluster");
    let remote_model_runtime = ControlPlaneState::serves_models_remotely(worker_health);
    if worker_health
        .model_path
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        if !remote_model_runtime {
            reasons.push("model path is missing".to_string());
        }
    } else if !remote_model_runtime {
        let model_dir = worker_health.model_dir.trim();
        let model_path = worker_health.model_path.as_deref().unwrap_or("").trim();
        if !model_dir.is_empty() && !node_path_starts_with(model_path, model_dir) {
            reasons.push(format!(
                "model path {model_path} is outside model directory {model_dir}"
            ));
        }
    }

    let runtime_mode = worker_health.runtime_mode.trim();
    let supports_local_execution = worker_health.supported_runtime_modes.iter().any(|mode| {
        matches!(
            mode,
            RuntimeMode::Local | RuntimeMode::Interactive | RuntimeMode::Mlx
        )
    });
    let uses_vllm_runtime = runtime_mode.eq_ignore_ascii_case("vllm");
    if runtime_mode.is_empty() && !supports_local_execution {
        reasons.push("runtime mode is missing".to_string());
    } else if !supports_local_execution
        && !runtime_mode.eq_ignore_ascii_case("local")
        && !runtime_mode.eq_ignore_ascii_case("interactive")
        && !runtime_mode.eq_ignore_ascii_case("mlx")
        && !runtime_mode.eq_ignore_ascii_case("cuda")
        && !uses_vllm_runtime
        && !contributed_cluster_runtime
        && !runtime_mode.eq_ignore_ascii_case("blas")
    {
        reasons.push(format!(
            "runtime mode {runtime_mode} is not ready for local execution"
        ));
    }

    let uses_mlx_runtime = runtime_mode.eq_ignore_ascii_case("mlx");
    if !uses_mlx_runtime
        && !uses_vllm_runtime
        && !contributed_cluster_runtime
        && !worker_health.llama_cli_available
    {
        reasons.push("llama-cli is unavailable".to_string());
    }

    if contributed_cluster_runtime {
        // Health for these nodes is the contributed endpoint answering, which
        // `worker_health.healthy` already covers above.
    } else if runtime_mode.eq_ignore_ascii_case("cuda") || uses_vllm_runtime {
        if !worker_health.cuda_driver_available {
            reasons.push("CUDA driver is unavailable".to_string());
        }
        if !worker_health.cuda_device_available {
            reasons.push("CUDA device is unavailable".to_string());
        }
    } else if !uses_mlx_runtime && !worker_health.blas_device_available {
        reasons.push("BLAS device acceleration is unavailable".to_string());
    }

    if reasons.is_empty() {
        (true, None)
    } else {
        (false, Some(reasons.join("; ")))
    }
}

fn normalize_admission_backends(backends: Vec<Backend>) -> Vec<Backend> {
    let mut normalized = if backends.is_empty() {
        vec![Backend::Auto, Backend::M, Backend::Cuda, Backend::Vllm]
    } else {
        backends
    };
    normalized.sort_by_key(|backend| backend.as_str());
    normalized.dedup();
    normalized
}

pub fn evaluate_admission_policy(
    base_allowed: bool,
    base_reason: Option<String>,
    policy: &AdmissionPolicy,
    backend: Backend,
    identity_trust_path: &str,
    available_memory_mb: u32,
    worker_health: &WorkerHealthReport,
) -> (bool, Option<String>) {
    let mut reasons = base_reason.map(|reason| vec![reason]).unwrap_or_default();

    if policy.enabled {
        if !policy.allowed_backends.contains(&backend) {
            reasons.push(format!(
                "backend {backend} is not allowed by admission policy"
            ));
        }

        if policy.enforce_model_policy {
            match worker_health
                .model_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                Some(name) if policy.allowed_models.iter().any(|allowed| allowed == name) => {}
                Some(name)
                    if crate::contracts::OFFICIAL_MODELS
                        .iter()
                        .any(|(known, _)| *known == name) =>
                {
                    reasons.push(format!("model {name} is denied by operator model policy"));
                }
                Some(name) => reasons.push(format!(
                    "model {name} is under investigation and is not admitted"
                )),
                None => {
                    reasons.push("model identity is missing and is under investigation".to_string())
                }
            }
        }

        if policy.require_trusted_identity && !is_trusted_identity_path(identity_trust_path) {
            reasons.push("trusted identity is required by admission policy".to_string());
        }

        if policy.require_healthy_runtime {
            if !worker_health.healthy {
                reasons.push("healthy runtime is required by admission policy".to_string());
            }
            if !worker_health.runtime_ready {
                reasons.push("runtime readiness is required by admission policy".to_string());
            }
        }

        if policy.min_memory_mb > 0 && available_memory_mb < policy.min_memory_mb {
            reasons.push(format!(
                "node memory {available_memory_mb} MB is below admission minimum {} MB",
                policy.min_memory_mb
            ));
        }

        if matches!(backend, Backend::Cuda | Backend::Vllm) && policy.min_cuda_vram_mb > 0 {
            match worker_health.cuda_memory_mb {
                Some(cuda_memory_mb) if cuda_memory_mb < policy.min_cuda_vram_mb => {
                    reasons.push(format!(
                        "CUDA VRAM {cuda_memory_mb} MB is below admission minimum {} MB",
                        policy.min_cuda_vram_mb
                    ));
                }
                None => reasons.push(format!(
                    "CUDA VRAM was not reported; admission minimum is {} MB",
                    policy.min_cuda_vram_mb
                )),
                _ => {}
            }
        }
    }

    if base_allowed && reasons.is_empty() {
        (true, None)
    } else {
        (false, Some(reasons.join("; ")))
    }
}

fn node_path_starts_with(path: &str, base: &str) -> bool {
    let path = normalize_node_path(path);
    let base = normalize_node_path(base);

    if base.is_empty() {
        return true;
    }

    path == base || path.starts_with(&format!("{base}/"))
}

fn normalize_node_path(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    while normalized.ends_with('/') && normalized.len() > 1 {
        normalized.pop();
    }
    normalized.to_ascii_lowercase()
}

pub fn state_path() -> PathBuf {
    std::env::var_os("MUNDUSX_CONTROL_PLANE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("MUNDUSX_HOME").map(PathBuf::from))
        .or_else(|| dirs::home_dir().map(|dir| dir.join(".mundusx-control-plane")))
        .unwrap_or_else(|| PathBuf::from(".mundusx-control-plane"))
        .join("state.json")
}

pub fn load_state() -> std::io::Result<Option<ControlPlaneState>> {
    let path = state_path();
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path)?;
    let state: ControlPlaneState = serde_json::from_str(&raw)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    Ok(Some(state))
}

pub fn save_state(state: &ControlPlaneState) -> std::io::Result<PathBuf> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let data = serde_json::to_string_pretty(state).expect("state serialization");
    fs::write(&path, format!("{data}\n"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{
        RuntimeMode, WorkerHealthReport, IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK,
    };

    fn m_series_registration(node_id: &str) -> AgentRegistration {
        AgentRegistration {
            node_id: node_id.to_string(),
            public_key_fingerprint: format!("fingerprint-{node_id}"),
            public_key_hex: format!("hex-{node_id}"),
            hostname: format!("host-{node_id}"),
            identity_trust_path: IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK.to_string(),
            backend: Backend::M,
            contribution_percent: 50,
            agent_version: "0.1.0".to_string(),
        }
    }

    fn cuda_registration(node_id: &str) -> AgentRegistration {
        AgentRegistration {
            node_id: node_id.to_string(),
            public_key_fingerprint: format!("fingerprint-{node_id}"),
            public_key_hex: format!("hex-{node_id}"),
            hostname: format!("host-{node_id}"),
            identity_trust_path: IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK.to_string(),
            backend: Backend::Cuda,
            contribution_percent: 50,
            agent_version: "0.1.0".to_string(),
        }
    }

    fn vllm_registration(node_id: &str) -> AgentRegistration {
        AgentRegistration {
            node_id: node_id.to_string(),
            public_key_fingerprint: format!("fingerprint-{node_id}"),
            public_key_hex: format!("hex-{node_id}"),
            hostname: format!("host-{node_id}"),
            identity_trust_path: IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK.to_string(),
            backend: Backend::Vllm,
            contribution_percent: 65,
            agent_version: "0.1.0".to_string(),
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
            cuda_memory_mb: None,
            power_source: "AC Power".to_string(),
            on_battery: false,
            battery_percent: Some(90),
            runtime_ready: true,
            runtime_mode: "local".to_string(),
            parallel_slots: 1,
            supported_runtime_modes: vec![RuntimeMode::Local, RuntimeMode::Interactive],
            streaming_supported: false,
            capabilities: crate::contracts::NodeCapabilityProfile {
                roles: vec![
                    NodeRole::Chat,
                    NodeRole::Batch,
                    NodeRole::ChunkAnalysis,
                    NodeRole::Reducer,
                    NodeRole::Synthesizer,
                ],
                ..Default::default()
            },
            checked_at: checked_at.to_string(),
            notes: vec!["m-series ready".to_string()],
        }
    }

    fn ready_heartbeat(node_id: &str, updated_at: &str) -> Heartbeat {
        Heartbeat {
            node_id: node_id.to_string(),
            backend: Backend::M,
            agent_state: AgentState::Ready,
            available_memory_mb: 16_000,
            available_gpu_percent: 50,
            updated_at: updated_at.to_string(),
            contribution_percent: 50,
            hostname: format!("host-{node_id}"),
            identity_trust_path: IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK.to_string(),
            power_source: "AC Power".to_string(),
            on_battery: false,
            battery_percent: Some(90),
            policy_allowed: true,
            policy_reason: None,
            worker_health: healthy_worker_health(updated_at),
        }
    }

    fn low_vram_cuda_heartbeat(node_id: &str, updated_at: &str) -> Heartbeat {
        let mut worker_health = healthy_worker_health(updated_at);
        worker_health.blas_device_available = false;
        worker_health.cuda_device_available = true;
        worker_health.cuda_driver_available = true;
        worker_health.cuda_device_name = Some("GeForce GTX 1650".to_string());
        worker_health.runtime_mode = "cuda".to_string();
        worker_health.supported_runtime_modes = vec![RuntimeMode::Local];
        worker_health.capabilities.roles =
            vec![NodeRole::Chat, NodeRole::Batch, NodeRole::ChunkAnalysis];
        worker_health.notes = vec![
            "CUDA low-VRAM profile selected for 4096 MB; advertise modest workloads only"
                .to_string(),
        ];

        Heartbeat {
            node_id: node_id.to_string(),
            backend: Backend::Cuda,
            agent_state: AgentState::Ready,
            available_memory_mb: 0,
            available_gpu_percent: 20,
            updated_at: updated_at.to_string(),
            contribution_percent: 50,
            hostname: format!("host-{node_id}"),
            identity_trust_path: IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK.to_string(),
            power_source: "AC Power".to_string(),
            on_battery: false,
            battery_percent: Some(90),
            policy_allowed: true,
            policy_reason: None,
            worker_health,
        }
    }

    fn ready_vllm_heartbeat(node_id: &str, updated_at: &str) -> Heartbeat {
        let mut worker_health = healthy_worker_health(updated_at);
        worker_health.model_name = Some("Qwen/Qwen2.5-32B-Instruct".to_string());
        worker_health.model_path = None;
        worker_health.llama_cli_available = false;
        worker_health.blas_device_available = false;
        worker_health.cuda_device_available = true;
        worker_health.cuda_driver_available = true;
        worker_health.cuda_device_name = Some("NVIDIA GB10".to_string());
        worker_health.cuda_memory_mb = Some(121_000);
        worker_health.runtime_mode = "vllm".to_string();
        worker_health.parallel_slots = 4;

        Heartbeat {
            node_id: node_id.to_string(),
            backend: Backend::Vllm,
            agent_state: AgentState::Ready,
            available_memory_mb: 121_000,
            available_gpu_percent: 65,
            updated_at: updated_at.to_string(),
            contribution_percent: 65,
            hostname: format!("host-{node_id}"),
            identity_trust_path: IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK.to_string(),
            power_source: "AC Power".to_string(),
            on_battery: false,
            battery_percent: None,
            policy_allowed: true,
            policy_reason: None,
            worker_health,
        }
    }

    fn ready_state() -> ControlPlaneState {
        let mut state = ControlPlaneState::default();
        state.register(m_series_registration("node-1"));
        state.heartbeat(ready_heartbeat("node-1", "1"), "1".to_string());
        state
    }

    #[test]
    fn default_policy_admits_ready_vllm_node() {
        let mut state = ControlPlaneState::default();
        state.register(vllm_registration("node-vllm"));

        let node = state.heartbeat(ready_vllm_heartbeat("node-vllm", "1"), "1".to_string());

        assert!(node.policy_allowed, "{:?}", node.policy_reason);
        assert_eq!(node.backend, Backend::Vllm);
    }

    #[test]
    fn ready_vllm_node_can_claim_default_job_without_llama_cli() {
        let mut state = ControlPlaneState::default();
        let mut request = classification_request("hello world");
        request.model = None;
        state.submit_job(request, "1".to_string());
        state.register(vllm_registration("node-vllm"));
        state.heartbeat(ready_vllm_heartbeat("node-vllm", "2"), "2".to_string());

        let claim = state.claim_job("node-vllm", "3".to_string()).job;

        assert!(claim.is_some());
    }

    #[test]
    fn admission_policy_blocks_disallowed_backend() {
        let mut state = ControlPlaneState::default();
        state.register(m_series_registration("node-1"));
        state.set_admission_policy(
            AdmissionPolicyUpdate {
                enforce_model_policy: false,
                allowed_models: crate::contracts::official_model_names(),
                enabled: true,
                require_trusted_identity: false,
                require_healthy_runtime: true,
                min_memory_mb: 0,
                min_cuda_vram_mb: 0,
                allowed_backends: vec![Backend::Cuda],
                actor: Some("operator".to_string()),
            },
            "1".to_string(),
        );

        let node = state.heartbeat(ready_heartbeat("node-1", "2"), "2".to_string());

        assert!(!node.policy_allowed);
        assert_eq!(node.computed_policy_allowed, false);
        assert!(node
            .policy_reason
            .as_deref()
            .unwrap_or_default()
            .contains("backend m is not allowed by admission policy"));
    }

    #[test]
    fn model_policy_quarantines_unknown_models_for_investigation() {
        let mut policy = AdmissionPolicy::default();
        policy.enforce_model_policy = true;
        let health = healthy_worker_health("1");

        let (allowed, reason) = evaluate_admission_policy(
            true,
            None,
            &policy,
            Backend::M,
            crate::contracts::IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK,
            16_000,
            &health,
        );

        assert!(!allowed);
        assert!(reason
            .as_deref()
            .is_some_and(|value| value.contains("under investigation")));
    }

    #[test]
    fn admission_policy_blocks_underpowered_cuda_node() {
        let mut state = ControlPlaneState::default();
        state.register(cuda_registration("node-cuda"));
        state.set_admission_policy(
            AdmissionPolicyUpdate {
                enforce_model_policy: false,
                allowed_models: crate::contracts::official_model_names(),
                enabled: true,
                require_trusted_identity: false,
                require_healthy_runtime: true,
                min_memory_mb: 0,
                min_cuda_vram_mb: 8192,
                allowed_backends: vec![Backend::Cuda],
                actor: Some("operator".to_string()),
            },
            "1".to_string(),
        );
        let mut heartbeat = low_vram_cuda_heartbeat("node-cuda", "2");
        heartbeat.available_memory_mb = 16_000;
        heartbeat.worker_health.cuda_memory_mb = Some(4096);

        let node = state.heartbeat(heartbeat, "2".to_string());

        assert!(!node.policy_allowed);
        assert!(node
            .policy_reason
            .as_deref()
            .unwrap_or_default()
            .contains("CUDA VRAM 4096 MB is below admission minimum 8192 MB"));
    }

    #[test]
    fn admission_policy_reapplies_to_existing_nodes() {
        let mut state = ready_state();
        assert!(state.nodes.get("node-1").expect("node").policy_allowed);

        state.set_admission_policy(
            AdmissionPolicyUpdate {
                enforce_model_policy: false,
                allowed_models: crate::contracts::official_model_names(),
                enabled: true,
                require_trusted_identity: true,
                require_healthy_runtime: true,
                min_memory_mb: 0,
                min_cuda_vram_mb: 0,
                allowed_backends: vec![Backend::M],
                actor: Some("operator".to_string()),
            },
            "2".to_string(),
        );

        let node = state.nodes.get("node-1").expect("node");
        assert!(!node.policy_allowed);
        assert!(node
            .policy_reason
            .as_deref()
            .unwrap_or_default()
            .contains("trusted identity is required by admission policy"));
    }

    fn completed_graph_history_job(
        job_id: &str,
        node_id: &str,
        status: JobGraphNodeStatus,
        latency_ms: Option<u64>,
    ) -> JobRecord {
        let graph_node = JobGraphNode {
            id: format!("{job_id}.chunk"),
            name: "Historical chunk".to_string(),
            responsibility: "section".to_string(),
            depends_on: Vec::new(),
            required_output: "historical scheduler telemetry".to_string(),
            recommended_max_tokens: None,
            minimum_max_tokens: None,
            workload: StepWorkloadRequirements::default(),
            status,
            blocked_by: Vec::new(),
            assigned_node_id: Some(node_id.to_string()),
            assigned_at: Some("1".to_string()),
            started_at: Some("1".to_string()),
            completed_at: Some("2".to_string()),
            worker_id: Some(format!("worker-{node_id}")),
            backend: Some(Backend::M),
            model: Some("demo".to_string()),
            runtime_mode: Some(RuntimeMode::Local.as_str().to_string()),
            effective_max_tokens: Some(512),
            queue_wait_ms: Some(0),
            runtime_ms: latency_ms,
            latency_ms,
            output_chars: Some(12),
            estimated_output_tokens: Some(3),
            attempt_count: 1,
            max_attempts: DEFAULT_GRAPH_NODE_MAX_ATTEMPTS,
            failed_node_ids: Vec::new(),
            output: if status == JobGraphNodeStatus::Completed {
                Some("chunk output".to_string())
            } else {
                None
            },
            error: if status == JobGraphNodeStatus::Failed {
                Some("runtime failed".to_string())
            } else {
                None
            },
        };
        JobRecord {
            job_id: job_id.to_string(),
            request_id: job_id.to_string(),
            prompt: "historical telemetry job".to_string(),
            preferred_backend: Backend::Auto,
            routing_mode: RoutingMode::Normal,
            runtime_mode: RuntimeMode::Local,
            stream: false,
            model: Some("demo".to_string()),
            mode: None,
            system_prompt: None,
            max_tokens: None,
            max_tokens_source: None,
            temperature: None,
            top_p: None,
            seed: None,
            classification: RequestClassification::default(),
            scheduling_requirements: JobSchedulingRequirements::default(),
            scheduler_decision: None,
            fallback_decision: FallbackDecision::default(),
            plan: JobPlan::default(),
            graph: JobGraph {
                graph_id: format!("graph-{job_id}"),
                request_id: job_id.to_string(),
                plan_id: format!("plan-{job_id}"),
                status: if status == JobGraphNodeStatus::Completed {
                    JobGraphStatus::Completed
                } else {
                    JobGraphStatus::Failed
                },
                nodes: vec![graph_node],
                results: Vec::new(),
                final_output: None,
                merge_error: None,
                synthesis_status: SynthesisStatus::Collecting,
                final_manifest: None,
                final_node_id: None,
                created_at: "1".to_string(),
                updated_at: "2".to_string(),
            },
            execution_mode: JobExecutionMode::Decompose,
            graph_execution_enabled: true,
            active_graph_node_id: None,
            last_completed_graph_node_id: None,
            status: if status == JobGraphNodeStatus::Completed {
                JobStatus::Completed
            } else {
                JobStatus::Failed
            },
            submitted_at: "1".to_string(),
            assigned_node_id: Some(node_id.to_string()),
            assigned_at: Some("1".to_string()),
            completed_at: Some("2".to_string()),
            worker_id: Some(format!("worker-{node_id}")),
            backend: Some(Backend::M),
            output: None,
            error: None,
        }
    }

    fn make_reducer_ready(state: &mut ControlPlaneState, job_id: &str) {
        let job = state.jobs.get_mut(job_id).expect("job");
        let final_node_id = job.graph.final_node_id.clone().expect("final node");
        for node in &mut job.graph.nodes {
            if node.id != final_node_id {
                node.status = JobGraphNodeStatus::Completed;
                node.output = Some(format!("{} complete", node.name));
                node.error = None;
                node.completed_at = Some("4".to_string());
            }
        }
        refresh_job_graph(&mut job.graph);
        job.status = JobStatus::Queued;
        job.active_graph_node_id = next_ready_graph_node_id(&job.graph);
    }

    fn classification_request(prompt: &str) -> JobRequest {
        JobRequest {
            request_id: "job-1".to_string(),
            prompt: prompt.to_string(),
            preferred_backend: Backend::Auto,
            routing_mode: RoutingMode::Normal,
            runtime_mode: RuntimeMode::Local,
            execution_mode: JobExecutionMode::Single,
            stream: false,
            model: Some("demo".to_string()),
            system_prompt: None,
            max_tokens: None,
            max_tokens_source: None,
            temperature: None,
            top_p: None,
            seed: None,
        }
    }

    fn reducer_fixture_request() -> JobRequest {
        classification_request(
            "Design and implement a backend API plus frontend dashboard and add tests.",
        )
    }

    #[test]
    fn classifies_interactive_chat_requests() {
        let mut request = classification_request("Reply to the user in a short conversation.");
        request.runtime_mode = RuntimeMode::Interactive;

        let classification = classify_job_request(&request);

        assert_eq!(classification.task_type, RequestTaskType::Chat);
        assert_eq!(classification.output_format, ExpectedOutputFormat::Text);
        assert_eq!(classification.context_size, ContextSize::Small);
        assert!(classification
            .execution_constraints
            .contains(&"runtime:interactive".to_string()));
    }

    #[test]
    fn classifies_coding_requests() {
        let request = classification_request(
            "Debug this Rust API bug and return a patch with tests for the failing function.",
        );

        let classification = classify_job_request(&request);

        assert_eq!(classification.task_type, RequestTaskType::Coding);
        assert_eq!(classification.complexity, RequestComplexity::Medium);
        assert_eq!(classification.output_format, ExpectedOutputFormat::Code);
    }

    #[test]
    fn chat_system_prompt_does_not_force_history_requests_into_code_plans() {
        let mut request =
            classification_request("Now tell me the history of Mercedes-Benz from its origins.");
        request.execution_mode = JobExecutionMode::Auto;
        request.system_prompt = Some(
            "If the request asks for a full program or code, provide complete useful code."
                .to_string(),
        );

        let classification = classify_job_request(&request);
        let plan = plan_job_request(&request, &classification);

        assert_ne!(classification.task_type, RequestTaskType::Coding);
        assert_eq!(plan.strategy, "sectioned_research");
        assert!(plan
            .jobs
            .iter()
            .any(|job| job.name == "Origins and founders"));
        assert!(!plan
            .jobs
            .iter()
            .any(|job| job.name == "Complete source code"));
    }

    #[test]
    fn sectioned_research_honors_user_requested_split_sections() {
        let mut request = classification_request(
            "Write a detailed history of Microsoft from its origins to today, split by founding, early years, expansion, cloud era, AI era, and summary.",
        );
        request.execution_mode = JobExecutionMode::Decompose;

        let classification = classify_job_request(&request);
        let plan = plan_job_request(&request, &classification);

        assert_eq!(plan.strategy, "sectioned_research");
        let names = plan
            .jobs
            .iter()
            .map(|job| job.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "Founding",
                "Early Years",
                "Expansion",
                "Cloud Era",
                "AI Era",
                "Summary",
                "Final synthesis",
            ]
        );
        assert!(plan
            .jobs
            .iter()
            .filter(|job| job.responsibility != "merge")
            .all(|job| job
                .required_output
                .contains("Do not include any other requested section")));
        assert_eq!(
            plan.jobs.last().map(|job| job.responsibility.as_str()),
            Some("merge")
        );
    }

    #[test]
    fn comparison_prompts_use_comparison_sections_not_history_sections() {
        let mut request = classification_request(
            "Compare Ethereum, Solana, and Polygon for decentralized apps. Cover architecture, performance, developer ecosystem, costs, risks, and recommendation.",
        );
        request.execution_mode = JobExecutionMode::Auto;

        let classification = classify_job_request(&request);
        let plan = plan_job_request(&request, &classification);

        assert_eq!(plan.strategy, "sectioned_comparison");
        let names = plan
            .jobs
            .iter()
            .map(|job| job.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "Architecture",
                "Performance",
                "Developer ecosystem",
                "Costs",
                "Risks",
                "Recommendation",
            ]
        );
        assert!(!plan
            .jobs
            .iter()
            .any(|job| job.name == "Origins and founders"));
    }

    #[test]
    fn smart_contract_mainnet_request_uses_ordered_deployment_plan() {
        let mut request = classification_request(
            "Give me a detailed step in deploying a smart contract into mainet?",
        );
        request.execution_mode = JobExecutionMode::Auto;

        let classification = classify_job_request(&request);
        let plan = plan_job_request(&request, &classification);
        let graph = build_job_graph("job-1", &plan, "1");

        assert_eq!(plan.strategy, "deployment_procedure");
        let names = plan
            .jobs
            .iter()
            .map(|job| job.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "Prerequisites and network setup",
                "Contract readiness and security",
                "Testnet deployment and validation",
                "Mainnet deployment",
                "Verification and operations",
                "Final synthesis",
            ]
        );
        assert!(!names.contains(&"Origins and founders"));
        assert!(!names.contains(&"Early development"));
        assert_eq!(graph.final_node_id.as_deref(), Some("job.final_synthesis"));
        assert_eq!(
            plan.jobs[3].depends_on,
            vec!["job.testnet_validation".to_string()]
        );
    }

    #[test]
    fn product_plan_prompts_return_user_facing_sections_without_reducer() {
        let mut request = classification_request(
            "Create a full product description, technical architecture, and launch plan for MundusX.AI.",
        );
        request.execution_mode = JobExecutionMode::Auto;

        let classification = classify_job_request(&request);
        let plan = plan_job_request(&request, &classification);
        let graph = build_job_graph("job-1", &plan, "1");

        assert_eq!(plan.strategy, "sectioned_product_plan");
        assert!(plan
            .jobs
            .iter()
            .any(|job| job.name == "Product description"));
        assert!(plan
            .jobs
            .iter()
            .any(|job| job.name == "Technical architecture"));
        assert!(plan.jobs.iter().any(|job| job.name == "Launch plan"));
        assert!(!plan.jobs.iter().any(|job| job.responsibility == "merge"));
        assert_eq!(graph.final_node_id, None);
        assert_eq!(graph.nodes.len(), 3);
    }

    #[test]
    fn detailed_c_binary_file_program_uses_complete_code_plan() {
        let mut request = classification_request(
            "i need a deatailed program in C, to store students record, id,fname,lname,bdate, age in binary file, and i need to read the file and print the record of a student with id 1001",
        );
        request.execution_mode = JobExecutionMode::Auto;
        request.max_tokens = Some(4_096);

        let classification = classify_job_request(&request);
        let plan = plan_job_request(&request, &classification);
        let graph = build_job_graph("job-1", &plan, "1");

        assert_eq!(classification.task_type, RequestTaskType::Coding);
        assert_eq!(classification.output_format, ExpectedOutputFormat::Code);
        assert!(classification
            .execution_constraints
            .contains(&"complete_code_output".to_string()));
        assert_eq!(plan.strategy, "complete_code_generation");
        assert!(plan.jobs.iter().any(|job| job.name == "Code contract"));
        assert!(plan
            .jobs
            .iter()
            .any(|job| job.name == "Binary write functions"));
        assert!(plan
            .jobs
            .iter()
            .any(|job| job.name == "Binary search and read functions"));
        assert!(plan
            .jobs
            .iter()
            .any(|job| job.name == "Main menu and demo flow"));
        assert_eq!(graph.final_node_id.as_deref(), Some("job.final_merge"));
    }

    #[test]
    fn classifies_document_style_requests() {
        let request = classification_request(
            "Draft a customer-facing implementation report in markdown with a checklist.",
        );

        let classification = classify_job_request(&request);

        assert_eq!(classification.task_type, RequestTaskType::Document);
        assert_eq!(classification.privacy_level, PrivacyLevel::Internal);
        assert_eq!(classification.output_format, ExpectedOutputFormat::Markdown);
    }

    #[test]
    fn classifies_generic_inference_requests() {
        let request = classification_request("Estimate the next number in this sequence: 2, 4, 8.");

        let classification = classify_job_request(&request);

        assert_eq!(classification.task_type, RequestTaskType::Inference);
        assert_eq!(classification.complexity, RequestComplexity::Low);
        assert_eq!(classification.privacy_level, PrivacyLevel::Public);
    }

    #[test]
    fn stores_classification_before_scheduling() {
        let mut state = ControlPlaneState::default();
        let record = state.submit_job(
            classification_request("Return JSON for this public inference request."),
            "1".to_string(),
        );

        assert_eq!(record.status, JobStatus::Queued);
        assert_eq!(
            record.classification.output_format,
            ExpectedOutputFormat::Json
        );
        assert_eq!(
            state
                .jobs
                .get("job-1")
                .map(|job| job.classification.output_format),
            Some(ExpectedOutputFormat::Json)
        );
    }

    #[test]
    fn stores_scheduling_requirements_before_claiming() {
        let mut state = ControlPlaneState::default();
        let record = state.submit_job(
            classification_request("Fix this Rust API bug and return markdown docs."),
            "1".to_string(),
        );

        assert_eq!(
            record.scheduling_requirements.task_type,
            RequestTaskType::Coding
        );
        assert_eq!(
            record.scheduling_requirements.output_format,
            ExpectedOutputFormat::Code
        );
        assert_eq!(
            record.scheduling_requirements.language.as_deref(),
            Some("rust")
        );
        let decision = record.scheduler_decision.expect("scheduler decision");
        assert_eq!(decision.node_id, "");
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.contains("no compatible node slot")));
    }

    #[test]
    fn queued_job_records_no_capacity_before_nodes_arrive() {
        let mut state = ControlPlaneState::default();
        let record = state.submit_job(classification_request("hello world"), "1".to_string());

        assert_eq!(record.status, JobStatus::Queued);
        let decision = record.scheduler_decision.expect("scheduler decision");
        assert_eq!(decision.node_id, "");
        assert_eq!(decision.score, 0);
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.contains("no compatible node slot")));
    }

    #[test]
    fn unassigned_graph_job_expires_when_no_worker_arrives() {
        let mut state = ControlPlaneState::default();
        let record = state.submit_job(
            JobRequest {
                request_id: "job-queued-graph".to_string(),
                prompt: "Give me a detailed history of apple from its origins to today."
                    .to_string(),
                preferred_backend: Backend::Auto,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Decompose,
                stream: false,
                model: Some("Qwen/Qwen2.5-1.5B-Instruct".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "1".to_string(),
        );

        assert_eq!(record.status, JobStatus::Queued);
        assert!(record.graph_execution_enabled);
        assert_eq!(
            record
                .graph
                .nodes
                .iter()
                .filter(|node| node.status == JobGraphNodeStatus::Ready)
                .count(),
            4
        );

        let changed = state.run_maintenance("601");

        assert_eq!(changed.len(), 1);
        let job = state.jobs.get("job-queued-graph").expect("job");
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.completed_at.as_deref(), Some("601"));
        assert!(job
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("queued job expired after 600s"));
        assert!(job
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("waiting_for_role:chunk_analysis"));
        assert!(job
            .graph
            .nodes
            .iter()
            .all(|node| node.status == JobGraphNodeStatus::Failed));
    }

    #[test]
    fn incompatible_node_arrival_keeps_queued_job_without_resubmission() {
        let mut state = ControlPlaneState::default();
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "1".to_string(),
        );
        state.register(AgentRegistration {
            node_id: "node-cuda".to_string(),
            public_key_fingerprint: "fingerprint-cuda".to_string(),
            public_key_hex: "hex-cuda".to_string(),
            hostname: "host-cuda".to_string(),
            identity_trust_path: IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK.to_string(),
            backend: Backend::Cuda,
            contribution_percent: 50,
            agent_version: "0.1.0".to_string(),
        });
        let mut heartbeat = ready_heartbeat("node-cuda", "2");
        heartbeat.backend = Backend::Cuda;
        heartbeat.worker_health.model_name = Some("other".to_string());
        state.heartbeat(heartbeat, "2".to_string());

        let job = state.jobs.get("job-1").expect("job");
        assert_eq!(job.status, JobStatus::Queued);
        let decision = job.scheduler_decision.as_ref().expect("scheduler decision");
        assert_eq!(decision.node_id, "");
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.contains("no compatible node slot")));
    }

    #[test]
    fn compatible_node_arrival_scores_queued_job_without_resubmission() {
        let mut state = ControlPlaneState::default();
        state.submit_job(classification_request("hello world"), "1".to_string());

        state.register(m_series_registration("node-1"));
        state.heartbeat(ready_heartbeat("node-1", "2"), "2".to_string());

        let job = state.jobs.get("job-1").expect("job");
        assert_eq!(job.status, JobStatus::Queued);
        let decision = job.scheduler_decision.as_ref().expect("scheduler decision");
        assert_eq!(decision.node_id, "node-1");
        assert!(decision.score > 0);

        let claim = state.claim_job("node-1", "3".to_string());
        assert_eq!(
            claim.job.map(|job| (job.job_id, job.status)),
            Some(("job-1".to_string(), JobStatus::Assigned))
        );
    }

    #[test]
    fn auto_max_tokens_expand_for_claiming_node_capacity() {
        let mut state = ready_state();
        let mut request = classification_request("Explain why local inference can be slow");
        request.max_tokens = Some(512);
        request.max_tokens_source = Some("auto".to_string());
        state.submit_job(request, "2".to_string());

        let claim = state.claim_job("node-1", "3".to_string());
        let claimed_job = claim.job.expect("claimed job");

        assert_eq!(claimed_job.max_tokens, Some(1_024));
    }

    #[test]
    fn compact_reviewed_code_plan_caps_each_generation_stage() {
        let mut state = ready_state();
        let mut request = classification_request(
            "Create a Node.js Express CRUD API for customers, with Markdown documentation and a code review.",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        request.max_tokens = Some(3_072);
        request.max_tokens_source = Some("auto".to_string());
        let record = state.submit_job(request, "2".to_string());
        let node = state.nodes.get("node-1").expect("ready node");

        assert_eq!(
            graph_node_max_tokens(&record, "job.backend", Some(node)),
            2_048
        );
        assert_eq!(
            graph_node_max_tokens(&record, "job.code_review", Some(node)),
            512
        );
    }

    #[test]
    fn dependent_graph_queue_wait_starts_when_dependencies_complete() {
        let mut state = ready_state();
        let mut request = classification_request(
            "Create a Node.js Express CRUD API for customers, with Markdown documentation and a code review.",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        let mut record = state.submit_job(request, "10".to_string());
        record
            .graph
            .nodes
            .iter_mut()
            .find(|node| node.id == "job.backend")
            .expect("backend")
            .completed_at = Some("40".to_string());

        assert_eq!(graph_node_ready_at(&record, "job.backend"), "10");
        assert_eq!(graph_node_ready_at(&record, "job.code_review"), "40");
        assert_eq!(
            elapsed_ms_between(&graph_node_ready_at(&record, "job.code_review"), "43"),
            Some(3_000)
        );

        let backend = record
            .graph
            .nodes
            .iter_mut()
            .find(|node| node.id == "job.backend")
            .expect("backend");
        backend.attempt_count = 1;
        backend.completed_at = Some("50".to_string());
        assert_eq!(graph_node_ready_at(&record, "job.backend"), "50");
    }

    #[test]
    fn create_me_fibonacci_program_is_classified_as_complete_code() {
        let mut request = classification_request("create me a fibonacci program in java");
        request.max_tokens = Some(1_536);
        request.max_tokens_source = Some("auto".to_string());

        let classification = classify_job_request(&request);
        assert_eq!(classification.task_type, RequestTaskType::Coding);
        assert_eq!(classification.output_format, ExpectedOutputFormat::Code);
        assert_eq!(classification.complexity, RequestComplexity::High);

        let mut state = ready_state();
        state.submit_job(request, "2".to_string());
        let claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("coding job claim");
        assert!(claim.max_tokens.expect("dynamic budget") >= 1_536);
    }

    #[test]
    fn explicit_max_tokens_do_not_expand_for_claiming_node_capacity() {
        let mut state = ready_state();
        let mut request = classification_request("Explain why local inference can be slow");
        request.max_tokens = Some(512);
        request.max_tokens_source = Some("explicit".to_string());
        state.submit_job(request, "2".to_string());

        let claim = state.claim_job("node-1", "3".to_string());
        let claimed_job = claim.job.expect("claimed job");

        assert_eq!(claimed_job.max_tokens, Some(512));
    }

    #[test]
    fn synthesis_budget_uses_planner_hint_and_completed_dependency_volume() {
        let mut state = ready_state();
        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Decompose;
        request.max_tokens = Some(512);
        request.max_tokens_source = None;
        let mut job = state.submit_job(request, "2".to_string());
        let final_node_id = job.graph.final_node_id.clone().expect("final node");

        for node in &mut job.graph.nodes {
            if node.id == final_node_id {
                node.responsibility = "synthesize".to_string();
                node.recommended_max_tokens = Some(3_072);
                node.minimum_max_tokens = Some(1_024);
            } else {
                node.status = JobGraphNodeStatus::Completed;
                node.output = Some("evidence ".repeat(500));
                node.estimated_output_tokens = Some(1_000);
            }
        }

        let claiming_node = state.nodes.get("node-1").expect("ready node");
        let budget = graph_node_max_tokens(&job, &final_node_id, Some(claiming_node));

        assert!(budget >= 3_072);
        assert!(budget <= node_generation_ceiling(Some(claiming_node)));
    }

    #[test]
    fn detects_only_near_budget_incomplete_synthesis_outputs() {
        assert!(output_appears_token_limited(
            &format!("Detailed history {}", "continued ".repeat(220)),
            384,
        ));
        assert!(!output_appears_token_limited(
            &format!("Detailed history {}.", "complete ".repeat(220)),
            384,
        ));
        assert!(!output_appears_token_limited(
            "Short but complete enough",
            2_048
        ));
    }

    #[test]
    fn rejects_malformed_or_repetitive_compact_code_outputs() {
        let valid = "```javascript\nconst express = require('express');\nfunction start() { return express(); }\nmodule.exports = { start };\n```\n\n## Run\nUse `node server.js`.";
        assert_eq!(compact_code_output_failure_reason(valid, 2_048), None);

        let unmatched = "```javascript\nfunction start() {\n  return true;\n";
        assert_eq!(
            compact_code_output_failure_reason(unmatched, 2_048).as_deref(),
            Some("has an unmatched Markdown code fence")
        );

        let repetitive = "```javascript\nfunction validate(input) {\n  return input;\n}\nfunction validate(input) {\n  return input;\n}\nfunction validate(input) {\n  return input;\n}\n```";
        assert_eq!(
            compact_code_output_failure_reason(repetitive, 2_048).as_deref(),
            Some("contains repeated source declarations")
        );
    }

    #[test]
    fn stale_busy_node_is_marked_stopped_and_not_counted_online() {
        let mut state = ControlPlaneState::default();
        state.register(m_series_registration("node-1"));
        let mut heartbeat = ready_heartbeat("node-1", "1");
        heartbeat.agent_state = AgentState::Busy;
        state.heartbeat(heartbeat, "1".to_string());

        state.run_maintenance("62");

        let node = state.nodes.get("node-1").expect("node exists");
        assert_eq!(node.reported_state, AgentState::Busy);
        assert_eq!(node.state, AgentState::Stopped);
        assert!(!node.policy_allowed);
        assert!(node
            .policy_reason
            .as_deref()
            .expect("stale reason")
            .contains("heartbeat stale"));
        let snapshot = state.snapshot("memory");
        assert_eq!(snapshot["online_count"].as_u64(), Some(0));
        assert_eq!(snapshot["stopped_count"].as_u64(), Some(1));
    }

    #[test]
    fn maintenance_reports_stale_nodes_for_persistence() {
        let mut state = ControlPlaneState::default();
        state.register(m_series_registration("node-1"));
        state.heartbeat(ready_heartbeat("node-1", "1"), "1".to_string());

        let maintenance = state.run_maintenance_with_nodes("62");

        assert!(maintenance.changed_jobs.is_empty());
        assert_eq!(maintenance.changed_nodes.len(), 1);
        let node = maintenance.changed_nodes.first().expect("changed node");
        assert_eq!(node.node_id, "node-1");
        assert_eq!(node.state, AgentState::Stopped);
        assert!(!node.policy_allowed);
        assert!(node
            .policy_reason
            .as_deref()
            .expect("stale reason")
            .contains("heartbeat stale"));
    }

    #[test]
    fn fresh_heartbeat_restores_stale_node_for_claims() {
        let mut state = ControlPlaneState::default();
        state.register(m_series_registration("node-1"));
        state.heartbeat(ready_heartbeat("node-1", "1"), "1".to_string());
        state.run_maintenance("62");
        state.submit_job(classification_request("hello world"), "63".to_string());

        assert!(state.claim_job("node-1", "64".to_string()).job.is_none());

        state.heartbeat(ready_heartbeat("node-1", "65"), "65".to_string());
        let claim = state.claim_job("node-1", "66".to_string()).job;
        assert!(claim.is_some());
        assert_eq!(
            state.nodes.get("node-1").map(|node| node.state),
            Some(AgentState::Busy)
        );
    }

    #[test]
    fn paused_policy_node_does_not_satisfy_queued_job() {
        let mut state = ControlPlaneState::default();
        state.submit_job(classification_request("hello world"), "1".to_string());
        state.register(m_series_registration("node-1"));
        state.heartbeat(ready_heartbeat("node-1", "2"), "2".to_string());
        state
            .set_node_policy_override(
                "node-1",
                Some(NodePolicyOverrideInput {
                    target: NodePolicyOverrideTarget::Paused,
                    reason: "maintenance".to_string(),
                    actor: "operator".to_string(),
                    updated_at: "3".to_string(),
                }),
            )
            .expect("policy override");

        let job = state.jobs.get("job-1").expect("job");
        assert_eq!(job.status, JobStatus::Queued);
        assert_eq!(
            job.scheduler_decision
                .as_ref()
                .map(|decision| decision.node_id.as_str()),
            Some("")
        );
        assert!(state.claim_job("node-1", "4".to_string()).job.is_none());
    }

    #[test]
    fn runtime_or_model_mismatch_keeps_job_queued() {
        let mut state = ControlPlaneState::default();
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Interactive,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("missing-model".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "1".to_string(),
        );
        state.register(m_series_registration("node-1"));
        let mut heartbeat = ready_heartbeat("node-1", "2");
        heartbeat.worker_health.supported_runtime_modes = vec![RuntimeMode::Local];
        heartbeat.worker_health.model_name = Some("demo".to_string());
        state.heartbeat(heartbeat, "2".to_string());

        let job = state.jobs.get("job-1").expect("job");
        assert_eq!(job.status, JobStatus::Queued);
        assert_eq!(
            job.scheduler_decision
                .as_ref()
                .map(|decision| decision.node_id.as_str()),
            Some("")
        );
        assert!(state.claim_job("node-1", "3".to_string()).job.is_none());
    }

    #[test]
    fn marks_simple_local_requests_as_not_needing_fallback() {
        let request = classification_request("Estimate the next number in this sequence: 2, 4, 8.");
        let classification = classify_job_request(&request);
        let requirements = scheduling_requirements_for(&request, &classification);

        let decision = fallback_decision_for(&requirements);

        assert_eq!(decision.status, FallbackDecisionStatus::NotNeeded);
        assert_eq!(decision.provider, None);
        assert!(decision.triggers.is_empty());
        assert!(decision.blocked_reasons.is_empty());
    }

    #[test]
    fn requires_operator_approval_for_public_large_context_fallback() {
        let mut request = classification_request(
            "Summarize this public dataset with a very long transcript and return markdown.",
        );
        request.max_tokens = Some(16_000);
        let classification = classify_job_request(&request);
        let requirements = scheduling_requirements_for(&request, &classification);

        let decision = fallback_decision_for(&requirements);

        assert_eq!(decision.status, FallbackDecisionStatus::RequiresApproval);
        assert_eq!(
            decision.provider,
            Some(crate::contracts::FallbackProvider::OperatorApprovedStrongerModel)
        );
        assert!(decision.triggers.contains(&"large_context".to_string()));
        assert!(decision.requires_operator_approval);
        assert_eq!(decision.max_cost_cents, Some(25));
    }

    #[test]
    fn blocks_sensitive_requests_from_stronger_model_fallback() {
        let request = classification_request(
            "Analyze private credentials, secrets, and confidential customer data as JSON.",
        );
        let classification = classify_job_request(&request);
        let requirements = scheduling_requirements_for(&request, &classification);

        let decision = fallback_decision_for(&requirements);

        assert_eq!(decision.status, FallbackDecisionStatus::Blocked);
        assert_eq!(decision.provider, None);
        assert!(decision
            .blocked_reasons
            .iter()
            .any(|reason| reason.contains("privacy level Sensitive")));
    }

    #[test]
    fn stores_fallback_decision_with_submitted_job() {
        let mut state = ControlPlaneState::default();
        let record = state.submit_job(
            classification_request("Return JSON for this public inference request."),
            "1".to_string(),
        );

        assert_eq!(
            record.fallback_decision.status,
            FallbackDecisionStatus::RequiresApproval
        );
        assert_eq!(
            state
                .jobs
                .get("job-1")
                .map(|job| job.fallback_decision.status),
            Some(FallbackDecisionStatus::RequiresApproval)
        );
    }

    #[test]
    fn plans_simple_requests_as_single_execution_unit() {
        let request = classification_request("Estimate the next number in this sequence: 2, 4, 8.");
        let classification = classify_job_request(&request);

        let plan = plan_job_request(&request, &classification);

        assert_eq!(plan.strategy, "single_job");
        assert_eq!(plan.jobs.len(), 1);
        assert_eq!(plan.jobs[0].responsibility, "inference");
        assert!(plan.jobs[0].depends_on.is_empty());
    }

    #[test]
    fn plans_complex_coding_requests_by_responsibility() {
        let request = classification_request(
            "Design and implement a backend API plus frontend dashboard, add tests, update docs, and include a security review.",
        );
        let classification = classify_job_request(&request);

        let plan = plan_job_request(&request, &classification);
        let responsibilities = plan
            .jobs
            .iter()
            .map(|job| job.responsibility.as_str())
            .collect::<Vec<_>>();

        assert_eq!(plan.strategy, "responsibility_based");
        assert!(responsibilities.contains(&"analysis"));
        assert!(responsibilities.contains(&"backend"));
        assert!(responsibilities.contains(&"frontend"));
        assert!(responsibilities.contains(&"tests"));
        assert!(responsibilities.contains(&"documentation"));
        assert!(responsibilities.contains(&"security"));
        assert!(responsibilities.contains(&"merge"));

        let final_merge = plan
            .jobs
            .iter()
            .find(|job| job.id == "job.final_merge")
            .expect("final merge job");
        assert!(final_merge.depends_on.contains(&"job.backend".to_string()));
        assert!(final_merge.depends_on.contains(&"job.frontend".to_string()));
        assert!(final_merge.depends_on.contains(&"job.tests".to_string()));
    }

    #[test]
    fn plans_word_only_crud_documentation_and_review_as_dependency_aware_work() {
        let request = classification_request(
            "i need nodejs program using express, i want api to produce CRUD operations to a customer model (firstname, lastname, birthdate, gender), with md documentation and code review",
        );
        let classification = classify_job_request(&request);
        let plan = plan_job_request(&request, &classification);

        assert_eq!(classification.task_type, RequestTaskType::Coding);
        assert_eq!(plan.strategy, "compact_reviewed_code_delivery");
        assert_eq!(plan.jobs.len(), 2);
        let backend = plan
            .jobs
            .iter()
            .find(|job| job.id == "job.backend")
            .expect("backend");
        let review = plan
            .jobs
            .iter()
            .find(|job| job.id == "job.code_review")
            .expect("review");
        assert!(backend.depends_on.is_empty());
        assert_eq!(review.depends_on, vec!["job.backend".to_string()]);
        assert!(backend.required_output.contains("Markdown"));
        assert_eq!(backend.workload.context_budget_tokens, 4_096);
        assert_eq!(review.workload.context_budget_tokens, 4_096);
        assert!(plan.jobs.iter().all(|job| job.id != "job.scope"));
        assert!(plan.jobs.iter().all(|job| job.id != "job.tests"));
        assert!(plan.jobs.iter().all(|job| job.id != "job.final_merge"));
    }

    #[test]
    fn compact_reviewed_code_graph_runs_review_after_complete_delivery() {
        let mut state = ready_state();
        let mut request = classification_request(
            "Create a Node.js Express CRUD API for customers, with Markdown documentation and a code review.",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        request.max_tokens = Some(3_072);
        request.max_tokens_source = Some("auto".to_string());

        let record = state.submit_job(request, "1".to_string());

        assert_eq!(record.plan.strategy, "compact_reviewed_code_delivery");
        assert_eq!(record.graph.final_node_id, None);
        assert_eq!(record.graph.nodes.len(), 2);
        assert_eq!(record.graph.nodes[0].id, "job.backend");
        assert_eq!(record.graph.nodes[0].status, JobGraphNodeStatus::Ready);

        state
            .update_graph_node(
                "job-1",
                "job.backend",
                JobGraphNodeStatus::Completed,
                Some("```js\nconst express = require('express');\n```".to_string()),
                None,
                "2".to_string(),
            )
            .expect("complete implementation");

        let graph = &state.jobs.get("job-1").expect("job").graph;
        let ready_ids = graph
            .nodes
            .iter()
            .filter(|node| node.status == JobGraphNodeStatus::Ready)
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ready_ids, vec!["job.code_review"]);
        let review_prompt = graph_node_execution_prompt(
            state.jobs.get("job-1").expect("job"),
            "job.code_review",
            state.nodes.get("node-1"),
        );
        assert!(review_prompt.contains("Accepted dependency output"));
        assert!(review_prompt.contains("const express = require('express')"));
    }

    #[test]
    fn compact_reviewed_code_retries_invalid_implementation_before_review() {
        let mut state = ready_state();
        let mut request = classification_request(
            "Create a Node.js Express CRUD API for customers, with Markdown documentation and a code review.",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        request.max_tokens_source = Some("auto".to_string());
        state.submit_job(request, "1".to_string());

        let first_claim = state
            .claim_job("node-1", "2".to_string())
            .job
            .expect("implementation claim");
        assert_eq!(
            first_claim.active_graph_node_id.as_deref(),
            Some("job.backend")
        );

        let retried = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("```javascript\nfunction createCustomer() {".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "3".to_string(),
            )
            .expect("invalid implementation completion");

        assert_eq!(retried.status, JobStatus::Queued);
        let backend = retried
            .graph
            .nodes
            .iter()
            .find(|node| node.id == "job.backend")
            .expect("backend node");
        assert_eq!(backend.status, JobGraphNodeStatus::Ready);
        assert!(backend
            .error
            .as_deref()
            .is_some_and(|error| error.contains("unmatched Markdown code fence")));
        assert_eq!(
            retried
                .graph
                .nodes
                .iter()
                .find(|node| node.id == "job.code_review")
                .expect("review node")
                .status,
            JobGraphNodeStatus::Waiting
        );

        let retry_claim = state
            .claim_job("node-1", "4".to_string())
            .job
            .expect("implementation retry claim");
        assert_eq!(
            retry_claim.active_graph_node_id.as_deref(),
            Some("job.backend")
        );
        assert!(retry_claim.max_tokens >= first_claim.max_tokens);
        assert_eq!(
            retry_claim
                .graph
                .nodes
                .iter()
                .find(|node| node.id == "job.backend")
                .and_then(|node| node.recommended_max_tokens),
            Some(3_072)
        );
        assert!(retry_claim.prompt.contains("structural-validation retry"));
        assert!(retry_claim.prompt.contains("Do not repeat declarations"));
    }

    #[test]
    fn compact_reviewed_code_graph_assembles_outputs_without_a_reducer() {
        let request = classification_request(
            "Create a Node.js Express CRUD API for customers, with Markdown documentation and a code review.",
        );
        let classification = classify_job_request(&request);
        let plan = plan_job_request(&request, &classification);
        let mut graph = build_job_graph("job-1", &plan, "1");

        for node in &mut graph.nodes {
            node.status = JobGraphNodeStatus::Completed;
            node.output = Some(
                match node.id.as_str() {
                    "job.backend" => "```js\nconst express = require('express');\n```\n\nInstall dependencies and run the server.",
                    "job.code_review" => "No blocking correctness defects found.",
                    _ => unreachable!("unexpected compact-plan node"),
                }
                .to_string(),
            );
        }
        refresh_job_graph(&mut graph);
        refresh_graph_results(&mut graph, ExpectedOutputFormat::Code, None, None, None);

        let output = graph
            .final_output
            .expect("deterministically assembled output");
        assert_eq!(graph.final_node_id, None);
        assert_eq!(graph.synthesis_status, SynthesisStatus::Completed);
        assert!(graph
            .final_manifest
            .as_ref()
            .is_some_and(|manifest| manifest.complete));
        assert!(output.starts_with("Complete implementation and documentation\n```js"));
        assert!(output.contains("Install dependencies and run the server"));
        assert!(output.contains("Independent code review\nNo blocking"));
    }

    #[test]
    fn explicit_decomposition_rejects_an_external_single_job_collapse() {
        let mut request = classification_request(
            "i need nodejs program using express, i want api to produce CRUD operations to a customer model, with md documentation and code review",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        let classification = classify_job_request(&request);
        let deterministic = plan_job_request(&request, &classification);
        let collapsed = JobPlan {
            plan_id: "external-single".to_string(),
            strategy: "langgraph".to_string(),
            summary: "External planner collapsed the request.".to_string(),
            jobs: vec![deterministic.jobs[0].clone()],
        };

        assert!(deterministic.jobs.len() > 1);
        assert!(!external_plan_preserves_explicit_decomposition(
            &request,
            &deterministic,
            &collapsed,
        ));
        assert!(external_plan_preserves_explicit_decomposition(
            &request,
            &deterministic,
            &deterministic,
        ));
    }

    #[test]
    fn plans_documentation_summaries_without_blocked_dependency_chain() {
        let request = classification_request("Summarize the current control-plane architecture.");
        let classification = classify_job_request(&request);

        let plan = plan_job_request(&request, &classification);

        assert_eq!(classification.task_type, RequestTaskType::Document);
        assert_eq!(plan.strategy, "documentation_summary");
        assert_eq!(plan.jobs.len(), 1);
        assert_eq!(plan.jobs[0].id, "job.documentation_summary");
        assert_eq!(plan.jobs[0].responsibility, "documentation");
        assert!(plan.jobs[0].depends_on.is_empty());
    }

    #[test]
    fn complete_program_requests_use_code_generation_plan() {
        let request = classification_request(
            "Give me a complete Turbo C program to handle enrollment of students save in binary file",
        );
        let classification = classify_job_request(&request);

        assert_eq!(classification.task_type, RequestTaskType::Coding);
        assert_eq!(classification.complexity, RequestComplexity::High);
        assert_eq!(classification.output_format, ExpectedOutputFormat::Code);
        assert_eq!(classification.context_size, ContextSize::Medium);
        assert!(classification
            .execution_constraints
            .contains(&"complete_code_output".to_string()));

        let plan = plan_job_request(&request, &classification);
        let responsibilities = plan
            .jobs
            .iter()
            .map(|job| job.responsibility.as_str())
            .collect::<Vec<_>>();

        assert_eq!(plan.strategy, "complete_code_generation");
        assert_eq!(plan.jobs.len(), 8);
        assert!(responsibilities.contains(&"contract"));
        assert!(responsibilities.contains(&"implementation"));
        assert!(responsibilities.contains(&"validation"));
        assert!(responsibilities.contains(&"merge"));
        assert!(plan.jobs.iter().any(|job| job.id == "job.code_contract"));
        assert!(plan.jobs.iter().any(|job| job.id == "job.code_types"));
        assert!(plan.jobs.iter().any(|job| job.id == "job.code_file_write"));
        assert!(plan.jobs.iter().any(|job| job.id == "job.code_file_read"));
        assert!(plan.jobs.iter().any(|job| job.id == "job.code_helpers"));
        assert!(plan.jobs.iter().any(|job| job.id == "job.code_main"));
    }

    #[test]
    fn decomposed_small_code_with_explanation_uses_two_chunks() {
        let mut state = ready_state();
        let mut request = classification_request(
            "Show me a complete program in Java for magic square three by three and explain how it works.",
        );
        request.execution_mode = JobExecutionMode::Decompose;

        let record = state.submit_job(request, "1".to_string());

        assert_eq!(record.execution_mode, JobExecutionMode::Decompose);
        assert!(record.graph_execution_enabled);
        assert_eq!(record.plan.strategy, "code_with_explanation");
        assert_eq!(record.graph.nodes.len(), 2);
        assert_eq!(record.graph.nodes[0].id, "job.complete_source");
        assert_eq!(record.graph.nodes[0].name, "Complete source code");
        assert_eq!(record.graph.nodes[1].id, "job.code_explanation");
        assert_eq!(
            record.graph.nodes[1].depends_on,
            vec!["job.complete_source".to_string()]
        );
    }

    #[test]
    fn stores_plan_before_scheduling() {
        let mut state = ControlPlaneState::default();
        let record = state.submit_job(
            classification_request("Implement a Rust API change with tests and documentation."),
            "1".to_string(),
        );

        assert_eq!(record.status, JobStatus::Queued);
        assert_eq!(record.plan.strategy, "responsibility_based");
        assert_eq!(
            state
                .jobs
                .get("job-1")
                .map(|job| job.plan.strategy.as_str()),
            Some("responsibility_based")
        );
    }

    #[test]
    fn creates_job_graph_with_parallel_ready_nodes() {
        let mut state = ControlPlaneState::default();
        let record = state.submit_job(
            classification_request(
                "Design and implement a backend API plus frontend dashboard and add tests.",
            ),
            "1".to_string(),
        );

        assert_eq!(record.graph.status, JobGraphStatus::Created);
        let scope = record
            .graph
            .nodes
            .iter()
            .find(|node| node.id == "job.scope")
            .expect("scope node");
        assert_eq!(scope.status, JobGraphNodeStatus::Ready);

        let backend = record
            .graph
            .nodes
            .iter()
            .find(|node| node.id == "job.backend")
            .expect("backend node");
        assert_eq!(backend.status, JobGraphNodeStatus::Waiting);
        assert_eq!(backend.blocked_by, vec!["job.scope".to_string()]);

        state
            .update_graph_node(
                "job-1",
                "job.scope",
                JobGraphNodeStatus::Completed,
                Some("scope complete".to_string()),
                None,
                "2".to_string(),
            )
            .expect("complete scope");

        let graph = &state.jobs.get("job-1").expect("job").graph;
        let ready_ids = graph
            .nodes
            .iter()
            .filter(|node| node.status == JobGraphNodeStatus::Ready)
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        assert!(ready_ids.contains(&"job.backend"));
        assert!(ready_ids.contains(&"job.frontend"));
    }

    #[test]
    fn default_single_mode_keeps_graph_advisory_only() {
        let mut state = ready_state();
        let record = state.submit_job(
            classification_request(
                "Design and implement a backend API plus frontend dashboard and add tests.",
            ),
            "1".to_string(),
        );

        assert_eq!(record.execution_mode, JobExecutionMode::Single);
        assert!(!record.graph_execution_enabled);

        let claim = state.claim_job("node-1", "2".to_string());
        let claimed = claim.job.expect("claimed job");
        assert_eq!(claimed.prompt, record.prompt);
        assert_eq!(
            state
                .jobs
                .get("job-1")
                .and_then(|job| job.active_graph_node_id.as_deref()),
            None
        );
    }

    #[test]
    fn translation_job_claim_uses_strict_worker_prompt_without_changing_stored_prompt() {
        let mut state = ready_state();
        let prompt = "Translate to German only: Our idea is cost savings of AI.";
        let record = state.submit_job(classification_request(prompt), "1".to_string());

        let claim = state
            .claim_job("node-1", "2".to_string())
            .job
            .expect("translation job claim");

        assert_eq!(record.prompt, prompt);
        assert_eq!(
            state.jobs.get("job-1").map(|job| job.prompt.as_str()),
            Some(prompt)
        );
        assert!(claim
            .prompt
            .contains("Translate the source text to German."));
        assert!(claim
            .prompt
            .contains("Return only the translated text in German."));
        assert!(claim
            .prompt
            .contains("Do not add labels, explanations, alternatives"));
        assert!(claim
            .prompt
            .contains("Source text:\nOur idea is cost savings of AI."));
    }

    #[test]
    fn translation_completion_strips_target_language_label() {
        let mut state = ready_state();
        state.submit_job(
            classification_request("Translate to German only: Our idea is cost savings of AI."),
            "1".to_string(),
        );
        state
            .claim_job("node-1", "2".to_string())
            .job
            .expect("translation claim");

        let completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some(
                        "German: Unsere Idee ist die Kosteneinsparung durch KI.".to_string(),
                    ),
                    error: None,
                    latency_ms: Some(10),
                },
                "3".to_string(),
            )
            .expect("translation completion");

        assert_eq!(
            completed.output.as_deref(),
            Some("Unsere Idee ist die Kosteneinsparung durch KI.")
        );
    }

    #[test]
    fn explicit_single_complete_code_request_stores_direct_graph_only() {
        let mut state = ready_state();
        let mut request = classification_request(
            "possible for you to show a complete program in java for magic square, 3x3 ?",
        );
        request.execution_mode = JobExecutionMode::Single;

        let record = state.submit_job(request, "1".to_string());

        assert_eq!(record.execution_mode, JobExecutionMode::Single);
        assert!(!record.graph_execution_enabled);
        assert_eq!(record.plan.strategy, "single_job");
        assert_eq!(record.graph.nodes.len(), 1);
        assert_eq!(record.graph.nodes[0].id, "job.direct_response");
        assert_eq!(record.graph.nodes[0].name, "Direct response");
        assert_eq!(record.graph.final_node_id, None);
    }

    #[test]
    fn advisory_graph_completion_does_not_fake_reducer_progress() {
        let mut state = ready_state();
        let mut request = classification_request(
            "Give me a detailed history of Facebook from its origins to today.",
        );
        request.execution_mode = JobExecutionMode::Single;

        let record = state.submit_job(request, "1".to_string());
        assert!(!record.graph_execution_enabled);

        state
            .claim_job("node-1", "2".to_string())
            .job
            .expect("claimed single job");

        let completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("single answer".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "3".to_string(),
            )
            .expect("completed job");

        assert_eq!(completed.status, JobStatus::Completed);
        assert_eq!(completed.output.as_deref(), Some("single answer"));
        assert!(completed.graph.results.is_empty());
        assert!(completed.graph.final_output.is_none());
        assert!(completed
            .graph
            .nodes
            .iter()
            .all(|node| node.status != JobGraphNodeStatus::Completed));
    }

    #[test]
    fn forced_decompose_executes_validated_graph_nodes_sequentially_with_one_node() {
        let mut state = ready_state();
        let mut request = classification_request(
            "Design and implement a backend API plus frontend dashboard and add tests.",
        );
        request.execution_mode = JobExecutionMode::Decompose;

        let record = state.submit_job(request, "1".to_string());
        assert!(record.graph_execution_enabled);

        let first_claim = state
            .claim_job("node-1", "2".to_string())
            .job
            .expect("scope claim");
        assert!(first_claim.prompt.contains("one code work unit"));
        assert!(first_claim
            .prompt
            .contains("Work unit title: Scope and constraints"));
        assert_eq!(
            state
                .jobs
                .get("job-1")
                .and_then(|job| job.active_graph_node_id.as_deref()),
            Some("job.scope")
        );

        let partial = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("scope complete".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "3".to_string(),
            )
            .expect("partial completion");

        assert_eq!(partial.status, JobStatus::Queued);
        assert_eq!(
            partial.last_completed_graph_node_id.as_deref(),
            Some("job.scope")
        );

        let second_claim = state
            .claim_job("node-1", "4".to_string())
            .job
            .expect("implementation claim");
        assert!(second_claim.prompt.contains("Original user request"));
        assert!(
            second_claim
                .prompt
                .contains("Work unit title: Backend implementation")
                || second_claim
                    .prompt
                    .contains("Work unit title: Frontend implementation")
        );
    }

    #[test]
    fn auto_keeps_sectionable_work_single_with_one_ready_node() {
        let mut one_node_state = ready_state();
        let mut request = classification_request(
            "Write a detailed history of Mercedes-Benz with major eras and milestones.",
        );
        request.execution_mode = JobExecutionMode::Auto;
        let one_node_record = one_node_state.submit_job(request.clone(), "1".to_string());
        assert!(!one_node_record.graph_execution_enabled);
        assert_eq!(
            one_node_record.plan.strategy,
            "single_job_latency_optimized"
        );
        assert!(one_node_record
            .plan
            .summary
            .contains("1 compatible node slot"));

        let mut two_node_state = ready_state();
        two_node_state.register(m_series_registration("node-2"));
        two_node_state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());
        let two_node_record = two_node_state.submit_job(request, "2".to_string());
        assert!(two_node_record.graph_execution_enabled);
        assert_eq!(two_node_record.plan.strategy, "sectioned_research");
        assert!(two_node_record
            .plan
            .summary
            .contains("2 compatible node slots"));
    }

    #[test]
    fn auto_decompose_fans_out_chunks_when_two_nodes_are_ready() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());
        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Auto;
        let record = state.submit_job(request, "2".to_string());
        assert!(record.graph_execution_enabled);

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first chunk claim");
        let first_graph_node = first_claim
            .active_graph_node_id
            .clone()
            .expect("first active graph node");
        assert!(first_claim.prompt.contains("Original user request"));
        assert!(first_claim
            .prompt
            .contains("one section for a larger answer"));
        assert!(first_claim.prompt.contains("Current section title:"));

        let first_completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("origins complete".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "4".to_string(),
            )
            .expect("first completion");
        assert_eq!(first_completed.status, JobStatus::Queued);

        let second_claim = state
            .claim_job("node-1", "6".to_string())
            .job
            .expect("second chunk claim");
        let third_claim = state
            .claim_job("node-2", "6".to_string())
            .job
            .expect("third chunk claim");
        let second_graph_node = second_claim
            .active_graph_node_id
            .as_deref()
            .expect("second active graph node");
        let third_graph_node = third_claim
            .active_graph_node_id
            .as_deref()
            .expect("third active graph node");

        assert_ne!(first_graph_node, second_graph_node);
        assert_ne!(first_graph_node, third_graph_node);
        assert_ne!(second_graph_node, third_graph_node);

        let job = state.jobs.get("job-1").expect("job");
        let running = job
            .graph
            .nodes
            .iter()
            .filter(|node| node.status == JobGraphNodeStatus::Running)
            .collect::<Vec<_>>();
        assert_eq!(running.len(), 2);
        assert!(running
            .iter()
            .any(|node| node.assigned_node_id.as_deref() == Some("node-1")));
        assert!(running
            .iter()
            .any(|node| node.assigned_node_id.as_deref() == Some("node-2")));
    }

    #[test]
    fn detailed_research_graph_width_tracks_available_qualified_nodes() {
        let mut request = classification_request("Give me a detailed history of OpenAI to date.");
        request.execution_mode = JobExecutionMode::Auto;
        let classification = classify_job_request(&request);
        let base = plan_job_request_for_submission(&request, &classification, 1);

        let one_node = dynamically_shape_research_plan(
            &request,
            &classification,
            1,
            Some(16_384),
            base.clone(),
        );
        let four_nodes =
            dynamically_shape_research_plan(&request, &classification, 4, Some(16_384), base);

        assert_eq!(one_node.strategy, "dynamic_research");
        assert_eq!(
            one_node
                .jobs
                .iter()
                .filter(|job| job.responsibility == "chunk_analysis")
                .count(),
            2
        );
        assert_eq!(
            four_nodes
                .jobs
                .iter()
                .filter(|job| job.responsibility == "chunk_analysis")
                .count(),
            4
        );
        assert!(four_nodes
            .jobs
            .iter()
            .filter(|job| job.responsibility == "chunk_analysis")
            .all(|job| {
                job.recommended_max_tokens == Some(768)
                    && job.workload.context_budget_tokens == 8_192
                    && job.workload.allowed_parallelism == 4
            }));
        assert_eq!(
            four_nodes
                .jobs
                .last()
                .map(|job| job.responsibility.as_str()),
            Some("synthesize")
        );
        assert!(one_node
            .jobs
            .iter()
            .filter(|job| job.responsibility == "chunk_analysis")
            .all(|job| job.workload.allowed_parallelism == 1));
    }

    #[test]
    fn detailed_research_fanout_uses_a_safe_shared_context_for_two_live_nodes() {
        let mut state = ready_state();
        state
            .nodes
            .get_mut("node-1")
            .expect("first node")
            .worker_health
            .as_mut()
            .expect("first node health")
            .capabilities
            .max_context_tokens = Some(8_192);
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());
        state
            .nodes
            .get_mut("node-2")
            .expect("second node")
            .worker_health
            .as_mut()
            .expect("second node health")
            .capabilities
            .max_context_tokens = Some(1_536);

        let mut request = classification_request("Give me a detailed history of OpenAI to date.");
        request.execution_mode = JobExecutionMode::Auto;

        assert_eq!(state.compatible_ready_node_count_for_request(&request), 2);
        assert_eq!(
            state.compatible_ready_research_profile(&request),
            (2, 1_536)
        );

        let job = state.submit_job(request, "2".to_string());
        assert!(job
            .graph
            .nodes
            .iter()
            .filter(|node| node.responsibility == "chunk_analysis")
            .all(|node| {
                node.workload.allowed_parallelism == 2
                    && node.workload.context_budget_tokens == 1_536
            }));
    }

    #[test]
    fn brief_research_uses_one_chunk_without_synthesis() {
        let mut request = classification_request("Brief history of OpenAI.");
        request.execution_mode = JobExecutionMode::Auto;
        let classification = classify_job_request(&request);
        let base = plan_job_request_for_submission(&request, &classification, 4);
        let plan = dynamically_shape_research_plan(&request, &classification, 4, None, base);

        assert_eq!(plan.strategy, "dynamic_research");
        assert_eq!(plan.jobs.len(), 1);
        assert_eq!(plan.jobs[0].responsibility, "chunk_analysis");
        assert_eq!(plan.jobs[0].recommended_max_tokens, Some(1_024));
    }

    #[test]
    fn detailed_research_omits_impossible_synthesis_for_small_context_cluster() {
        let mut request = classification_request("Give me a detailed history of OpenAI to date.");
        request.execution_mode = JobExecutionMode::Auto;
        let classification = classify_job_request(&request);
        let base = plan_job_request_for_submission(&request, &classification, 2);
        let plan = dynamically_shape_research_plan(&request, &classification, 2, Some(1_536), base);

        assert_eq!(plan.strategy, "dynamic_research");
        assert_eq!(plan.jobs.len(), 2);
        assert!(plan
            .jobs
            .iter()
            .all(|job| job.responsibility == "chunk_analysis"));
        assert!(plan.summary.contains("synthesis omitted"));
    }

    #[test]
    fn sectioned_research_claims_sections_then_completes_with_reducer() {
        let mut state = ready_state();
        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Decompose;
        request.max_tokens = Some(1_024);
        state.submit_job(request, "2".to_string());

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first section claim");
        assert_eq!(first_claim.max_tokens, Some(384));

        state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("origins complete".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "4".to_string(),
            )
            .expect("first section completion");

        let mut completed = None;
        for (index, section_output) in [
            "early development complete",
            "expansion complete",
            "modern era complete",
        ]
        .iter()
        .enumerate()
        {
            let claim = state
                .claim_job("node-1", (index + 5).to_string())
                .job
                .expect("section claim");
            assert_eq!(claim.max_tokens, Some(384));
            completed = Some(
                state
                    .complete_job(
                        JobCompletion {
                            job_id: "job-1".to_string(),
                            node_id: "node-1".to_string(),
                            worker_id: format!("worker-{}", index + 2),
                            backend: Backend::M,
                            status: JobStatus::Completed,
                            output: Some((*section_output).to_string()),
                            error: None,
                            latency_ms: Some(10),
                        },
                        (index + 8).to_string(),
                    )
                    .expect("section completion"),
            );
        }

        let sections_completed = completed.expect("last section completion");
        assert_eq!(sections_completed.status, JobStatus::Queued);
        assert_eq!(
            sections_completed.graph.final_node_id.as_deref(),
            Some("job.final_synthesis")
        );

        let reducer_claim = state
            .claim_job("node-1", "12".to_string())
            .job
            .expect("strongest node claims synthesis");
        assert_eq!(
            reducer_claim.active_graph_node_id.as_deref(),
            Some("job.final_synthesis")
        );
        assert!(reducer_claim.prompt.contains("origins complete"));
        assert!(reducer_claim.prompt.contains("modern era complete"));

        let completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-reducer".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("Final synthesized answer.".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "13".to_string(),
            )
            .expect("synthesis completion");
        assert_eq!(completed.status, JobStatus::Completed);
        assert_eq!(
            completed.output.as_deref(),
            Some("Final synthesized answer.")
        );
    }

    #[test]
    fn large_sectioned_research_uses_larger_section_caps_and_reducer() {
        let mut state = ready_state();
        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Decompose;
        request.max_tokens = Some(2_048);
        state.submit_job(request, "2".to_string());

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first section claim");
        assert_eq!(first_claim.max_tokens, Some(768));
        assert!(first_claim.prompt.contains("the system adds the heading"));
        assert!(first_claim
            .prompt
            .contains("never invent a person, date, event, or technical detail"));

        state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("origins output".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "4".to_string(),
            )
            .expect("first section completion");

        for (index, section_output) in [
            "early development output",
            "expansion output",
            "modern era output",
        ]
        .iter()
        .enumerate()
        {
            let claim = state
                .claim_job("node-1", (index + 5).to_string())
                .job
                .expect("section claim");
            assert_eq!(claim.max_tokens, Some(768));
            state
                .complete_job(
                    JobCompletion {
                        job_id: "job-1".to_string(),
                        node_id: "node-1".to_string(),
                        worker_id: format!("worker-{}", index + 2),
                        backend: Backend::M,
                        status: JobStatus::Completed,
                        output: Some((*section_output).to_string()),
                        error: None,
                        latency_ms: Some(10),
                    },
                    (index + 8).to_string(),
                )
                .expect("section completion");
        }

        let job = state.jobs.get("job-1").expect("job");
        assert_eq!(job.status, JobStatus::Queued);
        assert_eq!(
            job.graph.final_node_id.as_deref(),
            Some("job.final_synthesis")
        );

        let reducer_claim = state
            .claim_job("node-1", "12".to_string())
            .job
            .expect("reducer claim");
        assert_eq!(
            reducer_claim.active_graph_node_id.as_deref(),
            Some("job.final_synthesis")
        );
        assert_eq!(reducer_claim.max_tokens, Some(4_096));
        assert!(reducer_claim.prompt.contains("expansion output"));
    }

    #[test]
    fn complete_code_generation_claims_contract_then_function_chunks() {
        let mut state = ready_state();
        let mut request = classification_request(
            "Give me a complete Turbo C program to handle enrollment of students save in binary file",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        request.max_tokens = Some(4_096);
        state.submit_job(request, "2".to_string());

        let contract_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("contract claim");
        assert_eq!(
            contract_claim.active_graph_node_id.as_deref(),
            Some("job.code_contract")
        );
        assert_eq!(contract_claim.max_tokens, Some(512));

        state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("contract complete".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "4".to_string(),
            )
            .expect("contract completion");

        let types_claim = state
            .claim_job("node-1", "5".to_string())
            .job
            .expect("types claim");
        assert_eq!(
            types_claim.active_graph_node_id.as_deref(),
            Some("job.code_types")
        );
        assert_eq!(types_claim.max_tokens, Some(768));

        state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-2".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("types complete".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "6".to_string(),
            )
            .expect("types completion");

        let file_chunk_claim = state
            .claim_job("node-1", "7".to_string())
            .job
            .expect("file/helper chunk claim");
        assert!(matches!(
            file_chunk_claim.active_graph_node_id.as_deref(),
            Some("job.code_file_write") | Some("job.code_file_read") | Some("job.code_helpers")
        ));
        assert_eq!(file_chunk_claim.max_tokens, Some(1_024));
    }

    #[test]
    fn small_explicit_graph_budget_remains_an_upper_bound() {
        let mut state = ready_state();
        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Decompose;
        request.max_tokens = Some(64);
        state.submit_job(request, "2".to_string());

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first section claim");

        assert_eq!(first_claim.max_tokens, Some(64));
    }

    #[test]
    fn failed_graph_chunk_retries_on_a_different_ready_node() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());

        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Auto;
        state.submit_job(request, "2".to_string());

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first claim");
        let failed_graph_node = first_claim
            .active_graph_node_id
            .clone()
            .expect("failed graph node");

        let retryable_failure = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Failed,
                    output: None,
                    error: Some("local runtime failed".to_string()),
                    latency_ms: Some(10),
                },
                "4".to_string(),
            )
            .expect("retryable failure");

        assert_eq!(retryable_failure.status, JobStatus::Queued);
        assert_ne!(retryable_failure.graph.status, JobGraphStatus::Failed);
        assert_eq!(retryable_failure.error, None);

        let retry_claim = state
            .claim_job("node-2", "5".to_string())
            .job
            .expect("retry claim");
        assert_eq!(
            retry_claim.active_graph_node_id.as_deref(),
            Some(failed_graph_node.as_str())
        );

        let retry_node = state
            .jobs
            .get("job-1")
            .expect("job")
            .graph
            .nodes
            .iter()
            .find(|node| node.id == failed_graph_node)
            .expect("retried graph node");
        assert_eq!(retry_node.status, JobGraphNodeStatus::Running);
        assert_eq!(retry_node.attempt_count, 2);
        assert!(retry_node.failed_node_ids.contains(&"node-1".to_string()));
        assert_eq!(retry_node.assigned_node_id.as_deref(), Some("node-2"));
    }

    #[test]
    fn failed_analysis_chunk_falls_back_to_a_healthy_lower_capacity_node() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        let mut micro_heartbeat = ready_heartbeat("node-2", "1");
        micro_heartbeat.worker_health.capabilities.capacity_class = "micro".to_string();
        state.heartbeat(micro_heartbeat, "1".to_string());

        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "2".to_string());
        state
            .jobs
            .get_mut("job-1")
            .expect("job")
            .graph
            .nodes
            .first_mut()
            .expect("first analysis node")
            .workload
            .minimum_capacity_class = CapacityClass::Standard;

        let chunk_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("analysis claim");
        let failed_chunk = chunk_claim
            .active_graph_node_id
            .clone()
            .expect("analysis node");
        let first_budget = chunk_claim
            .graph
            .nodes
            .iter()
            .find(|node| node.id == failed_chunk)
            .and_then(|node| node.effective_max_tokens)
            .expect("first analysis budget");
        let retryable = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Failed,
                    output: None,
                    error: Some(
                        "model spent its whole budget on reasoning and returned no content"
                            .to_string(),
                    ),
                    latency_ms: Some(10),
                },
                "4".to_string(),
            )
            .expect("retryable analysis failure");
        let failed_node = retryable
            .graph
            .nodes
            .iter()
            .find(|node| node.id == failed_chunk)
            .expect("failed analysis node");
        assert_eq!(failed_node.status, JobGraphNodeStatus::Ready);
        assert_eq!(
            failed_node.recommended_max_tokens,
            Some(first_budget.saturating_mul(2).min(8_192))
        );

        let fallback_claim = state
            .claim_job("node-2", "5".to_string())
            .job
            .expect("lower-capacity fallback claim");
        assert_eq!(
            fallback_claim.active_graph_node_id.as_deref(),
            Some(failed_chunk.as_str())
        );
        assert!(fallback_claim
            .scheduler_decision
            .as_ref()
            .expect("scheduler decision")
            .reasons
            .iter()
            .any(|reason| reason.contains("capacity_degraded_retry")));
    }

    #[test]
    fn untried_analysis_chunk_uses_healthy_micro_node_when_qualified_node_is_busy() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        let mut micro_heartbeat = ready_heartbeat("node-2", "1");
        micro_heartbeat.worker_health.capabilities.capacity_class = "micro".to_string();
        state.heartbeat(micro_heartbeat, "1".to_string());

        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "2".to_string());
        for node in &mut state.jobs.get_mut("job-1").expect("job").graph.nodes {
            if node.status == JobGraphNodeStatus::Ready {
                node.workload.minimum_capacity_class = CapacityClass::Standard;
            }
        }

        assert!(state.claim_job("node-2", "3".to_string()).job.is_none());

        let qualified_claim = state
            .claim_job("node-1", "4".to_string())
            .job
            .expect("qualified node claims the first analysis chunk");
        let fallback_claim = state
            .claim_job("node-2", "4".to_string())
            .job
            .expect("micro node claims another independent chunk");

        assert_ne!(
            qualified_claim.active_graph_node_id,
            fallback_claim.active_graph_node_id
        );
        let fallback_node = fallback_claim
            .graph
            .nodes
            .iter()
            .find(|node| Some(node.id.as_str()) == fallback_claim.active_graph_node_id.as_deref())
            .expect("fallback graph node");
        assert_eq!(fallback_node.attempt_count, 1);
        assert!(fallback_claim
            .scheduler_decision
            .as_ref()
            .expect("scheduler decision")
            .reasons
            .iter()
            .any(|reason| reason.contains("capacity_degraded_retry")));
    }

    #[test]
    fn node_with_insufficient_advertised_context_cannot_claim_graph_chunk() {
        let mut state = ready_state();
        state
            .nodes
            .get_mut("node-1")
            .expect("node")
            .worker_health
            .as_mut()
            .expect("health")
            .capabilities
            .max_context_tokens = Some(1_536);

        let mut request = classification_request("Analyze a long factual topic.");
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "2".to_string());
        state
            .jobs
            .get_mut("job-1")
            .expect("job")
            .graph
            .nodes
            .first_mut()
            .expect("graph node")
            .workload
            .context_budget_tokens = 8_192;

        assert!(state.claim_job("node-1", "3".to_string()).job.is_none());
    }

    #[test]
    fn failed_analysis_chunk_can_return_to_original_node_after_all_nodes_were_tried() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());

        let mut request = classification_request("Analyze a topic in parallel.");
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "2".to_string());

        let graph = &mut state.jobs.get_mut("job-1").expect("job").graph;
        for node in graph.nodes.iter_mut().skip(1) {
            node.status = JobGraphNodeStatus::Waiting;
        }
        let graph_node = graph.nodes.first_mut().expect("first analysis node");
        let expected_graph_node_id = graph_node.id.clone();
        graph_node.status = JobGraphNodeStatus::Ready;
        graph_node.attempt_count = 2;
        graph_node.failed_node_ids = vec!["node-1".to_string(), "node-2".to_string()];
        graph_node.assigned_node_id = None;

        let retry_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("original node may retry after all schedulable nodes were tried");
        assert_eq!(
            retry_claim.active_graph_node_id.as_deref(),
            Some(expected_graph_node_id.as_str())
        );
    }

    #[test]
    fn stale_running_graph_chunk_retries_on_a_different_ready_node() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());

        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Auto;
        state.submit_job(request, "2".to_string());

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first claim");
        let stale_graph_node = first_claim
            .active_graph_node_id
            .clone()
            .expect("stale graph node");

        state.heartbeat(ready_heartbeat("node-2", "604"), "604".to_string());
        let retry_claim = state
            .claim_job("node-2", "604".to_string())
            .job
            .expect("retry claim after stale lease");
        assert_eq!(
            retry_claim.active_graph_node_id.as_deref(),
            Some(stale_graph_node.as_str())
        );

        let retried_node = state
            .jobs
            .get("job-1")
            .expect("job")
            .graph
            .nodes
            .iter()
            .find(|node| node.id == stale_graph_node)
            .expect("retried graph node");
        assert_eq!(retried_node.status, JobGraphNodeStatus::Running);
        assert_eq!(retried_node.attempt_count, 2);
        assert!(retried_node.failed_node_ids.contains(&"node-1".to_string()));
        assert_eq!(retried_node.assigned_node_id.as_deref(), Some("node-2"));
        assert_eq!(retried_node.worker_id, None);
    }

    #[test]
    fn coding_chunk_keeps_assignment_for_thirty_minutes() {
        let mut state = ready_state();
        let mut request = classification_request(
            "Implement the API, update the frontend, and run the complete test suite.",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "2".to_string());

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first coding claim");
        let graph_node_id = first_claim
            .active_graph_node_id
            .expect("active coding graph node");

        state.run_maintenance("604");
        let active_node = state
            .jobs
            .get("job-1")
            .expect("job")
            .graph
            .nodes
            .iter()
            .find(|node| node.id == graph_node_id)
            .expect("coding graph node");
        assert_eq!(active_node.status, JobGraphNodeStatus::Running);
        assert_eq!(active_node.assigned_node_id.as_deref(), Some("node-1"));

        state.run_maintenance("1804");
        let expired_node = state
            .jobs
            .get("job-1")
            .expect("job")
            .graph
            .nodes
            .iter()
            .find(|node| node.id == graph_node_id)
            .expect("expired coding graph node");
        assert_eq!(expired_node.status, JobGraphNodeStatus::Ready);
        assert!(expired_node.failed_node_ids.contains(&"node-1".to_string()));
        assert!(expired_node
            .error
            .as_deref()
            .expect("stale coding error")
            .contains("stale assignment timed out after 1800s on node-1"));
    }

    #[test]
    fn stale_running_graph_chunk_fails_after_max_attempts() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());

        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Auto;
        state.submit_job(request, "2".to_string());

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first claim");
        let stale_graph_node = first_claim
            .active_graph_node_id
            .clone()
            .expect("stale graph node");
        let job = state.jobs.get_mut("job-1").expect("job");
        let graph_node = job
            .graph
            .nodes
            .iter_mut()
            .find(|node| node.id == stale_graph_node)
            .expect("graph node");
        graph_node.max_attempts = 1;

        let retry = state.claim_job("node-2", "604".to_string());
        assert!(retry.job.is_none());

        let job = state.jobs.get("job-1").expect("job");
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.graph.status, JobGraphStatus::Failed);
        assert!(job
            .error
            .as_deref()
            .expect("stale error")
            .contains("stale assignment timed out after 600s on node-1"));
    }

    #[test]
    fn failed_graph_chunk_exhausts_attempts_before_failing_parent_job() {
        let mut state = ready_state();
        for node_id in ["node-2", "node-3"] {
            state.register(m_series_registration(node_id));
            state.heartbeat(ready_heartbeat(node_id, "1"), "1".to_string());
        }

        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Auto;
        state.submit_job(request, "2".to_string());

        let mut active_graph_node = None;
        for (attempt, node_id) in ["node-1", "node-2", "node-3"].iter().enumerate() {
            let claim = state
                .claim_job(node_id, (attempt + 3).to_string())
                .job
                .expect("attempt claim");
            let claimed_graph_node = claim
                .active_graph_node_id
                .clone()
                .expect("active graph node");
            if let Some(expected_graph_node) = active_graph_node.as_deref() {
                assert_eq!(claimed_graph_node, expected_graph_node);
            } else {
                active_graph_node = Some(claimed_graph_node.clone());
            }

            let completed = state
                .complete_job(
                    JobCompletion {
                        job_id: "job-1".to_string(),
                        node_id: (*node_id).to_string(),
                        worker_id: format!("worker-{}", attempt + 1),
                        backend: Backend::M,
                        status: JobStatus::Failed,
                        output: None,
                        error: Some(format!("attempt {} failed", attempt + 1)),
                        latency_ms: Some(10),
                    },
                    (attempt + 6).to_string(),
                )
                .expect("failed attempt");

            if attempt < 2 {
                assert_eq!(completed.status, JobStatus::Queued);
                assert_ne!(completed.graph.status, JobGraphStatus::Failed);
            } else {
                assert_eq!(completed.status, JobStatus::Failed);
                assert_eq!(completed.graph.status, JobGraphStatus::Failed);
                assert_eq!(
                    completed
                        .graph
                        .nodes
                        .iter()
                        .find(|node| Some(node.id.as_str()) == active_graph_node.as_deref())
                        .expect("exhausted graph node")
                        .attempt_count,
                    DEFAULT_GRAPH_NODE_MAX_ATTEMPTS
                );
            }
        }
    }

    #[test]
    fn decompose_allows_parallel_claims_for_independent_graph_nodes() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());

        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "2".to_string());

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first parallel claim");
        let second_claim = state
            .claim_job("node-2", "3".to_string())
            .job
            .expect("second parallel claim");

        let first_graph_node = first_claim
            .active_graph_node_id
            .as_deref()
            .expect("first active graph node");
        let second_graph_node = second_claim
            .active_graph_node_id
            .as_deref()
            .expect("second active graph node");
        assert_ne!(first_graph_node, second_graph_node);

        let job = state.jobs.get("job-1").expect("job");
        let running = job
            .graph
            .nodes
            .iter()
            .filter(|node| node.status == JobGraphNodeStatus::Running)
            .collect::<Vec<_>>();
        assert_eq!(running.len(), 2);
        assert!(running
            .iter()
            .any(|node| node.assigned_node_id.as_deref() == Some("node-1")));
        assert!(running
            .iter()
            .any(|node| node.assigned_node_id.as_deref() == Some("node-2")));

        let first_completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("node one output".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "4".to_string(),
            )
            .expect("first completion");
        assert_eq!(first_completed.status, JobStatus::Assigned);
        assert_eq!(
            first_completed.active_graph_node_id.as_deref(),
            Some(second_graph_node)
        );
        assert_eq!(first_completed.assigned_node_id.as_deref(), Some("node-2"));

        let second_completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-2".to_string(),
                    worker_id: "worker-2".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("node two output".to_string()),
                    error: None,
                    latency_ms: Some(25),
                },
                "5".to_string(),
            )
            .expect("second completion");
        assert_eq!(second_completed.status, JobStatus::Queued);

        let first_result = second_completed
            .graph
            .results
            .iter()
            .find(|result| result.node_id == first_graph_node)
            .expect("first result");
        let second_result = second_completed
            .graph
            .results
            .iter()
            .find(|result| result.node_id == second_graph_node)
            .expect("second result");
        assert_eq!(first_result.source_node_id.as_deref(), Some("node-1"));
        assert_eq!(first_result.latency_ms, Some(10));
        assert_eq!(first_result.queue_wait_ms, Some(1_000));
        assert_eq!(
            first_result.output_chars,
            Some("node one output".chars().count())
        );
        assert_eq!(second_result.source_node_id.as_deref(), Some("node-2"));
        assert_eq!(second_result.latency_ms, Some(25));
        assert_eq!(second_result.queue_wait_ms, Some(1_000));
        assert_eq!(
            second_result.output_chars,
            Some("node two output".chars().count())
        );
    }

    #[test]
    fn comparison_plan_allows_parallel_claims_for_independent_sections() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());

        let mut request = classification_request(
            "Compare Ethereum, Solana, and Polygon for decentralized apps. Cover architecture, performance, developer ecosystem, costs, risks, and recommendation.",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "2".to_string());

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first comparison section claimed");
        let second_claim = state
            .claim_job("node-2", "3".to_string())
            .job
            .expect("second comparison section claimed");

        assert_ne!(
            first_claim.active_graph_node_id,
            second_claim.active_graph_node_id
        );

        let job = state.jobs.get("job-1").expect("job");
        let running = job
            .graph
            .nodes
            .iter()
            .filter(|node| node.status == JobGraphNodeStatus::Running)
            .collect::<Vec<_>>();
        assert_eq!(running.len(), 2);
        assert!(running
            .iter()
            .any(|node| node.assigned_node_id.as_deref() == Some("node-1")));
        assert!(running
            .iter()
            .any(|node| node.assigned_node_id.as_deref() == Some("node-2")));
    }

    #[test]
    fn auto_graph_jobs_can_fan_out_across_m_series_and_cuda_models() {
        let mut state = ready_state();
        state.register(cuda_registration("node-cuda"));
        let mut cuda_heartbeat = ready_heartbeat("node-cuda", "1");
        cuda_heartbeat.backend = Backend::Cuda;
        cuda_heartbeat.available_memory_mb = 32_688;
        cuda_heartbeat.available_gpu_percent = 50;
        cuda_heartbeat.worker_health.runtime_mode = "cuda".to_string();
        cuda_heartbeat.worker_health.supported_runtime_modes = vec![RuntimeMode::Local];
        cuda_heartbeat.worker_health.cuda_device_available = true;
        cuda_heartbeat.worker_health.cuda_driver_available = true;
        cuda_heartbeat.worker_health.cuda_device_name = Some("GeForce RTX test".to_string());
        cuda_heartbeat.worker_health.cuda_memory_mb = Some(8_192);
        cuda_heartbeat.worker_health.model_name = Some("Qwen/Qwen2.5-1.5B-Instruct".to_string());
        cuda_heartbeat.worker_health.model_dir = "C:\\Users\\batal\\.opengpu\\models".to_string();
        cuda_heartbeat.worker_health.model_path =
            Some("C:\\Users\\batal\\.opengpu\\models\\qwen.gguf".to_string());
        state.heartbeat(cuda_heartbeat, "1".to_string());

        let mut request = classification_request(
            "Compare Ethereum, Solana, and Polygon for decentralized apps. Cover architecture, performance, developer ecosystem, costs, risks, and recommendation.",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        request.preferred_backend = Backend::Auto;
        request.model = None;
        state.submit_job(request, "2".to_string());

        let m_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("m-series comparison section claimed");
        let cuda_claim = state
            .claim_job("node-cuda", "3".to_string())
            .job
            .expect("cuda comparison section claimed");

        assert_ne!(
            m_claim.active_graph_node_id,
            cuda_claim.active_graph_node_id
        );

        let job = state.jobs.get("job-1").expect("job");
        assert_eq!(job.model, None);
        let cuda_node = job
            .graph
            .nodes
            .iter()
            .find(|node| node.assigned_node_id.as_deref() == Some("node-cuda"))
            .expect("cuda graph node");
        assert_eq!(cuda_node.backend, Some(Backend::Cuda));
        assert_eq!(
            cuda_node.model.as_deref(),
            Some("Qwen/Qwen2.5-1.5B-Instruct")
        );
    }

    #[test]
    fn decompose_awards_credits_per_completed_graph_node() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());

        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "2".to_string());

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first claim");
        let second_claim = state
            .claim_job("node-2", "3".to_string())
            .job
            .expect("second claim");
        let first_graph_node = first_claim
            .active_graph_node_id
            .clone()
            .expect("first graph node");
        let second_graph_node = second_claim
            .active_graph_node_id
            .clone()
            .expect("second graph node");

        let first_completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("first chunk output".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "4".to_string(),
            )
            .expect("first completion");
        let first_award = state
            .award_job_reward(&first_completed, "4".to_string())
            .expect("first award");

        let second_completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-2".to_string(),
                    worker_id: "worker-2".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("second chunk output".to_string()),
                    error: None,
                    latency_ms: Some(10),
                },
                "5".to_string(),
            )
            .expect("second completion");
        let second_award = state
            .award_job_reward(&second_completed, "5".to_string())
            .expect("second award");

        assert_eq!(state.credits_ledger.len(), 2);
        assert_eq!(first_award.device_id.as_deref(), Some("node-1"));
        assert_eq!(second_award.device_id.as_deref(), Some("node-2"));
        assert_eq!(first_award.parent_job_id.as_deref(), Some("job-1"));
        assert_eq!(second_award.parent_job_id.as_deref(), Some("job-1"));
        assert_eq!(
            first_award.graph_node_id.as_deref(),
            Some(first_graph_node.as_str())
        );
        assert_eq!(
            second_award.graph_node_id.as_deref(),
            Some(second_graph_node.as_str())
        );
        assert_eq!(first_award.job_id.as_deref(), Some("job-1"));
        assert_eq!(second_award.job_id.as_deref(), Some("job-1"));
        assert_ne!(first_award.id, second_award.id);
        assert!(state
            .award_job_reward(&second_completed, "6".to_string())
            .is_none());
    }

    #[test]
    fn tool_rewards_use_fixed_work_type_amounts_and_dedupe() {
        let mut state = ControlPlaneState::default();
        let request = ToolRewardRequest {
            job_id: "weather-job-1".to_string(),
            tool: "weather".to_string(),
            device_id: Some("weather-tool".to_string()),
            prompt_chars: Some(24),
            output_chars: Some(80),
            units: None,
            metadata: serde_json::json!({ "cache_hit": true }),
        };

        let award = state
            .award_tool_reward(request.clone(), "10".to_string())
            .expect("tool award");
        let duplicate = state.award_tool_reward(request, "11".to_string());

        assert!(duplicate.is_none());
        assert_eq!(state.credits_ledger.len(), 1);
        assert_eq!(award.entry_type, "tool_reward");
        assert_eq!(award.device_id.as_deref(), Some("weather-tool"));
        assert_eq!(award.amount, 0.05);
        assert_eq!(award.metadata["work_type"], "tool_weather");
        assert_eq!(award.metadata["prompt_chars"], 24);
        assert_eq!(award.metadata["output_chars"], 80);
        assert_eq!(award.metadata["reported_metadata"]["cache_hit"], true);
    }

    #[test]
    fn credit_award_ignores_contribution_percent_multiplier() {
        let mut state = ready_state();
        state
            .set_operator_contribution_percent("node-1", Some(80))
            .expect("operator cap update");
        state.submit_job(classification_request("hello world"), "2".to_string());
        state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("claim");

        let completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("x".repeat(835)),
                    error: None,
                    latency_ms: Some(10),
                },
                "4".to_string(),
            )
            .expect("completion");
        let award = state
            .award_job_reward(&completed, "5".to_string())
            .expect("award");

        assert_eq!(award.amount, 3.0);
        assert_eq!(
            award
                .metadata
                .get("formula")
                .and_then(|value| value.as_str()),
            Some("ceil((prompt_chars + output_chars) / 400)")
        );
        assert_eq!(
            award
                .metadata
                .get("contribution_percent_role")
                .and_then(|value| value.as_str()),
            Some("routing_budget_only")
        );
        assert_eq!(
            award
                .metadata
                .get("contribution_percent")
                .and_then(|value| value.as_u64()),
            Some(80)
        );
    }

    #[test]
    fn reducer_prompt_receives_completed_subjob_outputs() {
        let mut state = ready_state();
        let mut request = classification_request(
            "Design and implement a backend API plus frontend dashboard and add tests.",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "1".to_string());

        for (node_id, output, updated_at) in [
            ("job.scope", "scope accepted", "2"),
            ("job.backend", "backend complete", "3"),
            ("job.frontend", "frontend complete", "4"),
            ("job.tests", "tests complete", "5"),
        ] {
            state
                .update_graph_node(
                    "job-1",
                    node_id,
                    JobGraphNodeStatus::Completed,
                    Some(output.to_string()),
                    None,
                    updated_at.to_string(),
                )
                .expect("complete graph node");
        }

        let claim = state
            .claim_job("node-1", "6".to_string())
            .job
            .expect("final claim");
        assert!(claim.prompt.contains("Completed section notes"));
        assert!(claim.prompt.contains("scope accepted"));
        assert!(claim.prompt.contains("backend complete"));
        assert!(claim.prompt.contains("frontend complete"));
        assert!(claim.prompt.contains("tests complete"));
        assert!(claim
            .prompt
            .contains("Write one accurate, coherent final answer"));
    }

    #[test]
    fn reducer_prompt_strips_worker_metadata_and_caps_sections() {
        let noisy_output = format!(
            "llama.cpp mode=cuda; model=demo; path=C:\\models\\demo.gguf; response=Do not include any introduction.\nDo not return output.\n{} [end of text]",
            "BMW began as an aircraft engine maker. ".repeat(200)
        );

        let mut state = ready_state();
        let mut request = reducer_fixture_request();
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "1".to_string());

        for (node_id, updated_at) in [
            ("job.scope", "2"),
            ("job.backend", "3"),
            ("job.frontend", "4"),
            ("job.tests", "5"),
        ] {
            state
                .update_graph_node(
                    "job-1",
                    node_id,
                    JobGraphNodeStatus::Completed,
                    Some(noisy_output.clone()),
                    None,
                    updated_at.to_string(),
                )
                .expect("complete graph node");
        }

        let claim = state
            .claim_job("node-1", "6".to_string())
            .job
            .expect("final claim");
        assert!(claim
            .prompt
            .contains("BMW began as an aircraft engine maker."));
        assert!(!claim.prompt.contains("Do not include any introduction"));
        assert!(!claim.prompt.contains("Do not return output"));
        assert!(!claim.prompt.contains("llama.cpp mode=cuda"));
        assert!(!claim.prompt.contains("C:\\models\\demo.gguf"));
        // The combined dependency payload must leave room for synthesis output inside the
        // worker's advertised context instead of independently spending the per-section cap.
        assert!(claim.prompt.len() > 12_000);
        assert!(claim.prompt.len() < 18_000);
    }

    #[test]
    fn auto_generation_budget_never_exceeds_worker_ceiling() {
        assert_eq!(scale_auto_generation_budget(4_096, 1_024), 1_024);
        assert_eq!(scale_auto_generation_budget(512, 2_048), 1_024);
    }

    #[test]
    fn worker_output_cleanup_removes_mlx_warnings_and_instruction_echoes() {
        let output = clean_worker_output(
            "mlx-lm mode=mlx; response=Calling `python -m mlx_lm.generate...` directly is deprecated. Use `mlx_lm.generate...` instead.\nExpand on the major growth periods and milestones.\nBitcoin launched in 2009.",
        );

        assert_eq!(output, "Bitcoin launched in 2009.");
    }

    #[test]
    fn section_output_cleanup_removes_duplicate_title_and_leaked_next_section() {
        let output = clean_section_output(
            "Origins and founders",
            "## Origins and founders Origins and founders: Bitcoin was introduced by Satoshi Nakamoto.\n\n## Early development\nThis belongs to another worker.",
        );

        assert_eq!(output, "Bitcoin was introduced by Satoshi Nakamoto.");
    }

    #[test]
    fn section_output_cleanup_drops_collapsed_prompt_echo() {
        let output = clean_section_output(
            "Origins and founders",
            "Avoid jargon and technical language unless absolutely necessary. Provide a clear, concise, and direct answer to the user's request. The answer should be short and direct.",
        );

        assert_eq!(output, "");
    }

    #[test]
    fn prompt_echo_section_is_requeued_for_a_different_node() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());
        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "2".to_string());

        let first_claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("first section claim");
        let section_id = first_claim
            .active_graph_node_id
            .clone()
            .expect("active section");
        let retried = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some(
                        "Do not include a title. Do not include the user's request. Do not include the user's request."
                            .to_string(),
                    ),
                    error: None,
                    latency_ms: Some(10),
                },
                "4".to_string(),
            )
            .expect("echo completion is handled");

        assert_eq!(retried.status, JobStatus::Queued);
        let section = retried
            .graph
            .nodes
            .iter()
            .find(|node| node.id == section_id)
            .expect("retried section");
        assert_eq!(section.status, JobGraphNodeStatus::Ready);
        assert_eq!(section.failed_node_ids, vec!["node-1".to_string()]);
        assert_eq!(section.output, None);

        let second_claim = state
            .claim_job("node-2", "5".to_string())
            .job
            .expect("different node retries section");
        assert_eq!(
            second_claim.active_graph_node_id.as_deref(),
            Some(section_id.as_str())
        );
    }

    #[test]
    fn low_vram_node_waits_for_credible_synthesizer_then_preserves_sections() {
        let noisy_output = format!(
            "llama.cpp mode=cuda; response={}",
            "Nokia factual section. ".repeat(200)
        );
        let mut state = ControlPlaneState::default();
        state.register(cuda_registration("node-weak"));
        state.heartbeat(low_vram_cuda_heartbeat("node-weak", "1"), "1".to_string());
        let mut request = reducer_fixture_request();
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "2".to_string());

        for updated_at in ["3", "4", "5", "6"] {
            let claim = state
                .claim_job("node-weak", updated_at.to_string())
                .job
                .expect("section claim");
            assert_ne!(
                claim.active_graph_node_id.as_deref(),
                Some("job.final_merge")
            );
            state
                .complete_job(
                    JobCompletion {
                        job_id: "job-1".to_string(),
                        node_id: "node-weak".to_string(),
                        worker_id: "worker-weak".to_string(),
                        backend: Backend::Cuda,
                        status: JobStatus::Completed,
                        output: Some(noisy_output.clone()),
                        error: None,
                        latency_ms: Some(10),
                    },
                    updated_at.to_string(),
                )
                .expect("section completion");
        }

        assert!(state.claim_job("node-weak", "7".to_string()).job.is_none());

        let degraded = state.jobs.get("job-1").expect("job exists");
        assert_eq!(degraded.status, JobStatus::Completed);
        assert_eq!(degraded.error, None);
        assert!(degraded
            .output
            .as_deref()
            .is_some_and(|output| !output.trim().is_empty()));
        assert_eq!(
            degraded
                .graph
                .nodes
                .iter()
                .filter(|node| node.status == JobGraphNodeStatus::Completed)
                .count(),
            5
        );
        assert!(degraded
            .graph
            .nodes
            .iter()
            .filter(|node| node.status == JobGraphNodeStatus::Completed)
            .all(|node| node.output.is_some()));
    }

    #[test]
    fn compact_final_reducer_failure_records_section_fallback_as_completed() {
        let mut state = ControlPlaneState::default();
        state.register(cuda_registration("node-weak"));
        state.heartbeat(low_vram_cuda_heartbeat("node-weak", "1"), "1".to_string());
        let mut request = reducer_fixture_request();
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "2".to_string());

        for (node_id, output, updated_at) in [
            ("job.scope", "Scope section text", "3"),
            ("job.backend", "Backend section text", "4"),
            ("job.frontend", "Frontend section text", "5"),
            ("job.tests", "Tests section text", "6"),
        ] {
            state
                .update_graph_node(
                    "job-1",
                    node_id,
                    JobGraphNodeStatus::Completed,
                    Some(output.to_string()),
                    None,
                    updated_at.to_string(),
                )
                .expect("complete section");
        }

        {
            let job = state.jobs.get_mut("job-1").expect("job exists");
            job.status = JobStatus::Assigned;
            job.assigned_node_id = Some("node-weak".to_string());
            job.active_graph_node_id = Some("job.final_merge".to_string());
            let final_node = job
                .graph
                .nodes
                .iter_mut()
                .find(|node| node.id == "job.final_merge")
                .expect("final node");
            final_node.status = JobGraphNodeStatus::Running;
            final_node.assigned_node_id = Some("node-weak".to_string());
            final_node.backend = Some(Backend::Cuda);
            final_node.attempt_count = 1;
        }

        let completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-weak".to_string(),
                    worker_id: "worker-weak".to_string(),
                    backend: Backend::Cuda,
                    status: JobStatus::Failed,
                    output: None,
                    error: Some("llama-cli exited 1".to_string()),
                    latency_ms: Some(10),
                },
                "7".to_string(),
            )
            .expect("compact reducer failure falls back");

        assert_eq!(completed.status, JobStatus::Completed);
        assert!(completed.error.is_none());
        assert!(completed
            .output
            .as_deref()
            .expect("fallback output")
            .contains("Scope section text"));
        let final_node = completed
            .graph
            .nodes
            .iter()
            .find(|node| node.id == "job.final_merge")
            .expect("final node");
        assert_eq!(final_node.status, JobGraphNodeStatus::Completed);
        assert!(final_node.error.is_none());
        assert!(completed.graph.merge_error.is_none());
        assert_eq!(
            state
                .nodes
                .get("node-weak")
                .map(|node| node.trust.consecutive_failures),
            Some(1)
        );
    }

    #[test]
    fn compact_node_defers_reducer_when_strong_node_is_available() {
        let mut state = ControlPlaneState::default();
        state.register(cuda_registration("node-weak"));
        state.heartbeat(low_vram_cuda_heartbeat("node-weak", "1"), "1".to_string());
        let mut request = reducer_fixture_request();
        request.execution_mode = JobExecutionMode::Decompose;
        request.model = None;
        state.submit_job(request, "2".to_string());

        for updated_at in ["3", "4", "5", "6"] {
            state
                .claim_job("node-weak", updated_at.to_string())
                .job
                .expect("section claim");
            state
                .complete_job(
                    JobCompletion {
                        job_id: "job-1".to_string(),
                        node_id: "node-weak".to_string(),
                        worker_id: "worker-weak".to_string(),
                        backend: Backend::Cuda,
                        status: JobStatus::Completed,
                        output: Some("section complete".to_string()),
                        error: None,
                        latency_ms: Some(10),
                    },
                    updated_at.to_string(),
                )
                .expect("section completion");
        }

        let cuda_node = state.nodes.get_mut("node-weak").expect("cuda node");
        cuda_node.available_memory_mb = 2_898;
        cuda_node.available_gpu_percent = 70;
        let cuda_health = cuda_node.worker_health.as_mut().expect("cuda health");
        cuda_health.model_name = Some("UD-IQ2_M".to_string());
        cuda_health.cuda_device_name = Some("NVIDIA RTX 5090".to_string());
        cuda_health.notes.clear();
        cuda_health.capabilities.max_context_tokens = Some(1_536);
        cuda_health.capabilities.roles.push(NodeRole::Coding);
        cuda_health.capabilities.roles.push(NodeRole::Reducer);
        cuda_health.capabilities.roles.push(NodeRole::Synthesizer);

        state.register(m_series_registration("node-strong"));
        let mut mlx_heartbeat = ready_heartbeat("node-strong", "7");
        mlx_heartbeat.available_memory_mb = 8_192;
        mlx_heartbeat.worker_health.model_name =
            Some("mlx-community/Qwen2.5-3B-Instruct-4bit".to_string());
        mlx_heartbeat.worker_health.runtime_mode = "mlx".to_string();
        mlx_heartbeat.worker_health.capabilities.max_context_tokens = Some(8_192);
        mlx_heartbeat.worker_health.capabilities.roles = vec![
            NodeRole::Batch,
            NodeRole::Chat,
            NodeRole::ChunkAnalysis,
            NodeRole::Coding,
        ];
        state.heartbeat(mlx_heartbeat, "7".to_string());
        state
            .jobs
            .get_mut("job-1")
            .and_then(|job| {
                job.graph
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == "job.final_merge")
            })
            .expect("final merge")
            .assigned_node_id = Some("node-weak".to_string());

        assert_eq!(
            best_reducer_node_id_for_job(&state, state.jobs.get("job-1").expect("decomposed job"))
                .as_deref(),
            Some("node-strong")
        );

        assert!(state.claim_job("node-weak", "8".to_string()).job.is_none());
        let reducer_claim = state
            .claim_job("node-strong", "9".to_string())
            .job
            .expect("strong node claims reducer");
        assert_eq!(
            reducer_claim.active_graph_node_id.as_deref(),
            Some("job.final_merge")
        );
        assert_eq!(
            reducer_claim.assigned_node_id.as_deref(),
            Some("node-strong")
        );
        assert_eq!(
            reducer_claim.scheduler_decision.as_ref().map(|decision| {
                decision
                    .reasons
                    .iter()
                    .any(|reason| reason.contains("strong node selected"))
            }),
            Some(true)
        );
    }

    #[test]
    fn final_reducer_failure_completes_with_section_fallback() {
        let mut state = ready_state();
        let mut request = reducer_fixture_request();
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "1".to_string());

        for (expected_node, output, updated_at) in [
            ("job.scope", "Scope section text", "2"),
            ("job.backend", "Backend section text", "3"),
            ("job.frontend", "Frontend section text", "4"),
            ("job.tests", "Tests section text", "5"),
        ] {
            let claim = state
                .claim_job("node-1", updated_at.to_string())
                .job
                .expect("section claim");
            assert_eq!(claim.active_graph_node_id.as_deref(), Some(expected_node));
            state
                .complete_job(
                    JobCompletion {
                        job_id: "job-1".to_string(),
                        node_id: "node-1".to_string(),
                        worker_id: "worker-1".to_string(),
                        backend: Backend::M,
                        status: JobStatus::Completed,
                        output: Some(format!("llama.cpp mode=cuda; response={output}")),
                        error: None,
                        latency_ms: Some(10),
                    },
                    updated_at.to_string(),
                )
                .expect("section completion");
        }

        let final_claim = state
            .claim_job("node-1", "6".to_string())
            .job
            .expect("final claim");
        assert_eq!(
            final_claim.active_graph_node_id.as_deref(),
            Some("job.final_merge")
        );

        let completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Failed,
                    output: None,
                    error: Some("llama-cli exited 1".to_string()),
                    latency_ms: Some(10),
                },
                "7".to_string(),
            )
            .expect("reducer failure falls back");

        assert_eq!(completed.status, JobStatus::Completed);
        assert!(completed
            .error
            .as_deref()
            .expect("reducer warning")
            .contains("Final synthesis: llama-cli exited 1"));
        assert!(completed
            .output
            .as_deref()
            .expect("fallback output")
            .contains("Scope section text"));
        assert!(completed
            .graph
            .merge_error
            .as_deref()
            .expect("merge warning")
            .contains("Final synthesis: llama-cli exited 1"));
        assert!(state
            .award_job_reward(&completed, "8".to_string())
            .is_none());
    }

    #[test]
    fn keeps_sequential_graph_nodes_waiting_until_dependencies_complete() {
        let mut state = ControlPlaneState::default();
        state.submit_job(
            classification_request(
                "Design and implement a backend API plus frontend dashboard and add tests.",
            ),
            "1".to_string(),
        );

        let error = state
            .update_graph_node(
                "job-1",
                "job.tests",
                JobGraphNodeStatus::Running,
                None,
                None,
                "2".to_string(),
            )
            .expect_err("tests are blocked");
        assert_eq!(error, "graph node dependencies are not satisfied");

        state
            .update_graph_node(
                "job-1",
                "job.scope",
                JobGraphNodeStatus::Completed,
                Some("scope complete".to_string()),
                None,
                "3".to_string(),
            )
            .expect("scope complete");

        let tests_node = state
            .jobs
            .get("job-1")
            .expect("job")
            .graph
            .nodes
            .iter()
            .find(|node| node.id == "job.tests")
            .expect("tests node");
        assert_eq!(tests_node.status, JobGraphNodeStatus::Waiting);
        assert!(tests_node.blocked_by.contains(&"job.backend".to_string()));
        assert!(tests_node.blocked_by.contains(&"job.frontend".to_string()));
    }

    #[test]
    fn marks_graph_failed_when_a_dependency_fails() {
        let mut state = ControlPlaneState::default();
        state.submit_job(
            classification_request("Implement a Rust API change with tests and documentation."),
            "1".to_string(),
        );

        state
            .update_graph_node(
                "job-1",
                "job.scope",
                JobGraphNodeStatus::Failed,
                None,
                Some("scope rejected".to_string()),
                "2".to_string(),
            )
            .expect("fail scope");

        let graph = &state.jobs.get("job-1").expect("job").graph;
        assert_eq!(graph.status, JobGraphStatus::Failed);
        let backend_node = graph
            .nodes
            .iter()
            .find(|node| node.id == "job.backend")
            .expect("backend node");
        assert_eq!(backend_node.status, JobGraphNodeStatus::Waiting);
        assert!(backend_node.blocked_by.contains(&"job.scope".to_string()));
    }

    #[test]
    fn collects_graph_results_and_merges_final_response() {
        let mut state = ControlPlaneState::default();
        state.submit_job(
            classification_request(
                "Design and implement a backend API plus frontend dashboard and add tests.",
            ),
            "1".to_string(),
        );

        for (node_id, output, updated_at) in [
            ("job.scope", "scope accepted", "2"),
            ("job.backend", "backend complete", "3"),
            ("job.frontend", "frontend complete", "4"),
            ("job.tests", "tests complete", "5"),
        ] {
            state
                .update_graph_node(
                    "job-1",
                    node_id,
                    JobGraphNodeStatus::Completed,
                    Some(output.to_string()),
                    None,
                    updated_at.to_string(),
                )
                .expect("complete graph node");
        }

        let graph = state
            .update_graph_node(
                "job-1",
                "job.final_merge",
                JobGraphNodeStatus::Completed,
                Some("final coherent response".to_string()),
                None,
                "6".to_string(),
            )
            .expect("complete final merge");

        assert_eq!(graph.status, JobGraphStatus::Completed);
        assert_eq!(graph.results.len(), 5);
        assert_eq!(
            graph.final_output.as_deref(),
            Some("final coherent response")
        );
        assert_eq!(graph.merge_error, None);
        assert!(graph
            .results
            .iter()
            .any(|result| result.node_id == "job.backend"
                && result.output.as_deref() == Some("backend complete")
                && result.verification_status == JobResultVerificationStatus::Accepted));
    }

    #[test]
    fn preserves_failed_result_metadata_for_partial_failures() {
        let mut state = ControlPlaneState::default();
        state.submit_job(
            classification_request("Implement a Rust API change with tests and documentation."),
            "1".to_string(),
        );

        state
            .update_graph_node(
                "job-1",
                "job.scope",
                JobGraphNodeStatus::Completed,
                Some("scope complete".to_string()),
                None,
                "2".to_string(),
            )
            .expect("scope complete");
        let graph = state
            .update_graph_node(
                "job-1",
                "job.backend",
                JobGraphNodeStatus::Failed,
                None,
                Some("backend failed validation".to_string()),
                "3".to_string(),
            )
            .expect("backend failure");

        assert_eq!(graph.status, JobGraphStatus::Failed);
        assert_eq!(
            graph.merge_error.as_deref(),
            Some("Backend implementation: backend failed validation")
        );
        let failed_result = graph
            .results
            .iter()
            .find(|result| result.node_id == "job.backend")
            .expect("failed result");
        assert_eq!(failed_result.status, JobGraphNodeStatus::Failed);
        assert_eq!(
            failed_result.error.as_deref(),
            Some("backend failed validation")
        );
        assert_eq!(
            failed_result.verification_status,
            JobResultVerificationStatus::Rejected
        );
    }

    #[test]
    fn rejects_empty_completed_results_before_final_merge() {
        let mut state = ControlPlaneState::default();
        state.submit_job(
            classification_request("Summarize this public inference request."),
            "1".to_string(),
        );

        let graph = state
            .update_graph_node(
                "job-1",
                "job.direct_response",
                JobGraphNodeStatus::Completed,
                Some("   ".to_string()),
                None,
                "2".to_string(),
            )
            .expect("complete direct response");

        assert_eq!(graph.status, JobGraphStatus::Failed);
        assert_eq!(graph.final_output, None);
        assert_eq!(
            graph.merge_error.as_deref(),
            Some("Direct response verification rejected: completed result output was empty")
        );
        let result = graph.results.first().expect("result");
        assert_eq!(
            result.verification_status,
            JobResultVerificationStatus::Rejected
        );
    }

    #[test]
    fn marks_invalid_json_results_as_fallback_needed() {
        let mut state = ControlPlaneState::default();
        state.submit_job(
            classification_request("Return JSON for this public inference request."),
            "1".to_string(),
        );

        let graph = state
            .update_graph_node(
                "job-1",
                "job.direct_response",
                JobGraphNodeStatus::Completed,
                Some("not json".to_string()),
                None,
                "2".to_string(),
            )
            .expect("complete direct response");

        assert_eq!(graph.status, JobGraphStatus::Failed);
        assert_eq!(graph.final_output, None);
        assert_eq!(
            graph.merge_error.as_deref(),
            Some(
                "Direct response verification fallback_needed: output is not valid JSON for the expected format"
            )
        );
        let result = graph.results.first().expect("result");
        assert_eq!(
            result.verification_status,
            JobResultVerificationStatus::FallbackNeeded
        );
    }

    #[test]
    fn covers_m_series_registration_through_completion_lifecycle() {
        let mut state = ControlPlaneState::default();
        let registration = m_series_registration("node-1");
        let registered = state.register(registration);
        assert_eq!(registered.state, AgentState::Starting);
        assert_eq!(registered.backend, Backend::M);

        let heartbeat = ready_heartbeat("node-1", "1");
        let node = state.heartbeat(heartbeat, "1".to_string());
        assert!(node.policy_allowed);
        assert_eq!(node.state, AgentState::Ready);
        assert_eq!(
            node.worker_health
                .as_ref()
                .and_then(|health| health.model_name.as_deref()),
            Some("demo")
        );

        let queued = state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: Some("You are a terse assistant.".to_string()),
                max_tokens: Some(32),
                max_tokens_source: None,
                temperature: Some(0.2),
                top_p: Some(0.9),
                seed: Some(42),
            },
            "2".to_string(),
        );
        assert_eq!(queued.status, JobStatus::Queued);

        let claim = state.claim_job("node-1", "3".to_string());
        let claimed = claim.job.expect("claimed job");
        assert_eq!(claimed.backend, Some(Backend::M));
        assert_eq!(claimed.assigned_node_id.as_deref(), Some("node-1"));
        assert_eq!(
            state.nodes.get("node-1").map(|node| node.state),
            Some(AgentState::Busy)
        );

        let completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("done".to_string()),
                    error: None,
                    latency_ms: Some(125),
                },
                "4".to_string(),
            )
            .expect("completed job");
        assert_eq!(completed.status, JobStatus::Completed);
        assert_eq!(completed.worker_id.as_deref(), Some("worker-1"));
        assert_eq!(
            state.nodes.get("node-1").map(|node| node.state),
            Some(AgentState::Ready)
        );

        let job_json = serde_json::to_value(&completed).expect("job json");
        assert_eq!(job_json["backend"], "m");
        assert_eq!(job_json["status"], "completed");
        assert_eq!(job_json["output"], "done");

        let node_json =
            serde_json::to_value(state.nodes.get("node-1").expect("node")).expect("node json");
        assert_eq!(node_json["backend"], "m");
        assert_eq!(node_json["state"], "ready");
        assert_eq!(node_json["worker_health"]["runtime_mode"], "local");

        let snapshot = state.snapshot("local-json-only");
        assert_eq!(snapshot["online_count"].as_u64(), Some(1));
        assert_eq!(snapshot["completed_job_count"].as_u64(), Some(1));
        assert_eq!(snapshot["assigned_job_count"].as_u64(), Some(0));
        assert_eq!(snapshot["policy_blocked_count"].as_u64(), Some(0));
    }

    #[test]
    fn blocks_unhealthy_m_series_node_from_claiming_jobs() {
        let mut state = ControlPlaneState::default();
        state.register(m_series_registration("node-1"));
        let mut heartbeat = ready_heartbeat("node-1", "1");
        heartbeat.worker_health.healthy = false;
        heartbeat.worker_health.llama_cli_available = false;
        heartbeat.worker_health.runtime_mode = "batch".to_string();
        heartbeat.worker_health.supported_runtime_modes = Vec::new();
        state.heartbeat(heartbeat, "1".to_string());
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "2".to_string(),
        );

        let claim = state.claim_job("node-1", "3".to_string());
        assert!(claim.job.is_none());
        assert_eq!(
            state.jobs.get("job-1").map(|job| job.status),
            Some(JobStatus::Queued)
        );

        let node = state.nodes.get("node-1").expect("node exists");
        assert!(!node.policy_allowed);
        let reason = node.policy_reason.as_deref().expect("policy reason");
        assert!(reason.contains("worker health probe reported unhealthy"));
        assert!(reason.contains("llama-cli is unavailable"));
        assert!(reason.contains("runtime mode batch is not ready for local execution"));

        let snapshot = state.snapshot("local-json-only");
        assert_eq!(snapshot["policy_blocked_count"].as_u64(), Some(1));
        assert_eq!(snapshot["queued_job_count"].as_u64(), Some(1));
        assert_eq!(snapshot["assigned_job_count"].as_u64(), Some(0));
    }

    #[test]
    fn claims_queued_job_for_ready_node() {
        let mut state = ready_state();
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::Auto,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: Some("You are a terse assistant.".to_string()),
                max_tokens: Some(32),
                max_tokens_source: None,
                temperature: Some(0.2),
                top_p: Some(0.9),
                seed: Some(42),
            },
            "2".to_string(),
        );

        let claim = state.claim_job("node-1", "3".to_string());
        let job = claim.job.expect("claimed job");
        assert_eq!(job.job_id, "job-1");
        assert_eq!(job.status, JobStatus::Assigned);
        assert_eq!(job.assigned_node_id.as_deref(), Some("node-1"));
    }

    #[test]
    fn prefers_m_series_nodes_for_auto_jobs_when_available() {
        let mut state = ready_state();
        state.register(AgentRegistration {
            node_id: "node-2".to_string(),
            public_key_fingerprint: "fingerprint-2".to_string(),
            public_key_hex: "ddeeff".to_string(),
            hostname: "host-2".to_string(),
            identity_trust_path: "local-encrypted-fallback".to_string(),
            backend: Backend::Cuda,
            contribution_percent: 40,
            agent_version: "0.1.0".to_string(),
        });
        state.heartbeat(
            Heartbeat {
                node_id: "node-2".to_string(),
                backend: Backend::Cuda,
                agent_state: AgentState::Ready,
                available_memory_mb: 16_000,
                available_gpu_percent: 50,
                updated_at: "2".to_string(),
                contribution_percent: 40,
                hostname: "host-2".to_string(),
                identity_trust_path: "local-encrypted-fallback".to_string(),
                power_source: "AC Power".to_string(),
                on_battery: false,
                battery_percent: Some(90),
                policy_allowed: true,
                policy_reason: None,
                worker_health: WorkerHealthReport {
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
                    supported_runtime_modes: vec![RuntimeMode::Local],
                    streaming_supported: false,
                    capabilities: Default::default(),
                    checked_at: "2".to_string(),
                    notes: vec![],
                },
            },
            "2".to_string(),
        );
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::Auto,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: Some("You are a terse assistant.".to_string()),
                max_tokens: Some(32),
                max_tokens_source: None,
                temperature: Some(0.2),
                top_p: Some(0.9),
                seed: Some(42),
            },
            "3".to_string(),
        );

        let cuda_claim = state.claim_job("node-2", "4".to_string());
        assert!(cuda_claim.job.is_none());
        assert_eq!(
            state.jobs.get("job-1").map(|job| job.status),
            Some(JobStatus::Queued)
        );

        let m_claim = state.claim_job("node-1", "5".to_string());
        let job = m_claim.job.expect("claimed job");
        assert_eq!(job.job_id, "job-1");
        assert_eq!(job.backend, Some(Backend::M));
        assert_eq!(job.assigned_node_id.as_deref(), Some("node-1"));
    }

    #[test]
    fn completion_updates_node_trust_stats() {
        let mut state = ready_state();
        state.submit_job(classification_request("hello world"), "2".to_string());
        state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("claimed job");

        state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("done".to_string()),
                    error: None,
                    latency_ms: Some(125),
                },
                "4".to_string(),
            )
            .expect("completed job");

        let node = state.nodes.get("node-1").expect("node");
        assert_eq!(node.trust.completed_jobs, 1);
        assert_eq!(node.trust.failed_jobs, 0);
        assert_eq!(node.trust.consecutive_failures, 0);
        assert_eq!(node.trust.total_latency_ms, 125);
        assert_eq!(node.trust.last_success_at.as_deref(), Some("4"));
        assert!(node.trust.score > 50);

        state.submit_job(
            JobRequest {
                request_id: "job-2".to_string(),
                prompt: "hello again".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "5".to_string(),
        );
        state
            .claim_job("node-1", "6".to_string())
            .job
            .expect("second claim");
        state
            .complete_job(
                JobCompletion {
                    job_id: "job-2".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Failed,
                    output: None,
                    error: Some("runtime failed".to_string()),
                    latency_ms: Some(75),
                },
                "7".to_string(),
            )
            .expect("failed job");

        let node = state.nodes.get("node-1").expect("node");
        assert_eq!(node.trust.completed_jobs, 1);
        assert_eq!(node.trust.failed_jobs, 1);
        assert_eq!(node.trust.consecutive_failures, 1);
        assert_eq!(node.trust.total_latency_ms, 200);
        assert_eq!(node.trust.last_failure_at.as_deref(), Some("7"));
        assert_eq!(
            node.trust.last_failure_reason.as_deref(),
            Some("runtime failed")
        );
    }

    #[test]
    fn scheduler_prefers_higher_trust_node_when_capabilities_match() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());

        {
            let node_1 = state.nodes.get_mut("node-1").expect("node-1");
            node_1.trust.score = 30;
            node_1.trust.failed_jobs = 4;
            node_1.trust.consecutive_failures = 2;
            let node_2 = state.nodes.get_mut("node-2").expect("node-2");
            node_2.trust.score = 90;
            node_2.trust.completed_jobs = 10;
        }

        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "Draft a concise report.".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "2".to_string(),
        );

        let job = state.jobs.get("job-1").expect("job");
        let decision = job.scheduler_decision.as_ref().expect("scheduler decision");
        assert_eq!(decision.node_id, "node-2");
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.starts_with("trust:90")));
    }

    #[test]
    fn scheduler_routes_simple_jobs_to_lightweight_advertised_model() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());

        state
            .nodes
            .get_mut("node-1")
            .and_then(|node| node.worker_health.as_mut())
            .expect("node-1 health")
            .model_name = Some("Qwen/Qwen2.5-0.5B-Instruct".to_string());
        state
            .nodes
            .get_mut("node-2")
            .and_then(|node| node.worker_health.as_mut())
            .expect("node-2 health")
            .model_name = Some("Qwen/Qwen2.5-3B-Instruct".to_string());

        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "Answer in one word: 4+3?".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "2".to_string(),
        );

        let job = state.jobs.get("job-1").expect("job");
        let decision = job.scheduler_decision.as_ref().expect("scheduler decision");
        assert_eq!(decision.node_id, "node-1");
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.contains("tier small")));

        let claim = state
            .claim_job("node-1", "3".to_string())
            .job
            .expect("claim");
        assert_eq!(claim.model.as_deref(), Some("Qwen/Qwen2.5-0.5B-Instruct"));
    }

    #[test]
    fn scheduler_avoids_tiny_models_for_long_generation_when_normal_model_is_ready() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());

        state
            .nodes
            .get_mut("node-1")
            .and_then(|node| node.worker_health.as_mut())
            .expect("node-1 health")
            .model_name = Some("HuggingFaceTB/SmolLM2-135M-Instruct".to_string());
        state
            .nodes
            .get_mut("node-2")
            .and_then(|node| node.worker_health.as_mut())
            .expect("node-2 health")
            .model_name = Some("Qwen/Qwen2.5-1.5B-Instruct".to_string());

        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "Give me a detailed history of Honda from its origins to today."
                    .to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "2".to_string(),
        );

        let job = state.jobs.get("job-1").expect("job");
        let decision = job.scheduler_decision.as_ref().expect("scheduler decision");
        assert_eq!(decision.node_id, "node-2");
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.contains("normal model acceptable")));

        let claim = state
            .claim_job("node-2", "3".to_string())
            .job
            .expect("claim");
        assert_eq!(claim.model.as_deref(), Some("Qwen/Qwen2.5-1.5B-Instruct"));
    }

    #[test]
    fn scheduler_uses_chunk_latency_telemetry_for_decisions() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());
        state.jobs.insert(
            "history-slow".to_string(),
            completed_graph_history_job(
                "history-slow",
                "node-1",
                JobGraphNodeStatus::Completed,
                Some(140_000),
            ),
        );
        state.jobs.insert(
            "history-fast".to_string(),
            completed_graph_history_job(
                "history-fast",
                "node-2",
                JobGraphNodeStatus::Completed,
                Some(8_000),
            ),
        );

        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "Draft a concise public history note.".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "5".to_string(),
        );

        let job = state.jobs.get("job-1").expect("job");
        let decision = job.scheduler_decision.as_ref().expect("decision");
        assert_eq!(decision.node_id, "node-2");
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.contains("performance:avg_chunk_latency_ms:8000")));
    }

    #[test]
    fn slow_nodes_remain_eligible_for_regular_parallel_chunks() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());
        state.jobs.insert(
            "history-slow".to_string(),
            completed_graph_history_job(
                "history-slow",
                "node-1",
                JobGraphNodeStatus::Completed,
                Some(140_000),
            ),
        );
        state.jobs.insert(
            "history-fast".to_string(),
            completed_graph_history_job(
                "history-fast",
                "node-2",
                JobGraphNodeStatus::Completed,
                Some(8_000),
            ),
        );

        let mut request =
            classification_request("Give me a detailed history of BMW from its origins to today.");
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "5".to_string());

        let slow_claim = state
            .claim_job("node-1", "6".to_string())
            .job
            .expect("slow node can still claim section work");
        assert_ne!(
            slow_claim.active_graph_node_id.as_deref(),
            Some("job.final_merge")
        );
    }

    #[test]
    fn reducer_waits_for_fastest_ready_node_when_slow_node_polls_first() {
        let mut state = ready_state();
        for node_id in ["node-2", "node-3", "node-4"] {
            state.register(m_series_registration(node_id));
            state.heartbeat(ready_heartbeat(node_id, "1"), "1".to_string());
        }
        state.jobs.insert(
            "history-slow".to_string(),
            completed_graph_history_job(
                "history-slow",
                "node-1",
                JobGraphNodeStatus::Completed,
                Some(140_000),
            ),
        );
        state.jobs.insert(
            "history-fast".to_string(),
            completed_graph_history_job(
                "history-fast",
                "node-2",
                JobGraphNodeStatus::Completed,
                Some(8_000),
            ),
        );
        state.jobs.insert(
            "history-failed".to_string(),
            completed_graph_history_job(
                "history-failed",
                "node-3",
                JobGraphNodeStatus::Failed,
                Some(40_000),
            ),
        );
        state.jobs.insert(
            "history-medium".to_string(),
            completed_graph_history_job(
                "history-medium",
                "node-4",
                JobGraphNodeStatus::Completed,
                Some(45_000),
            ),
        );

        let mut request = reducer_fixture_request();
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "5".to_string());
        make_reducer_ready(&mut state, "job-1");

        assert!(state.claim_job("node-1", "6".to_string()).job.is_none());
        assert!(state.claim_job("node-3", "6".to_string()).job.is_none());

        let fast_claim = state
            .claim_job("node-2", "6".to_string())
            .job
            .expect("fast node claims reducer");
        assert_eq!(
            fast_claim.active_graph_node_id.as_deref(),
            Some("job.final_merge")
        );
        let decision = fast_claim
            .scheduler_decision
            .as_ref()
            .expect("scheduler decision");
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.contains("performance:avg_chunk_latency_ms:8000")));
    }

    #[test]
    fn reducer_waits_for_highest_capacity_ready_node() {
        let mut state = ready_state();
        state.register(m_series_registration("node-strongest"));
        let mut heartbeat = ready_heartbeat("node-strongest", "1");
        heartbeat.available_memory_mb = 64_000;
        heartbeat.worker_health.model_name = Some("Qwen/Qwen2.5-14B-Instruct".to_string());
        state.heartbeat(heartbeat, "1".to_string());

        let mut request = reducer_fixture_request();
        request.execution_mode = JobExecutionMode::Decompose;
        request.model = None;
        state.submit_job(request, "2".to_string());
        make_reducer_ready(&mut state, "job-1");

        assert!(state.claim_job("node-1", "3".to_string()).job.is_none());
        let claim = state
            .claim_job("node-strongest", "3".to_string())
            .job
            .expect("highest-capacity node claims reducer");
        assert_eq!(
            claim.active_graph_node_id.as_deref(),
            Some("job.final_merge")
        );
        let reducer = state
            .jobs
            .get("job-1")
            .and_then(|job| {
                job.graph
                    .nodes
                    .iter()
                    .find(|node| node.id == "job.final_merge")
            })
            .expect("assigned reducer node");
        assert_eq!(reducer.assigned_node_id.as_deref(), Some("node-strongest"));
        assert_eq!(reducer.model.as_deref(), Some("Qwen/Qwen2.5-14B-Instruct"));
    }

    #[test]
    fn healthy_mlx_node_uses_strong_reducer_capacity_without_blas() {
        let mut state = ready_state();
        let node = state.nodes.get_mut("node-1").expect("ready node");
        let health = node.worker_health.as_mut().expect("worker health");
        health.runtime_mode = "mlx".to_string();
        health.blas_device_available = false;
        health.model_name = Some("mlx-community/Qwen2.5-3B-Instruct-4bit".to_string());

        assert_eq!(reducer_profile(node), ReducerProfile::Strong);
        assert_eq!(reducer_section_char_limit(node), 6_000);
    }

    #[test]
    fn long_implementation_chunk_waits_for_fast_ready_node() {
        let mut state = ready_state();
        state.register(m_series_registration("node-2"));
        state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());
        state.jobs.insert(
            "history-slow".to_string(),
            completed_graph_history_job(
                "history-slow",
                "node-1",
                JobGraphNodeStatus::Completed,
                Some(140_000),
            ),
        );
        state.jobs.insert(
            "history-fast".to_string(),
            completed_graph_history_job(
                "history-fast",
                "node-2",
                JobGraphNodeStatus::Completed,
                Some(8_000),
            ),
        );

        let mut request = classification_request(
            "Give me a complete Turbo C program to handle enrollment of students save in binary file",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "5".to_string());
        state
            .update_graph_node(
                "job-1",
                "job.code_contract",
                JobGraphNodeStatus::Completed,
                Some("contract complete".to_string()),
                None,
                "6".to_string(),
            )
            .expect("contract complete");

        assert!(state.claim_job("node-1", "7".to_string()).job.is_none());

        let fast_claim = state
            .claim_job("node-2", "7".to_string())
            .job
            .expect("fast node claims implementation");
        assert_eq!(
            fast_claim.active_graph_node_id.as_deref(),
            Some("job.code_types")
        );
        let decision = fast_claim
            .scheduler_decision
            .as_ref()
            .expect("scheduler decision");
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.contains("performance:avg_chunk_latency_ms:8000")));
    }

    #[test]
    fn single_node_still_claims_long_chunk_without_waiting() {
        let mut state = ready_state();
        state.jobs.insert(
            "history-slow".to_string(),
            completed_graph_history_job(
                "history-slow",
                "node-1",
                JobGraphNodeStatus::Completed,
                Some(140_000),
            ),
        );

        let mut request = classification_request(
            "Give me a complete Turbo C program to handle enrollment of students save in binary file",
        );
        request.execution_mode = JobExecutionMode::Decompose;
        state.submit_job(request, "5".to_string());
        state
            .update_graph_node(
                "job-1",
                "job.code_contract",
                JobGraphNodeStatus::Completed,
                Some("contract complete".to_string()),
                None,
                "6".to_string(),
            )
            .expect("contract complete");

        let claim = state
            .claim_job("node-1", "7".to_string())
            .job
            .expect("only ready node claims implementation");
        assert_eq!(
            claim.active_graph_node_id.as_deref(),
            Some("job.code_types")
        );
    }

    #[test]
    fn claim_uses_capability_score_for_eligible_jobs() {
        let mut state = ready_state();
        state.submit_job(
            JobRequest {
                request_id: "job-low-score".to_string(),
                prompt: "Estimate this public sequence: 2, 4, 8.".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "2".to_string(),
        );
        state.submit_job(
            JobRequest {
                request_id: "job-high-score".to_string(),
                prompt: "Draft a markdown operator report for this internal rollout.".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "3".to_string(),
        );

        let claim = state.claim_job("node-1", "4".to_string());
        let job = claim.job.expect("claimed job");
        let decision = job.scheduler_decision.expect("scheduler decision");

        assert_eq!(job.job_id, "job-high-score");
        assert_eq!(decision.node_id, "node-1");
        assert!(decision.score > 0);
        assert!(decision
            .reasons
            .contains(&"requested model is already present".to_string()));
        assert_eq!(
            state.jobs.get("job-low-score").map(|job| job.status),
            Some(JobStatus::Queued)
        );
    }

    #[test]
    fn claim_tie_breaks_matching_jobs_deterministically() {
        let mut state = ready_state();
        for request_id in ["job-a", "job-b"] {
            state.submit_job(
                JobRequest {
                    request_id: request_id.to_string(),
                    prompt: "hello world".to_string(),
                    preferred_backend: Backend::M,
                    routing_mode: RoutingMode::Normal,
                    runtime_mode: RuntimeMode::Local,
                    execution_mode: JobExecutionMode::Single,
                    stream: false,
                    model: None,
                    system_prompt: None,
                    max_tokens: None,
                    max_tokens_source: None,
                    temperature: None,
                    top_p: None,
                    seed: None,
                },
                "2".to_string(),
            );
        }

        let claim = state.claim_job("node-1", "3".to_string());
        let job = claim.job.expect("claimed job");

        assert_eq!(job.job_id, "job-a");
        assert!(job.scheduler_decision.is_some());
    }

    #[test]
    fn stores_worker_health_snapshot_on_heartbeat() {
        let state = ready_state();
        let node = state.nodes.get("node-1").expect("node exists");
        let worker_health = node.worker_health.as_ref().expect("worker health present");
        assert!(worker_health.healthy);
        assert_eq!(worker_health.model_name.as_deref(), Some("demo"));
        assert_eq!(
            worker_health.model_path.as_deref(),
            Some("/tmp/models/demo.gguf")
        );
        assert!(worker_health.llama_cli_available);
        assert!(worker_health.blas_device_available);
    }

    #[test]
    fn computes_policy_server_side_for_healthy_node() {
        let mut state = ready_state();
        state.heartbeat(
            Heartbeat {
                node_id: "node-1".to_string(),
                backend: Backend::M,
                agent_state: AgentState::Ready,
                available_memory_mb: 16_000,
                available_gpu_percent: 50,
                updated_at: "2".to_string(),
                contribution_percent: 50,
                hostname: "host-1".to_string(),
                identity_trust_path: "local-encrypted-fallback".to_string(),
                power_source: "AC Power".to_string(),
                on_battery: false,
                battery_percent: Some(90),
                policy_allowed: false,
                policy_reason: Some("client says blocked".to_string()),
                worker_health: WorkerHealthReport {
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
                    capabilities: Default::default(),
                    checked_at: "2".to_string(),
                    notes: vec![],
                },
            },
            "2".to_string(),
        );

        let node = state.nodes.get("node-1").expect("node exists");
        assert!(node.policy_allowed);
        assert_eq!(node.policy_reason, None);
    }

    #[test]
    fn allows_healthy_node_when_power_source_is_unknown_but_not_on_battery() {
        let mut state = ready_state();
        let mut heartbeat = ready_heartbeat("node-1", "2");
        heartbeat.power_source = "unknown".to_string();
        heartbeat.worker_health.power_source = "unknown".to_string();
        heartbeat.on_battery = false;
        heartbeat.worker_health.on_battery = false;
        heartbeat.battery_percent = None;
        heartbeat.worker_health.battery_percent = None;

        let node = state.heartbeat(heartbeat, "2".to_string());

        assert!(node.policy_allowed);
        assert_eq!(node.policy_reason, None);
    }

    #[test]
    fn allows_windows_cuda_node_with_model_path_inside_model_dir() {
        let mut state = ControlPlaneState::default();
        state.register(AgentRegistration {
            node_id: "node-win".to_string(),
            public_key_fingerprint: "fingerprint-win".to_string(),
            public_key_hex: "aabbcc".to_string(),
            hostname: "dave".to_string(),
            identity_trust_path: "local-encrypted-fallback".to_string(),
            backend: Backend::Cuda,
            contribution_percent: 50,
            agent_version: "0.1.0".to_string(),
        });

        let node = state.heartbeat(
            Heartbeat {
                node_id: "node-win".to_string(),
                backend: Backend::Cuda,
                agent_state: AgentState::Ready,
                available_memory_mb: 16_000,
                available_gpu_percent: 50,
                updated_at: "2".to_string(),
                contribution_percent: 50,
                hostname: "dave".to_string(),
                identity_trust_path: "local-encrypted-fallback".to_string(),
                power_source: "unknown".to_string(),
                on_battery: false,
                battery_percent: None,
                policy_allowed: true,
                policy_reason: None,
                worker_health: WorkerHealthReport {
                    healthy: true,
                    model_dir: r"C:\Users\batal\.opengpu\models".to_string(),
                    model_name: Some("Qwen/Qwen2.5-0.5B-Instruct".to_string()),
                    model_path: Some(
                        r"C:\Users\batal\.opengpu\models\qwen_qwen2_5-0_5b-instruct\qwen.gguf"
                            .to_string(),
                    ),
                    llama_cli_available: true,
                    blas_device_available: false,
                    cuda_device_available: true,
                    cuda_driver_available: true,
                    cuda_device_name: Some("GeForce GTX 1650".to_string()),
                    cuda_memory_mb: Some(4096),
                    power_source: "unknown".to_string(),
                    on_battery: false,
                    battery_percent: None,
                    runtime_ready: true,
                    runtime_mode: "cuda".to_string(),
                    parallel_slots: 1,
                    supported_runtime_modes: vec![RuntimeMode::Local],
                    streaming_supported: false,
                    capabilities: Default::default(),
                    checked_at: "2".to_string(),
                    notes: vec![],
                },
            },
            "2".to_string(),
        );

        assert!(node.policy_allowed);
        assert_eq!(node.policy_reason, None);
    }

    /// Health exactly as a node contributing an already-running local cluster
    /// reports it: the endpoint answers, but there is no MundusX model file, no
    /// llama-cli, and no accelerator of its own.
    fn contributed_cluster_worker_health(checked_at: &str) -> WorkerHealthReport {
        let mut health = healthy_worker_health(checked_at);
        health.runtime_mode = "contributed-cluster".to_string();
        health.model_path = None;
        health.model_name = Some("UD-IQ2_M".to_string());
        health.llama_cli_available = false;
        health.blas_device_available = false;
        health.cuda_device_available = false;
        health.cuda_driver_available = false;
        health
    }

    #[test]
    fn schedules_jobs_onto_a_node_contributing_a_running_local_cluster() {
        // Admission alone was not enough: `worker_runtime_dependencies_ready`
        // also required mlx, vllm, or a local llama-cli, so these nodes were
        // never eligible and jobs stayed queued and unassigned.
        let health = contributed_cluster_worker_health("2");

        assert!(ControlPlaneState::worker_runtime_dependencies_ready(
            &health
        ));
    }

    #[test]
    fn a_node_without_a_remote_runtime_still_needs_llama_cli_to_be_scheduled() {
        let mut health = healthy_worker_health("2");
        health.llama_cli_available = false;

        assert!(!ControlPlaneState::worker_runtime_dependencies_ready(
            &health
        ));
    }

    #[test]
    fn admits_a_node_contributing_a_running_local_cluster() {
        // Before this, such a node was blocked with "model path is missing;
        // llama-cli is unavailable; BLAS device acceleration is unavailable",
        // even though it routes every job to a healthy local endpoint.
        let health = contributed_cluster_worker_health("2");

        let (allowed, reason) =
            evaluate_policy(AgentState::Ready, "AC Power", false, Some(90), &health);

        assert!(allowed, "unexpected block: {reason:?}");
        assert_eq!(reason, None);
    }

    #[test]
    fn a_contributed_cluster_still_needs_a_model_and_a_healthy_endpoint() {
        let mut unhealthy = contributed_cluster_worker_health("2");
        unhealthy.healthy = false;
        let (allowed, reason) =
            evaluate_policy(AgentState::Ready, "AC Power", false, Some(90), &unhealthy);
        assert!(!allowed);
        assert!(reason
            .as_deref()
            .expect("reason")
            .contains("worker health probe reported unhealthy"));

        let mut no_model = contributed_cluster_worker_health("2");
        no_model.model_name = None;
        let (allowed, reason) =
            evaluate_policy(AgentState::Ready, "AC Power", false, Some(90), &no_model);
        assert!(!allowed);
        assert!(reason
            .as_deref()
            .expect("reason")
            .contains("model name is missing"));
    }

    #[test]
    fn other_runtimes_still_require_a_local_model_and_accelerator() {
        // The exemption must not leak into the normal local-runtime path.
        let mut health = healthy_worker_health("2");
        health.model_path = None;
        health.llama_cli_available = false;
        health.blas_device_available = false;

        let (allowed, reason) =
            evaluate_policy(AgentState::Ready, "AC Power", false, Some(90), &health);
        let reason = reason.expect("reason");

        assert!(!allowed);
        assert!(reason.contains("model path is missing"));
        assert!(reason.contains("llama-cli is unavailable"));
        assert!(reason.contains("BLAS device acceleration is unavailable"));
    }

    #[test]
    fn blocks_windows_cuda_node_when_llama_cli_is_missing() {
        let mut state = ControlPlaneState::default();
        state.register(cuda_registration("node-win"));
        let mut heartbeat = low_vram_cuda_heartbeat("node-win", "2");
        heartbeat.worker_health.llama_cli_available = false;

        let node = state.heartbeat(heartbeat, "2".to_string());

        assert!(!node.policy_allowed);
        assert!(node
            .policy_reason
            .as_deref()
            .expect("policy reason")
            .contains("llama-cli is unavailable"));
    }

    #[test]
    fn still_blocks_non_cuda_node_without_blas_runtime() {
        let mut health = healthy_worker_health("2");
        health.llama_cli_available = false;
        health.blas_device_available = false;

        let (allowed, reason) =
            evaluate_policy(AgentState::Ready, "AC Power", false, Some(90), &health);

        assert!(!allowed);
        let reason = reason.expect("policy reason");
        assert!(reason.contains("llama-cli is unavailable"));
        assert!(reason.contains("BLAS device acceleration is unavailable"));
    }

    #[test]
    fn allows_healthy_mlx_node_without_llama_runtime() {
        let mut health = healthy_worker_health("2");
        health.runtime_mode = "mlx".to_string();
        health.model_name = Some("mlx-community/Qwen2.5-3B-Instruct-4bit".to_string());
        health.model_path = None;
        health.supported_runtime_modes = vec![RuntimeMode::Local];
        health.llama_cli_available = false;
        health.blas_device_available = false;

        let (allowed, reason) =
            evaluate_policy(AgentState::Ready, "AC Power", false, Some(90), &health);

        assert!(allowed);
        assert_eq!(reason, None);
    }

    #[test]
    fn still_blocks_cuda_node_without_model_path() {
        let mut health = healthy_worker_health("2");
        health.runtime_mode = "cuda".to_string();
        health.model_path = None;
        health.cuda_device_available = true;
        health.cuda_driver_available = true;

        let (allowed, reason) =
            evaluate_policy(AgentState::Ready, "AC Power", false, Some(90), &health);

        assert!(!allowed);
        assert!(reason
            .expect("policy reason")
            .contains("model path is missing"));
    }

    #[test]
    fn healthy_mlx_node_can_claim_local_job_without_llama_runtime() {
        let mut state = ready_state();
        let node = state.nodes.get_mut("node-1").expect("ready node");
        let health = node.worker_health.as_mut().expect("worker health");
        health.runtime_mode = "mlx".to_string();
        health.model_name = Some("mlx-community/Qwen2.5-3B-Instruct-4bit".to_string());
        health.model_path = None;
        health.supported_runtime_modes = vec![RuntimeMode::Local];
        health.llama_cli_available = false;
        health.blas_device_available = false;

        state.submit_job(
            JobRequest {
                request_id: "mlx-job".to_string(),
                prompt: "Summarize this request".to_string(),
                preferred_backend: Backend::Auto,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: None,
                max_tokens: Some(128),
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "2".to_string(),
        );

        let claim = state.claim_job("node-1", "3".to_string());
        assert_eq!(claim.job.map(|job| job.job_id).as_deref(), Some("mlx-job"));
    }

    #[test]
    fn node_path_prefix_check_supports_windows_macos_and_linux_paths() {
        assert!(node_path_starts_with(
            r"C:\Users\batal\.opengpu\models\qwen\model.gguf",
            r"C:\Users\batal\.opengpu\models",
        ));
        assert!(node_path_starts_with(
            "/Users/batal/.opengpu/models/qwen/model.gguf",
            "/Users/batal/.opengpu/models",
        ));
        assert!(node_path_starts_with(
            "/home/batal/.opengpu/models/qwen/model.gguf",
            "/home/batal/.opengpu/models",
        ));
        assert!(!node_path_starts_with(
            "/home/batal/.opengpu/modelshare/qwen.gguf",
            "/home/batal/.opengpu/models",
        ));
    }

    #[test]
    fn blocks_nodes_that_are_not_ready_for_local_execution() {
        let mut state = ControlPlaneState::default();
        state.register(AgentRegistration {
            node_id: "node-2".to_string(),
            public_key_fingerprint: "fingerprint-2".to_string(),
            public_key_hex: "ddeeff".to_string(),
            hostname: "host-2".to_string(),
            identity_trust_path: "local-encrypted-fallback".to_string(),
            backend: Backend::M,
            contribution_percent: 20,
            agent_version: "0.1.0".to_string(),
        });

        state.heartbeat(
            Heartbeat {
                node_id: "node-2".to_string(),
                backend: Backend::M,
                agent_state: AgentState::Ready,
                available_memory_mb: 16_000,
                available_gpu_percent: 50,
                updated_at: "2".to_string(),
                contribution_percent: 20,
                hostname: "host-2".to_string(),
                identity_trust_path: "local-encrypted-fallback".to_string(),
                power_source: "AC Power".to_string(),
                on_battery: false,
                battery_percent: Some(90),
                policy_allowed: true,
                policy_reason: None,
                worker_health: WorkerHealthReport {
                    healthy: true,
                    model_dir: "/tmp/models".to_string(),
                    model_name: Some("demo".to_string()),
                    model_path: Some("/opt/models/demo.gguf".to_string()),
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
                    runtime_mode: "batch".to_string(),
                    parallel_slots: 1,
                    supported_runtime_modes: Vec::new(),
                    streaming_supported: false,
                    capabilities: Default::default(),
                    checked_at: "2".to_string(),
                    notes: vec![],
                },
            },
            "2".to_string(),
        );

        let node = state.nodes.get("node-2").expect("node exists");
        assert!(!node.policy_allowed);
        let reason = node.policy_reason.as_deref().expect("policy reason");
        assert!(reason
            .contains("model path /opt/models/demo.gguf is outside model directory /tmp/models"));
        assert!(reason.contains("runtime mode batch is not ready for local execution"));
    }

    #[test]
    fn snapshot_counts_trusted_nodes_from_identity_trust_path() {
        let mut state = ready_state();
        state.register(AgentRegistration {
            node_id: "node-2".to_string(),
            public_key_fingerprint: "fingerprint-2".to_string(),
            public_key_hex: "ddeeff".to_string(),
            hostname: "host-2".to_string(),
            identity_trust_path: "keychain".to_string(),
            backend: Backend::M,
            contribution_percent: 20,
            agent_version: "0.1.0".to_string(),
        });

        let snapshot = state.snapshot("supabase");
        assert_eq!(snapshot["trusted_count"].as_u64(), Some(1));
        assert_eq!(snapshot["online_count"].as_u64(), Some(1));
        assert_eq!(snapshot["storage_source"].as_str(), Some("supabase"));
    }

    #[test]
    fn does_not_claim_job_for_busy_node() {
        let mut state = ready_state();
        state.heartbeat(
            Heartbeat {
                node_id: "node-1".to_string(),
                backend: Backend::M,
                agent_state: AgentState::Busy,
                available_memory_mb: 16_000,
                available_gpu_percent: 50,
                updated_at: "2".to_string(),
                contribution_percent: 50,
                hostname: "host-1".to_string(),
                identity_trust_path: "local-encrypted-fallback".to_string(),
                power_source: "AC Power".to_string(),
                on_battery: false,
                battery_percent: Some(90),
                policy_allowed: true,
                policy_reason: None,
                worker_health: WorkerHealthReport {
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
                    capabilities: Default::default(),
                    checked_at: "2".to_string(),
                    notes: vec![],
                },
            },
            "2".to_string(),
        );
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::Auto,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "3".to_string(),
        );

        let claim = state.claim_job("node-1", "4".to_string());
        assert!(claim.job.is_none());
        assert_eq!(
            state.jobs.get("job-1").map(|job| job.status),
            Some(JobStatus::Queued)
        );
    }

    #[test]
    fn cuda_parallel_capacity_uses_reported_slots_and_cap_applied_vram() {
        let mut state = ready_state();
        let node = state.nodes.get_mut("node-1").expect("node exists");
        node.backend = Backend::Cuda;
        node.contribution_percent = 80;
        let health = node.worker_health.as_mut().expect("worker health");
        health.cuda_device_available = true;
        health.cuda_memory_mb = Some(32_768);
        health.runtime_mode = "persistent-warm-cuda".to_string();
        health.parallel_slots = 4;

        let job = state.submit_job(
            classification_request("Summarize the history of Warsaw."),
            "3".to_string(),
        );
        let node = state.nodes.get("node-1").expect("node exists");
        assert_eq!(
            ControlPlaneState::node_parallel_capacity_for_job(node, &job),
            4
        );
    }

    #[test]
    fn coding_parallelism_is_disabled_on_low_vram_and_capped_on_rtx_5090() {
        let mut state = ready_state();
        let node = state.nodes.get_mut("node-1").expect("node exists");
        node.backend = Backend::Cuda;
        node.contribution_percent = 80;
        let health = node.worker_health.as_mut().expect("worker health");
        health.cuda_device_available = true;
        health.cuda_memory_mb = Some(4_096);
        health.runtime_mode = "persistent-warm-cuda".to_string();
        health.parallel_slots = 4;

        let job = state.submit_job(
            classification_request("Write a complete Rust program with tests."),
            "3".to_string(),
        );
        let node = state.nodes.get("node-1").expect("node exists");
        assert_eq!(
            ControlPlaneState::node_parallel_capacity_for_job(node, &job),
            1
        );

        let node = state.nodes.get_mut("node-1").expect("node exists");
        node.worker_health
            .as_mut()
            .expect("worker health")
            .cuda_memory_mb = Some(32_768);
        assert_eq!(
            ControlPlaneState::node_parallel_capacity_for_job(node, &job),
            2
        );
    }

    #[test]
    fn mlx_parallel_capacity_uses_reported_unified_memory_slots() {
        let mut state = ready_state();
        let node = state.nodes.get_mut("node-1").expect("node exists");
        node.backend = Backend::M;
        node.available_memory_mb = 64_000;
        node.contribution_percent = 80;
        let health = node.worker_health.as_mut().expect("worker health");
        health.runtime_mode = "mlx".to_string();
        health.parallel_slots = 3;

        let job = state.submit_job(
            classification_request("Summarize the history of Warsaw."),
            "3".to_string(),
        );
        let node = state.nodes.get("node-1").expect("node exists");
        assert_eq!(
            ControlPlaneState::node_parallel_capacity_for_job(node, &job),
            3
        );
    }

    #[test]
    fn mlx_coding_parallelism_is_conservative() {
        let mut state = ready_state();
        let node = state.nodes.get_mut("node-1").expect("node exists");
        node.backend = Backend::M;
        node.available_memory_mb = 64_000;
        node.contribution_percent = 80;
        let health = node.worker_health.as_mut().expect("worker health");
        health.runtime_mode = "mlx".to_string();
        health.parallel_slots = 3;

        let job = state.submit_job(
            classification_request("Write a complete Rust program with tests."),
            "3".to_string(),
        );
        let node = state.nodes.get("node-1").expect("node exists");
        assert_eq!(
            ControlPlaneState::node_parallel_capacity_for_job(node, &job),
            2
        );
    }

    #[test]
    fn warm_high_capacity_busy_node_can_claim_another_job_slot() {
        let mut state = ready_state();
        let mut warm_health = healthy_worker_health("2");
        warm_health.model_name = Some("Qwen/Qwen2.5-1.5B-Instruct".to_string());
        warm_health.runtime_mode = "persistent-warm-cuda".to_string();
        warm_health.cuda_device_available = true;
        warm_health.cuda_memory_mb = Some(32_768);
        warm_health.parallel_slots = 4;
        warm_health.streaming_supported = true;

        state.heartbeat(
            Heartbeat {
                node_id: "node-1".to_string(),
                backend: Backend::Cuda,
                agent_state: AgentState::Ready,
                available_memory_mb: 49_152,
                available_gpu_percent: 80,
                updated_at: "2".to_string(),
                contribution_percent: 80,
                hostname: "host-1".to_string(),
                identity_trust_path: "local-encrypted-fallback".to_string(),
                power_source: "AC Power".to_string(),
                on_battery: false,
                battery_percent: Some(90),
                policy_allowed: true,
                policy_reason: None,
                worker_health: warm_health,
            },
            "2".to_string(),
        );

        for request_id in ["job-1", "job-2"] {
            state.submit_job(
                JobRequest {
                    request_id: request_id.to_string(),
                    prompt: "short answer".to_string(),
                    preferred_backend: Backend::Auto,
                    routing_mode: RoutingMode::Normal,
                    runtime_mode: RuntimeMode::Local,
                    execution_mode: JobExecutionMode::Single,
                    stream: false,
                    model: None,
                    system_prompt: None,
                    max_tokens: None,
                    max_tokens_source: None,
                    temperature: None,
                    top_p: None,
                    seed: None,
                },
                "3".to_string(),
            );
        }

        let first_claim = state.claim_job("node-1", "4".to_string());
        assert_eq!(
            first_claim.job.as_ref().map(|job| job.request_id.as_str()),
            Some("job-1")
        );
        assert_eq!(
            state.nodes.get("node-1").map(|node| node.state),
            Some(AgentState::Busy)
        );

        let second_claim = state.claim_job("node-1", "5".to_string());
        assert_eq!(
            second_claim.job.as_ref().map(|job| job.request_id.as_str()),
            Some("job-2")
        );
        let decision = second_claim
            .job
            .as_ref()
            .and_then(|job| job.scheduler_decision.as_ref())
            .expect("scheduler decision");
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.starts_with("parallel_slots:1/")));

        state.complete_job(
            JobCompletion {
                job_id: "job-1".to_string(),
                node_id: "node-1".to_string(),
                worker_id: "worker-1".to_string(),
                backend: Backend::Cuda,
                status: JobStatus::Completed,
                output: Some("done".to_string()),
                error: None,
                latency_ms: Some(100),
            },
            "6".to_string(),
        );
        assert_eq!(
            state.nodes.get("node-1").map(|node| node.state),
            Some(AgentState::Busy)
        );
    }

    #[test]
    fn completes_assigned_job() {
        let mut state = ready_state();
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::Auto,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "2".to_string(),
        );

        let _ = state.claim_job("node-1", "3".to_string());
        let completed = state
            .complete_job(
                JobCompletion {
                    job_id: "job-1".to_string(),
                    node_id: "node-1".to_string(),
                    worker_id: "worker-1".to_string(),
                    backend: Backend::M,
                    status: JobStatus::Completed,
                    output: Some("done".to_string()),
                    error: None,
                    latency_ms: Some(125),
                },
                "4".to_string(),
            )
            .expect("completed job");

        assert_eq!(completed.status, JobStatus::Completed);
        assert_eq!(completed.output.as_deref(), Some("done"));
    }

    #[test]
    fn preserves_operator_cap_override_across_heartbeats() {
        let mut state = ready_state();

        let updated = state
            .set_operator_contribution_percent("node-1", Some(80))
            .expect("operator override");
        assert_eq!(updated.contribution_percent, 80);
        assert_eq!(updated.reported_contribution_percent, 50);
        assert_eq!(updated.operator_contribution_percent, Some(80));

        let mut heartbeat = ready_heartbeat("node-1", "2");
        heartbeat.contribution_percent = 35;
        let updated = state.heartbeat(heartbeat, "2".to_string());

        assert_eq!(updated.contribution_percent, 80);
        assert_eq!(updated.reported_contribution_percent, 35);
        assert_eq!(updated.operator_contribution_percent, Some(80));
    }

    #[test]
    fn clearing_operator_cap_override_restores_reported_cap() {
        let mut state = ready_state();
        state
            .set_operator_contribution_percent("node-1", Some(80))
            .expect("operator override");

        let updated = state
            .set_operator_contribution_percent("node-1", None)
            .expect("clear operator override");

        assert_eq!(updated.contribution_percent, 50);
        assert_eq!(updated.reported_contribution_percent, 50);
        assert_eq!(updated.operator_contribution_percent, None);
    }

    #[test]
    fn rejects_operator_cap_override_above_safe_range() {
        let mut state = ready_state();
        let error = state
            .set_operator_contribution_percent("node-1", Some(101))
            .expect_err("safe range validation");
        assert_eq!(error, "contribution_percent must be between 0 and 100");
    }

    #[test]
    fn override_allowed_does_not_bypass_runtime_health_for_claims() {
        let mut state = ControlPlaneState::default();
        state.register(m_series_registration("node-1"));
        let mut heartbeat = ready_heartbeat("node-1", "1");
        heartbeat.worker_health.healthy = false;
        heartbeat.worker_health.runtime_ready = false;
        heartbeat.worker_health.llama_cli_available = false;
        state.heartbeat(heartbeat, "1".to_string());
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "2".to_string(),
        );

        state
            .set_node_policy_override(
                "node-1",
                Some(NodePolicyOverrideInput {
                    target: NodePolicyOverrideTarget::Allowed,
                    reason: "operator verified local recovery".to_string(),
                    actor: "automation".to_string(),
                    updated_at: "3".to_string(),
                }),
            )
            .expect("override");

        let claim = state.claim_job("node-1", "4".to_string());
        assert!(claim.job.is_none());

        let node = state.nodes.get("node-1").expect("node exists");
        assert_eq!(
            node.operator_policy_override
                .as_ref()
                .map(|value| value.target),
            Some(NodePolicyOverrideTarget::Allowed)
        );
        assert!(node.policy_allowed);
        assert_eq!(
            node.policy_reason.as_deref(),
            Some("operator override: operator verified local recovery")
        );
        assert!(!node.computed_policy_allowed);
        assert_eq!(
            state.jobs.get("job-1").map(|job| job.status),
            Some(JobStatus::Queued)
        );
    }

    #[test]
    fn clearing_policy_override_restores_computed_policy_state() {
        let mut state = ready_state();
        state
            .set_node_policy_override(
                "node-1",
                Some(NodePolicyOverrideInput {
                    target: NodePolicyOverrideTarget::Paused,
                    reason: "operator drained the node".to_string(),
                    actor: "automation".to_string(),
                    updated_at: "2".to_string(),
                }),
            )
            .expect("override");

        let updated = state
            .set_node_policy_override("node-1", None)
            .expect("clear override");

        assert_eq!(updated.operator_policy_override, None);
        assert_eq!(updated.state, AgentState::Ready);
        assert!(updated.policy_allowed);
        assert_eq!(updated.policy_reason, None);
    }

    #[test]
    fn claims_local_job_when_worker_reports_blas_runtime_with_local_support() {
        let mut state = ready_state();
        let node = state.nodes.get_mut("node-1").expect("node exists");
        let worker_health = node.worker_health.as_mut().expect("worker health");
        worker_health.runtime_mode = "blas".to_string();
        worker_health.supported_runtime_modes = vec![RuntimeMode::Local];

        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::Auto,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "2".to_string(),
        );

        let claim = state.claim_job("node-1", "3".to_string());
        assert_eq!(claim.job.map(|job| job.job_id), Some("job-1".to_string()));
        assert_eq!(
            state.jobs.get("job-1").map(|job| job.status),
            Some(JobStatus::Assigned)
        );
    }

    #[test]
    fn does_not_claim_job_when_runtime_mode_is_unsupported() {
        let mut state = ready_state();
        let node = state.nodes.get_mut("node-1").expect("node exists");
        let worker_health = node.worker_health.as_mut().expect("worker health");
        worker_health.supported_runtime_modes = vec![RuntimeMode::Local];

        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Interactive,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "2".to_string(),
        );

        let claim = state.claim_job("node-1", "3".to_string());
        assert!(claim.job.is_none());
        assert_eq!(
            state.jobs.get("job-1").map(|job| job.status),
            Some(JobStatus::Queued)
        );
    }

    #[test]
    fn does_not_claim_streaming_job_when_node_cannot_stream() {
        let mut state = ready_state();
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::M,
                routing_mode: RoutingMode::Normal,
                runtime_mode: RuntimeMode::Interactive,
                execution_mode: JobExecutionMode::Single,
                stream: true,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                max_tokens_source: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "2".to_string(),
        );

        let claim = state.claim_job("node-1", "3".to_string());
        assert!(claim.job.is_none());
        assert_eq!(
            state.jobs.get("job-1").map(|job| job.status),
            Some(JobStatus::Queued)
        );
    }

    #[test]
    fn blocks_nodes_when_runtime_capability_report_is_not_ready() {
        let mut state = ControlPlaneState::default();
        state.register(m_series_registration("node-1"));
        let mut heartbeat = ready_heartbeat("node-1", "1");
        heartbeat.worker_health.runtime_ready = false;
        state.heartbeat(heartbeat, "1".to_string());

        let node = state.nodes.get("node-1").expect("node exists");
        assert!(!node.policy_allowed);
        let reason = node.policy_reason.as_deref().expect("policy reason");
        assert!(reason.contains("runtime capability report is not ready"));
    }

    #[test]
    fn explicit_roles_support_chunk_fallback_but_keep_synthesis_strict() {
        let mut health = healthy_worker_health("1");
        health.capabilities.roles = vec![NodeRole::Batch, NodeRole::Reducer];

        assert!(ControlPlaneState::capability_has_role(
            &health,
            NodeRole::ChunkAnalysis
        ));
        assert!(!ControlPlaneState::capability_has_role(
            &health,
            NodeRole::Synthesizer
        ));
        assert!(!ControlPlaneState::capability_has_role(
            &health,
            NodeRole::Vision
        ));
    }

    #[test]
    fn artifact_parser_preserves_separate_code_batches_and_safe_paths() {
        let output =
            "```diff\n--- a/src/a.rs\n+++ b/src/a.rs\n@@\n-old\n+new\n```\n```sh\ncargo test\n```";
        let blocks = fenced_output_blocks(output);
        assert_eq!(blocks.len(), 2);
        assert_eq!(
            artifact_kind_for_language(&blocks[0].0),
            ResultArtifactKind::Patch
        );
        assert_eq!(
            artifact_path(ResultArtifactKind::Patch, &blocks[0].1).as_deref(),
            Some("src/a.rs")
        );
        assert_eq!(
            artifact_kind_for_language(&blocks[1].0),
            ResultArtifactKind::Command
        );
        assert!(!safe_artifact_path("../secret"));
    }

    #[test]
    fn artifact_validation_rejects_unsafe_patches_and_invalid_json() {
        let unsafe_patch = "--- a/secret\n+++ b/../secret\n@@ -1 +1 @@\n-old\n+new";
        let patch_evidence = validate_artifact(ResultArtifactKind::Patch, None, unsafe_patch);
        assert!(patch_evidence
            .iter()
            .any(|item| { item.kind == ValidationEvidenceKind::PathSafety && !item.passed }));

        let json_evidence = validate_artifact(ResultArtifactKind::StructuredData, None, "{nope}");
        assert!(json_evidence.iter().any(|item| {
            item.kind == ValidationEvidenceKind::StructuredDataSyntax && !item.passed
        }));
    }

    #[test]
    fn deterministic_conflicts_create_bounded_repair_plans_and_timeline_events() {
        let artifact = |id: &str, checksum: &str| ResultArtifact {
            artifact_id: id.to_string(),
            result_node_id: "node-a".to_string(),
            sequence: 0,
            kind: ResultArtifactKind::Patch,
            path: Some("src/lib.rs".to_string()),
            language: Some("diff".to_string()),
            media_type: "text/x-diff".to_string(),
            content: checksum.to_string(),
            byte_size: checksum.len(),
            checksum_sha256: checksum.to_string(),
            base_checksum_sha256: None,
            verification_status: JobResultVerificationStatus::Accepted,
            verification_reason: None,
            source_worker_id: Some("worker-a".to_string()),
            source_node_id: Some("machine-a".to_string()),
            validation_evidence: Vec::new(),
        };
        let conflicts = artifact_conflicts(&[artifact("a", "111"), artifact("b", "222")]);
        assert_eq!(conflicts.len(), 1);

        let graph = JobGraph {
            graph_id: "graph-1".to_string(),
            request_id: "request-1".to_string(),
            plan_id: "plan-1".to_string(),
            status: JobGraphStatus::InProgress,
            nodes: Vec::new(),
            results: Vec::new(),
            final_output: None,
            merge_error: None,
            synthesis_status: SynthesisStatus::Collecting,
            final_manifest: None,
            final_node_id: None,
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
        };
        let repairs = artifact_repair_plans(&graph, &conflicts);
        assert_eq!(repairs.len(), 1);
        assert_eq!(repairs[0].max_attempts, DEFAULT_GRAPH_NODE_MAX_ATTEMPTS);
        let timeline = orchestration_timeline(&graph, &repairs);
        assert_eq!(timeline[0].stage, "repair");
        assert_eq!(timeline[0].status, "planned");
    }
}
