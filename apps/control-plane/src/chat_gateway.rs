use crate::contracts::{ChatCompletionRequest, JobRecord, JobStatus};
use crate::state::ControlPlaneState;
use crate::tools::ToolAnswer;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const GENERATION_LIMIT_MARKER: &str = "[truncated: hit the generation limit]";
const MAX_STREAM_DELTA_BYTES: usize = 64 * 1024;
const MAX_STREAM_BUFFER_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug)]
struct LiveStreamBuffer {
    next_sequence: u64,
    last_delta: Option<String>,
    buffered_bytes: usize,
    deltas: VecDeque<String>,
}

impl Default for LiveStreamBuffer {
    fn default() -> Self {
        Self {
            next_sequence: 1,
            last_delta: None,
            buffered_bytes: 0,
            deltas: VecDeque::new(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct LiveStreamRegistry {
    jobs: BTreeMap<String, LiveStreamBuffer>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PushDeltaResult {
    Accepted,
    Duplicate,
}

impl LiveStreamRegistry {
    pub fn register(&mut self, job_id: &str) {
        self.jobs.entry(job_id.to_string()).or_default();
    }

    pub fn push(
        &mut self,
        job_id: &str,
        sequence: u64,
        delta: String,
    ) -> Result<PushDeltaResult, String> {
        let buffer = self
            .jobs
            .get_mut(job_id)
            .ok_or_else(|| "live stream is not registered for this job".to_string())?;
        if sequence < buffer.next_sequence {
            if sequence + 1 == buffer.next_sequence
                && buffer.last_delta.as_deref() == Some(delta.as_str())
            {
                return Ok(PushDeltaResult::Duplicate);
            }
            return Err(
                "duplicate stream delta does not match the last accepted payload".to_string(),
            );
        }
        if sequence > buffer.next_sequence {
            return Err(format!(
                "out-of-order stream delta: expected {}, received {sequence}",
                buffer.next_sequence
            ));
        }
        if delta.is_empty() {
            return Err("stream delta must not be empty".to_string());
        }
        if delta.len() > MAX_STREAM_DELTA_BYTES {
            return Err("stream delta exceeds the 64 KiB limit".to_string());
        }
        if buffer.buffered_bytes.saturating_add(delta.len()) > MAX_STREAM_BUFFER_BYTES {
            return Err("live stream buffer exceeds the 256 KiB limit".to_string());
        }
        buffer.buffered_bytes += delta.len();
        buffer.last_delta = Some(delta.clone());
        buffer.deltas.push_back(delta);
        buffer.next_sequence += 1;
        Ok(PushDeltaResult::Accepted)
    }

    pub fn drain(&mut self, job_id: &str) -> Vec<String> {
        let Some(buffer) = self.jobs.get_mut(job_id) else {
            return Vec::new();
        };
        buffer.buffered_bytes = 0;
        buffer.deltas.drain(..).collect()
    }

    pub fn remove(&mut self, job_id: &str) {
        self.jobs.remove(job_id);
    }
}

pub fn output_hit_generation_limit(output: &str) -> bool {
    let normalized = output.trim_start().to_ascii_lowercase();
    normalized.starts_with(GENERATION_LIMIT_MARKER)
        || normalized
            .split_once("response=")
            .is_some_and(|(_, response)| response.trim_start().starts_with(GENERATION_LIMIT_MARKER))
}

pub fn strip_generation_limit_marker(output: &str) -> &str {
    let trimmed = output.trim_start();
    if trimmed
        .to_ascii_lowercase()
        .starts_with(GENERATION_LIMIT_MARKER)
    {
        trimmed
            .get(GENERATION_LIMIT_MARKER.len()..)
            .unwrap_or_default()
            .trim_start()
    } else if let Some((_, response)) = trimmed.split_once("response=") {
        let response = response.trim_start();
        if response
            .to_ascii_lowercase()
            .starts_with(GENERATION_LIMIT_MARKER)
        {
            response
                .get(GENERATION_LIMIT_MARKER.len()..)
                .unwrap_or_default()
                .trim_start()
        } else {
            output
        }
    } else {
        output
    }
}

pub fn public_model_id(environment: Option<&str>) -> &'static str {
    if environment
        .unwrap_or_default()
        .to_ascii_lowercase()
        .contains("benz")
    {
        "ehda-agnostic"
    } else {
        "mundusx-agnostic"
    }
}

pub fn validate_model(requested: Option<&str>, public_model: &str) -> Result<(), String> {
    let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if requested.eq_ignore_ascii_case(public_model) || requested.eq_ignore_ascii_case("auto") {
        Ok(())
    } else {
        Err(format!(
            "model `{requested}` is not exposed by this gateway; use `{public_model}`"
        ))
    }
}

pub fn is_openwebui_metadata_request(prompt: &str) -> bool {
    let normalized = prompt.trim().to_ascii_lowercase();
    if !normalized.starts_with("### task:") {
        return false;
    }
    [
        "suggest 3-5 relevant follow-up questions",
        "generate a concise title",
        "generate 1-3 broad tags",
        "generate search queries",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

pub fn history_contains_sensitive_data(history: &str) -> bool {
    let normalized = history.to_ascii_lowercase();
    [
        "-----begin private key-----",
        "-----begin rsa private key-----",
        "authorization: bearer ",
        "api_key=",
        "api-key=",
        "password=",
        "passwd=",
        "client_secret=",
        "aws_secret_access_key=",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

pub fn models_response(model: &str) -> Value {
    json!({
        "object": "list",
        "data": [{
            "id": model,
            "object": "model",
            "created": 0,
            "owned_by": "mundusx-router"
        }]
    })
}

pub fn completion_response(
    id: &str,
    created: u64,
    model: &str,
    content: &str,
    finish_reason: &str,
    job: Option<&JobRecord>,
    tool: Option<&ToolAnswer>,
) -> Value {
    let mut mundusx = serde_json::Map::new();
    if let Some(job) = job {
        mundusx.insert("job_id".to_string(), json!(job.job_id));
        mundusx.insert("request_id".to_string(), json!(job.request_id));
        mundusx.insert("status".to_string(), json!(job.status));
    }
    if let Some(tool) = tool {
        mundusx.insert("tool".to_string(), json!(tool.name));
        mundusx.insert("status".to_string(), json!(tool.status));
        mundusx.insert("grounded".to_string(), json!(tool.grounded));
        mundusx.insert("sources".to_string(), json!(&tool.sources));
        if let Some(retrieved_at) = tool.retrieved_at_epoch {
            mundusx.insert("retrieved_at_epoch".to_string(), json!(retrieved_at));
        }
        if let Some(expires_at) = tool.expires_at_epoch {
            mundusx.insert("expires_at_epoch".to_string(), json!(expires_at));
        }
    }
    json!({
        "id": id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": finish_reason
        }],
        "mundusx": mundusx
    })
}

pub fn sse_start(id: &str, created: u64, model: &str, live: bool) -> String {
    let start = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": Value::Null}]
    });
    let mode = if live {
        "live-delta"
    } else {
        "validated-buffered"
    };
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nX-Accel-Buffering: no\r\nX-MundusX-Stream-Mode: {mode}\r\nConnection: close\r\n\r\ndata: {start}\n\n"
    )
}

pub fn sse_delta(id: &str, created: u64, model: &str, content: &str) -> String {
    let chunk = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": Value::Null}]
    });
    format!("data: {chunk}\n\n")
}

pub fn sse_end(id: &str, created: u64, model: &str, finish_reason: &str) -> String {
    let end = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]
    });
    format!("data: {end}\n\ndata: [DONE]\n\n")
}

