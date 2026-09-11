use crate::contracts::{
    ChatCompletionRequest, JobRecord, JobStatus, QualityGateStatus, SynthesisStatus,
};
use crate::state::ControlPlaneState;
use crate::tools::ToolAnswer;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const GENERATION_LIMIT_MARKER: &str = "[truncated: hit the generation limit]";

/// Keep harness tool results on the native path even during a final turn that
/// omits tool definitions. Server lookups must not replace the harness's answer.
pub fn is_native_tool_turn(request: &ChatCompletionRequest) -> bool {
    request
        .tools
        .as_ref()
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty())
        || request.messages.iter().any(|message| {
            message.role.eq_ignore_ascii_case("tool")
                || message.tool_call_id.is_some()
                || message
                    .tool_calls
                    .as_ref()
                    .and_then(Value::as_array)
                    .is_some_and(|calls| !calls.is_empty())
        })
}

#[cfg(test)]
mod harness_routing_tests {
    use super::*;

    #[test]
    fn harness_final_turn_preserves_tool_history_without_definitions() {
        for tools in [Value::Null, json!([])] {
            let request: ChatCompletionRequest = serde_json::from_value(json!({
                "messages": [
                    {"role": "user", "content": "Who won in soccer on 2025-04-25?"},
                    {"role": "assistant", "content": null, "tool_calls": [{"id": "search1", "type": "function", "function": {"name": "web_search", "arguments": "{}"}}]},
                    {"role": "tool", "tool_call_id": "search1", "content": "Verified match results"}
                ], "tools": tools
            })).unwrap();
            assert!(is_native_tool_turn(&request));
        }
    }

    #[test]
    fn initial_harness_turn_and_plain_chat_remain_distinct() {
        let mut request: ChatCompletionRequest = serde_json::from_value(json!({
            "messages": [{"role": "user", "content": "soccer results today"}]
        }))
        .unwrap();
        assert!(!is_native_tool_turn(&request));
        request.tools = Some(json!([{ "type": "function", "function": {"name": "web_search"}}]));
        assert!(is_native_tool_turn(&request));
    }
}
const MAX_STREAM_DELTA_BYTES: usize = 64 * 1024;
const MAX_STREAM_BUFFER_BYTES: usize = 256 * 1024;
const DEFAULT_MAX_ACTIVE_CHAT_WEIGHT: usize = 14;
const CHAT_ADMISSION_KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChatAdmissionSnapshot {
    pub active: usize,
    pub queued: usize,
    pub max_active: usize,
    pub active_weight: usize,
    pub queued_weight: usize,
    pub max_weight: usize,
}

#[derive(Clone, Copy, Debug)]
struct AdmissionTicket {
    id: u64,
    weight: usize,
}

#[derive(Debug, Default)]
struct ChatAdmissionState {
    active: usize,
    active_weight: usize,
    next_ticket: u64,
    queue: VecDeque<AdmissionTicket>,
}

#[derive(Debug)]
pub struct ChatAdmissionController {
    max_weight: usize,
    state: Mutex<ChatAdmissionState>,
    changed: Condvar,
}

impl ChatAdmissionController {
    pub fn new(max_weight: usize) -> Self {
        Self {
            max_weight: max_weight.max(1),
            state: Mutex::new(ChatAdmissionState::default()),
            changed: Condvar::new(),
        }
    }

    pub fn from_env() -> Self {
        Self::new(max_active_chat_requests_from_env())
    }

    pub fn snapshot(&self) -> ChatAdmissionSnapshot {
        let state = self.state.lock().expect("chat admission state lock");
        ChatAdmissionSnapshot {
            active: state.active,
            queued: state.queue.len(),
            max_active: self.max_weight,
            active_weight: state.active_weight,
            queued_weight: state.queue.iter().map(|ticket| ticket.weight).sum(),
            max_weight: self.max_weight,
        }
    }

    pub fn acquire<F>(self: &Arc<Self>, keep_alive: F) -> Result<ChatAdmissionPermit, String>
    where
        F: FnMut() -> Result<(), String>,
    {
        self.acquire_weighted(1, keep_alive)
    }

