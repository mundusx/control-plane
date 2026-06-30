use crate::contracts::{
    is_trusted_identity_path, AgentRegistration, AgentState, Backend, ContextSize,
    ControlPlaneSnapshot, CreditsLedgerRecord, ExpectedOutputFormat, FallbackDecision,
    FallbackDecisionStatus, FallbackPolicy, Heartbeat, JobClaimResponse, JobCompletion,
    JobEventRecord, JobExecutionMode, JobGraph, JobGraphNode, JobGraphNodeStatus, JobGraphStatus,
    JobPlan, JobRecord, JobRequest, JobResultRecord, JobResultVerificationStatus,
    JobSchedulingRequirements, JobStatus, NodePolicyOverride, NodePolicyOverrideInput,
    NodePolicyOverrideTarget, NodeRecord, PlannedJob, PrivacyLevel, RequestClassification,
    RequestComplexity, RequestTaskType, RuntimeMode, SchedulerDecision, WorkerHealthReport,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ControlPlaneState {
    pub nodes: BTreeMap<String, NodeRecord>,
    pub jobs: BTreeMap<String, JobRecord>,
    pub job_events: Vec<JobEventRecord>,
    pub credits_ledger: Vec<CreditsLedgerRecord>,
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
        amount: f64,
        currency: &str,
        metadata: serde_json::Value,
        created_at: String,
    ) -> Option<CreditsLedgerRecord> {
        let job_id_ref = job_id.as_deref();
        if self
            .credits_ledger
            .iter()
            .any(|entry| entry.entry_type == "job_reward" && entry.job_id.as_deref() == job_id_ref)
        {
            return None;
        }

        let record = CreditsLedgerRecord {
            id: uuid::Uuid::new_v4().to_string(),
            user_id: None,
            device_id,
            job_id,
            entry_type: "job_reward".to_string(),
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
        let node_id = job.assigned_node_id.clone()?;
        let node = self.nodes.get(&node_id)?;
        let prompt_chars = job.prompt.chars().count() as f64;
        let output_chars = job
            .output
            .as_ref()
            .map(|output| output.chars().count() as f64)
            .unwrap_or(0.0);
        let work_units = ((prompt_chars + output_chars) / 400.0).ceil().max(1.0);
        let contribution_multiplier = 1.0 + (node.contribution_percent as f64 / 100.0);
        let amount = ((work_units * contribution_multiplier) * 100.0).round() / 100.0;
        let metadata = serde_json::json!({
            "formula": "ceil((prompt_chars + output_chars) / 400) * (1 + contribution_percent / 100)",
            "prompt_chars": prompt_chars,
            "output_chars": output_chars,
            "contribution_percent": node.contribution_percent,
            "backend": node.backend,
            "job_status": job.status,
        });
        self.record_credit_award(
            Some(node_id),
            Some(job.job_id.clone()),
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
            worker_health: None,
            updated_at: String::new(),
        };

        self.nodes.insert(registration.node_id, record.clone());
        self.reevaluate_queued_jobs();
        record
    }

    pub fn submit_job(&mut self, request: JobRequest, submitted_at: String) -> JobRecord {
        let job_id = request.request_id.clone();
        let classification = classify_job_request(&request);
        let scheduling_requirements = scheduling_requirements_for(&request, &classification);
        let fallback_decision = fallback_decision_for(&scheduling_requirements);
        let plan = plan_job_request(&request, &classification);
        let graph = build_job_graph(&request.request_id, &plan, &submitted_at);
        let ready_node_count = self.ready_executable_node_count(&request);
        let graph_execution_enabled =
            graph_execution_allowed(&request, &classification, &plan, ready_node_count);
        let record = JobRecord {
            job_id: job_id.clone(),
            request_id: request.request_id,
            prompt: request.prompt,
            preferred_backend: request.preferred_backend,
            runtime_mode: request.runtime_mode,
            execution_mode: request.execution_mode,
            stream: request.stream,
            model: request.model,
            system_prompt: request.system_prompt,
            max_tokens: request.max_tokens,
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

    fn node_backend_matches(
        job: &JobRecord,
        node_backend: Backend,
        ready_m_exists: bool,
        ready_cuda_exists: bool,
    ) -> bool {
        match job.preferred_backend {
            Backend::Auto => {
                if ready_m_exists {
                    node_backend == Backend::M
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
            "local" => vec![RuntimeMode::Local],
            "interactive" => vec![RuntimeMode::Interactive],
            _ => Vec::new(),
        }
    }

    fn node_can_run_job(node: &NodeRecord, job: &JobRecord) -> bool {
        let allowed_override_active = node
            .operator_policy_override
            .as_ref()
            .map(|value| value.target == NodePolicyOverrideTarget::Allowed)
            .unwrap_or(false);

        if allowed_override_active {
            return true;
        }

        let Some(worker_health) = node.worker_health.as_ref() else {
            return false;
        };

        if !worker_health.runtime_ready {
            return false;
        }

        let runtime_modes = Self::reported_runtime_modes(worker_health);
        if !runtime_modes.contains(&job.runtime_mode) {
            return false;
        }

        if job.stream && !worker_health.streaming_supported {
            return false;
        }

        if let Some(required_model) = job
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

    fn scheduler_score(node: &NodeRecord, job: &JobRecord) -> SchedulerDecision {
        let mut score = 0;
        let mut reasons = Vec::new();
        let requirements = &job.scheduling_requirements;

        match (requirements.task_type, node.backend) {
            (RequestTaskType::Coding, Backend::Cuda) => {
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

            if worker_health.streaming_supported {
                score += 3;
                reasons.push("streaming capable".to_string());
            }

            if worker_health.llama_cli_available && worker_health.blas_device_available {
                score += 5;
                reasons.push("local runtime dependencies ready".to_string());
            }
        }

        SchedulerDecision {
            node_id: node.node_id.clone(),
            score,
            reasons,
        }
    }

    fn best_scheduler_decision_for_job(&self, job: &JobRecord) -> SchedulerDecision {
        let ready_m_exists = self.nodes.values().any(|candidate| {
            candidate.state == AgentState::Ready
                && candidate.policy_allowed
                && candidate.backend == Backend::M
        });
        let ready_cuda_exists = self.nodes.values().any(|candidate| {
            candidate.state == AgentState::Ready
                && candidate.policy_allowed
                && candidate.backend == Backend::Cuda
        });

        self.nodes
            .values()
            .filter(|node| {
                node.state == AgentState::Ready
                    && node.policy_allowed
                    && Self::node_backend_matches(
                        job,
                        node.backend,
                        ready_m_exists,
                        ready_cuda_exists,
                    )
                    && Self::node_can_run_job(node, job)
            })
            .map(|node| Self::scheduler_score(node, job))
            .max_by(|left, right| {
                left.score
                    .cmp(&right.score)
                    .then_with(|| right.node_id.cmp(&left.node_id))
            })
            .unwrap_or_else(|| SchedulerDecision {
                node_id: String::new(),
                score: 0,
                reasons: vec![format!(
                    "queued: no compatible ready node available for backend {:?}, runtime {:?}, model {}",
                    job.preferred_backend,
                    job.runtime_mode,
                    job.model.as_deref().unwrap_or("any")
                )],
            })
    }

    fn reevaluate_queued_jobs(&mut self) {
        let updates: Vec<(String, SchedulerDecision)> = self
            .jobs
            .iter()
            .filter(|(_, job)| job.status == JobStatus::Queued && self.job_has_claimable_work(job))
            .map(|(job_id, job)| (job_id.clone(), self.best_scheduler_decision_for_job(job)))
            .collect();

        for (job_id, scheduler_decision) in updates {
            if let Some(job) = self.jobs.get_mut(&job_id) {
                job.scheduler_decision = Some(scheduler_decision);
            }
        }
    }

    pub fn claim_job(&mut self, node_id: &str, claimed_at: String) -> JobClaimResponse {
        let Some(node) = self.nodes.get(node_id) else {
            return JobClaimResponse { job: None };
        };

        if node.state != AgentState::Ready {
            return JobClaimResponse { job: None };
        }

        if !node.policy_allowed {
            return JobClaimResponse { job: None };
        }

        let node_backend = node.backend;
        let ready_m_exists = self.nodes.values().any(|candidate| {
            candidate.state == AgentState::Ready
                && candidate.policy_allowed
                && candidate.backend == Backend::M
        });
        let ready_cuda_exists = self.nodes.values().any(|candidate| {
            candidate.state == AgentState::Ready
                && candidate.policy_allowed
                && candidate.backend == Backend::Cuda
        });
        let selected = self
            .jobs
            .iter()
            .filter_map(|(job_id, job)| {
                if job.status == JobStatus::Queued
                    && self.job_has_claimable_work(job)
                    && Self::node_backend_matches(
                        job,
                        node_backend,
                        ready_m_exists,
                        ready_cuda_exists,
                    )
                    && Self::node_can_run_job(node, job)
                {
                    Some((job_id.clone(), Self::scheduler_score(node, job)))
                } else {
                    None
                }
            })
            .max_by(|(left_id, left_decision), (right_id, right_decision)| {
                left_decision
                    .score
                    .cmp(&right_decision.score)
                    .then_with(|| right_id.cmp(left_id))
            });

        let Some((job_id, scheduler_decision)) = selected else {
            return JobClaimResponse { job: None };
        };

        if let Some(job) = self.jobs.get_mut(&job_id) {
            let active_graph_node_id = if job.graph_execution_enabled {
                next_ready_graph_node_id(&job.graph)
            } else {
                None
            };
            if let Some(active_node_id) = active_graph_node_id.as_ref() {
                if let Some(graph_node) = job
                    .graph
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == *active_node_id)
                {
                    graph_node.status = JobGraphNodeStatus::Running;
                    graph_node.blocked_by.clear();
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
                claim_job.prompt = graph_node_execution_prompt(job, active_node_id);
            }

            let claimed = JobClaimResponse {
                job: Some(claim_job),
            };
            self.reevaluate_queued_jobs();
            return claimed;
        }

        JobClaimResponse { job: None }
    }

    pub fn complete_job(
        &mut self,
        completion: JobCompletion,
        completed_at: String,
    ) -> Option<JobRecord> {
        let updated_job = {
            let job = self.jobs.get_mut(&completion.job_id)?;
            if job.assigned_node_id.as_deref() != Some(completion.node_id.as_str()) {
                return Some(job.clone());
            }

            if job.graph_execution_enabled {
                complete_graph_execution_job(job, completion.clone(), completed_at.clone())
            } else {
                job.status = completion.status;
                job.worker_id = Some(completion.worker_id.clone());
                job.backend = Some(completion.backend);
                job.output = completion.output.clone();
                job.error = completion.error.clone();
                job.completed_at = Some(completed_at.clone());
                apply_job_completion_to_graph(job, &completion);
                job.graph.updated_at = completed_at.clone();
                job.clone()
            }
        };

        if let Some(node) = self.nodes.get_mut(&completion.node_id) {
            if node.reported_state == AgentState::Busy {
                node.reported_state = AgentState::Ready;
            }
            node.backend = completion.backend;
            node.updated_at = completed_at;
            Self::apply_policy_override(node);
        }

        self.reevaluate_queued_jobs();
        Some(updated_job)
    }

    fn ready_executable_node_count(&self, request: &JobRequest) -> usize {
        let probe = JobRecord {
            job_id: request.request_id.clone(),
            request_id: request.request_id.clone(),
            prompt: request.prompt.clone(),
            preferred_backend: request.preferred_backend,
            runtime_mode: request.runtime_mode,
            execution_mode: request.execution_mode,
            stream: request.stream,
            model: request.model.clone(),
            system_prompt: request.system_prompt.clone(),
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            top_p: request.top_p,
            seed: request.seed,
            classification: classify_job_request(request),
            scheduling_requirements: scheduling_requirements_for(
                request,
                &classify_job_request(request),
            ),
            scheduler_decision: None,
            fallback_decision: FallbackDecision::default(),
            plan: JobPlan::default(),
            graph: JobGraph::default(),
            graph_execution_enabled: false,
            active_graph_node_id: None,
            last_completed_graph_node_id: None,
            status: JobStatus::Queued,
            submitted_at: String::new(),
            assigned_node_id: None,
            assigned_at: None,
            completed_at: None,
            worker_id: None,
            backend: None,
            output: None,
            error: None,
        };
        let ready_m_exists = self.nodes.values().any(|candidate| {
            candidate.state == AgentState::Ready
                && candidate.policy_allowed
                && candidate.backend == Backend::M
        });
        let ready_cuda_exists = self.nodes.values().any(|candidate| {
            candidate.state == AgentState::Ready
                && candidate.policy_allowed
                && candidate.backend == Backend::Cuda
        });

        self.nodes
            .values()
            .filter(|node| {
                node.state == AgentState::Ready
                    && node.policy_allowed
                    && Self::node_backend_matches(
                        &probe,
                        node.backend,
                        ready_m_exists,
                        ready_cuda_exists,
                    )
                    && Self::node_can_run_job(node, &probe)
            })
            .count()
    }

    fn job_has_claimable_work(&self, job: &JobRecord) -> bool {
        !job.graph_execution_enabled || next_ready_graph_node_id(&job.graph).is_some()
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
        let existing_override = self
            .nodes
            .get(&heartbeat.node_id)
            .and_then(|node| node.operator_contribution_percent);
        let existing_policy_override = self
            .nodes
            .get(&heartbeat.node_id)
            .and_then(|node| node.operator_policy_override.clone());
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
            worker_health: Some(heartbeat.worker_health),
            updated_at: updated_at.clone(),
        };
        Self::apply_policy_override(&mut record);

        self.nodes.insert(heartbeat.node_id, record.clone());
        self.reevaluate_queued_jobs();
        record
    }
}

fn graph_execution_allowed(
    request: &JobRequest,
    classification: &RequestClassification,
    plan: &JobPlan,
    ready_node_count: usize,
) -> bool {
    if request.stream || plan.jobs.len() <= 1 {
        return false;
    }

    match request.execution_mode {
        JobExecutionMode::Single => false,
        JobExecutionMode::Decompose => true,
        JobExecutionMode::Auto => {
            ready_node_count >= 2
                && classification.privacy_level != PrivacyLevel::Sensitive
                && (classification.complexity == RequestComplexity::High
                    || looks_sectionable_prompt(&request.prompt))
        }
    }
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

fn next_ready_graph_node_id(graph: &JobGraph) -> Option<String> {
    graph
        .nodes
        .iter()
        .find(|node| node.status == JobGraphNodeStatus::Ready)
        .map(|node| node.id.clone())
}

fn complete_graph_execution_job(
    job: &mut JobRecord,
    completion: JobCompletion,
    completed_at: String,
) -> JobRecord {
    let active_node_id = job.active_graph_node_id.clone();
    if let Some(active_node_id) = active_node_id.as_deref() {
        if let Some(graph_node) = job
            .graph
            .nodes
            .iter_mut()
            .find(|node| node.id == active_node_id)
        {
            graph_node.status = match completion.status {
                JobStatus::Completed => JobGraphNodeStatus::Completed,
                JobStatus::Failed => JobGraphNodeStatus::Failed,
                _ => graph_node.status,
            };
            graph_node.output = completion.output.clone();
            graph_node.error = completion.error.clone();
        }
    }

    refresh_job_graph(&mut job.graph);
    refresh_graph_results(
        &mut job.graph,
        job.classification.output_format,
        Some(completion.worker_id.as_str()),
        Some(completion.node_id.as_str()),
        completion.latency_ms,
    );

    job.worker_id = Some(completion.worker_id);
    job.backend = Some(completion.backend);
    job.output = completion.output;
    job.error = completion.error.or_else(|| job.graph.merge_error.clone());
    job.last_completed_graph_node_id = active_node_id.clone();
    job.active_graph_node_id = None;

    if completion.status == JobStatus::Failed || job.graph.status == JobGraphStatus::Failed {
        job.status = JobStatus::Failed;
        job.completed_at = Some(completed_at.clone());
    } else if job.graph.status == JobGraphStatus::Completed {
        job.status = JobStatus::Completed;
        job.output = job
            .graph
            .final_output
            .clone()
            .or_else(|| job.output.clone());
        job.completed_at = Some(completed_at.clone());
    } else {
        job.status = JobStatus::Queued;
        job.completed_at = None;
    }

    job.graph.updated_at = completed_at;
    job.clone()
}

fn graph_node_execution_prompt(job: &JobRecord, active_node_id: &str) -> String {
    let Some(node) = job
        .graph
        .nodes
        .iter()
        .find(|node| node.id == active_node_id)
    else {
        return job.prompt.clone();
    };

    if node.responsibility == "merge" {
        let sections = job
            .graph
            .nodes
            .iter()
            .filter(|candidate| candidate.id != node.id)
            .filter_map(|candidate| {
                candidate
                    .output
                    .as_ref()
                    .map(|output| format!("## {}\n{}", candidate.name, output.trim()))
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        return format!(
            "Original user request:\n{}\n\nCompleted subjob outputs:\n{}\n\nProduce the final answer. Preserve useful details, remove duplication, and return only the final response.",
            job.prompt, sections
        );
    }

    format!(
        "Original user request:\n{}\n\nYou are executing one validated MundusX subjob.\nSubjob: {}\nResponsibility: {}\nRequired output: {}\n\nReturn only this subjob's useful output. Do not solve unrelated sections.",
        job.prompt, node.name, node.responsibility, node.required_output
    )
}

fn normalize_amount(value: f64) -> f64 {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded.abs() < 0.005 {
        0.0
    } else {
        rounded
    }
}

pub fn classify_job_request(request: &JobRequest) -> RequestClassification {
    let combined = format!(
        "{}\n{}\n{}",
        request.system_prompt.as_deref().unwrap_or(""),
        request.prompt,
        request.model.as_deref().unwrap_or("")
    );
    let lower = combined.to_ascii_lowercase();
    let prompt_chars = request.prompt.chars().count();

    let task_type = if contains_any(
        &lower,
        &[
            "code",
            "bug",
            "test",
            "rust",
            "javascript",
            "typescript",
            "python",
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

    let output_format = if contains_any(&lower, &["json", "schema", "object"]) {
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
    } else if prompt_chars > 800 || request.max_tokens.unwrap_or_default() > 1_024 {
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
    let lower = format!(
        "{}\n{}",
        request.system_prompt.as_deref().unwrap_or(""),
        request.prompt
    )
    .to_ascii_lowercase();

    let decomposition_needed = classification.complexity == RequestComplexity::High
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
            }],
        };
    }

    if looks_sectionable_prompt(&request.prompt)
        && classification.task_type != RequestTaskType::Coding
    {
        let mut jobs = Vec::new();
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
            "Milestones can be drafted independently before final synthesis.",
        );
        push_planned_job(
            &mut jobs,
            "job.modern_era",
            "Modern era",
            "section",
            Vec::new(),
            "Cover recent developments, current positioning, and future-facing themes.",
            "Modern context should be isolated from historical background before reduction.",
        );

        let final_dependencies = jobs.iter().map(|job| job.id.clone()).collect::<Vec<_>>();
        push_planned_job(
            &mut jobs,
            "job.final_merge",
            "Final synthesis",
            "merge",
            final_dependencies,
            "Merge section outputs into one coherent final answer for the original prompt.",
            "A reducer is required to remove duplication and produce the user-facing answer.",
        );

        return JobPlan {
            plan_id: format!("plan-{}", request.request_id),
            strategy: "sectioned_research".to_string(),
            summary: format!(
                "Planned {} sectioned research units plus a final reducer.",
                jobs.len()
            ),
            jobs,
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
                status: JobGraphNodeStatus::Waiting,
                blocked_by: job.depends_on.clone(),
                output: None,
                error: None,
            })
            .collect(),
        final_node_id: plan
            .jobs
            .iter()
            .find(|job| job.responsibility == "merge")
            .map(|job| job.id.clone())
            .or_else(|| plan.jobs.last().map(|job| job.id.clone())),
        results: Vec::new(),
        final_output: None,
        merge_error: None,
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
    source_worker_id: Option<&str>,
    source_node_id: Option<&str>,
    latency_ms: Option<u64>,
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
            JobResultRecord {
                node_id: node.id.clone(),
                name: node.name.clone(),
                responsibility: node.responsibility.clone(),
                status: node.status,
                output: node.output.clone(),
                error: node.error.clone(),
                source_worker_id: source_worker_id.map(str::to_string),
                source_node_id: source_node_id.map(str::to_string),
                latency_ms,
                verification_status,
                verification_reason,
            }
        })
        .collect();

    graph.final_output = merge_completed_graph_outputs(graph);
    graph.merge_error = merge_graph_error(graph);
    if graph.merge_error.is_some() {
        graph.status = JobGraphStatus::Failed;
    }
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
        parts.push(format!("## {}\n{}", result.name, output));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
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
    });
}

fn contains_any(input: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| input.contains(needle))
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

    if worker_health
        .model_path
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        reasons.push("model path is missing".to_string());
    } else {
        let model_dir = worker_health.model_dir.trim();
        let model_path = worker_health.model_path.as_deref().unwrap_or("").trim();
        if !model_dir.is_empty() && !node_path_starts_with(model_path, model_dir) {
            reasons.push(format!(
                "model path {model_path} is outside model directory {model_dir}"
            ));
        }
    }

    let runtime_mode = worker_health.runtime_mode.trim();
    let supports_local_execution = worker_health
        .supported_runtime_modes
        .iter()
        .any(|mode| matches!(mode, RuntimeMode::Local | RuntimeMode::Interactive));
    if runtime_mode.is_empty() && !supports_local_execution {
        reasons.push("runtime mode is missing".to_string());
    } else if !supports_local_execution
        && !runtime_mode.eq_ignore_ascii_case("local")
        && !runtime_mode.eq_ignore_ascii_case("interactive")
        && !runtime_mode.eq_ignore_ascii_case("cuda")
        && !runtime_mode.eq_ignore_ascii_case("blas")
    {
        reasons.push(format!(
            "runtime mode {runtime_mode} is not ready for local execution"
        ));
    }

    if runtime_mode.eq_ignore_ascii_case("cuda") {
        if !worker_health.cuda_driver_available {
            reasons.push("CUDA driver is unavailable".to_string());
        }
        if !worker_health.cuda_device_available {
            reasons.push("CUDA device is unavailable".to_string());
        }
    } else {
        if !worker_health.llama_cli_available {
            reasons.push("llama-cli is unavailable".to_string());
        }

        if !worker_health.blas_device_available {
            reasons.push("BLAS device acceleration is unavailable".to_string());
        }
    }

    if reasons.is_empty() {
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
            supported_runtime_modes: vec![RuntimeMode::Local, RuntimeMode::Interactive],
            streaming_supported: false,
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

    fn ready_state() -> ControlPlaneState {
        let mut state = ControlPlaneState::default();
        state.register(m_series_registration("node-1"));
        state.heartbeat(ready_heartbeat("node-1", "1"), "1".to_string());
        state
    }

    fn classification_request(prompt: &str) -> JobRequest {
        JobRequest {
            request_id: "job-1".to_string(),
            prompt: prompt.to_string(),
            preferred_backend: Backend::Auto,
            runtime_mode: RuntimeMode::Local,
            execution_mode: JobExecutionMode::Single,
            stream: false,
            model: Some("demo".to_string()),
            system_prompt: None,
            max_tokens: None,
            temperature: None,
            top_p: None,
            seed: None,
        }
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
            .any(|reason| reason.contains("no compatible ready node")));
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
            .any(|reason| reason.contains("no compatible ready node")));
    }

    #[test]
    fn incompatible_node_arrival_keeps_queued_job_without_resubmission() {
        let mut state = ControlPlaneState::default();
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::M,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
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
            .any(|reason| reason.contains("no compatible ready node")));
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
                runtime_mode: RuntimeMode::Interactive,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("missing-model".to_string()),
                system_prompt: None,
                max_tokens: None,
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
        assert!(first_claim.prompt.contains("validated MundusX subjob"));
        assert!(first_claim.prompt.contains("Subjob: Scope and constraints"));
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
                .contains("Subjob: Backend implementation")
                || second_claim
                    .prompt
                    .contains("Subjob: Frontend implementation")
        );
    }

    #[test]
    fn auto_decompose_requires_multiple_ready_nodes_and_sectionable_work() {
        let mut one_node_state = ready_state();
        let mut request = classification_request(
            "Write a detailed history of Mercedes-Benz with major eras and milestones.",
        );
        request.execution_mode = JobExecutionMode::Auto;
        let one_node_record = one_node_state.submit_job(request.clone(), "1".to_string());
        assert!(!one_node_record.graph_execution_enabled);

        let mut two_node_state = ready_state();
        two_node_state.register(m_series_registration("node-2"));
        two_node_state.heartbeat(ready_heartbeat("node-2", "1"), "1".to_string());
        let two_node_record = two_node_state.submit_job(request, "2".to_string());
        assert!(two_node_record.graph_execution_enabled);
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
        assert!(claim.prompt.contains("Completed subjob outputs"));
        assert!(claim.prompt.contains("scope accepted"));
        assert!(claim.prompt.contains("backend complete"));
        assert!(claim.prompt.contains("frontend complete"));
        assert!(claim.prompt.contains("tests complete"));
        assert!(claim.prompt.contains("Produce the final answer"));
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
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: Some("You are a terse assistant.".to_string()),
                max_tokens: Some(32),
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
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
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
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: Some("You are a terse assistant.".to_string()),
                max_tokens: Some(32),
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
                    power_source: "AC Power".to_string(),
                    on_battery: false,
                    battery_percent: Some(90),
                    runtime_ready: true,
                    runtime_mode: "local".to_string(),
                    supported_runtime_modes: vec![RuntimeMode::Local],
                    streaming_supported: false,
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
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: Some("You are a terse assistant.".to_string()),
                max_tokens: Some(32),
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
    fn claim_uses_capability_score_for_eligible_jobs() {
        let mut state = ready_state();
        state.submit_job(
            JobRequest {
                request_id: "job-low-score".to_string(),
                prompt: "Estimate this public sequence: 2, 4, 8.".to_string(),
                preferred_backend: Backend::M,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: None,
                max_tokens: None,
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
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
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
                    runtime_mode: RuntimeMode::Local,
                    execution_mode: JobExecutionMode::Single,
                    stream: false,
                    model: None,
                    system_prompt: None,
                    max_tokens: None,
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
                    power_source: "AC Power".to_string(),
                    on_battery: false,
                    battery_percent: Some(90),
                    runtime_ready: true,
                    runtime_mode: "local".to_string(),
                    supported_runtime_modes: vec![RuntimeMode::Local, RuntimeMode::Interactive],
                    streaming_supported: false,
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
                    llama_cli_available: false,
                    blas_device_available: false,
                    cuda_device_available: true,
                    cuda_driver_available: true,
                    cuda_device_name: Some("GeForce GTX 1650".to_string()),
                    power_source: "unknown".to_string(),
                    on_battery: false,
                    battery_percent: None,
                    runtime_ready: true,
                    runtime_mode: "cuda".to_string(),
                    supported_runtime_modes: vec![RuntimeMode::Local],
                    streaming_supported: false,
                    checked_at: "2".to_string(),
                    notes: vec![],
                },
            },
            "2".to_string(),
        );

        assert!(node.policy_allowed);
        assert_eq!(node.policy_reason, None);
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
                    power_source: "AC Power".to_string(),
                    on_battery: false,
                    battery_percent: Some(90),
                    runtime_ready: true,
                    runtime_mode: "batch".to_string(),
                    supported_runtime_modes: Vec::new(),
                    streaming_supported: false,
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
                    power_source: "AC Power".to_string(),
                    on_battery: false,
                    battery_percent: Some(90),
                    runtime_ready: true,
                    runtime_mode: "local".to_string(),
                    supported_runtime_modes: vec![RuntimeMode::Local, RuntimeMode::Interactive],
                    streaming_supported: false,
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
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: None,
                max_tokens: None,
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
    fn completes_assigned_job() {
        let mut state = ready_state();
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::Auto,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: None,
                system_prompt: None,
                max_tokens: None,
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
    fn override_allowed_unblocks_claim_routing_immediately() {
        let mut state = ControlPlaneState::default();
        state.register(m_series_registration("node-1"));
        let mut heartbeat = ready_heartbeat("node-1", "1");
        heartbeat.worker_health.healthy = false;
        heartbeat.worker_health.runtime_ready = false;
        state.heartbeat(heartbeat, "1".to_string());
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "hello world".to_string(),
                preferred_backend: Backend::M,
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
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
        let job = claim.job.expect("claimed job");
        assert_eq!(job.assigned_node_id.as_deref(), Some("node-1"));

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
                runtime_mode: RuntimeMode::Local,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
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
                runtime_mode: RuntimeMode::Interactive,
                execution_mode: JobExecutionMode::Single,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
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
                runtime_mode: RuntimeMode::Interactive,
                execution_mode: JobExecutionMode::Single,
                stream: true,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
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
}
