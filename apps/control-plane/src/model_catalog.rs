use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Catalog {
    pub version: u32,
    pub revision: u64,
    pub entries: Vec<Entry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub enabled: bool,
    pub model: Value,
}

impl Default for Catalog {
    fn default() -> Self {
        serde_json::from_str(include_str!("../config/model-catalog.json")).expect("bundled model catalog")
    }
}

impl Catalog {
    pub fn names(&self) -> Vec<String> {
        let mut names = self.entries.iter().filter(|entry| entry.enabled)
            .filter_map(|entry| entry.model["name"].as_str().map(str::to_string)).collect::<Vec<_>>();
        names.sort(); names.dedup(); names
    }

    pub fn public(&self) -> Value {
        let models = self.entries.iter().filter(|entry| entry.enabled).map(|entry| entry.model.clone()).collect::<Vec<_>>();
        let presets = models.iter().flat_map(|model| {
            model["backend_compatibility"].as_array().into_iter().flatten().map(move |backend|
                json!({"backend":backend,"min_memory_gb":0,"max_memory_gb":999,"lighter":model,"recommended":model}))
        }).collect::<Vec<_>>();
        json!({"version":self.version,"revision":self.revision,"models":models,"presets":presets})
    }

    pub fn upsert(&mut self, entry: Entry, revision: u64) -> Result<(), String> {
        if revision != self.revision { return Err("Catalog changed. Reload before saving.".into()); }
        validate(&entry)?;
        if let Some(existing) = self.entries.iter_mut().find(|existing| existing.id == entry.id) {
            *existing = entry;
        } else {
            if self.entries.len() >= 500 { return Err("Catalog entry limit reached.".into()); }
            self.entries.push(entry);
        }
        self.revision += 1;
        Ok(())
    }
}

pub fn validate(entry: &Entry) -> Result<(), String> {
    let model = &entry.model;
    if entry.id.is_empty() || entry.id.len() > 100 || !entry.id.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)) {
        return Err("Use a stable entry ID containing letters, numbers, underscores or hyphens.".into());
    }
    for field in ["name", "label", "source_url", "source_kind"] {
        if model[field].as_str().is_none_or(|value| value.trim().is_empty() || value.len() > 2048 || value.chars().any(char::is_control)) {
            return Err(format!("Invalid {field}."));
        }
    }
    for field in ["notes", "sha256"] {
        if model[field].as_str().is_none_or(|value| value.len() > 4096) { return Err(format!("Invalid {field}.")); }
    }
    let source = model["source_url"].as_str().unwrap();
    if !source.starts_with("https://huggingface.co/") || source.contains(['?', '#', '\\']) {
        return Err("Use a public https://huggingface.co/ model or artifact URL without credentials or query parameters.".into());
    }
    let kind = model["source_kind"].as_str().unwrap();
    if !["huggingface-open", "huggingface-mlx", "huggingface-vllm", "huggingface-diffusion"].contains(&kind) {
        return Err("Unsupported model source kind.".into());
    }
    if kind == "huggingface-diffusion" && (model["format"] != "sd15-safetensors"
        || model["capabilities"]["task_capabilities"] != json!(["text_to_image"])
        || model["capabilities"]["supports_tools"] == true
        || model["capabilities"]["supports_embeddings"] == true) {
        return Err("Diffusion checkpoints require sd15-safetensors format and text_to_image capability only.".into());
    }
    let systems = model["supported_os"].as_array().ok_or("Select supported operating systems.")?;
    if systems.is_empty() || systems.iter().any(|os| !matches!(os.as_str(), Some("windows"|"macos"|"linux"))) {
        return Err("Invalid operating systems.".into());
    }
    if systems.iter().any(|os| match kind {
        "huggingface-mlx" => os != "macos",
        "huggingface-vllm" => os != "linux",
        _ => os == "macos",
    }) { return Err("Use MLX for macOS, vLLM for Linux, and GGUF for Windows/Linux.".into()); }
    if matches!(kind, "huggingface-open" | "huggingface-diffusion") && model["sha256"].as_str().is_none_or(|s| s.len()!=64 || !s.bytes().all(|c| c.is_ascii_hexdigit())) {
        return Err("Single-file downloads require a 64-character SHA-256 checksum.".into());
    }
    if model["estimated_vram_mb"].as_u64().is_none_or(|n| n == 0 || n > 10_000_000) {
        return Err("Specify a positive estimated model memory requirement in MB.".into());
    }
    let backends = model["backend_compatibility"].as_array().ok_or("Select compatible backends.")?;
    if backends.is_empty() || backends.iter().any(|b| !matches!(b.as_str(), Some("auto"|"m"|"cuda"|"vulkan"|"vllm"))) {
        return Err("Invalid compatible backends.".into());
    }
    for field in ["supports_vision", "supports_embeddings", "supports_tools"] {
        if model["capabilities"].get(field).is_some_and(|value| !value.is_boolean()) { return Err(format!("Invalid {field}.")); }
    }
    if let Some(tasks) = model["capabilities"].get("task_capabilities") {
        if tasks.as_array().is_none_or(|tasks| tasks.len()>30 || tasks.iter().any(|task| task.as_str().is_none_or(|s| s.len()>80 || s.is_empty()))) {
            return Err("Invalid task capabilities.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diffusion_catalog_cannot_claim_chat_or_tools() {
        let mut entry: Entry = serde_json::from_str(include_str!("../../../docs/dreamshaper-8-catalog-entry.json")).unwrap();
        assert!(validate(&entry).is_ok());
        entry.model["capabilities"]["task_capabilities"] = json!(["chat"]);
        assert!(validate(&entry).is_err());
        entry.model["capabilities"]["task_capabilities"] = json!(["text_to_image"]);
        entry.model["capabilities"]["supports_tools"] = json!(true);
        assert!(validate(&entry).is_err());
    }
    #[test]
    fn catalog_preserves_vision_and_excludes_disabled_models() {
        let mut catalog = Catalog::default();
        assert!(catalog.entries.iter().all(|entry| validate(entry).is_ok()));
        let glimmer = catalog.entries.iter().find(|e| e.model["name"] == "RedHatAI/Muse-Glimmer-30B-FP8-block").unwrap();
        assert_eq!(glimmer.model["capabilities"]["supports_vision"], true);
        for entry in &mut catalog.entries { entry.enabled = false; }
        assert_eq!(catalog.public()["models"], json!([]));
        assert_eq!(catalog.public()["presets"], json!([]));
    }
    #[test]
    fn catalog_rejects_conflicts_and_unsafe_downloads() {
        let mut catalog = Catalog::default();
        let mut entry = catalog.entries[0].clone();
        assert!(catalog.upsert(entry.clone(), 99).is_err());
        entry.model["source_url"] = json!("http://localhost/secret");
        assert!(catalog.upsert(entry, 0).is_err());
        assert_eq!(catalog.revision, 0);
    }
}