    pub fn acquire_weighted<F>(
        self: &Arc<Self>,
        weight: usize,
        keep_alive: F,
    ) -> Result<ChatAdmissionPermit, String>
    where
        F: FnMut() -> Result<(), String>,
    {
        self.acquire_weighted_with_interval(weight, keep_alive, CHAT_ADMISSION_KEEP_ALIVE_INTERVAL)
    }

    pub fn try_acquire(self: &Arc<Self>) -> Result<Option<ChatAdmissionPermit>, String> {
        self.try_acquire_weighted(1)
    }

    pub fn try_acquire_weighted(
        self: &Arc<Self>,
        weight: usize,
    ) -> Result<Option<ChatAdmissionPermit>, String> {
        let weight = self.normalize_weight(weight);
        let mut state = self
            .state
            .lock()
            .map_err(|_| "chat admission state lock poisoned".to_string())?;
        if state.active_weight.saturating_add(weight) > self.max_weight || !state.queue.is_empty() {
            return Ok(None);
        }
        state.active += 1;
        state.active_weight += weight;
        Ok(Some(ChatAdmissionPermit {
            controller: Arc::clone(self),
            weight,
        }))
    }

    fn acquire_with_interval<F>(
        self: &Arc<Self>,
        mut keep_alive: F,
        keep_alive_interval: Duration,
    ) -> Result<ChatAdmissionPermit, String>
    where
        F: FnMut() -> Result<(), String>,
    {
        self.acquire_weighted_with_interval(1, &mut keep_alive, keep_alive_interval)
    }

    fn acquire_weighted_with_interval<F>(
        self: &Arc<Self>,
        weight: usize,
        mut keep_alive: F,
        keep_alive_interval: Duration,
    ) -> Result<ChatAdmissionPermit, String>
    where
        F: FnMut() -> Result<(), String>,
    {
        let weight = self.normalize_weight(weight);
        let ticket = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "chat admission state lock poisoned".to_string())?;
            let ticket = AdmissionTicket {
                id: state.next_ticket,
                weight,
            };
            state.next_ticket = state.next_ticket.wrapping_add(1);
            state.queue.push_back(ticket);
            ticket
        };
        let mut last_keep_alive = Instant::now();

        loop {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "chat admission state lock poisoned".to_string())?;
            if state.active_weight.saturating_add(weight) <= self.max_weight
                && state
                    .queue
                    .front()
                    .is_some_and(|queued| queued.id == ticket.id)
            {
                state.queue.pop_front();
                state.active += 1;
                state.active_weight += weight;
                self.changed.notify_all();
                return Ok(ChatAdmissionPermit {
                    controller: Arc::clone(self),
                    weight,
                });
            }

            let wait_for = keep_alive_interval
                .saturating_sub(last_keep_alive.elapsed())
                .max(Duration::from_millis(1));
            let (guard, _) = self
                .changed
                .wait_timeout(state, wait_for)
                .map_err(|_| "chat admission state lock poisoned".to_string())?;
            drop(guard);

            if last_keep_alive.elapsed() >= keep_alive_interval {
                if let Err(error) = keep_alive() {
                    self.remove_queued_ticket(ticket.id);
                    return Err(error);
                }
                last_keep_alive = Instant::now();
            }
        }
    }

    fn remove_queued_ticket(&self, ticket: u64) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(index) = state.queue.iter().position(|queued| queued.id == ticket) {
                state.queue.remove(index);
                self.changed.notify_all();
            }
        }
    }

    fn normalize_weight(&self, weight: usize) -> usize {
        weight.max(1).min(self.max_weight)
    }
}

pub struct ChatAdmissionPermit {
    controller: Arc<ChatAdmissionController>,
    weight: usize,
}

impl Drop for ChatAdmissionPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.controller.state.lock() {
            state.active = state.active.saturating_sub(1);
            state.active_weight = state.active_weight.saturating_sub(self.weight);
            self.controller.changed.notify_all();
        }
    }
}

