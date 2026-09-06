use crate::contracts::{
    AgentRegistration, AppendChatMessageRequest, ChatMessageRecord, CreditsLedgerRecord,
    JobCompletion, JobEventRecord, JobRecord, NodeRecord,
};
use crate::state::ControlPlaneState;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use serde_json::json;
use std::collections::HashSet;
use std::env;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SUPABASE_REST_TIMEOUT: Duration = Duration::from_secs(10);

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
        let job_events = self.fetch_job_events()?;
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
            "capability_fabric_version": registration.capability_fabric_version,
            "capability_manifest_json": registration.capabilities,
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
        let (wh_healthy, wh_runtime_ready, wh_model_name, wh_runtime_mode, wh_streaming, wh_json) =
            if let Some(wh) = node.worker_health.as_ref() {
                (
                    Some(wh.healthy),
                    Some(wh.runtime_ready),
                    wh.model_name.clone(),
                    Some(wh.runtime_mode.clone()),
                    Some(wh.streaming_supported),
                    serde_json::to_value(wh).ok(),
                )
            } else {
                (None, None, None, None, None, None)
            };
        let payload = json!({
            "node_id": node.node_id,
            "public_key_fingerprint": node.public_key_fingerprint,
            "public_key_hex": node.public_key_hex,
            "hostname": node.hostname,
            "identity_trust_path": node.identity_trust_path,
            "backend": node.backend,
            "contribution_percent": node.contribution_percent,
            "agent_version": node.agent_version,
            "capability_fabric_version": node.capability_fabric_version,
            "capability_manifest_json": node.capabilities,
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
            "worker_healthy": wh_healthy,
            "worker_runtime_ready": wh_runtime_ready,
            "worker_model_name": wh_model_name,
            "worker_runtime_mode": wh_runtime_mode,
            "worker_streaming": wh_streaming,
            "worker_health_json": wh_json,
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
            "mode": job.mode,
            "system_prompt": job.system_prompt,
            "max_tokens": job.max_tokens,
            "temperature": job.temperature,
            "top_p": job.top_p,
            "seed": job.seed,
            "classification": job.classification,
            "plan": job.plan,
            "graph": job.graph,
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
            "parent_job_id": entry.parent_job_id,
            "graph_node_id": entry.graph_node_id,
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

    pub fn append_chat_message(
        &self,
        conversation_id: &str,
        payload: &AppendChatMessageRequest,
    ) -> Result<ChatMessageRecord, String> {
        self.post_json(
            "chat_conversations",
            Some("conversation_id"),
            "resolution=merge-duplicates,return=minimal",
            json!({ "conversation_id": conversation_id }),
        )?;

        let message_row = json!({
            "conversation_id": conversation_id,
            "role": payload.role,
            "content": payload.content,
            "job_id": payload.job_id,
            "tool": payload.tool,
            "metadata": payload.metadata.clone().unwrap_or_else(|| json!({})),
        });

        let inserted: Vec<ChatMessageRecord> = if payload.job_id.is_some() {
            self.post_json_returning_with_conflict(
                "chat_messages",
                Some("job_id"),
                "resolution=ignore-duplicates,return=representation",
                message_row,
            )?
        } else {
            self.post_json_returning_with_conflict(
                "chat_messages",
                None,
                "return=representation",
                message_row,
            )?
        };

        let record = match inserted.into_iter().next() {
            Some(record) => record,
            None => {
                let job_id = payload.job_id.as_deref().ok_or_else(|| {
                    "supabase did not return the inserted chat message".to_string()
                })?;
                let conversation_id_escaped = escape_query_value(conversation_id);
                let job_id_escaped = escape_query_value(job_id);
                self.fetch_json::<Vec<ChatMessageRecord>>(&format!(
                    "chat_messages?conversation_id=eq.{conversation_id_escaped}&job_id=eq.{job_id_escaped}&select=*&limit=1"
                ))?
                .into_iter()
                .next()
                .ok_or_else(|| "supabase did not return the existing chat message".to_string())?
            }
        };

        let _ = self.post_json(
            "chat_conversations",
            Some("conversation_id"),
            "resolution=merge-duplicates,return=minimal",
            json!({
                "conversation_id": conversation_id,
                "last_message_at": record.created_at,
            }),
        );

        Ok(record)
    }

    pub fn fetch_chat_messages(
        &self,
        conversation_id: &str,
        limit: u32,
    ) -> Result<Vec<ChatMessageRecord>, String> {
        let conversation_id = escape_query_value(conversation_id);
        let path = format!(
            "chat_messages?conversation_id=eq.{conversation_id}&select=*&order=created_at.desc,id.desc&limit={limit}"
        );
        let mut messages: Vec<ChatMessageRecord> = self.fetch_json(&path)?;
        messages.reverse();
        Ok(messages)
    }

    pub fn delete_chat_conversation(&self, conversation_id: &str) -> Result<bool, String> {
        let conversation_id = escape_query_value(conversation_id);
        let deleted_messages = self.delete_path(&format!(
            "chat_messages?conversation_id=eq.{conversation_id}"
        ))?;
        let deleted_conversation = self.delete_path(&format!(
            "chat_conversations?conversation_id=eq.{conversation_id}"
        ))?;
        Ok(deleted_messages || deleted_conversation)
    }

    fn job_payload(&self, job: &JobRecord) -> serde_json::Value {
        json!({
            "job_id": job.job_id,
            "request_id": job.request_id,
            "prompt": job.prompt,
            "preferred_backend": job.preferred_backend,
            "model": job.model,
            "mode": job.mode,
            "system_prompt": job.system_prompt,
            "max_tokens": job.max_tokens,
            "temperature": job.temperature,
            "top_p": job.top_p,
            "seed": job.seed,
            "classification": job.classification,
            "plan": job.plan,
            "graph": job.graph,
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
            "payload": payload.clone(),
        });

        self.post_json(
            "job_events",
            Some("source_event_id"),
            "resolution=merge-duplicates,return=minimal",
            body,
        )
        .or_else(|error| {
            if !error.contains("source_event_id") {
                return Err(error);
            }

            let legacy_body = json!({
                "node_id": node_id,
                "job_id": job_id,
                "event_type": event_type,
                "payload": payload,
            });
            self.post_json("job_events", None, "return=minimal", legacy_body)
        })
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

        let response = supabase_rest_request(
            "POST",
            &url,
            &self.api_key,
            &[("Content-Type", "application/json"), ("Prefer", prefer)],
            Some(payload.to_string()),
        )?;

        if response.is_success() {
            Ok(())
        } else if response.body.trim().is_empty() {
            Err(format!("supabase sync failed: HTTP {}", response.status))
        } else {
            Err(format!(
                "supabase sync failed: HTTP {}: {}",
                response.status,
                response.body.trim()
            ))
        }
    }

    fn post_json_returning_with_conflict<T>(
        &self,
        table: &str,
        on_conflict: Option<&str>,
        prefer: &str,
        payload: serde_json::Value,
    ) -> Result<T, String>
    where
        T: serde::de::DeserializeOwned,
    {
        let mut url = format!("{}/rest/v1/{}", self.base_url, table);
        if let Some(on_conflict) = on_conflict {
            url.push_str(&format!("?on_conflict={on_conflict}"));
        }

        let response = supabase_rest_request(
            "POST",
            &url,
            &self.api_key,
            &[("Content-Type", "application/json"), ("Prefer", prefer)],
            Some(payload.to_string()),
        )?;

        if !response.is_success() {
            return Err(if response.body.trim().is_empty() {
                format!("supabase sync failed: HTTP {}", response.status)
            } else {
                format!(
                    "supabase sync failed: HTTP {}: {}",
                    response.status,
                    response.body.trim()
                )
            });
        }

        if response.body.trim().is_empty() {
            return serde_json::from_str("[]")
                .map_err(|error| format!("failed to parse supabase response: {error}"));
        }

        serde_json::from_slice(response.body.as_bytes())
            .map_err(|error| format!("failed to parse supabase response: {error}"))
    }

    fn fetch_json<T>(&self, path: &str) -> Result<T, String>
    where
        T: serde::de::DeserializeOwned,
    {
        let response = supabase_rest_request(
            "GET",
            &format!("{}/rest/v1/{}", self.base_url, path),
            &self.api_key,
            &[
                ("Content-Type", "application/json"),
                ("Accept", "application/json"),
            ],
            None,
        )?;

        if !response.is_success() {
            return Err(if response.body.trim().is_empty() {
                format!("supabase fetch failed: HTTP {}", response.status)
            } else {
                format!(
                    "supabase fetch failed: HTTP {}: {}",
                    response.status,
                    response.body.trim()
                )
            });
        }

        serde_json::from_slice(response.body.as_bytes())
            .map_err(|error| format!("failed to parse supabase response: {error}"))
    }

    fn delete_path(&self, path: &str) -> Result<bool, String> {
        let response = supabase_rest_request(
            "DELETE",
            &format!("{}/rest/v1/{}", self.base_url, path),
            &self.api_key,
            &[("Prefer", "return=minimal")],
            None,
        )?;

        if response.is_success() {
            Ok(true)
        } else if is_missing_supabase_table(response.status, &response.body) {
            Ok(false)
        } else if response.body.trim().is_empty() {
            Err(format!("supabase delete failed: HTTP {}", response.status))
        } else {
            Err(format!(
                "supabase delete failed: HTTP {}: {}",
                response.status,
                response.body.trim()
            ))
        }
    }

    fn fetch_job_events(&self) -> Result<Vec<JobEventRecord>, String> {
        match self.fetch_json("job_events?select=*&order=source_event_id.asc.nullslast,id.asc") {
            Ok(events) => Ok(events),
            Err(error) if error.contains("source_event_id") => {
                eprintln!(
                    "supabase job_events restore using legacy id ordering because source_event_id is unavailable: {error}"
                );
                self.fetch_json("job_events?select=*&order=id.asc")
            }
            Err(error) => Err(error),
        }
    }
}

#[derive(Debug)]
struct RestUrl {
    host: String,
    port: u16,
    path_and_query: String,
}

#[derive(Debug)]
struct RestResponse {
    status: u16,
    body: String,
}

impl RestResponse {
    fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

fn is_missing_supabase_table(status: u16, body: &str) -> bool {
    status == 404 && body.contains("\"code\":\"PGRST205\"")
}

fn supabase_rest_request(
    method: &str,
    url: &str,
    api_key: &str,
    headers: &[(&str, &str)],
    body: Option<String>,
) -> Result<RestResponse, String> {
    let parsed = parse_https_url(url)?;
    let body = body.unwrap_or_default();
    let mut request = format!(
        "{method} {} HTTP/1.1\r\nHost: {}\r\napikey: {}\r\nAuthorization: Bearer {}\r\nConnection: close\r\nContent-Length: {}\r\n",
        parsed.path_and_query,
        parsed.host,
        api_key,
        api_key,
        body.len()
    );
    for (name, value) in headers {
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    request.push_str(&body);

    let address = (parsed.host.as_str(), parsed.port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve supabase REST API host: {error}"))?
        .next()
        .ok_or_else(|| "failed to resolve supabase REST API host".to_string())?;
    let tcp = TcpStream::connect_timeout(&address, SUPABASE_REST_TIMEOUT)
        .map_err(|error| format!("failed to connect to supabase REST API: {error}"))?;
    tcp.set_read_timeout(Some(SUPABASE_REST_TIMEOUT))
        .map_err(|error| format!("failed to set supabase REST read timeout: {error}"))?;
    tcp.set_write_timeout(Some(SUPABASE_REST_TIMEOUT))
        .map_err(|error| format!("failed to set supabase REST write timeout: {error}"))?;
    let server_name = ServerName::try_from(parsed.host.clone())
        .map_err(|_| format!("invalid supabase REST TLS host: {}", parsed.host))?;
    let connection = ClientConnection::new(rustls_client_config()?, server_name)
        .map_err(|error| format!("failed to negotiate TLS with supabase REST API: {error}"))?;
    let mut stream = StreamOwned::new(connection, tcp);
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("failed to send supabase REST request: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("failed to flush supabase REST request: {error}"))?;

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|error| format!("failed to read supabase REST response: {error}"))?;
    parse_http_response(&raw)
}

fn rustls_client_config() -> Result<Arc<ClientConfig>, String> {
    let mut roots = RootCertStore::empty();
    let certs = rustls_native_certs::load_native_certs();

    for cert in certs.certs {
        roots
            .add(cert)
            .map_err(|error| format!("failed to load native TLS certificate: {error}"))?;
    }

    if roots.is_empty() {
        let details = certs
            .errors
            .into_iter()
            .map(|error| error.to_string())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(if details.is_empty() {
            "failed to initialize TLS: no native root certificates found".to_string()
        } else {
            format!("failed to initialize TLS: no native root certificates found ({details})")
        });
    }

    Ok(Arc::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    ))
}

fn parse_https_url(url: &str) -> Result<RestUrl, String> {
    let without_scheme = url
        .strip_prefix("https://")
        .ok_or_else(|| "supabase REST URL must start with https://".to_string())?;
    let (authority, path) = without_scheme
        .split_once('/')
        .map(|(authority, path)| (authority, format!("/{path}")))
        .unwrap_or((without_scheme, "/".to_string()));
    if authority.is_empty() {
        return Err("supabase REST URL is missing a host".to_string());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => {
            let port = port
                .parse::<u16>()
                .map_err(|_| "supabase REST URL has an invalid port".to_string())?;
            (host.to_string(), port)
        }
        _ => (authority.to_string(), 443),
    };
    Ok(RestUrl {
        host,
        port,
        path_and_query: path,
    })
}

fn parse_http_response(raw: &[u8]) -> Result<RestResponse, String> {
    let header_end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "supabase REST response is missing headers".to_string())?;
    let headers = std::str::from_utf8(&raw[..header_end])
        .map_err(|_| "supabase REST response headers are not utf-8".to_string())?;
    let mut header_lines = headers.split("\r\n");
    let status_line = header_lines
        .next()
        .ok_or_else(|| "supabase REST response is missing a status line".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "supabase REST response status is malformed".to_string())?
        .parse::<u16>()
        .map_err(|_| "supabase REST response status is invalid".to_string())?;
    let transfer_encoding = header_lines.clone().find_map(|line| {
        line.split_once(':').and_then(|(name, value)| {
            if name.eq_ignore_ascii_case("transfer-encoding") {
                Some(value.trim().to_ascii_lowercase())
            } else {
                None
            }
        })
    });
    let mut body = raw[header_end + 4..].to_vec();
    if transfer_encoding
        .as_deref()
        .is_some_and(|value| value.contains("chunked"))
    {
        body = decode_chunked_body(&body)?;
    }
    String::from_utf8(body)
        .map(|body| RestResponse { status, body })
        .map_err(|_| "supabase REST response body is not utf-8".to_string())
}

fn decode_chunked_body(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    let mut offset = 0;
    loop {
        let line_end = raw[offset..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "chunked response is missing a chunk size terminator".to_string())?
            + offset;
        let size_line = std::str::from_utf8(&raw[offset..line_end])
            .map_err(|_| "chunked response size is not utf-8".to_string())?;
        let size_hex = size_line.split(';').next().unwrap_or(size_line).trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| "chunked response has an invalid chunk size".to_string())?;
        offset = line_end + 2;
        if size == 0 {
            return Ok(decoded);
        }
        let chunk_end = offset
            .checked_add(size)
            .ok_or_else(|| "chunked response size overflowed".to_string())?;
        if raw.len() < chunk_end + 2 {
            return Err("chunked response ended before the declared chunk size".to_string());
        }
        decoded.extend_from_slice(&raw[offset..chunk_end]);
        if &raw[chunk_end..chunk_end + 2] != b"\r\n" {
            return Err("chunked response chunk is missing trailing CRLF".to_string());
        }
        offset = chunk_end + 2;
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

fn trim_trailing_slash(input: &str) -> String {
    input.trim_end_matches('/').to_string()
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

    #[test]
    fn escapes_special_characters_in_query_values() {
        assert_eq!(escape_query_value("abc-123_DEF.~"), "abc-123_DEF.~");
        assert_eq!(escape_query_value("a b&c=d"), "a%20b%26c%3Dd");
    }

    #[test]
    fn recognizes_missing_supabase_table_errors() {
        let body = r#"{"code":"PGRST205","message":"Could not find the table 'public.chat_messages' in the schema cache"}"#;
        assert!(is_missing_supabase_table(404, body));
        assert!(!is_missing_supabase_table(500, body));
        assert!(!is_missing_supabase_table(404, r#"{"code":"OTHER"}"#));
    }

    #[test]
    fn parses_supabase_rest_https_url() {
        let parsed =
            parse_https_url("https://example.supabase.co/rest/v1/jobs?select=*&order=id.asc")
                .expect("parsed url");

        assert_eq!(parsed.host, "example.supabase.co");
        assert_eq!(parsed.port, 443);
        assert_eq!(parsed.path_and_query, "/rest/v1/jobs?select=*&order=id.asc");
    }

    #[test]
    fn rejects_non_https_supabase_rest_url() {
        let error = parse_https_url("http://example.supabase.co/rest/v1/jobs")
            .expect_err("http url should be rejected");

        assert_eq!(error, "supabase REST URL must start with https://");
    }

    #[test]
    fn initializes_rustls_client_config_from_native_roots() {
        rustls_client_config().expect("rustls client config");
    }

    #[test]
    fn parses_chunked_supabase_rest_response() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        let response = parse_http_response(raw).expect("parsed response");

        assert_eq!(response.status, 200);
        assert_eq!(response.body, "hello world");
        assert!(response.is_success());
    }

    #[test]
    fn reports_non_success_rest_response_body() {
        let raw =
            b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 24\r\n\r\n{\"message\":\"bad token\"}";
        let response = parse_http_response(raw).expect("parsed response");

        assert_eq!(response.status, 401);
        assert_eq!(response.body, "{\"message\":\"bad token\"}");
        assert!(!response.is_success());
    }
}
