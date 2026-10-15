//! Catalog estimates and operator limits. No jobs or model tests are launched.
use crate::contracts::{ModelCapability, NodeRecord, NodeRole};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const TASKS: &[&str] = &[
    "chat",
    "coding",
    "coding_basic",
    "small_coding",
    "medium_coding",
    "large_coding",
    "math",
    "reasoning",
    "research",
    "synthesizer",
    "tool_use",
    "native_tool_calls_v1",
    "vision",
    "embedding",
    "long_context",
];

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub allowed_capabilities: Option<Vec<String>>,
    pub max_context_tokens: Option<u32>,
    pub max_parallel_jobs: Option<u32>,
    pub allow_tools: Option<bool>,
    pub allow_streaming: Option<bool>,
    pub reason: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Override {
    pub settings: Settings,
    pub actor: String,
    pub updated_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub node_id: String,
    pub policy: Option<Settings>,
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if self.reason.trim().is_empty() || self.reason.len() > 512 {
            return Err("Provide a reason of 1–512 characters".into());
        }
        if self.allowed_capabilities.as_ref().is_some_and(|tasks| {
            tasks.len() > TASKS.len() || tasks.iter().any(|t| !TASKS.contains(&t.as_str()))
        }) {
            return Err("Unknown capability".into());
        }
        if self
            .max_context_tokens
            .is_some_and(|n| !(512..=2_097_152).contains(&n))
        {
            return Err("Context limit must be 512–2097152 tokens".into());
        }
        if self
            .max_parallel_jobs
            .is_some_and(|n| !(1..=64).contains(&n))
        {
            return Err("Parallel jobs must be 1–64".into());
        }
        Ok(())
    }
}

pub fn role_capability(role: &NodeRole) -> &'static str {
    match role {
        NodeRole::Coding => "coding",
        NodeRole::ToolUse => "tool_use",
        NodeRole::Vision => "vision",
        NodeRole::Embedding => "embedding",
        NodeRole::ChunkAnalysis => "research",
        NodeRole::Reducer | NodeRole::Synthesizer => "synthesizer",
        _ => "chat",
    }
}
fn claims(node: &NodeRecord, model: &ModelCapability) -> BTreeSet<String> {
    let mut tasks = model
        .task_capabilities
        .iter()
        .chain(model.capability_scores.iter().map(|s| &s.capability))
        .map(|t| {
            if t == "embeddings" {
                "embedding".into()
            } else {
                t.to_ascii_lowercase()
            }
        })
        .collect::<BTreeSet<_>>();
    let roles = if model.roles.is_empty() {
        node.worker_health.as_ref().map(|h| &h.capabilities.roles)
    } else {
        Some(&model.roles)
    };
    if let Some(roles) = roles {
        for role in roles {
            tasks.insert(role_capability(role).into());
        }
    }
    if tasks.contains("large_coding") {
        tasks.insert("medium_coding".into());
    }
    if tasks.contains("coding_basic")
        || tasks.contains("small_coding")
        || tasks.contains("medium_coding")
        || tasks.contains("large_coding")
    {
        tasks.insert("coding".into());
    }
    if tasks.contains("coding") {
        tasks.extend(["coding_basic", "small_coding"].map(String::from));
    }
    if model.supports_tools
        && node.worker_health.as_ref().is_some_and(|h| {
            h.capabilities.supports_tools
                && h.capabilities
                    .supported_tools
                    .iter()
                    .any(|t| t == "native_tool_calls_v1")
        })
    {
        tasks.extend(["tool_use", "native_tool_calls_v1"].map(String::from));
    }
    if model.supports_vision
        && node
            .worker_health
            .as_ref()
            .is_some_and(|h| h.capabilities.supports_vision)
    {
        tasks.insert("vision".into());
    }
    if model.supports_embeddings
        && node
            .worker_health
            .as_ref()
            .is_some_and(|h| h.capabilities.supports_embeddings)
    {
        tasks.insert("embedding".into());
    }
    if model.context_tokens.is_some_and(|n| n >= 8192) {
        tasks.insert("long_context".into());
    }
    tasks
}

