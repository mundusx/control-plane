use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RuntimeTokenUsage {
    pub call_id: String,
    pub completion_tokens: u64,
    pub prompt_tokens: Option<u64>,
    pub source: String,
}

pub fn measured_totals(records: &[RuntimeTokenUsage]) -> Option<(u64,u64)> {
    if records.is_empty() { return None; }
    let mut input=0u64;
    let mut output=0u64;
    for record in records {
        input=input.checked_add(record.prompt_tokens?)?;
        output=output.checked_add(record.completion_tokens)?;
    }
    Some((input,output))
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
    fn credit_token_totals_require_complete_usage_and_sum_each_call_once() {
        let call=|input,output|super::RuntimeTokenUsage{call_id:String::new(),prompt_tokens:input,completion_tokens:output,source:"runtime".into()};
        assert_eq!(super::measured_totals(&[]),None);
        assert_eq!(super::measured_totals(&[call(None,1000)]),None);
        assert_eq!(super::measured_totals(&[call(Some(20),1000),call(None,10)]),None);
        let (input,output)=super::measured_totals(&[call(Some(200),1000),call(Some(0),50)]).unwrap();
        assert_eq!((input+output).div_ceil(100),13);
        assert_eq!(super::measured_totals(&[call(Some(0),0)]),Some((0,0)));
        for (total,expected) in [(1u64,1u64),(100,1),(101,2),(1_000_020,10_001)] {
            let (input,output)=super::measured_totals(&[call(Some(20.min(total)),total-20.min(total))]).unwrap();
            assert_eq!((input+output).div_ceil(100),expected);
        }
    }
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