pub fn validated_stream_remainder<'a>(
    final_content: &'a str,
    streamed_content: &str,
) -> Result<&'a str, String> {
    final_content.strip_prefix(streamed_content).ok_or_else(|| {
        "streamed content is not an exact prefix of the validated final output".to_string()
    })
}

pub fn sse_finish(completion: &Value) -> String {
    let id = completion["id"].as_str().unwrap_or("chatcmpl-mundusx");
    let created = completion["created"].as_u64().unwrap_or_default();
    let model = completion["model"].as_str().unwrap_or("mundusx-agnostic");
    let content = completion["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default();
    let finish_reason = completion["choices"][0]["finish_reason"]
        .as_str()
        .unwrap_or("stop");
    format!(
        "{}{}",
        sse_delta(id, created, model, content),
        sse_end(id, created, model, finish_reason)
    )
}

pub fn sse_keep_alive() -> &'static str {
    ": mundusx keep-alive\n\n"
}

pub fn wait_for_job(
    state: &Arc<Mutex<ControlPlaneState>>,
    job_id: &str,
    timeout: Duration,
) -> Result<JobRecord, String> {
    wait_for_job_with_keepalive(state, job_id, timeout, || Ok(()))
}

pub fn wait_for_job_with_keepalive<F>(
    state: &Arc<Mutex<ControlPlaneState>>,
    job_id: &str,
    timeout: Duration,
    mut keep_alive: F,
) -> Result<JobRecord, String>
where
    F: FnMut() -> Result<(), String>,
{
    let started = Instant::now();
    let mut last_keep_alive = Instant::now();
    loop {
        let job = state
            .lock()
            .map_err(|_| "control-plane state lock poisoned".to_string())?
            .jobs
            .get(job_id)
            .cloned()
            .ok_or_else(|| format!("chat job {job_id} disappeared"))?;
        match job.status {
            JobStatus::Completed => {
                if job
                    .output
                    .as_deref()
                    .is_some_and(|output| !output.trim().is_empty())
                {
                    return Ok(job);
                }
                return Err("completed chat job has no validated output".to_string());
            }
            JobStatus::Failed => {
                return Err(job
                    .error
                    .clone()
                    .unwrap_or_else(|| "chat job failed".to_string()));
            }
            JobStatus::Queued | JobStatus::Assigned => {}
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "chat completion timed out after {} seconds",
                timeout.as_secs()
            ));
        }
        if last_keep_alive.elapsed() >= Duration::from_secs(10) {
            keep_alive()?;
            last_keep_alive = Instant::now();
        }
        thread::sleep(Duration::from_millis(100));
    }
}