pub fn release_permit_after_job_terminal(
    permit: ChatAdmissionPermit,
    state: Arc<Mutex<ControlPlaneState>>,
    job_id: String,
) {
    thread::spawn(move || {
        let _permit = permit;
        loop {
            let terminal = state
                .lock()
                .ok()
                .and_then(|state| state.jobs.get(&job_id).map(|job| job.status))
                .is_none_or(|status| matches!(status, JobStatus::Completed | JobStatus::Failed));
            if terminal {
                return;
            }
            thread::sleep(Duration::from_millis(250));
        }
    });
}

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

pub fn finish_reason_for_job(job: &JobRecord) -> &'static str {
    if job
        .output
        .as_deref()
        .is_some_and(output_hit_generation_limit)
        || job.graph.synthesis_status == SynthesisStatus::CompletedPartial
        || job.quality_gate.status == QualityGateStatus::CompletedPartial
    {
        "length"
    } else {
        "stop"
    }
}

pub fn semantic_status_for_job(job: &JobRecord) -> &'static str {
    if job.graph.synthesis_status == SynthesisStatus::CompletedPartial
        || job.quality_gate.status == QualityGateStatus::CompletedPartial
    {
        "completed_partial"
    } else if job.quality_gate.status == QualityGateStatus::Passed
        && !job.quality_gate.execution_verified
    {
        "structurally_valid_unverified"
    } else {
        "completed"
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
        mundusx.insert("quality_gate".to_string(), json!(job.quality_gate));
        mundusx.insert(
            "semantic_status".to_string(),
            json!(semantic_status_for_job(job)),
        );
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
    let native_message = content
        .strip_prefix("__MUNDUSX_OPENAI_TOOL_RESULT_V1__")
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let message = native_message
        .as_ref()
        .and_then(|value| value.get("message"))
        .cloned()
        .unwrap_or_else(|| json!({"role": "assistant", "content": content}));
    let native_finish_reason = native_message
        .as_ref()
        .and_then(|value| value.get("finish_reason"))
        .and_then(Value::as_str)
        .unwrap_or(finish_reason);
    let finish_reason = if message
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|tool_calls| !tool_calls.is_empty())
    {
        "tool_calls"
    } else {
        native_finish_reason
    };
    json!({
        "id": id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason
        }],
        "mundusx": mundusx
    })
}

pub fn sse_start(id: &str, _created: u64, _model: &str, live: bool, resume_token: &str) -> String {
    let mode = if live {
        "live-delta"
    } else {
        "validated-buffered"
    };
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nX-Accel-Buffering: no\r\nX-MundusX-Stream-Mode: {mode}\r\nX-MundusX-Completion-Id: {id}\r\nX-MundusX-Resume-Token: {resume_token}\r\nConnection: close\r\n\r\n: stream opened\n\n"
    )
}

pub fn sse_delta(id: &str, created: u64, model: &str, content: &str) -> String {
    let chunk = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": Value::Null}]
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
    let message = &completion["choices"][0]["message"];
    let content = message["content"].as_str().unwrap_or_default();
    let finish_reason = completion["choices"][0]["finish_reason"]
        .as_str()
        .unwrap_or("stop");
    if let Some(tool_calls) = message.get("tool_calls").filter(|value| value.is_array()) {
        // OpenAI streaming clients assemble tool-call fragments by index. The
        // completed assistant message does not include that streaming-only
        // field, so add it while converting the buffered message to an SSE
        // delta.
        let indexed_tool_calls = tool_calls
            .as_array()
            .expect("tool_calls was checked as an array")
            .iter()
            .enumerate()
            .map(|(index, call)| {
                let mut call = call.clone();
                if let Some(fields) = call.as_object_mut() {
                    fields.insert("index".to_string(), json!(index));
                }
                call
            })
            .collect::<Vec<_>>();
        let chunk = json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": Value::Null, "tool_calls": indexed_tool_calls}, "finish_reason": Value::Null}]
        });
        format!(
            "data: {chunk}\n\n{}",
            sse_end(id, created, model, finish_reason)
        )
    } else {
        format!(
            "{}{}",
            sse_delta(id, created, model, content),
            sse_end(id, created, model, finish_reason)
        )
    }
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
        .unwrap_or(600)
        .clamp(5, 900);
    Duration::from_secs(seconds)
}

