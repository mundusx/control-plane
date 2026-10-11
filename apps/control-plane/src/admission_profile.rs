//! Predefined starting classifications; these are estimates, not benchmark scores.
use crate::contracts::{ModelCapability, NodeRecord};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AdmissionProfile {
    pub source: String,
    pub node_class: String,
    pub model_class: String,
    pub context_tokens: u32,
    pub estimated_model_memory_mb: Option<u32>,
    pub max_parallel_jobs: u32,
    pub capabilities: Vec<String>,
}

impl AdmissionProfile {
    pub fn detected(node: &NodeRecord, model: &ModelCapability) -> Self {
        let memory = node.worker_health.as_ref().and_then(|h| h.capabilities.usable_memory_mb).unwrap_or(0);
        let (node_class, context) = match memory {
            0..=8191 => ("compact", 2048), 8192..=16383 => ("standard", 4096),
            16384..=65535 => ("workstation", 8192), _ => ("large_memory", 16384),
        };
        let name = model.name.rsplit(['/', '\\']).next().unwrap_or(&model.name).to_ascii_lowercase();
        let expert = name.starts_with("qwen3-coder-30b-") && name.contains("instruct");
        let family = name == "qwen3-coder";
        let standard = ["qwen2.5-coder-7b-", "qwen2.5-coder-14b-", "qwen2.5-coder-32b-"].iter().any(|prefix|name.starts_with(prefix)) && name.contains("instruct");
        let basic = ["qwen2.5-coder-0.5b-", "qwen2.5-coder-1.5b-", "qwen2.5-coder-3b-"].iter().any(|prefix|name.starts_with(prefix)) && name.contains("instruct");
        let quant = model.quantization.as_deref().filter(|q|!q.trim().is_empty()).unwrap_or(&name).to_ascii_lowercase().replace('-', "");
        let parameters = if expert {Some(30.5)} else if standard || basic {
            [0.5, 1.5, 3.0, 7.0, 14.0, 32.0].into_iter().find(|n|name.starts_with(&format!("qwen2.5-coder-{n}b-")))
        } else {None};
        let per_billion = if quant.contains("4bit") || quant.contains("int4") || quant.contains("q4") {640.0}
            else if quant.contains("5bit") || quant.contains("q5") {750.0}
            else if quant.contains("6bit") || quant.contains("q6") {850.0}
            else if quant.contains("8bit") || quant.contains("fp8") || quant.contains("q8") {1100.0} else {2200.0};
        let estimate = parameters.map(|n|(n*per_billion) as u32);
        let weight = model.estimated_vram_mb.filter(|n|*n>0).or(estimate);
        let headroom = memory.saturating_sub(weight.unwrap_or(0));
        let memory_context = match headroom {0..=8191=>2048,8192..=16383=>4096,16384..=65535=>8192,_=>16384};
        let mut capabilities = vec!["chat".into()];
        // Managed MLX calculates this ceiling from cached architecture, actual
        // weight bytes, contribution budget, KV precision and parallel slots.
        // Served vLLM contexts are read from its runtime metadata. A catalog
        // tier must not replace those bounded runtime contracts with 8K.
        let runtime_context = node.worker_health.as_ref()
            .filter(|h| matches!(h.runtime_mode.as_str(), "mlx" | "vllm"))
            .filter(|_| model.output_capacity_mode.as_deref() == Some("context_window"))
            .and(model.context_tokens.filter(|n| *n >= 1024));
        let limit = runtime_context.unwrap_or_else(|| model.context_tokens.unwrap_or(2048).min(context).min(memory_context).min(if family {4096} else if expert || standard || basic {16384} else {2048}));
        if expert || standard || basic || family {
            capabilities.extend(["coding", "coding_basic", "small_coding"].map(String::from));
            if !basic && limit >= 4096 { capabilities.push("medium_coding".into()); }
            if expert && limit >= 8192 { capabilities.push("large_coding".into()); }
        }
        Self { source:if runtime_context.is_some() {"runtime_metadata"} else {"predefined_estimate"}.into(), node_class:node_class.into(),
            model_class:if expert {"coding_expert"} else if family {"coding_family"} else if standard {"coding_standard"} else if basic {"coding_basic"} else {"general_chat"}.into(),
            context_tokens:limit, estimated_model_memory_mb:weight, max_parallel_jobs:1, capabilities }
    }
}
