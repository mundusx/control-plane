use crate::contracts::{
    AgentRegistration, CreditsLedgerRecord, Heartbeat, JobCompletion, JobEventRecord, JobRecord,
    NodeRecord,
};
use crate::state::ControlPlaneState;
use serde_json::json;
use std::collections::HashSet;
use std::env;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
pub struct SupabaseMirror {
    base_url: String,
    api_key: String,
}

impl SupabaseMirror {
    pub fn from_env() -> Option<Self> {
        let api_key = env::var("SUPABASE_SERVICE_ROLE_KEY").ok()?;
        let base_url = env::var("SUPABASE_URL").ok().or_else(|| {
            env::var("DATABASE_URL")
                .ok()
                .and_then(|url| derive_supabase_url(&url))
        })?;

        Some(Self {
            base_url: trim_trailing_slash(&base_url),
            api_key,
        })
    }

    pub fn restore_state(&self) -> Result<ControlPlaneState, String> {
        let devices: Vec<NodeRecord> = self.fetch_json("devices?select=*")?;
        let jobs: Vec<JobRecord> = self.fetch_json("jobs?select=*")?;
        let job_events: Vec<JobEventRecord> =
            self.fetch_json("job_events?select=*&order=source_event_id.asc.nullslast,id.asc")?;
        let credits_ledger: Vec<CreditsLedgerRecord> =
            self.fetch_json("credits_ledger?select=*&order=created_at.asc")?;

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
        let payload = json!({
            "node_id": registration.node_id,
            "public_key_fingerprint": registration.public_key_fingerprint,
            "public_key_hex": registration.public_key_hex,
            "hostname": registration.hostname,
            "identity_trust_path": registration.identity_trust_path,
            "backend": registration.backend,
            "contribution_percent": registration.contribution_percent,
            "agent_version": registration.agent_version,
            "state": "starting",
            "reported_state": "starting",
            "available_memory_mb": 0_u64,
            "available_gpu_percent": 0_u64,
            "power_source": "unknown",
            "on_battery": false,
            "battery_percent": null,
            "policy_allowed": false,
            "policy_reason": null,
            "computed_policy_allowed": false,
            "computed_policy_reason": null,
            "operator_policy_override_target": null,
            "operator_policy_override_reason": null,
            "operator_policy_override_actor": null,
            "operator_policy_override_updated_at": null,
            "last_seen_at_epoch": now,
            "updated_at_epoch": now,
        });

        self.post_json(
            "devices",
            Some("node_id"),
            "resolution=merge-duplicates,return=minimal",
            payload,
        )
    }

    pub fn record_node_snapshot(&self, node: &NodeRecord) -> Result<(), String> {
        let policy_override = node.operator_policy_override.as_ref();
        let payload = json!({
            "node_id": node.node_id,
            "public_key_fingerprint": node.public_key_fingerprint,
            "public_key_hex": node.public_key_hex,
            "hostname": node.hostname,
            "identity_trust_path": node.identity_trust_path,
            "backend": node.backend,
            "contribution_percent": node.contribution_percent,
            "agent_version": node.agent_version,
            "state": node.state,
            "reported_state": node.reported_state,
            "available_memory_mb": node.available_memory_mb,
            "available_gpu_percent": node.available_gpu_percent,
            "power_source": node.power_source,
            "on_battery": node.on_battery,
            "battery_percent": node.battery_percent,
            "policy_allowed": node.policy_allowed,
            "policy_reason": node.policy_reason,
            "computed_policy_allowed": node.computed_policy_allowed,
            "computed_policy_reason": node.computed_policy_reason,
            "operator_policy_override_target": policy_override.map(|value| value.target),
            "operator_policy_override_reason": policy_override.map(|value| value.reason.clone()),
            "operator_policy_override_actor": policy_override.map(|value| value.actor.clone()),
            "operator_policy_override_updated_at": policy_override.map(|value| value.updated_at.clone()),
            "last_seen_at_epoch": parse_epoch(&node.updated_at).unwrap_or_else(now_epoch),
            "updated_at_epoch": parse_epoch(&node.updated_at).unwrap_or_else(now_epoch),
        });

        self.post_json(
            "devices",
            Some("node_id"),
            "resolution=merge-duplicates,return=minimal",
            payload,
        )
    }

