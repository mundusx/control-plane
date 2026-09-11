use crate::contracts::{
    AgentRegistration, AppendChatMessageRequest, ChatMessageRecord, CreditsLedgerRecord,
    JobCompletion, JobEventRecord, JobRecord, NodeRecord,
};
use crate::harness::{
    HarnessApproval, HarnessArtifact, HarnessAttempt, HarnessAuditEvent,
    HarnessCapacityReservation, HarnessOperationalEvent, HarnessOperationalPolicy, HarnessRunner,
    HarnessState, HarnessTask, HarnessToolCall, HarnessValidation,
};
use crate::state::ControlPlaneState;
use native_tls::TlsConnector;
use postgres::{Client, Config};
use postgres_native_tls::MakeTlsConnector;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
pub struct PostgresStore {
    database_url: String,
}

impl PostgresStore {
    pub fn from_env(pool_url: Option<&str>, direct_url: Option<&str>) -> Option<Self> {
        Self::from_values(pool_url, direct_url)
    }

    fn from_values(pool_url: Option<&str>, direct_url: Option<&str>) -> Option<Self> {
        let database_url = pool_url
            .and_then(trimmed)
            .or_else(|| direct_url.and_then(trimmed))?;
        Some(Self { database_url })
    }

    pub fn restore_state(&self) -> Result<ControlPlaneState, String> {
        let mut client = self.connect()?;
        let devices: Vec<NodeRecord> = query_json_array(&mut client, DEVICES_RESTORE_SQL)?;
        let jobs: Vec<JobRecord> = query_json_array(&mut client, JOBS_RESTORE_SQL)?;
        let job_events: Vec<JobEventRecord> = query_json_array(
            &mut client,
            "select coalesce(jsonb_agg(to_jsonb(t) order by t.source_event_id asc nulls last, t.id asc)::text, '[]') from public.job_events t",
        )?;
        let credits_ledger: Vec<CreditsLedgerRecord> = query_json_array(
            &mut client,
            "select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at asc)::text, '[]') from public.credits_ledger t",
        )?;

        let mut state = ControlPlaneState::default();
        for device in devices {
            state.nodes.insert(device.node_id.clone(), device);
        }
        for job in jobs {
            state.jobs.insert(job.job_id.clone(), job);
        }
        state.job_events = dedupe_job_events(job_events);
        state.credits_ledger = dedupe_credits_ledger(credits_ledger);
        let harness_runners: Vec<HarnessRunner> =
            query_json_array_optional(&mut client, HARNESS_RUNNERS_RESTORE_SQL)?;
        let harness_tasks: Vec<HarnessTask> =
            query_json_array_optional(&mut client, HARNESS_TASKS_RESTORE_SQL)?;
        let harness_attempts: Vec<HarnessAttempt> =
            query_json_array_optional(&mut client, HARNESS_ATTEMPTS_RESTORE_SQL)?;
        let harness_approvals: Vec<HarnessApproval> =
            query_json_array_optional(&mut client, HARNESS_APPROVALS_RESTORE_SQL)?;
        let harness_reservations: Vec<HarnessCapacityReservation> =
            query_json_array_optional(&mut client, HARNESS_RESERVATIONS_RESTORE_SQL)?;
        let harness_audit_events: Vec<HarnessAuditEvent> =
            query_json_array_optional(&mut client, HARNESS_AUDIT_RESTORE_SQL)?;
        let harness_tool_calls: Vec<HarnessToolCall> =
            query_json_array_optional(&mut client, HARNESS_TOOL_CALLS_RESTORE_SQL)?;
        let harness_validations: Vec<HarnessValidation> =
            query_json_array_optional(&mut client, HARNESS_VALIDATIONS_RESTORE_SQL)?;
        let harness_artifacts: Vec<HarnessArtifact> =
            query_json_array_optional(&mut client, HARNESS_ARTIFACTS_RESTORE_SQL)?;
        let harness_operational_policy: Vec<HarnessOperationalPolicy> =
            query_json_array_optional(&mut client, HARNESS_OPERATIONAL_POLICY_RESTORE_SQL)?;
        let harness_operational_events: Vec<HarnessOperationalEvent> =
            query_json_array_optional(&mut client, HARNESS_OPERATIONAL_EVENTS_RESTORE_SQL)?;
        state.harness = HarnessState {
            runners: harness_runners
                .into_iter()
                .map(|runner| (runner.runner_id.clone(), runner))
                .collect(),
            operational_policy: harness_operational_policy
                .into_iter()
                .next()
                .unwrap_or_default(),
            operational_events: harness_operational_events,
            tasks: harness_tasks
                .into_iter()
                .map(|task| (task.task_id.clone(), task))
                .collect(),
            attempts: harness_attempts
                .into_iter()
                .map(|attempt| (attempt.attempt_id.clone(), attempt))
                .collect(),
            reservations: harness_reservations
                .into_iter()
                .map(|reservation| (reservation.reservation_id.clone(), reservation))
                .collect(),
            tool_calls: harness_tool_calls
                .into_iter()
                .map(|record| (record.tool_call_id.clone(), record))
                .collect(),
            validations: harness_validations
                .into_iter()
                .map(|record| (record.validation_id.clone(), record))
                .collect(),
            artifacts: harness_artifacts
                .into_iter()
                .map(|record| (record.artifact_id.clone(), record))
                .collect(),
            approvals: harness_approvals
                .into_iter()
                .map(|approval| (approval.approval_id.clone(), approval))
                .collect(),
            audit_events: harness_audit_events,
        };
        Ok(state)
    }