pub fn max_active_chat_requests_from_env() -> usize {
    std::env::var("MUNDUSX_CHAT_MAX_ACTIVE_WEIGHT")
        .or_else(|_| std::env::var("MUNDUSX_CHAT_MAX_ACTIVE_REQUESTS"))
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_ACTIVE_CHAT_WEIGHT)
        .clamp(1, 64)
}

pub fn graph_admission_weight(job: &JobRecord) -> usize {
    if !job.graph_execution_enabled || job.graph.nodes.is_empty() {
        return 1;
    }

    let mut depths = BTreeMap::<String, usize>::new();
    for _ in 0..job.graph.nodes.len() {
        let mut changed = false;
        for node in &job.graph.nodes {
            let depth = node
                .depends_on
                .iter()
                .map(|dependency| depths.get(dependency).copied().unwrap_or(0) + 1)
                .max()
                .unwrap_or(0);
            if depths.get(&node.id).copied() != Some(depth) {
                depths.insert(node.id.clone(), depth);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let mut width_by_depth = BTreeMap::<usize, usize>::new();
    for node in &job.graph.nodes {
        let depth = depths.get(&node.id).copied().unwrap_or(0);
        *width_by_depth.entry(depth).or_default() += 1;
    }
    width_by_depth.values().copied().max().unwrap_or(1).max(1)
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
        ChatAdmissionController, LiveStreamRegistry, PushDeltaResult,
    };
    use crate::tools::{ToolAnswer, ToolSource};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn parent_chat_admission_caps_active_requests_and_queues_fifo() {
        let admission = Arc::new(ChatAdmissionController::new(7));
        let mut permits = (0..7)
            .map(|_| admission.acquire(|| Ok(())).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(admission.snapshot().active, 7);
        assert!(admission.try_acquire().unwrap().is_none());

        let (acquired_tx, acquired_rx) = mpsc::channel();
        let first_admission = Arc::clone(&admission);
        let first_tx = acquired_tx.clone();
        let first_waiter = thread::spawn(move || {
            let permit = first_admission.acquire(|| Ok(())).unwrap();
            first_tx.send(1_u8).unwrap();
            permit
        });

        for _ in 0..100 {
            if admission.snapshot().queued == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(admission.snapshot().queued, 1);
        assert!(acquired_rx.try_recv().is_err());

        let second_admission = Arc::clone(&admission);
        let second_waiter = thread::spawn(move || {
            let permit = second_admission.acquire(|| Ok(())).unwrap();
            acquired_tx.send(2_u8).unwrap();
            permit
        });
        for _ in 0..100 {
            if admission.snapshot().queued == 2 {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(admission.snapshot().queued, 2);

        drop(permits.pop().unwrap());
        assert_eq!(acquired_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        let first_permit = first_waiter.join().unwrap();
        assert_eq!(admission.snapshot().active, 7);
        assert_eq!(admission.snapshot().queued, 1);

        drop(permits.pop().unwrap());
        assert_eq!(acquired_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 2);
        let second_permit = second_waiter.join().unwrap();
        assert_eq!(admission.snapshot().active, 7);
        assert_eq!(admission.snapshot().queued, 0);

        drop(first_permit);
        drop(second_permit);
        drop(permits);
    }

    #[test]
    fn disconnected_queued_chat_is_removed_without_consuming_a_slot() {
        let admission = Arc::new(ChatAdmissionController::new(1));
        let active = admission.acquire(|| Ok(())).unwrap();
        let waiting_admission = Arc::clone(&admission);
        let waiter = thread::spawn(move || {
            waiting_admission.acquire_with_interval(
                || Err("client disconnected".to_string()),
                Duration::from_millis(5),
            )
        });

        let error = match waiter.join().unwrap() {
            Ok(_) => panic!("disconnected queued request must not be admitted"),
            Err(error) => error,
        };
        assert_eq!(error, "client disconnected");
        assert_eq!(admission.snapshot().active, 1);
        assert_eq!(admission.snapshot().queued, 0);
        drop(active);
    }

    #[test]
    fn weighted_admission_accounts_for_graph_width_and_preserves_fifo() {
        let admission = Arc::new(ChatAdmissionController::new(5));
        let wide = admission
            .try_acquire_weighted(4)
            .unwrap()
            .expect("wide graph admitted");
        assert_eq!(admission.snapshot().active, 1);
        assert_eq!(admission.snapshot().active_weight, 4);
        assert!(admission.try_acquire_weighted(2).unwrap().is_none());

        let direct = admission
            .try_acquire_weighted(1)
            .unwrap()
            .expect("one remaining unit admits direct work");
        assert_eq!(admission.snapshot().active_weight, 5);
        drop(direct);

        let waiting_admission = Arc::clone(&admission);
        let waiter = thread::spawn(move || {
            waiting_admission
                .acquire_weighted(2, || Ok(()))
                .expect("queued graph admitted")
        });
        for _ in 0..100 {
            if admission.snapshot().queued == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(admission.snapshot().queued_weight, 2);
        drop(wide);
        let queued = waiter.join().unwrap();
        assert_eq!(admission.snapshot().active_weight, 2);
        drop(queued);
    }

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
        let start = sse_start("chatcmpl-test", 1, "mundusx-agnostic", false, "resume-test");
        let finish = sse_finish(&completion);
        assert!(start.starts_with("HTTP/1.1 200 OK"));
        assert!(start.contains("Content-Type: text/event-stream"));
        assert!(!start.contains("data:"));
        assert!(finish.contains("\"role\":\"assistant\""));
        assert!(finish.contains("\"delta\":{\"content\":\"Done.\",\"role\":\"assistant\"}"));
        assert!(finish.contains("data: [DONE]"));
    }

    #[test]
    fn preserves_native_tool_calls_in_completion_and_sse() {
        let native = concat!(
            "__MUNDUSX_OPENAI_TOOL_RESULT_V1__",
            r#"{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"search_files","arguments":"{\"pattern\":\"*.java\"}"}}]},"finish_reason":"tool_calls"}"#
        );
        let completion = completion_response(
            "chatcmpl-tools",
            1,
            "mundusx-agnostic",
            native,
            "stop",
            None,
            None,
        );
        assert_eq!(completion["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(
            completion["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "search_files"
        );
        let stream = sse_finish(&completion);
        assert!(stream.contains("\"tool_calls\""));
        assert!(stream.contains("\"index\":0"));
        assert!(stream.contains("\"finish_reason\":\"tool_calls\""));
        assert!(stream.ends_with("data: [DONE]\n\n"));
    }

    #[test]
    fn normalizes_native_tool_call_finish_reason() {
        let native = concat!(
            "__MUNDUSX_OPENAI_TOOL_RESULT_V1__",
            r#"{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"terminal","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"stop"}"#
        );
        let completion = completion_response(
            "chatcmpl-tools",
            1,
            "mundusx-agnostic",
            native,
            "stop",
            None,
            None,
        );

        assert_eq!(completion["choices"][0]["finish_reason"], "tool_calls");
        let stream = sse_finish(&completion);
        assert!(
            stream.contains("\"delta\":{\"content\":null,\"role\":\"assistant\",\"tool_calls\"")
        );
        assert!(stream.contains("\"index\":0"));
        assert!(!stream.contains("__MUNDUSX_OPENAI_TOOL_RESULT_V1__"));
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
        let start = sse_start("chatcmpl-live", 1, "mundusx-agnostic", true, "resume-live");
        assert!(start.contains("X-MundusX-Stream-Mode: live-delta"));
        assert!(start.contains("X-MundusX-Completion-Id: chatcmpl-live"));
        assert!(start.contains("X-MundusX-Resume-Token: resume-live"));
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