    pub fn record_heartbeat(&self, heartbeat: &Heartbeat, node: &NodeRecord) -> Result<(), String> {
        let now = parse_epoch(&heartbeat.updated_at).unwrap_or_else(now_epoch);
        let source_heartbeat_key =
            heartbeat_sync_key(heartbeat, now, node.policy_allowed, node.policy_reason.as_deref());

        self.record_node_snapshot(node)?;

        let policy_override = node.operator_policy_override.as_ref();
        let heartbeat_row = json!({
            "source_heartbeat_key": source_heartbeat_key,
            "node_id": heartbeat.node_id,
            "backend": heartbeat.backend,
            "agent_state": heartbeat.agent_state,
            "reported_state": node.reported_state,
            "available_memory_mb": heartbeat.available_memory_mb,
            "available_gpu_percent": heartbeat.available_gpu_percent,
            "contribution_percent": heartbeat.contribution_percent,
            "hostname": heartbeat.hostname,
            "identity_trust_path": heartbeat.identity_trust_path,
            "power_source": heartbeat.power_source,
            "on_battery": heartbeat.on_battery,
            "battery_percent": heartbeat.battery_percent,
            "policy_allowed": node.policy_allowed,
            "policy_reason": node.policy_reason,
            "computed_policy_allowed": node.computed_policy_allowed,
            "computed_policy_reason": node.computed_policy_reason,
            "operator_policy_override_target": policy_override.map(|value| value.target),
            "operator_policy_override_reason": policy_override.map(|value| value.reason.clone()),
            "operator_policy_override_actor": policy_override.map(|value| value.actor.clone()),
            "operator_policy_override_updated_at": policy_override.map(|value| value.updated_at.clone()),
            "observed_at_epoch": now,
        });

        self.post_json(
            "heartbeats",
            Some("source_heartbeat_key"),
            "resolution=merge-duplicates,return=minimal",
            heartbeat_row,
        )?;

        Ok(())
    }

    pub fn record_job(&self, job: &JobRecord) -> Result<(), String> {
        let payload = self.job_payload(job);
        self.post_json(
            "jobs",
            Some("job_id"),
            "resolution=merge-duplicates,return=minimal",
            payload,
        )?;

        Ok(())
    }

    pub fn record_job_completion(
        &self,
        completion: &JobCompletion,
        job: &JobRecord,
    ) -> Result<(), String> {
        let payload = json!({
            "job_id": job.job_id,
            "request_id": job.request_id,
            "prompt": job.prompt,
            "preferred_backend": job.preferred_backend,
            "model": job.model,
            "system_prompt": job.system_prompt,
            "max_tokens": job.max_tokens,
            "temperature": job.temperature,
            "top_p": job.top_p,
            "seed": job.seed,
            "status": completion.status,
            "assigned_node_id": job.assigned_node_id,
            "worker_id": completion.worker_id,
            "backend": completion.backend,
            "output": completion.output,
            "error": completion.error,
            "submitted_at_epoch": parse_epoch(&job.submitted_at).unwrap_or_else(now_epoch),
            "assigned_at_epoch": job.assigned_at.as_deref().and_then(parse_epoch),
            "completed_at_epoch": job.completed_at.as_deref().and_then(parse_epoch),
            "updated_at_epoch": now_epoch(),
        });

        self.post_json(
            "jobs",
            Some("job_id"),
            "resolution=merge-duplicates,return=minimal",
            payload,
        )?;

        Ok(())
    }

    pub fn record_credit_award(&self, entry: &CreditsLedgerRecord) -> Result<(), String> {
        let payload = json!({
            "id": entry.id,
            "user_id": entry.user_id,
            "device_id": entry.device_id,
            "job_id": entry.job_id,
            "entry_type": entry.entry_type,
            "amount": entry.amount,
            "currency": entry.currency,
            "metadata": entry.metadata,
            "created_at": entry.created_at,
        });

        self.post_json(
            "credits_ledger",
            Some("id"),
            "resolution=merge-duplicates,return=minimal",
            payload,
        )
    }

    pub fn record_job_event(&self, event: &JobEventRecord) -> Result<(), String> {
        self.insert_event(
            event.node_id.as_deref(),
            event.job_id.as_deref(),
            &event.event_type,
            event.payload.clone(),
            event.source_event_id.unwrap_or(event.id),
        )
    }

    fn job_payload(&self, job: &JobRecord) -> serde_json::Value {
        json!({
            "job_id": job.job_id,
            "request_id": job.request_id,
            "prompt": job.prompt,
            "preferred_backend": job.preferred_backend,
            "model": job.model,
            "system_prompt": job.system_prompt,
            "max_tokens": job.max_tokens,
            "temperature": job.temperature,
            "top_p": job.top_p,
            "seed": job.seed,
            "status": job.status,
            "assigned_node_id": job.assigned_node_id,
            "worker_id": job.worker_id,
            "backend": job.backend,
            "output": job.output,
            "error": job.error,
            "submitted_at_epoch": parse_epoch(&job.submitted_at).unwrap_or_else(now_epoch),
            "assigned_at_epoch": job.assigned_at.as_deref().and_then(parse_epoch),
            "completed_at_epoch": job.completed_at.as_deref().and_then(parse_epoch),
            "updated_at_epoch": now_epoch(),
        })
    }