    pub fn record_registration(&self, registration: &AgentRegistration) -> Result<(), String> {
        let now = now_epoch();
        let capability_manifest_json = registration
            .capabilities
            .as_ref()
            .and_then(|value| serde_json::to_string(value).ok());
        let mut client = self.connect()?;
        client
            .execute(
                DEVICES_UPSERT_SQL,
                &[
                    &registration.node_id,
                    &registration.public_key_fingerprint,
                    &registration.public_key_hex,
                    &registration.hostname,
                    &registration.identity_trust_path,
                    &registration.backend.to_string(),
                    &(registration.contribution_percent as i32),
                    &registration.agent_version,
                    &"starting",
                    &"starting",
                    &0_i32,
                    &0_i32,
                    &"unknown",
                    &false,
                    &Option::<i32>::None,
                    &false,
                    &Option::<String>::None,
                    &false,
                    &Option::<String>::None,
                    &Option::<String>::None,
                    &Option::<String>::None,
                    &Option::<String>::None,
                    &Option::<String>::None,
                    &Option::<String>::None,
                    &registration.capability_fabric_version,
                    &capability_manifest_json,
                    &Some(now),
                    &Some(now),
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("postgres registration sync failed: {error}"))
    }

    pub fn record_harness_runner(&self, runner: &HarnessRunner) -> Result<(), String> {
        let mut client = self.connect()?;
        client
            .execute(
                HARNESS_RUNNER_UPSERT_SQL,
                &[
                    &runner.runner_id,
                    &runner.device_id,
                    &runner.public_key_hex,
                    &enum_value(&runner.kind)?,
                    &runner.owner_user_id,
                    &serde_json::to_string(&runner.tenant_ids)
                        .map_err(|error| error.to_string())?,
                    &serde_json::to_string(&runner.repository_source_ids)
                        .map_err(|error| error.to_string())?,
                    &serde_json::to_string(&runner.local_projects)
                        .map_err(|error| error.to_string())?,
                    &serde_json::to_string(&runner.execution_modes)
                        .map_err(|error| error.to_string())?,
                    &serde_json::to_string(&runner.supported_operations)
                        .map_err(|error| error.to_string())?,
                    &runner.network_default_disabled,
                    &(runner.max_workspace_mb as i32),
                    &(runner.usable_memory_mb as i32),
                    &(runner.parallel_slots as i32),
                    &runner.trusted_identity,
                    &runner.ready,
                    &(runner.last_seen_epoch as i64),
                ],
            )
            .map_err(|error| format!("postgres harness runner sync failed: {error}"))?;
        Ok(())
    }

    pub fn consume_harness_runner_pairing(
        &self,
        pairing_code: &str,
        runner_id: &str,
        public_key_hex: &str,
    ) -> Result<String, String> {
        let pairing_code = pairing_code.trim();
        if pairing_code.len() < 20 || pairing_code.len() > 200 {
            return Err("HARNESS_PAIRING_INVALID: pairing code is invalid".to_string());
        }
        let pairing_hash = hex::encode(Sha256::digest(pairing_code.as_bytes()));
        let mut client = self.connect()?;
        let mut transaction = client
            .transaction()
            .map_err(|error| format!("postgres pairing transaction failed: {error}"))?;
        let bootstrap_row = transaction
            .query_opt(
                r#"update public.harness_runner_bootstrap_sessions
set consumed_at = coalesce(consumed_at, now()),
    runner_id = coalesce(runner_id, $2)
where bootstrap_hash = $1
  and approved_at is not null
  and user_id is not null
  and public_key_hex = $3
  and expires_at > now()
  and (consumed_at is null or runner_id = $2)
returning user_id::text"#,
                &[&pairing_hash, &runner_id, &public_key_hex],
            )
            .map_err(|error| format!("postgres bootstrap lookup failed: {error}"))?;
        let legacy_row = if bootstrap_row.is_none() {
            transaction
            .query_opt(
                r#"update public.harness_runner_pairings
set consumed_at = coalesce(consumed_at, now()),
    runner_id = coalesce(runner_id, $2),
    public_key_hex = coalesce(public_key_hex, $3)
where pairing_hash = $1
  and expires_at > now()
  and (consumed_at is null or (runner_id = $2 and public_key_hex = $3))
returning user_id::text"#,
                &[&pairing_hash, &runner_id, &public_key_hex],
            )
            .map_err(|error| format!("postgres pairing lookup failed: {error}"))?
        } else {
            None
        };
        let Some(row) = bootstrap_row.or(legacy_row) else {
            return Err(
                "HARNESS_PAIRING_INVALID: pairing code is expired, consumed, or belongs to another runner"
                    .to_string(),
            );
        };
        let owner_user_id: String = row.get(0);
        transaction
            .execute(
                "delete from public.harness_runner_pairings where expires_at < now() - interval '1 day'",
                &[],
            )
            .map_err(|error| format!("postgres pairing cleanup failed: {error}"))?;
        transaction
            .execute(
                "delete from public.harness_runner_bootstrap_sessions where expires_at < now() - interval '1 day'",
                &[],
            )
            .map_err(|error| format!("postgres bootstrap cleanup failed: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("postgres pairing commit failed: {error}"))?;
        Ok(owner_user_id)
    }

    pub fn record_node_snapshot(&self, node: &NodeRecord) -> Result<(), String> {
        let policy_override = node.operator_policy_override.as_ref();
        let worker_health_json = node
            .worker_health
            .as_ref()
            .and_then(|value| serde_json::to_string(value).ok());
        let capability_manifest_json = node
            .capabilities
            .as_ref()
            .and_then(|value| serde_json::to_string(value).ok());
        let updated_at_epoch = parse_epoch(&node.updated_at);
        let mut client = self.connect()?;
        client
            .execute(
                DEVICES_UPSERT_SQL,
                &[
                    &node.node_id,
                    &node.public_key_fingerprint,
                    &node.public_key_hex,
                    &node.hostname,
                    &node.identity_trust_path,
                    &node.backend.to_string(),
                    &(node.contribution_percent as i32),
                    &node.agent_version,
                    &node.state.to_string(),
                    &node.reported_state.to_string(),
                    &(node.available_memory_mb as i32),
                    &(node.available_gpu_percent as i32),
                    &node.power_source,
                    &node.on_battery,
                    &node.battery_percent.map(i32::from),
                    &node.policy_allowed,
                    &node.policy_reason,
                    &node.computed_policy_allowed,
                    &node.computed_policy_reason,
                    &policy_override.map(|value| value.target.to_string()),
                    &policy_override.map(|value| value.reason.clone()),
                    &policy_override.map(|value| value.actor.clone()),
                    &policy_override.map(|value| value.updated_at.clone()),
                    &worker_health_json,
                    &node.capability_fabric_version,
                    &capability_manifest_json,
                    &updated_at_epoch,
                    &updated_at_epoch,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("postgres node sync failed: {error}"))
    }

    pub fn record_job(&self, job: &JobRecord) -> Result<(), String> {
        let mut client = self.connect()?;
        upsert_job(&mut client, job)
    }

    pub fn record_job_completion(
        &self,
        _completion: &JobCompletion,
        job: &JobRecord,
    ) -> Result<(), String> {
        self.record_job(job)
    }

    pub fn record_credit_award(&self, entry: &CreditsLedgerRecord) -> Result<(), String> {
        let metadata = entry.metadata.to_string();
        let mut client = self.connect()?;
        client
            .execute(
                CREDITS_UPSERT_SQL,
                &[
                    &entry.id,
                    &entry.user_id,
                    &entry.device_id,
                    &entry.job_id,
                    &entry.parent_job_id,
                    &entry.graph_node_id,
                    &entry.entry_type,
                    &entry.amount,
                    &entry.currency,
                    &metadata,
                    &entry.created_at,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("postgres credit sync failed: {error}"))
    }

    pub fn record_job_event(&self, event: &JobEventRecord) -> Result<(), String> {
        let payload = event.payload.to_string();
        let source_event_id = event.source_event_id.unwrap_or(event.id) as i64;
        let mut client = self.connect()?;
        client
            .execute(
                JOB_EVENTS_UPSERT_SQL,
                &[
                    &source_event_id,
                    &event.node_id,
                    &event.job_id,
                    &event.event_type,
                    &payload,
                    &event.created_at,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("postgres job event sync failed: {error}"))
    }

    pub fn append_chat_message(
        &self,
        conversation_id: &str,
        payload: &AppendChatMessageRequest,
    ) -> Result<ChatMessageRecord, String> {
        let metadata = payload.metadata.clone().unwrap_or_else(|| json!({}));
        let metadata = metadata.to_string();
        let mut client = self.connect()?;
        client
            .execute(
                "insert into public.chat_conversations (conversation_id) values ($1::text::uuid) on conflict (conversation_id) do nothing",
                &[&conversation_id],
            )
            .map_err(|error| format!("postgres chat conversation sync failed: {error}"))?;

        let row = client
            .query_one(
                CHAT_MESSAGE_INSERT_SQL,
                &[
                    &conversation_id,
                    &payload.role,
                    &payload.content,
                    &payload.job_id,
                    &payload.tool,
                    &metadata,
                ],
            )
            .map_err(|error| format!("postgres chat message sync failed: {error}"))?;
        let raw: String = row.get(0);
        let record = serde_json::from_str::<ChatMessageRecord>(&raw)
            .map_err(|error| format!("failed to parse postgres chat message: {error}"))?;
        let created_at = record.created_at.clone();

        client
            .execute(
                "update public.chat_conversations set last_message_at = coalesce($2::text::timestamptz, last_message_at), message_count = (select count(*) from public.chat_messages where conversation_id = $1::text::uuid) where conversation_id = $1::text::uuid",
                &[&conversation_id, &created_at],
            )
            .map_err(|error| format!("postgres chat conversation update failed: {error}"))?;
        Ok(record)
    }

    pub fn fetch_chat_messages(
        &self,
        conversation_id: &str,
        limit: u32,
    ) -> Result<Vec<ChatMessageRecord>, String> {
        let limit = i64::from(limit);
        let mut client = self.connect()?;
        let row = client
            .query_one(CHAT_MESSAGES_FETCH_SQL, &[&conversation_id, &limit])
            .map_err(|error| format!("postgres chat messages fetch failed: {error}"))?;
        let raw: String = row.get(0);
        serde_json::from_str(&raw)
            .map_err(|error| format!("failed to parse postgres chat messages: {error}"))
    }

    pub fn delete_chat_conversation(&self, conversation_id: &str) -> Result<bool, String> {
        let mut client = self.connect()?;
        let deleted = client
            .execute(
                "delete from public.chat_conversations where conversation_id = $1::text::uuid",
                &[&conversation_id],
            )
            .map_err(|error| format!("postgres chat conversation delete failed: {error}"))?;
        Ok(deleted > 0)
    }

    pub fn record_harness_operational_policy(&self, harness: &HarnessState) -> Result<(), String> {
        let mut client = self.connect()?;
        let mut transaction = client
            .transaction()
            .map_err(|error| format!("failed to start harness policy transaction: {error}"))?;
        let drained_runners = serde_json::to_string(&harness.operational_policy.drained_runners)
            .map_err(|error| format!("failed to serialize drained nodes: {error}"))?;
        transaction
            .execute(
                HARNESS_OPERATIONAL_POLICY_UPSERT_SQL,
                &[
                    &harness.operational_policy.kill_switch,
                    &drained_runners,
                    &(harness.operational_policy.tenant_max_active_attempts as i32),
                    &(harness.operational_policy.tenant_max_queued_tasks as i32),
                    &(harness.operational_policy.tenant_max_artifact_bytes as i64),
                ],
            )
            .map_err(|error| format!("postgres harness policy sync failed: {error}"))?;
        for event in &harness.operational_events {
            let metadata = event.metadata.to_string();
            transaction
                .execute(
                    HARNESS_OPERATIONAL_EVENT_UPSERT_SQL,
                    &[
                        &event.event_id,
                        &event.actor,
                        &event.action,
                        &event.target,
                        &metadata,
                        &(event.created_at_epoch as i64),
                    ],
                )
                .map_err(|error| format!("postgres harness operator event sync failed: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("postgres harness policy commit failed: {error}"))
    }

    pub fn record_harness_task(&self, harness: &HarnessState, task_id: &str) -> Result<(), String> {
        self.record_harness_task_inner(harness, task_id, None, None, None)
    }

    pub fn record_harness_task_transition(
        &self,
        harness: &HarnessState,
        task_id: &str,
        expected_task_state_version: u64,
    ) -> Result<(), String> {
        self.record_harness_task_inner(
            harness,
            task_id,
            Some(expected_task_state_version),
            None,
            None,
        )
    }

    pub fn record_harness_attempt_transition(
        &self,
        harness: &HarnessState,
        task_id: &str,
        expected_task_state_version: u64,
        attempt_id: &str,
        expected_attempt_state_version: u64,
    ) -> Result<(), String> {
        self.record_harness_task_inner(
            harness,
            task_id,
            Some(expected_task_state_version),
            Some((attempt_id, expected_attempt_state_version)),
            None,
        )
    }

    pub fn record_harness_reservation(
        &self,
        harness: &HarnessState,
        task_id: &str,
        reservation_id: &str,
        expected_task_state_version: u64,
        node_total_slots: u32,
        now_epoch: u64,
    ) -> Result<(), String> {
        self.record_harness_task_inner(
            harness,
            task_id,
            Some(expected_task_state_version),
            None,
            Some((reservation_id, node_total_slots, now_epoch)),
        )
    }

    fn record_harness_task_inner(
        &self,
        harness: &HarnessState,
        task_id: &str,
        expected_task_state_version: Option<u64>,
        expected_attempt: Option<(&str, u64)>,
        capacity_check: Option<(&str, u32, u64)>,
    ) -> Result<(), String> {
        let task = harness
            .tasks
            .get(task_id)
            .ok_or_else(|| "harness task not found for persistence".to_string())?;
        let allowed_path_prefixes = serde_json::to_string(&task.allowed_path_prefixes)
            .map_err(|error| format!("failed to serialize harness paths: {error}"))?;
        let allowed_operations = serde_json::to_string(&task.allowed_operations)
            .map_err(|error| format!("failed to serialize harness operations: {error}"))?;
        let validation_profiles = serde_json::to_string(&task.validation_profiles)
            .map_err(|error| format!("failed to serialize harness profiles: {error}"))?;
        let budgets = serde_json::to_string(&task.budgets)
            .map_err(|error| format!("failed to serialize harness budgets: {error}"))?;
        let execution_mode = enum_value(task.execution_mode)?;
        let task_state = enum_value(task.state)?;
        let verification_level = task.verification_level.map(enum_value).transpose()?;
        let mut client = self.connect()?;
        let mut transaction = client
            .transaction()
            .map_err(|error| format!("failed to start harness transaction: {error}"))?;
        if let Some(expected_version) = expected_task_state_version {
            let row = transaction
                .query_opt(
                    "select state_version from public.harness_tasks where task_id = $1 for update",
                    &[&task_id],
                )
                .map_err(|error| format!("postgres harness task lock failed: {error}"))?
                .ok_or_else(|| {
                    "HARNESS_STATE_CONFLICT: durable harness task is missing".to_string()
                })?;
            let durable_version: i64 = row.get(0);
            if durable_version != expected_version as i64 {
                return Err(
                    "HARNESS_STATE_CONFLICT: durable harness task version changed".to_string(),
                );
            }
        }
        if let Some((attempt_id, expected_version)) = expected_attempt {
            let row = transaction
                .query_opt(
                    "select state_version from public.harness_attempts where attempt_id = $1 and task_id = $2 for update",
                    &[&attempt_id, &task_id],
                )
                .map_err(|error| format!("postgres harness attempt lock failed: {error}"))?
                .ok_or_else(|| "HARNESS_STATE_CONFLICT: durable harness attempt is missing".to_string())?;
            let durable_version: i64 = row.get(0);
            if durable_version != expected_version as i64 {
                return Err(
                    "HARNESS_STATE_CONFLICT: durable harness attempt version changed".to_string(),
                );
            }
        }
        if let Some((reservation_id, node_total_slots, now_epoch)) = capacity_check {
            let reservation = harness.reservations.get(reservation_id).ok_or_else(|| {
                "HARNESS_STATE_CONFLICT: capacity reservation is missing".to_string()
            })?;
            transaction
                .query_one(
                    "select pg_advisory_xact_lock(hashtext($1))",
                    &[&reservation.runner_id],
                )
                .map_err(|error| format!("postgres harness capacity lock failed: {error}"))?;
            let durable_state = transaction
                .query_one(
                    "select state from public.harness_tasks where task_id = $1",
                    &[&task_id],
                )
                .map_err(|error| format!("postgres harness task state check failed: {error}"))?
                .get::<_, String>(0);
            if durable_state != "queued" {
                return Err("HARNESS_STATE_CONFLICT: durable task is no longer queued".to_string());
            }
            let approved = transaction
                .query_one(
                    "select exists(select 1 from public.harness_approvals where task_id = $1 and scope = 'execute_uat' and expires_at_epoch > $2)",
                    &[&task_id, &(now_epoch as i64)],
                )
                .map_err(|error| format!("postgres harness approval check failed: {error}"))?
                .get::<_, bool>(0);
            if !approved {
                return Err(
                    "HARNESS_APPROVAL_REQUIRED: durable execute_uat approval is missing or expired"
                        .to_string(),
                );
            }
            let active_slots = transaction
                .query_one(
                    "select coalesce(sum(slots), 0)::bigint from public.harness_capacity_reservations where runner_id = $1 and state = 'active' and expires_at_epoch > $2",
                    &[&reservation.runner_id, &(now_epoch as i64)],
                )
                .map_err(|error| format!("postgres harness capacity check failed: {error}"))?
                .get::<_, i64>(0);
            if active_slots.saturating_add(i64::from(reservation.slots))
                > i64::from(node_total_slots)
            {
                return Err(
                    "HARNESS_RESOURCE_EXHAUSTED: durable node capacity is fully reserved"
                        .to_string(),
                );
            }
        }
        transaction
            .execute(
                HARNESS_TASK_UPSERT_SQL,
                &[
                    &task.task_id,
                    &task.harness_contract_version,
                    &task.tenant_id,
                    &task.repository_source_id,
                    &task.objective,
                    &task.base_revision,
                    &allowed_path_prefixes,
                    &execution_mode,
                    &allowed_operations,
                    &validation_profiles,
                    &budgets,
                    &task_state,
                    &(task.state_version as i64),
                    &task.current_attempt_id,
                    &verification_level,
                    &task.terminal_code,
                    &(task.created_at_epoch as i64),
                    &(task.updated_at_epoch as i64),
                    &(task.expires_at_epoch as i64),
                    &task.requested_by_user_id,
                    &task.submitted_via,
                ],
            )
            .map_err(|error| format!("postgres harness task sync failed: {error}"))?;

        for attempt in harness
            .attempts
            .values()
            .filter(|value| value.task_id == task_id)
        {
            let state = serde_json::to_string(&attempt.state)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string();
            transaction
                .execute(
                    HARNESS_ATTEMPT_UPSERT_SQL,
                    &[
                        &attempt.attempt_id,
                        &attempt.task_id,
                        &attempt.runner_id,
                        &enum_value(attempt.execution_mode)?,
                        &state,
                        &(attempt.state_version as i64),
                        &(attempt.reserved_slots as i32),
                        &attempt.workspace_id,
                        &attempt.failure_code,
                        &(attempt.created_at_epoch as i64),
                        &(attempt.updated_at_epoch as i64),
                        &attempt.started_at_epoch.map(|value| value as i64),
                        &attempt.finished_at_epoch.map(|value| value as i64),
                        &(attempt.model_turns as i32),
                        &(attempt.tool_calls as i32),
                        &(attempt.output_bytes as i64),
                        &(attempt.repair_attempts as i32),
                        &attempt.last_progress_sha256,
                        &(attempt.repeated_progress_count as i32),
                    ],
                )
                .map_err(|error| format!("postgres harness attempt sync failed: {error}"))?;
        }
        for reservation in harness
            .reservations
            .values()
            .filter(|value| value.task_id == task_id)
        {
            transaction
                .execute(
                    HARNESS_RESERVATION_UPSERT_SQL,
                    &[
                        &reservation.reservation_id,
                        &reservation.task_id,
                        &reservation.attempt_id,
                        &reservation.runner_id,
                        &(reservation.slots as i32),
                        &reservation.state,
                        &(reservation.created_at_epoch as i64),
                        &(reservation.expires_at_epoch as i64),
                        &reservation.released_at_epoch.map(|value| value as i64),
                    ],
                )
                .map_err(|error| format!("postgres harness reservation sync failed: {error}"))?;
        }
        for record in harness
            .tool_calls
            .values()
            .filter(|value| value.task_id == task_id)
        {
            transaction
                .execute(
                    HARNESS_TOOL_CALL_UPSERT_SQL,
                    &[
                        &record.tool_call_id,
                        &record.task_id,
                        &record.attempt_id,
                        &record.operation,
                        &record.idempotency_key,
                        &record.input_sha256,
                        &record.output_sha256,
                        &record.status,
                        &record.code,
                        &record.duration_ms.map(|value| value as i64),
                        &(record.output_bytes as i64),
                        &(record.created_at_epoch as i64),
                        &record.completed_at_epoch.map(|value| value as i64),
                    ],
                )
                .map_err(|error| format!("postgres harness tool-call sync failed: {error}"))?;
        }
        for record in harness
            .validations
            .values()
            .filter(|value| value.task_id == task_id)
        {
            transaction
                .execute(
                    HARNESS_VALIDATION_UPSERT_SQL,
                    &[
                        &record.validation_id,
                        &record.task_id,
                        &record.attempt_id,
                        &record.profile_id,
                        &record.profile_version,
                        &record.status,
                        &record.code,
                        &record.exit_code,
                        &record.duration_ms.map(|value| value as i64),
                        &record.output_sha256,
                        &record.artifact_sha256,
                        &record.base_revision,
                        &record.environment_sha256,
                        &record.output_truncated,
                        &(record.created_at_epoch as i64),
                    ],
                )
                .map_err(|error| format!("postgres harness validation sync failed: {error}"))?;
        }
        for record in harness
            .artifacts
            .values()
            .filter(|value| value.task_id == task_id)
        {
            let changed_paths = serde_json::to_string(&record.changed_paths)
                .map_err(|error| format!("failed to serialize harness artifact paths: {error}"))?;
            let verification_level = enum_value(record.verification_level)?;
            transaction
                .execute(
                    HARNESS_ARTIFACT_UPSERT_SQL,
                    &[
                        &record.artifact_id,
                        &record.task_id,
                        &record.attempt_id,
                        &record.kind,
                        &record.sha256,
                        &(record.size_bytes as i64),
                        &record.storage_reference,
                        &record.base_revision,
                        &changed_paths,
                        &verification_level,
                        &(record.created_at_epoch as i64),
                    ],
                )
                .map_err(|error| format!("postgres harness artifact sync failed: {error}"))?;
        }
        for approval in harness
            .approvals
            .values()
            .filter(|value| value.task_id == task_id)
        {
            let scope = serde_json::to_string(&approval.scope)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string();
            transaction
                .execute(
                    HARNESS_APPROVAL_UPSERT_SQL,
                    &[
                        &approval.approval_id,
                        &approval.task_id,
                        &approval.artifact_digest,
                        &approval.target,
                        &scope,
                        &approval.approver,
                        &(approval.created_at_epoch as i64),
                        &(approval.expires_at_epoch as i64),
                    ],
                )
                .map_err(|error| format!("postgres harness approval sync failed: {error}"))?;
        }
        for event in harness
            .audit_events
            .iter()
            .filter(|value| value.task_id == task_id)
        {
            let metadata = event.metadata.to_string();
            transaction
                .execute(
                    HARNESS_AUDIT_UPSERT_SQL,
                    &[
                        &event.event_id,
                        &event.task_id,
                        &event.attempt_id,
                        &event.actor,
                        &event.event_type,
                        &event.code,
                        &metadata,
                        &(event.created_at_epoch as i64),
                    ],
                )
                .map_err(|error| format!("postgres harness audit sync failed: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("postgres harness transaction commit failed: {error}"))
    }

    fn connect(&self) -> Result<Client, String> {
        connect_client(&self.database_url)
    }
}

fn upsert_job(client: &mut Client, job: &JobRecord) -> Result<(), String> {
    let classification = serde_json::to_string(&job.classification)
        .map_err(|error| format!("failed to serialize job classification: {error}"))?;
    let plan = serde_json::to_string(&job.plan)
        .map_err(|error| format!("failed to serialize job plan: {error}"))?;
    let graph = serde_json::to_string(&job.graph)
        .map_err(|error| format!("failed to serialize job graph: {error}"))?;
    client
        .execute(
            JOBS_UPSERT_SQL,
            &[
                &job.job_id,
                &job.request_id,
                &job.prompt,
                &job.preferred_backend.to_string(),
                &job.model,
                &job.mode,
                &job.system_prompt,
                &job.max_tokens.map(|value| value as i32),
                &job.temperature.map(f64::from),
                &job.top_p.map(f64::from),
                &job.seed.map(|value| value as i64),
                &classification,
                &plan,
                &graph,
                &job.status.to_string(),
                &job.assigned_node_id,
                &job.worker_id,
                &job.backend.map(|backend| backend.to_string()),
                &job.output,
                &job.error,
                &parse_epoch(&job.submitted_at),
                &job.assigned_at.as_deref().and_then(parse_epoch),
                &job.completed_at.as_deref().and_then(parse_epoch),
                &Some(now_epoch()),
            ],
        )
        .map(|_| ())
        .map_err(|error| format!("postgres job sync failed: {error}"))
}

fn enum_value<T: serde::Serialize>(value: T) -> Result<String, String> {
    serde_json::to_value(value)
        .map_err(|error| format!("failed to serialize harness enum: {error}"))?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "harness enum did not serialize as a string".to_string())
}

fn query_json_array<T>(client: &mut Client, sql: &str) -> Result<Vec<T>, String>
where
    T: serde::de::DeserializeOwned,
{
    let row = client
        .query_one(sql, &[])
        .map_err(|error| format!("postgres restore query failed: {}", postgres_error(&error)))?;
    let raw: String = row.get(0);
    serde_json::from_str(&raw).map_err(|error| format!("failed to parse postgres restore: {error}"))
}

fn query_json_array_optional<T>(client: &mut Client, sql: &str) -> Result<Vec<T>, String>
where
    T: serde::de::DeserializeOwned,
{
    match client.query_one(sql, &[]) {
        Ok(row) => {
            let raw: String = row.get(0);
            serde_json::from_str(&raw)
                .map_err(|error| format!("failed to parse postgres harness restore: {error}"))
        }
        Err(error) if error.code().is_some_and(|code| code.code() == "42P01") => Ok(Vec::new()),
        Err(error) => Err(format!("postgres harness restore query failed: {}", postgres_error(&error))),
    }
}

fn postgres_error(error: &postgres::Error) -> String {
    let Some(database_error) = error.as_db_error() else {
        return error.to_string();
    };
    let mut message = format!("{} (SQLSTATE {})", database_error.message(), database_error.code().code());
    if let Some(detail) = database_error.detail() {
        message.push_str(&format!("; detail: {detail}"));
    }
    if let Some(hint) = database_error.hint() {
        message.push_str(&format!("; hint: {hint}"));
    }
    message
}

fn connect_client(database_url: &str) -> Result<Client, String> {
    let mut config = Config::from_str(database_url)
        .map_err(|error| format!("failed to parse database url: {error}"))?;
    config.connect_timeout(Duration::from_secs(10));

    let strict_connector =
        postgres_connector(false).map_err(|error| format!("failed to build TLS: {error}"))?;
    match config.connect(strict_connector) {
        Ok(client) => Ok(client),
        Err(strict_error) => {
            eprintln!(
                "strict database TLS failed, retrying with relaxed certificate checks: {strict_error}"
            );
            let relaxed_connector = postgres_connector(true)
                .map_err(|error| format!("failed to build TLS: {error}"))?;
            config
                .connect(relaxed_connector)
                .map_err(|error| format!("failed to connect to database: {error}"))
        }
    }
}

fn postgres_connector(relaxed: bool) -> Result<MakeTlsConnector, native_tls::Error> {
    let mut builder = TlsConnector::builder();
    if relaxed {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    builder.build().map(MakeTlsConnector::new)
}

fn trimmed(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn parse_epoch(input: &str) -> Option<i64> {
    input.trim().parse().ok()
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn dedupe_job_events(job_events: Vec<JobEventRecord>) -> Vec<JobEventRecord> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(job_events.len());

    for event in job_events {
        let key = match event.source_event_id {
            Some(source_event_id) => format!("source_event_id:{source_event_id}"),
            None => format!(
                "legacy:{}:{}:{}:{}",
                event.node_id.as_deref().unwrap_or_default(),
                event.job_id.as_deref().unwrap_or_default(),
                event.event_type,
                event.payload
            ),
        };
        if seen.insert(key) {
            deduped.push(event);
        }
    }

    deduped
}

fn dedupe_credits_ledger(credits_ledger: Vec<CreditsLedgerRecord>) -> Vec<CreditsLedgerRecord> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(credits_ledger.len());

    for entry in credits_ledger {
        if seen.insert(entry.id.clone()) {
            deduped.push(entry);
        }
    }

    deduped
}

const DEVICES_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(jsonb_build_object(
  'node_id', node_id,
  'public_key_fingerprint', public_key_fingerprint,
  'public_key_hex', public_key_hex,
  'hostname', hostname,
  'backend', backend,
  'contribution_percent', contribution_percent,
  'reported_contribution_percent', contribution_percent,
  'operator_contribution_percent', null,
  'agent_version', agent_version,
  'capability_fabric_version', capability_fabric_version,
  'capabilities', capability_manifest_json,
  'state', state,
  'reported_state', coalesce(reported_state, state),
  'available_memory_mb', available_memory_mb,
  'available_gpu_percent', available_gpu_percent,
  'identity_trust_path', identity_trust_path,
  'power_source', power_source,
  'on_battery', on_battery,
  'battery_percent', battery_percent,
  'policy_allowed', policy_allowed,
  'policy_reason', policy_reason,
  'computed_policy_allowed', computed_policy_allowed,
  'computed_policy_reason', computed_policy_reason,
  'operator_policy_override', case
    when operator_policy_override_target is null then null
    else jsonb_build_object(
      'target', operator_policy_override_target,
      'reason', coalesce(operator_policy_override_reason, ''),
      'actor', coalesce(operator_policy_override_actor, ''),
      'updated_at', coalesce(operator_policy_override_updated_at, '')
    )
  end,
  'trust', jsonb_build_object(
    'score', 50,
    'completed_jobs', 0,
    'failed_jobs', 0,
    'consecutive_failures', 0,
    'total_latency_ms', 0,
    'accepted_results', 0,
    'rejected_results', 0,
    'last_success_at', null,
    'last_failure_at', null,
    'last_failure_reason', null
  ),
  'worker_health', worker_health_json,
  'updated_at', coalesce(updated_at_epoch::text, last_seen_at_epoch::text, '0')
) order by updated_at_epoch asc nulls last, node_id asc)::text, '[]')
from public.devices
"#;

const JOBS_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(jsonb_build_object(
  'job_id', job_id,
  'request_id', request_id,
  'prompt', prompt,
  'preferred_backend', preferred_backend,
  'runtime_mode', 'local',
  'stream', false,
  'model', model,
  'mode', mode,
  'system_prompt', system_prompt,
  'max_tokens', max_tokens,
  'max_tokens_source', null,
  'temperature', temperature,
  'top_p', top_p,
  'seed', seed,
  'classification', classification,
  'scheduling_requirements', jsonb_build_object(
    'task_type', 'inference',
    'context_size', 'small',
    'privacy_level', 'internal',
    'output_format', 'text',
    'runtime_mode', 'local',
    'stream', false,
    'model', model,
    'language', null,
    'preferred_roles', '[]'::jsonb,
    'constraints', '[]'::jsonb
  ),
  'scheduler_decision', null,
  'fallback_decision', jsonb_build_object(
    'status', 'not_needed',
    'provider', null,
    'triggers', '[]'::jsonb,
    'blocked_reasons', '[]'::jsonb,
    'requires_operator_approval', false,
    'max_cost_cents', null,
    'audit_reason', ''
  ),
  'plan', plan,
  'graph', graph,
  'execution_mode', 'single',
  'graph_execution_enabled', false,
  'active_graph_node_id', null,
  'last_completed_graph_node_id', null,
  'status', status,
  'submitted_at', coalesce(submitted_at_epoch::text, '0'),
  'assigned_node_id', assigned_node_id,
  'assigned_at', assigned_at_epoch::text,
  'completed_at', completed_at_epoch::text,
  'worker_id', worker_id,
  'backend', backend,
  'output', output,
  'error', error
) order by submitted_at_epoch asc nulls last, job_id asc)::text, '[]')
from public.jobs
"#;

const DEVICES_UPSERT_SQL: &str = r#"
insert into public.devices (
  node_id, public_key_fingerprint, public_key_hex, hostname, identity_trust_path,
  backend, contribution_percent, agent_version, state, reported_state,
  available_memory_mb, available_gpu_percent, power_source, on_battery, battery_percent,
  policy_allowed, policy_reason, computed_policy_allowed, computed_policy_reason,
  operator_policy_override_target, operator_policy_override_reason, operator_policy_override_actor,
  operator_policy_override_updated_at, worker_health_json, capability_fabric_version,
  capability_manifest_json, last_seen_at_epoch, updated_at_epoch
) values (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9, $10,
  $11, $12, $13, $14, $15,
  $16, $17, $18, $19,
  $20, $21, $22,
  $23, $24::text::jsonb, $25, $26::text::jsonb, $27, $28
)
on conflict (node_id) do update set
  public_key_fingerprint = excluded.public_key_fingerprint,
  public_key_hex = excluded.public_key_hex,
  hostname = excluded.hostname,
  identity_trust_path = excluded.identity_trust_path,
  backend = excluded.backend,
  contribution_percent = excluded.contribution_percent,
  agent_version = excluded.agent_version,
  state = excluded.state,
  reported_state = excluded.reported_state,
  available_memory_mb = excluded.available_memory_mb,
  available_gpu_percent = excluded.available_gpu_percent,
  power_source = excluded.power_source,
  on_battery = excluded.on_battery,
  battery_percent = excluded.battery_percent,
  policy_allowed = excluded.policy_allowed,
  policy_reason = excluded.policy_reason,
  computed_policy_allowed = excluded.computed_policy_allowed,
  computed_policy_reason = excluded.computed_policy_reason,
  operator_policy_override_target = excluded.operator_policy_override_target,
  operator_policy_override_reason = excluded.operator_policy_override_reason,
  operator_policy_override_actor = excluded.operator_policy_override_actor,
  operator_policy_override_updated_at = excluded.operator_policy_override_updated_at,
  worker_health_json = excluded.worker_health_json,
  capability_fabric_version = excluded.capability_fabric_version,
  capability_manifest_json = excluded.capability_manifest_json,
  last_seen_at_epoch = excluded.last_seen_at_epoch,
  updated_at_epoch = excluded.updated_at_epoch
"#;

const JOBS_UPSERT_SQL: &str = r#"
insert into public.jobs (
  job_id, request_id, prompt, preferred_backend, model, mode, system_prompt, max_tokens,
  temperature, top_p, seed, classification, plan, graph, status, assigned_node_id,
  worker_id, backend, output, error, submitted_at_epoch, assigned_at_epoch,
  completed_at_epoch, updated_at_epoch
) values (
  $1, $2, $3, $4, $5, $6, $7, $8,
  $9::double precision::numeric, $10::double precision::numeric, $11,
  $12::text::jsonb, $13::text::jsonb, $14::text::jsonb, $15, $16,
  $17, $18, $19, $20, $21, $22,
  $23, $24
)
on conflict (job_id) do update set
  request_id = excluded.request_id,
  prompt = excluded.prompt,
  preferred_backend = excluded.preferred_backend,
  model = excluded.model,
  mode = excluded.mode,
  system_prompt = excluded.system_prompt,
  max_tokens = excluded.max_tokens,
  temperature = excluded.temperature,
  top_p = excluded.top_p,
  seed = excluded.seed,
  classification = excluded.classification,
  plan = excluded.plan,
  graph = excluded.graph,
  status = excluded.status,
  assigned_node_id = excluded.assigned_node_id,
  worker_id = excluded.worker_id,
  backend = excluded.backend,
  output = excluded.output,
  error = excluded.error,
  submitted_at_epoch = excluded.submitted_at_epoch,
  assigned_at_epoch = excluded.assigned_at_epoch,
  completed_at_epoch = excluded.completed_at_epoch,
  updated_at_epoch = excluded.updated_at_epoch
"#;

const CREDITS_UPSERT_SQL: &str = r#"
insert into public.credits_ledger (
  id, user_id, device_id, job_id, parent_job_id, graph_node_id, entry_type,
  amount, currency, metadata, created_at
) values (
  $1::text::uuid, $2::text::uuid, $3, $4, $5, $6, $7,
  $8::double precision::numeric, $9, $10::text::jsonb,
  case
    when $11::text ~ '^[0-9]+$' then to_timestamp(($11::text)::bigint)
    else ($11::text)::timestamptz
  end
)
on conflict (id) do update set
  user_id = excluded.user_id,
  device_id = excluded.device_id,
  job_id = excluded.job_id,
  parent_job_id = excluded.parent_job_id,
  graph_node_id = excluded.graph_node_id,
  entry_type = excluded.entry_type,
  amount = excluded.amount,
  currency = excluded.currency,
  metadata = excluded.metadata,
  created_at = excluded.created_at
"#;

const JOB_EVENTS_UPSERT_SQL: &str = r#"
insert into public.job_events (
  source_event_id, node_id, job_id, event_type, payload, created_at
) values (
  $1, $2, $3, $4, $5::text::jsonb,
  case
    when $6::text ~ '^[0-9]+$' then to_timestamp(($6::text)::bigint)
    else ($6::text)::timestamptz
  end
)
on conflict (source_event_id) do update set
  node_id = excluded.node_id,
  job_id = excluded.job_id,
  event_type = excluded.event_type,
  payload = excluded.payload,
  created_at = excluded.created_at
"#;

const CHAT_MESSAGE_INSERT_SQL: &str = r#"
with inserted as (
  insert into public.chat_messages (conversation_id, role, content, job_id, tool, metadata)
  values ($1::text::uuid, $2, $3, $4, $5, $6::text::jsonb)
  on conflict (job_id) where job_id is not null do nothing
  returning *
), selected as (
  select * from inserted
  union all
  select * from public.chat_messages
  where conversation_id = $1::text::uuid and job_id = $4
  limit 1
)
select to_jsonb(selected)::text from selected limit 1
"#;

const CHAT_MESSAGES_FETCH_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at asc, t.id asc)::text, '[]')
from (
  select *
  from public.chat_messages
  where conversation_id = $1::text::uuid
  order by created_at desc, id desc
  limit $2
) t
"#;

const HARNESS_TASKS_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at_epoch, t.task_id)::text, '[]')
from public.harness_tasks t
"#;

const HARNESS_RUNNERS_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) order by t.runner_id)::text, '[]')
from public.harness_runners t
"#;

const HARNESS_ATTEMPTS_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at_epoch, t.attempt_id)::text, '[]')
from public.harness_attempts t
"#;

const HARNESS_RESERVATIONS_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at_epoch, t.reservation_id)::text, '[]')
from public.harness_capacity_reservations t
"#;

