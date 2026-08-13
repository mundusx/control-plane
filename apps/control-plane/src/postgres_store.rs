use crate::contracts::{
    AgentRegistration, AppendChatMessageRequest, ChatMessageRecord, CreditsLedgerRecord, Heartbeat,
    JobCompletion, JobEventRecord, JobRecord, NodeRecord,
};
use crate::state::ControlPlaneState;
use native_tls::TlsConnector;
use postgres::{Client, Config};
use postgres_native_tls::MakeTlsConnector;
use serde_json::json;
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
        Ok(state)
    }

    pub fn record_registration(&self, registration: &AgentRegistration) -> Result<(), String> {
        let now = now_epoch();
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
                    &Some(now),
                    &Some(now),
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("postgres registration sync failed: {error}"))
    }

    pub fn record_node_snapshot(&self, node: &NodeRecord) -> Result<(), String> {
        let policy_override = node.operator_policy_override.as_ref();
        let worker_health_json = node
            .worker_health
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
                    &updated_at_epoch,
                    &updated_at_epoch,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("postgres node sync failed: {error}"))
    }

    pub fn record_heartbeat(&self, heartbeat: &Heartbeat, node: &NodeRecord) -> Result<(), String> {
        self.record_node_snapshot(node)?;
        let observed_at = parse_epoch(&heartbeat.updated_at).unwrap_or_else(now_epoch);
        let source_heartbeat_key = heartbeat_sync_key(
            heartbeat,
            observed_at,
            node.policy_allowed,
            node.policy_reason.as_deref(),
        );
        let policy_override = node.operator_policy_override.as_ref();
        let worker_health_json = serde_json::to_string(&heartbeat.worker_health)
            .map_err(|error| format!("failed to serialize worker health: {error}"))?;
        let mut client = self.connect()?;
        client
            .execute(
                HEARTBEATS_UPSERT_SQL,
                &[
                    &source_heartbeat_key,
                    &heartbeat.node_id,
                    &heartbeat.backend.to_string(),
                    &heartbeat.agent_state.to_string(),
                    &node.reported_state.to_string(),
                    &(heartbeat.available_memory_mb as i32),
                    &(heartbeat.available_gpu_percent as i32),
                    &(heartbeat.contribution_percent as i32),
                    &heartbeat.hostname,
                    &heartbeat.identity_trust_path,
                    &heartbeat.power_source,
                    &heartbeat.on_battery,
                    &heartbeat.battery_percent.map(i32::from),
                    &node.policy_allowed,
                    &node.policy_reason,
                    &node.computed_policy_allowed,
                    &node.computed_policy_reason,
                    &policy_override.map(|value| value.target.to_string()),
                    &policy_override.map(|value| value.reason.clone()),
                    &policy_override.map(|value| value.actor.clone()),
                    &policy_override.map(|value| value.updated_at.clone()),
                    &heartbeat.worker_health.healthy,
                    &heartbeat.worker_health.runtime_ready,
                    &heartbeat.worker_health.model_name,
                    &heartbeat.worker_health.runtime_mode,
                    &heartbeat.worker_health.streaming_supported,
                    &worker_health_json,
                    &observed_at,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("postgres heartbeat sync failed: {error}"))
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
                "insert into public.chat_conversations (conversation_id) values ($1::uuid) on conflict (conversation_id) do nothing",
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
                "update public.chat_conversations set last_message_at = coalesce($2::timestamptz, last_message_at), message_count = (select count(*) from public.chat_messages where conversation_id = $1::uuid) where conversation_id = $1::uuid",
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
                "delete from public.chat_conversations where conversation_id = $1::uuid",
                &[&conversation_id],
            )
            .map_err(|error| format!("postgres chat conversation delete failed: {error}"))?;
        Ok(deleted > 0)
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

fn query_json_array<T>(client: &mut Client, sql: &str) -> Result<Vec<T>, String>
where
    T: serde::de::DeserializeOwned,
{
    let row = client
        .query_one(sql, &[])
        .map_err(|error| format!("postgres restore query failed: {error}"))?;
    let raw: String = row.get(0);
    serde_json::from_str(&raw).map_err(|error| format!("failed to parse postgres restore: {error}"))
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

fn heartbeat_sync_key(
    heartbeat: &Heartbeat,
    observed_at: i64,
    policy_allowed: bool,
    policy_reason: Option<&str>,
) -> String {
    let battery_percent = heartbeat
        .battery_percent
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_string());
    let policy_reason = policy_reason.unwrap_or_default().replace('|', "/");

    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        heartbeat.node_id,
        observed_at,
        heartbeat.backend,
        heartbeat.agent_state,
        heartbeat.available_memory_mb,
        heartbeat.available_gpu_percent,
        heartbeat.contribution_percent,
        heartbeat.hostname,
        heartbeat.identity_trust_path,
        heartbeat.power_source,
        heartbeat.on_battery,
        battery_percent,
        policy_allowed,
        policy_reason
    )
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
  operator_policy_override_updated_at, worker_health_json, last_seen_at_epoch, updated_at_epoch
) values (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9, $10,
  $11, $12, $13, $14, $15,
  $16, $17, $18, $19,
  $20, $21, $22,
  $23, $24::jsonb, $25, $26
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
  last_seen_at_epoch = excluded.last_seen_at_epoch,
  updated_at_epoch = excluded.updated_at_epoch
"#;

const HEARTBEATS_UPSERT_SQL: &str = r#"
insert into public.heartbeats (
  source_heartbeat_key, node_id, backend, agent_state, reported_state,
  available_memory_mb, available_gpu_percent, contribution_percent, hostname,
  identity_trust_path, power_source, on_battery, battery_percent, policy_allowed,
  policy_reason, computed_policy_allowed, computed_policy_reason,
  operator_policy_override_target, operator_policy_override_reason, operator_policy_override_actor,
  operator_policy_override_updated_at, worker_healthy, worker_runtime_ready, worker_model_name,
  worker_runtime_mode, worker_streaming, worker_health_json, observed_at_epoch
) values (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9,
  $10, $11, $12, $13, $14,
  $15, $16, $17,
  $18, $19, $20,
  $21, $22, $23, $24,
  $25, $26, $27::jsonb, $28
)
on conflict (source_heartbeat_key) do update set
  node_id = excluded.node_id,
  backend = excluded.backend,
  agent_state = excluded.agent_state,
  reported_state = excluded.reported_state,
  available_memory_mb = excluded.available_memory_mb,
  available_gpu_percent = excluded.available_gpu_percent,
  contribution_percent = excluded.contribution_percent,
  hostname = excluded.hostname,
  identity_trust_path = excluded.identity_trust_path,
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
  worker_healthy = excluded.worker_healthy,
  worker_runtime_ready = excluded.worker_runtime_ready,
  worker_model_name = excluded.worker_model_name,
  worker_runtime_mode = excluded.worker_runtime_mode,
  worker_streaming = excluded.worker_streaming,
  worker_health_json = excluded.worker_health_json,
  observed_at_epoch = excluded.observed_at_epoch
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
  $12::jsonb, $13::jsonb, $14::jsonb, $15, $16,
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
  $1::uuid, $2::uuid, $3, $4, $5, $6, $7,
  $8::double precision::numeric, $9, $10::jsonb, to_timestamp($11::bigint)
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
  $1, $2, $3, $4, $5::jsonb, to_timestamp($6::bigint)
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
  values ($1::uuid, $2, $3, $4, $5, $6::jsonb)
  on conflict (job_id) where job_id is not null do nothing
  returning *
), selected as (
  select * from inserted
  union all
  select * from public.chat_messages
  where conversation_id = $1::uuid and job_id = $4
  limit 1
)
select to_jsonb(selected)::text from selected limit 1
"#;