    fn insert_event(
        &self,
        node_id: Option<&str>,
        job_id: Option<&str>,
        event_type: &str,
        payload: serde_json::Value,
        source_event_id: u64,
    ) -> Result<(), String> {
        let body = json!({
            "source_event_id": source_event_id,
            "node_id": node_id,
            "job_id": job_id,
            "event_type": event_type,
            "payload": payload,
        });

        self.post_json(
            "job_events",
            Some("source_event_id"),
            "resolution=merge-duplicates,return=minimal",
            body,
        )
    }

    fn post_json(
        &self,
        table: &str,
        on_conflict: Option<&str>,
        prefer: &str,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        let mut url = format!("{}/rest/v1/{}", self.base_url, table);
        if let Some(on_conflict) = on_conflict {
            url.push_str(&format!("?on_conflict={on_conflict}"));
        }

        let mut command = Command::new("curl");
        command.arg("--silent");
        command.arg("--show-error");
        command.arg("--fail");
        command.arg("--request");
        command.arg("POST");
        command.arg("--header");
        command.arg(format!("apikey: {}", self.api_key));
        command.arg("--header");
        command.arg(format!("Authorization: Bearer {}", self.api_key));
        command.arg("--header");
        command.arg("Content-Type: application/json");
        command.arg("--header");
        command.arg(format!("Prefer: {prefer}"));
        command.arg(url);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start curl: {error}"))?;

        {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| "curl stdin unavailable".to_string())?;
            stdin
                .write_all(payload.to_string().as_bytes())
                .map_err(|error| format!("failed to send payload to curl: {error}"))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|error| format!("failed waiting for curl: {error}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if stderr.is_empty() {
            stdout
        } else if stdout.is_empty() {
            stderr
        } else {
            format!("{stderr}: {stdout}")
        };
        Err(if details.is_empty() {
            "supabase sync failed".to_string()
        } else {
            format!("supabase sync failed: {details}")
        })
    }

    fn fetch_json<T>(&self, path: &str) -> Result<T, String>
    where
        T: serde::de::DeserializeOwned,
    {
        let mut command = Command::new("curl");
        command.arg("--silent");
        command.arg("--show-error");
        command.arg("--fail");
        command.arg("--request");
        command.arg("GET");
        command.arg("--header");
        command.arg(format!("apikey: {}", self.api_key));
        command.arg("--header");
        command.arg(format!("Authorization: Bearer {}", self.api_key));
        command.arg("--header");
        command.arg("Content-Type: application/json");
        command.arg("--header");
        command.arg("Accept: application/json");
        command.arg(format!("{}/rest/v1/{}", self.base_url, path));
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let output = command
            .output()
            .map_err(|error| format!("failed to start curl: {error}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let details = if stderr.is_empty() {
                stdout
            } else if stdout.is_empty() {
                stderr
            } else {
                format!("{stderr}: {stdout}")
            };
            return Err(if details.is_empty() {
                "supabase fetch failed".to_string()
            } else {
                format!("supabase fetch failed: {details}")
            });
        }

        serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("failed to parse supabase response: {error}"))
    }
}

fn dedupe_job_events(job_events: Vec<JobEventRecord>) -> Vec<JobEventRecord> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(job_events.len());

    for event in job_events {
        let key = job_event_dedupe_key(&event);
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

fn job_event_dedupe_key(event: &JobEventRecord) -> String {
    match event.source_event_id {
        Some(source_event_id) => format!("source_event_id:{source_event_id}"),
        None => format!(
            "legacy:{}:{}:{}:{}",
            event.node_id.as_deref().unwrap_or_default(),
            event.job_id.as_deref().unwrap_or_default(),
            event.event_type,
            event.payload
        ),
    }
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

fn trim_trailing_slash(input: &str) -> String {
    input.trim_end_matches('/').to_string()
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn parse_epoch(input: &str) -> Option<i64> {
    input.trim().parse::<i64>().ok()
}

fn derive_supabase_url(database_url: &str) -> Option<String> {
    let without_scheme = database_url.split_once("://")?.1;
    let user_info = without_scheme.split('@').next()?;
    let username = user_info.split(':').next()?;
    let project_ref = username.strip_prefix("postgres.")?;
    if project_ref.is_empty() {
        return None;
    }

    Some(format!("https://{project_ref}.supabase.co"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_supabase_url_from_database_url() {
        let derived = derive_supabase_url(
            "postgresql://postgres.yjlvhhouncxhjkghnwyj:[YOUR-PASSWORD]@aws-1-eu-central-1.pooler.supabase.com:6543/postgres",
        )
        .expect("derived url");
        assert_eq!(derived, "https://yjlvhhouncxhjkghnwyj.supabase.co");
    }

    #[test]
    fn rejects_non_supabase_database_urls() {
        assert!(derive_supabase_url("postgresql://user:pass@localhost:5432/postgres").is_none());
    }
}