const HARNESS_APPROVALS_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at_epoch, t.approval_id)::text, '[]')
from public.harness_approvals t
"#;

const HARNESS_AUDIT_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at_epoch, t.event_id)::text, '[]')
from public.harness_audit_events t
"#;

const HARNESS_TOOL_CALLS_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at_epoch, t.tool_call_id)::text, '[]') from public.harness_tool_calls t
"#;
const HARNESS_VALIDATIONS_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at_epoch, t.validation_id)::text, '[]') from public.harness_validations t
"#;
const HARNESS_ARTIFACTS_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at_epoch, t.artifact_id)::text, '[]') from public.harness_artifacts t
"#;
const HARNESS_OPERATIONAL_POLICY_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(jsonb_build_object(
  'kill_switch', kill_switch,
  'drained_runners', drained_runners,
  'tenant_max_active_attempts', tenant_max_active_attempts,
  'tenant_max_queued_tasks', tenant_max_queued_tasks,
  'tenant_max_artifact_bytes', tenant_max_artifact_bytes
))::text, '[]') from public.harness_operational_policy where singleton = true
"#;
const HARNESS_OPERATIONAL_EVENTS_RESTORE_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) - 'id' order by t.created_at_epoch, t.event_id)::text, '[]') from public.harness_operational_events t
"#;