pub fn advertised_model(node: &NodeRecord, reported: &ModelCapability) -> ModelCapability {
    if !node.trust.capability_policy_enabled {
        return reported.clone();
    }
    let profile = crate::admission_profile::AdmissionProfile::detected(node, reported);
    let settings = node.trust.capability_policy.as_ref().map(|p| &p.settings);
    let mut allowed = profile
        .capabilities
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if profile.model_class != "general_chat" {
        allowed.insert("math".into());
        if profile.model_class != "coding_basic" {
            allowed.extend(["reasoning", "research", "synthesizer"].map(String::from));
        }
    }
    // Discrete CUDA cards use their VRAM tier for coding size; unified-memory
    // MLX/GB10 contributors keep their usable-memory tier.
    if node.backend == crate::contracts::Backend::Cuda {
        if let Some(vram) = node
            .worker_health
            .as_ref()
            .and_then(|h| h.capabilities.total_vram_mb)
        {
            let vram =
                (u64::from(vram) * u64::from(node.contribution_percent.min(100)) / 100) as u32;
            if vram < 12288 {
                allowed.remove("medium_coding");
            }
            if vram < 24576 {
                allowed.remove("large_coding");
            }
        }
    }
    allowed.extend(
        [
            "tool_use",
            "native_tool_calls_v1",
            "vision",
            "embedding",
            "long_context",
        ]
        .map(String::from),
    );
    if let Some(tasks) = settings.and_then(|p| p.allowed_capabilities.as_ref()) {
        allowed = tasks.iter().cloned().collect();
        if allowed
            .iter()
            .any(|c| ["small_coding", "medium_coding", "large_coding"].contains(&c.as_str()))
        {
            allowed.insert("coding".into());
        }
        if allowed.contains("coding") {
            allowed.extend(["coding_basic", "small_coding"].map(String::from));
        }
    }
    let claims = claims(node, reported);
    let mut model = reported.clone();
    model.task_capabilities = allowed.intersection(&claims).cloned().collect();
    let limit = settings
        .and_then(|p| p.max_context_tokens)
        .unwrap_or(profile.context_tokens);
    model.context_tokens = Some(
        reported
            .context_tokens
            .unwrap_or(profile.context_tokens)
            .min(limit),
    );
    if model.context_tokens.is_none_or(|n| n < 8192) {
        model.task_capabilities.retain(|c| c != "long_context");
    }
    model.supports_tools = reported.supports_tools
        && claims.contains("native_tool_calls_v1")
        && allowed.contains("tool_use")
        && settings.and_then(|p| p.allow_tools) != Some(false);
    if !model.supports_tools {
        model
            .task_capabilities
            .retain(|c| !["tool_use", "native_tool_calls_v1"].contains(&c.as_str()));
    }
    model.supports_vision =
        reported.supports_vision && model.task_capabilities.iter().any(|c| c == "vision");
    model.supports_embeddings =
        reported.supports_embeddings && model.task_capabilities.iter().any(|c| c == "embedding");
    let scored = model.clone();
    model
        .capability_scores
        .retain(|c| allows(&scored, &c.capability));
    model.roles.retain(|r| {
        model
            .task_capabilities
            .iter()
            .any(|c| c == role_capability(r))
    });
    model
}

pub fn streaming_allowed(node: &NodeRecord) -> bool {
    !node.trust.capability_policy_enabled
        || node
            .trust
            .capability_policy
            .as_ref()
            .and_then(|p| p.settings.allow_streaming)
            != Some(false)
}
pub fn parallel_limit(node: &NodeRecord, reported: usize) -> usize {
    if !node.trust.capability_policy_enabled {
        return reported;
    }
    reported.min(
        node.trust
            .capability_policy
            .as_ref()
            .and_then(|p| p.settings.max_parallel_jobs)
            .map(|limit| limit as usize)
            .unwrap_or(reported),
    )
}
pub fn allows(model: &ModelCapability, capability: &str) -> bool {
    match capability {
        "logic" => allows(model, "reasoning"),
        "historical_research" | "factual_retrieval" => allows(model, "research"),
        "summarization" => {
            allows(model, "synthesizer") || allows(model, "research") || allows(model, "chat")
        }
        "synthesis" => allows(model, "synthesizer") || allows(model, "reasoning"),
        "translation" => allows(model, "chat"),
        "native_tool_calls_v1" | "tool_use" => model.supports_tools,
        "vision" => model.supports_vision,
        "embedding" | "embeddings" => model.supports_embeddings,
        _ => model.task_capabilities.iter().any(|c| c == capability),
    }
}

