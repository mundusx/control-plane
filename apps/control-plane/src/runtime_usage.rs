use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RuntimeTokenUsage {
    pub call_id: String,
    pub completion_tokens: u64,
    pub prompt_tokens: Option<u64>,
    pub source: String,
}

pub fn parse(body: &str) -> Result<Vec<RuntimeTokenUsage>, String> {
    let payload: serde_json::Value=serde_json::from_str(body).map_err(|e|e.to_string())?;
    let Some(value)=payload.get("token_usage") else {return Ok(Vec::new());};
    let records:Vec<RuntimeTokenUsage>=serde_json::from_value(value.clone()).map_err(|e|e.to_string())?;
    if records.len()>64 {return Err("Too many runtime usage records".into());}
    let mut ids=std::collections::BTreeSet::new();
    for r in &records {
        if uuid::Uuid::parse_str(&r.call_id).is_err() || !ids.insert(r.call_id.clone())
            || r.source!="runtime" || r.completion_tokens>1_000_000_000
            || r.prompt_tokens.is_some_and(|n|n>1_000_000_000) {
            return Err("Invalid measured runtime usage".into());
        }
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_runtime_counts_are_measured_and_missing_usage_stays_unknown() {
        assert!(super::parse("{}").unwrap().is_empty());
        let id=uuid::Uuid::new_v4().to_string();
        let body=serde_json::json!({"token_usage":[{"call_id":id,"completion_tokens":123,"prompt_tokens":20,"source":"runtime"}]}).to_string();
        assert_eq!(super::parse(&body).unwrap()[0].completion_tokens,123);
        assert!(super::parse(&body.replace("runtime","estimated")).is_err());
        assert!(super::parse(&body.replace("123","-1")).is_err());
    }
}