const HARNESS_TASK_UPSERT_SQL: &str = r#"
insert into public.harness_tasks (
  task_id, harness_contract_version, tenant_id, repository_source_id, objective, base_revision,
  allowed_path_prefixes, execution_mode, allowed_operations, validation_profiles,
  budgets, state, state_version, current_attempt_id, verification_level,
  terminal_code, created_at_epoch, updated_at_epoch, expires_at_epoch,
  requested_by_user_id, submitted_via
) values (
  $1, $2, $3, $4, $5, $6,
  $7::text::jsonb, $8, $9::text::jsonb, $10::text::jsonb,
  $11::text::jsonb, $12, $13, $14, $15,
  $16, $17, $18, $19, $20::text::uuid, $21
)
on conflict (task_id) do update set
  harness_contract_version = excluded.harness_contract_version,
  tenant_id = excluded.tenant_id,
  repository_source_id = excluded.repository_source_id,
  objective = excluded.objective,
  base_revision = excluded.base_revision,
  allowed_path_prefixes = excluded.allowed_path_prefixes,
  execution_mode = excluded.execution_mode,
  allowed_operations = excluded.allowed_operations,
  validation_profiles = excluded.validation_profiles,
  budgets = excluded.budgets,
  state = excluded.state,
  state_version = excluded.state_version,
  current_attempt_id = excluded.current_attempt_id,
  verification_level = excluded.verification_level,
  terminal_code = excluded.terminal_code,
  created_at_epoch = excluded.created_at_epoch,
  updated_at_epoch = excluded.updated_at_epoch,
  expires_at_epoch = excluded.expires_at_epoch,
  requested_by_user_id = coalesce(public.harness_tasks.requested_by_user_id, excluded.requested_by_user_id),
  submitted_via = coalesce(public.harness_tasks.submitted_via, excluded.submitted_via)