/// Client-facing snapshots expose effective limits without mutating raw inventory.
pub fn public_node(node: &NodeRecord) -> serde_json::Value {
    let mut value = serde_json::to_value(node).expect("node JSON");
    if !node.trust.capability_policy_enabled
        || node
            .worker_health
            .as_ref()
            .is_some_and(|h| h.runtime_mode == "media")
    {
        return value;
    }
    let models = crate::state::ControlPlaneState::model_inventory(node)
        .iter()
        .map(|m| advertised_model(node, m))
        .collect::<Vec<_>>();
    let context = models.iter().filter_map(|m| m.context_tokens).max();
    let tools = models.iter().any(|m| m.supports_tools);
    let vision = models.iter().any(|m| m.supports_vision);
    let embeddings = models.iter().any(|m| m.supports_embeddings);
    let roles = node
        .worker_health
        .as_ref()
        .map(|h| {
            h.capabilities
                .roles
                .iter()
                .filter(|r| models.iter().any(|m| allows(m, role_capability(r))))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let supported_tools = node
        .worker_health
        .as_ref()
        .map(|h| {
            h.capabilities
                .supported_tools
                .iter()
                .filter(|t| models.iter().any(|m| allows(m, t)))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    value["reported_worker_health"] = value["worker_health"].clone();
    value["reported_capabilities"] = value["capabilities"].clone();
    let slots = crate::state::ControlPlaneState::node_runtime_parallel_capacity(node);
    if let Some(health) = value["worker_health"].as_object_mut() {
        health.insert(
            "streaming_supported".into(),
            serde_json::json!(
                node.worker_health
                    .as_ref()
                    .is_some_and(|h| h.streaming_supported)
                    && streaming_allowed(node)
            ),
        );
        health.insert("parallel_slots".into(), serde_json::json!(slots));
        if let Some(caps) = health
            .get_mut("capabilities")
            .and_then(serde_json::Value::as_object_mut)
        {
            caps.insert("models".into(), serde_json::json!(models));
            caps.insert("max_context_tokens".into(), serde_json::json!(context));
            caps.insert("supports_tools".into(), serde_json::json!(tools));
            caps.insert("supports_vision".into(), serde_json::json!(vision));
            caps.insert("supports_embeddings".into(), serde_json::json!(embeddings));
            caps.insert("max_parallel_jobs".into(), serde_json::json!(slots));
            caps.insert("roles".into(), serde_json::json!(roles));
            caps.insert("supported_tools".into(), serde_json::json!(supported_tools));
            caps.insert(
                "skill_tags".into(),
                serde_json::json!(models
                    .iter()
                    .flat_map(|m| m.task_capabilities.iter())
                    .collect::<BTreeSet<_>>()),
            );
        }
    }
    if let Some(caps) = value["capabilities"].as_object_mut() {
        caps.insert("models".into(), serde_json::json!(models));
        caps.insert("max_context_tokens".into(), serde_json::json!(context));
        caps.insert(
            "active_model".into(),
            serde_json::json!(models.iter().find(|m| m.active).or_else(|| models.first())),
        );
        caps.insert("parallel_slots".into(), serde_json::json!(slots));
        caps.insert("supported_roles".into(), serde_json::json!(roles));
        caps.insert("supported_tools".into(), serde_json::json!(supported_tools));
    }
    if models.iter().all(|m| m.task_capabilities.is_empty()) {
        value["policy_allowed"] = serde_json::json!(false);
        value["policy_reason"] = serde_json::json!("Capability policy has no allowed tasks");
    }
    value
}