pub fn wait_for_job_with_stream<F>(
    state: &Arc<Mutex<ControlPlaneState>>,
    streams: &Arc<Mutex<LiveStreamRegistry>>,
    job_id: &str,
    timeout: Duration,
    mut write_event: F,
) -> Result<JobRecord, String>
where
    F: FnMut(Option<&str>) -> Result<(), String>,
{
    let started = Instant::now();
    let mut last_keep_alive = Instant::now();
    loop {
        let deltas = streams
            .lock()
            .map_err(|_| "live stream registry lock poisoned".to_string())?
            .drain(job_id);
        for delta in deltas {
            write_event(Some(&delta))?;
        }

        let job = state
            .lock()
            .map_err(|_| "control-plane state lock poisoned".to_string())?
            .jobs
            .get(job_id)
            .cloned()
            .ok_or_else(|| format!("chat job {job_id} disappeared"))?;
        match job.status {
            JobStatus::Completed => {
                let trailing = streams
                    .lock()
                    .map_err(|_| "live stream registry lock poisoned".to_string())?
                    .drain(job_id);
                for delta in trailing {
                    write_event(Some(&delta))?;
                }
                if job
                    .output
                    .as_deref()
                    .is_some_and(|output| !output.trim().is_empty())
                {
                    return Ok(job);
                }
                return Err("completed chat job has no validated output".to_string());
            }
            JobStatus::Failed => {
                return Err(job
                    .error
                    .clone()
                    .unwrap_or_else(|| "chat job failed".to_string()));
            }
            JobStatus::Queued | JobStatus::Assigned => {}
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "chat completion timed out after {} seconds",
                timeout.as_secs()
            ));
        }
        if last_keep_alive.elapsed() >= Duration::from_secs(10) {
            write_event(None)?;
            last_keep_alive = Instant::now();
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub fn timeout_from_env() -> Duration {
    let seconds = std::env::var("MUNDUSX_CHAT_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(300)
        .clamp(5, 900);
    Duration::from_secs(seconds)
}

pub fn validate_request(request: &ChatCompletionRequest) -> Result<(), String> {
    if request.messages.is_empty() {
        return Err("messages must contain at least one entry".to_string());
    }
    if !request
        .messages
        .iter()
        .any(|message| message.role.eq_ignore_ascii_case("user") && !message.text().is_empty())
    {
        return Err("messages must contain a non-empty user message".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        completion_response, history_contains_sensitive_data, is_openwebui_metadata_request,
        models_response, output_hit_generation_limit, public_model_id, sse_finish, sse_start,
        strip_generation_limit_marker, validate_model, validated_stream_remainder,
        LiveStreamRegistry, PushDeltaResult,
    };
    use crate::tools::{ToolAnswer, ToolSource};

    #[test]
    fn exposes_environment_specific_virtual_model() {
        assert_eq!(public_model_id(Some("uat")), "mundusx-agnostic");
        assert_eq!(public_model_id(Some("benz-ehda")), "ehda-agnostic");
        assert!(validate_model(Some("mundusx-agnostic"), "mundusx-agnostic").is_ok());
        assert!(validate_model(Some("mlx-community/model"), "mundusx-agnostic").is_err());
        assert_eq!(
            models_response("mundusx-agnostic")["data"][0]["id"],
            "mundusx-agnostic"
        );
    }

    #[test]
    fn emits_openai_compatible_buffered_sse() {
        let completion = serde_json::json!({
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 1,
            "model": "mundusx-agnostic",
            "choices": [{"message": {"content": "Done."}, "finish_reason": "stop"}]
        });
        let start = sse_start("chatcmpl-test", 1, "mundusx-agnostic", false);
        let finish = sse_finish(&completion);
        assert!(start.starts_with("HTTP/1.1 200 OK"));
        assert!(start.contains("Content-Type: text/event-stream"));
        assert!(start.contains("\"role\":\"assistant\""));
        assert!(finish.contains("\"delta\":{\"content\":\"Done.\"}"));
        assert!(finish.contains("data: [DONE]"));
    }

    #[test]
    fn live_stream_registry_enforces_order_and_idempotency() {
        let mut streams = LiveStreamRegistry::default();
        streams.register("job-1");
        assert_eq!(
            streams.push("job-1", 1, "Hello".to_string()),
            Ok(PushDeltaResult::Accepted)
        );
        assert_eq!(
            streams.push("job-1", 1, "Hello".to_string()),
            Ok(PushDeltaResult::Duplicate)
        );
        assert!(streams.push("job-1", 1, "Altered".to_string()).is_err());
        assert!(streams.push("job-1", 3, "!".to_string()).is_err());
        assert_eq!(streams.drain("job-1"), vec!["Hello"]);
        assert_eq!(
            streams.push("job-1", 2, " world".to_string()),
            Ok(PushDeltaResult::Accepted)
        );
    }

    #[test]
    fn live_sse_advertises_delta_mode() {
        let start = sse_start("chatcmpl-live", 1, "mundusx-agnostic", true);
        assert!(start.contains("X-MundusX-Stream-Mode: live-delta"));
    }

    #[test]
    fn live_stream_reconciliation_appends_only_the_validated_remainder() {
        assert_eq!(
            validated_stream_remainder("Hello world", "Hello").unwrap(),
            " world"
        );
        assert_eq!(
            validated_stream_remainder("Hello world", "Hello world").unwrap(),
            ""
        );
        assert!(validated_stream_remainder("Hello world", "Altered").is_err());
    }

    #[test]
    fn exposes_grounding_sources_and_freshness_metadata() {
        let tool = ToolAnswer::fresh(
            "current_office_holder",
            "Verified answer.",
            vec![ToolSource {
                title: "Official source".to_string(),
                url: "https://example.com/source".to_string(),
                provider: "test".to_string(),
            }],
            300,
        );
        let response = completion_response(
            "chatcmpl-test",
            1,
            "mundusx-agnostic",
            &tool.content,
            "stop",
            None,
            Some(&tool),
        );

        assert_eq!(response["mundusx"]["grounded"], true);
        assert_eq!(response["mundusx"]["tool"], "current_office_holder");
        assert_eq!(
            response["mundusx"]["sources"][0]["url"],
            "https://example.com/source"
        );
        assert!(response["mundusx"]["retrieved_at_epoch"].is_u64());
        assert!(response["mundusx"]["expires_at_epoch"].is_u64());
    }

    #[test]
    fn identifies_openwebui_metadata_without_stealing_normal_questions() {
        assert!(is_openwebui_metadata_request(
            "### Task:\nSuggest 3-5 relevant follow-up questions based on the chat history."
        ));
        assert!(!is_openwebui_metadata_request(
            "Give me a detailed history of Tesla from its origins to today."
        ));
    }

    #[test]
    fn sensitive_history_guard_requires_secret_shaped_evidence() {
        assert!(history_contains_sensitive_data(
            "authorization: bearer secret-value"
        ));
        assert!(history_contains_sensitive_data("password=hunter2"));
        assert!(!history_contains_sensitive_data(
            "Discuss token budgets, private helper functions, and company history."
        ));
    }

    #[test]
    fn recognizes_and_removes_worker_generation_limit_marker() {
        let output = "[truncated: hit the generation limit] Certainly! Here is the answer";
        assert!(output_hit_generation_limit(output));
        assert_eq!(
            strip_generation_limit_marker(output),
            "Certainly! Here is the answer"
        );
        assert!(!output_hit_generation_limit("A complete answer."));
        assert!(output_hit_generation_limit(
            "mlx-lm mode=single response=[truncated: hit the generation limit] partial"
        ));
        assert_eq!(
            strip_generation_limit_marker(
                "mlx-lm mode=single response=[truncated: hit the generation limit] partial"
            ),
            "partial"
        );
    }
}