"#;

const HARNESS_RUNNER_UPSERT_SQL: &str = r#"
insert into public.harness_runners (
  runner_id, device_id, public_key_hex, kind, owner_user_id, tenant_ids,
  repository_source_ids, local_projects, execution_modes, supported_operations,
  network_default_disabled, max_workspace_mb, usable_memory_mb, parallel_slots,
  trusted_identity, ready, last_seen_epoch
) values (
  $1, $2, $3, $4, $5::text::uuid, $6::text::jsonb,
  $7::text::jsonb, $8::text::jsonb, $9::text::jsonb, $10::text::jsonb,
  $11, $12, $13, $14, $15, $16, $17
)
on conflict (runner_id) do update set
  device_id = excluded.device_id,
  public_key_hex = excluded.public_key_hex,
  kind = excluded.kind,
  owner_user_id = excluded.owner_user_id,
  tenant_ids = excluded.tenant_ids,
  repository_source_ids = excluded.repository_source_ids,
  local_projects = excluded.local_projects,
  execution_modes = excluded.execution_modes,
  supported_operations = excluded.supported_operations,
  network_default_disabled = excluded.network_default_disabled,
  max_workspace_mb = excluded.max_workspace_mb,
  usable_memory_mb = excluded.usable_memory_mb,
  parallel_slots = excluded.parallel_slots,
  trusted_identity = excluded.trusted_identity,
  ready = excluded.ready,
  last_seen_epoch = excluded.last_seen_epoch