const CHAT_MESSAGES_FETCH_SQL: &str = r#"
select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at asc, t.id asc)::text, '[]')
from (
  select *
  from public.chat_messages
  where conversation_id = $1::uuid
  order by created_at desc, id desc
  limit $2
) t
"#;

#[cfg(test)]
mod tests {
    use super::{heartbeat_sync_key, PostgresStore};
    use crate::contracts::{AgentState, Backend, Heartbeat, WorkerHealthReport};

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
    fn heartbeat_sync_key_is_stable_for_duplicate_heartbeats() {
        let heartbeat = Heartbeat {
            node_id: "node-1".to_string(),
            backend: Backend::M,
            agent_state: AgentState::Ready,
            available_memory_mb: 1024,
            available_gpu_percent: 50,
            updated_at: "123".to_string(),
            contribution_percent: 80,
            hostname: "host".to_string(),
            identity_trust_path: "keychain".to_string(),
            power_source: "ac".to_string(),
            on_battery: false,
            battery_percent: None,
            policy_allowed: true,
            policy_reason: None,
            worker_health: WorkerHealthReport {
                healthy: true,
                model_dir: String::new(),
                model_name: None,
                model_path: None,
                llama_cli_available: true,
                blas_device_available: true,
                cuda_device_available: false,
                cuda_driver_available: false,
                cuda_device_name: None,
                cuda_memory_mb: None,
                power_source: "ac".to_string(),
                on_battery: false,
                battery_percent: None,
                runtime_ready: true,
                runtime_mode: "local".to_string(),
                parallel_slots: 1,
                supported_runtime_modes: Vec::new(),
                streaming_supported: false,
                capabilities: Default::default(),
                checked_at: "123".to_string(),
                notes: Vec::new(),
            },
        };

        assert_eq!(
            heartbeat_sync_key(&heartbeat, 123, true, None),
            heartbeat_sync_key(&heartbeat, 123, true, None)
        );
    }
}