"#;

const HARNESS_ATTEMPT_UPSERT_SQL: &str = r#"
insert into public.harness_attempts (
  attempt_id, task_id, runner_id, execution_mode, state, state_version, reserved_slots,
  workspace_id, failure_code, created_at_epoch, updated_at_epoch,
  started_at_epoch, finished_at_epoch, model_turns, tool_calls, output_bytes,
  repair_attempts, last_progress_sha256, repeated_progress_count
) values (
  $1, $2, $3, $4, $5, $6, $7,
  $8, $9, $10, $11,
  $12, $13, $14, $15, $16, $17, $18, $19
)
on conflict (attempt_id) do update set
  task_id = excluded.task_id,
  runner_id = excluded.runner_id,
  execution_mode = excluded.execution_mode,
  state = excluded.state,
  state_version = excluded.state_version,
  reserved_slots = excluded.reserved_slots,
  workspace_id = excluded.workspace_id,
  failure_code = excluded.failure_code,
  updated_at_epoch = excluded.updated_at_epoch,
  started_at_epoch = excluded.started_at_epoch,
  finished_at_epoch = excluded.finished_at_epoch,
  model_turns = excluded.model_turns,
  tool_calls = excluded.tool_calls,
  output_bytes = excluded.output_bytes,
  repair_attempts = excluded.repair_attempts,
  last_progress_sha256 = excluded.last_progress_sha256,
  repeated_progress_count = excluded.repeated_progress_count
"#;

const HARNESS_RESERVATION_UPSERT_SQL: &str = r#"
insert into public.harness_capacity_reservations (
  reservation_id, task_id, attempt_id, runner_id, slots, state,
  created_at_epoch, expires_at_epoch, released_at_epoch
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
on conflict (reservation_id) do update set
  state = excluded.state,
  expires_at_epoch = excluded.expires_at_epoch,
  released_at_epoch = excluded.released_at_epoch
"#;

const HARNESS_APPROVAL_UPSERT_SQL: &str = r#"
insert into public.harness_approvals (
  approval_id, task_id, artifact_digest, target, scope, approver,
  created_at_epoch, expires_at_epoch
) values ($1, $2, $3, $4, $5, $6, $7, $8)
on conflict (approval_id) do update set
  artifact_digest = excluded.artifact_digest,
  target = excluded.target,
  scope = excluded.scope,
  approver = excluded.approver,
  expires_at_epoch = excluded.expires_at_epoch
"#;

const HARNESS_AUDIT_UPSERT_SQL: &str = r#"
insert into public.harness_audit_events (
  event_id, task_id, attempt_id, actor, event_type, code, metadata,
  created_at_epoch
) values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8)
on conflict (event_id) do nothing
"#;

const HARNESS_TOOL_CALL_UPSERT_SQL: &str = r#"
insert into public.harness_tool_calls (
  tool_call_id, task_id, attempt_id, operation, idempotency_key, input_sha256,
  output_sha256, status, code, duration_ms, output_bytes, created_at_epoch, completed_at_epoch
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
on conflict (tool_call_id) do update set
  output_sha256 = excluded.output_sha256, status = excluded.status, code = excluded.code,
  duration_ms = excluded.duration_ms, output_bytes = excluded.output_bytes,
  completed_at_epoch = excluded.completed_at_epoch
"#;

const HARNESS_VALIDATION_UPSERT_SQL: &str = r#"
insert into public.harness_validations (
  validation_id, task_id, attempt_id, profile_id, profile_version, status, code,
  exit_code, duration_ms, output_sha256, artifact_sha256, base_revision,
  environment_sha256, output_truncated, created_at_epoch
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
on conflict (validation_id) do nothing
"#;

const HARNESS_ARTIFACT_UPSERT_SQL: &str = r#"
insert into public.harness_artifacts (
  artifact_id, task_id, attempt_id, kind, sha256, size_bytes, storage_reference,
  base_revision, changed_paths, verification_level, created_at_epoch
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10, $11)
on conflict (artifact_id) do nothing
"#;

const HARNESS_OPERATIONAL_POLICY_UPSERT_SQL: &str = r#"
insert into public.harness_operational_policy (
  singleton, kill_switch, drained_runners, tenant_max_active_attempts,
  tenant_max_queued_tasks, tenant_max_artifact_bytes, updated_at
) values (true, $1, $2::text::jsonb, $3, $4, $5, now())
on conflict (singleton) do update set
  kill_switch = excluded.kill_switch,
  drained_runners = excluded.drained_runners,
  tenant_max_active_attempts = excluded.tenant_max_active_attempts,
  tenant_max_queued_tasks = excluded.tenant_max_queued_tasks,
  tenant_max_artifact_bytes = excluded.tenant_max_artifact_bytes,
  updated_at = excluded.updated_at
"#;

const HARNESS_OPERATIONAL_EVENT_UPSERT_SQL: &str = r#"
insert into public.harness_operational_events (
  event_id, actor, action, target, metadata, created_at_epoch
) values ($1, $2, $3, $4, $5::text::jsonb, $6)
on conflict (event_id) do nothing
"#;

#[cfg(test)]
mod tests {
    use super::{
        PostgresStore, CHAT_MESSAGE_INSERT_SQL, CREDITS_UPSERT_SQL, DEVICES_UPSERT_SQL,
        HARNESS_AUDIT_UPSERT_SQL, HARNESS_RESERVATION_UPSERT_SQL, HARNESS_TASK_UPSERT_SQL,
        JOBS_UPSERT_SQL, JOB_EVENTS_UPSERT_SQL,
    };

    #[test]
    fn postgres_store_prefers_pooled_runtime_url() {
        let store = PostgresStore::from_values(
            Some(" postgresql://app@pgbouncer.example/mundusx "),
            Some("postgresql://admin@postgres.example/mundusx"),
        )
        .expect("store");

        assert_eq!(
            store.database_url,
            "postgresql://app@pgbouncer.example/mundusx"
        );
    }

    #[test]
    fn postgres_store_falls_back_to_direct_url_for_local_development() {
        let store =
            PostgresStore::from_values(None, Some(" postgresql://admin@postgres.example/mundusx "))
                .expect("store");

        assert_eq!(
            store.database_url,
            "postgresql://admin@postgres.example/mundusx"
        );
    }

    #[test]
    fn serialized_json_parameters_are_cast_from_text_before_jsonb() {
        for sql in [
            DEVICES_UPSERT_SQL,
            JOBS_UPSERT_SQL,
            CREDITS_UPSERT_SQL,
            JOB_EVENTS_UPSERT_SQL,
            CHAT_MESSAGE_INSERT_SQL,
            HARNESS_TASK_UPSERT_SQL,
            HARNESS_RESERVATION_UPSERT_SQL,
            HARNESS_AUDIT_UPSERT_SQL,
        ] {
            for token in sql.split_whitespace() {
                if token.starts_with('$') && token.contains("::jsonb") {
                    assert!(
                        token.contains("::text::jsonb"),
                        "JSON parameter must bind as text before jsonb: {token}"
                    );
                }
            }
        }
    }

    #[test]
    fn serialized_timestamp_parameters_accept_epoch_and_restored_timestamp_text() {
        assert!(CREDITS_UPSERT_SQL.contains("$11::text"));
        assert!(CREDITS_UPSERT_SQL.contains("($11::text)::timestamptz"));
        assert!(JOB_EVENTS_UPSERT_SQL.contains("$6::text"));
        assert!(JOB_EVENTS_UPSERT_SQL.contains("($6::text)::timestamptz"));
    }
}
