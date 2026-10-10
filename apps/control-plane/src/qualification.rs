//! Control-plane-issued smoke tests. Advertisements never count as test results.
use crate::contracts::{JobRecord, ModelCapability, NodeRecord};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MODE: &str = "contributor_qualification_v1";
pub const SUITE: u32 = 5;
pub fn context_answer(nonce:&str)->String {
    let middle=hex::encode(Sha256::digest(format!("middle:{nonce}").as_bytes()));
    let end=hex::encode(Sha256::digest(format!("end:{nonce}").as_bytes()));
    format!("{nonce}|{}|{}",&middle[..32],&end[..32])
}

#[derive(Clone, Debug, Eq, PartialEq, Default, Serialize, Deserialize)]
pub struct Qualification {
    #[serde(default)]
    pub admission_profile: Option<crate::admission_profile::AdmissionProfile>,
    pub fingerprint: String,
    pub model: String,
    pub runtime: String,
    pub quantization: Option<String>,
    pub physical_memory_mb: Option<u32>,
    pub usable_memory_mb: Option<u32>,
    pub total_vram_mb: Option<u32>,
    pub configured_context_tokens: u32,
    pub tested_context_tokens: Option<u32>,
    pub created_at: String,
    pub probes: Vec<Probe>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Probe {
    pub kind: String,
    pub job_id: String,
    pub nonce: String,
    pub status: String,
    pub reason: Option<String>,
    pub stream_observed: bool,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub elapsed_ms: Option<u64>,
    pub completed_at: Option<String>,
}

pub fn fingerprint(node: &NodeRecord, model: &ModelCapability) -> String {
    fingerprint_for_suite(node,model,SUITE)
}
pub fn legacy_fingerprint(node: &NodeRecord, model: &ModelCapability) -> String {
    fingerprint_for_suite(node,model,4)
}
fn fingerprint_for_suite(node: &NodeRecord, model: &ModelCapability, suite: u32) -> String {
    let health = node.worker_health.as_ref().expect("healthy model inventory");
    let raw = json!([suite, node.public_key_fingerprint, node.public_key_hex,
        node.backend.to_string(), node.agent_version, health.runtime_mode,
        health.model_path, model.name, model.quantization, model.context_tokens,
        model.max_output_tokens, model.output_capacity_mode,
        health.capabilities.physical_memory_mb, health.capabilities.usable_memory_mb,
        health.capabilities.total_vram_mb, health.parallel_slots,
        health.capabilities.max_num_seqs, health.capabilities.kv_cache_size_tokens,
        node.capability_fabric_version, model.supports_tools, model.supports_vision, health.streaming_supported]);
    hex::encode(Sha256::digest(raw.to_string().as_bytes()))
}

impl Qualification {
    pub fn detected(node: &NodeRecord, model: &ModelCapability, now: &str) -> Self {
        let health = node.worker_health.as_ref().unwrap();
        // A starting configuration, not a hardware-derived quality score.
        let budget = match health.capabilities.usable_memory_mb.unwrap_or(0) {
            0..=8191 => 2048, 8192..=16383 => 4096, 16384..=32767 => 8192, _ => 16384,
        };
        let context = model.context_tokens.unwrap_or(2048).min(budget);
        let mut kinds = vec!["chat"];
        if model.supports_tools { kinds.extend(["native_tools", "tool_result"]); }
        kinds.extend(["context", "coding_basic"]);
        let coding = model.name.to_ascii_lowercase().contains("coder") || model.task_capabilities.iter().any(|c| c.contains("coding"));
        if coding && context >= 4096 { kinds.push("coding_medium"); }
        if coding && context >= 8192 { kinds.push("coding_large"); }
        if model.supports_vision { kinds.push("vision"); }
        if health.streaming_supported { kinds.push("streaming"); }
        let probes = kinds.into_iter().map(|kind| Probe {
            kind: kind.into(), job_id: format!("qualification-{}", uuid::Uuid::new_v4()),
            nonce: uuid::Uuid::new_v4().simple().to_string(), status: "pending".into(),
            reason: None, stream_observed: false, prompt_tokens: None,
            completion_tokens: None, elapsed_ms: None, completed_at: None,
        }).collect();
        Self { admission_profile:Some(crate::admission_profile::AdmissionProfile::detected(node, model)), fingerprint: fingerprint(node, model), model: model.name.clone(),
            runtime: health.runtime_mode.clone(), quantization: model.quantization.clone(),
            physical_memory_mb: health.capabilities.physical_memory_mb,
            usable_memory_mb: health.capabilities.usable_memory_mb,
            total_vram_mb: health.capabilities.total_vram_mb,
            configured_context_tokens: context, created_at: now.into(), probes,
            ..Self::default() }
    }

    pub fn passed(&self, kind: &str) -> bool {
        self.probes.iter().any(|p| p.kind == kind && p.status == "passed")
    }
    fn failed(&self, kind: &str) -> bool { self.probes.iter().any(|p| p.kind == kind && p.status == "failed") }
    pub fn context_limit(&self) -> Option<u32> {
        self.tested_context_tokens.or_else(|| self.admission_profile.as_ref().filter(|_| self.passed("chat"))
            .map(|p| if self.failed("context") {p.context_tokens.min(1024)} else {p.context_tokens.min(self.configured_context_tokens)}))
    }
    pub fn streaming_ready(&self) -> bool {
        self.passed("streaming") || self.probes.iter().any(|p|p.kind=="chat" && p.status=="passed" && p.stream_observed)
    }
    fn predefined(&self, capability: &str) -> bool {
        self.passed("chat") && self.admission_profile.as_ref().is_some_and(|p|p.capabilities.iter().any(|c|c==capability))
    }
    pub fn status(&self) -> &'static str {
        if self.passed("chat") && self.admission_profile.is_some() && self.probes.iter().any(|p|p.status=="pending") { "admitted" }
        else if self.probes.iter().any(|p| p.status == "pending") { "testing" }
        else if !self.passed("chat") { "failed" }
        else if self.tested_context_tokens.is_none_or(|n|n==0) { "limited" }
        else if self.probes.iter().any(|p| p.status == "failed") { "limited" }
        else { "qualified" }
    }
    pub fn is_probe(&self, job: &JobRecord) -> bool {
        job.mode.as_deref() == Some(MODE) && self.probes.iter().any(|p| p.job_id == job.job_id)
    }
    pub fn allows(&self, capability: &str) -> bool {
        match capability {
            "chat" => self.passed("chat"),
            "coding" | "coding_basic" | "small_coding" => !self.failed("coding_basic") && (self.passed("coding_basic") || self.predefined(capability)),
            "medium_coding" => !self.failed("coding_basic") && !self.failed("coding_medium") && ((self.passed("coding_basic") && self.passed("coding_medium")) || self.predefined(capability)),
            "large_coding" => !self.failed("coding_basic") && !self.failed("coding_medium") && !self.failed("coding_large") && ((self.passed("coding_basic") && self.passed("coding_medium") && self.passed("coding_large")) || self.predefined(capability)),
            "vision" => self.passed("vision"),
            "long_context" => self.tested_context_tokens.is_some_and(|n| n >= 8192),
            "tool_use" | "native_tool_calls_v1" => self.passed("native_tools") && self.passed("tool_result"),
            _ => false, // Untested workloads do not inherit a successful chat test.
        }
    }

    pub fn prompt(&self, probe: &Probe) -> String {
        match probe.kind.as_str() {
            "coding_basic" => "Implement the expression for a Python function f(a,b,c) that multiplies a by b and adds c. Return only JSON with one key expression containing the return expression. No explanation or function wrapper.".into(),
            "vision" => crate::vision_probe::prompt(&self.model, &probe.nonce),
            "coding_medium" | "coding_large" => {
                let task = if probe.kind == "coding_medium" {
                    "Implement function solve(values) returning the unique integers in values sorted ascending. Inputs include empty arrays, duplicates and negative integers."
                } else {
                    "Implement function solve(input) where input={intervals,nodes,edges}. Return {intervals: merged sorted closed overlapping intervals, order: lexicographically smallest topological ordering of all numeric nodes, or null if edges contain a cycle}. Closed intervals overlap when next start <= previous end. Edges are [from,to]. Include isolated nodes."
                };
                format!("{task} Return only JSON with one key source containing executable JavaScript source, including function solve. The test runner supports function declarations, arrays, plain objects, let/const, for/for-of/while, if, return, arithmetic, comparisons, array push/pop/shift/sort/slice/map/filter/reduce/includes, Object.keys/values/entries, Math.min/max/abs/floor, and arrow callbacks. Do not use imports, classes, Set/Map, spread syntax, regex, async, or I/O. Keep it under 120 lines.")
            }
            "native_tools" | "tool_result" => {
                let name = "mundusx_read_probe";
                let mut messages = vec![json!({"role":"user","content":format!("Call {name} once with nonce {}. This is a side-effect-free test.", probe.nonce)})];
                let tools = if probe.kind == "native_tools" {
                    json!([{"type":"function","function":{"name":name,"description":"Read a test value without external effects.","parameters":{"type":"object","properties":{"nonce":{"type":"string"}},"required":["nonce"],"additionalProperties":false}}}])
                } else {
                    messages.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":"qualification_read","type":"function","function":{"name":name,"arguments":json!({"nonce":probe.nonce}).to_string()}}]}));
                    messages.push(json!({"role":"tool","tool_call_id":"qualification_read","content":json!({"value":probe.nonce}).to_string()}));
                    messages.push(json!({"role":"user","content":"Return only the value from the tool result."}));
                    json!([])
                };
                format!("__MUNDUSX_OPENAI_TOOL_TURN_V1__{}", json!({"model":self.model,"messages":messages,"tools":tools,"stream":false,"max_tokens":128,"temperature":0}))
            }
            "context" => {
                // Deliberately bounded. Runtime token counts determine the observed
                // tested context; character estimates never become measured counts.
                let answer=context_answer(&probe.nonce);
                let tokens=answer.split('|').collect::<Vec<_>>();
                let padding = "neutral context padding ".repeat((self.configured_context_tokens.saturating_sub(384) / 6) as usize);
                format!("Remember the beginning token: {}.\n{padding}\nRemember the middle token: {}.\n{padding}\nThe ending token is {}. Return the beginning, middle and ending tokens in that order separated by |, with no other text.",tokens[0],tokens[1],tokens[2])
            }
            _ => format!("Return exactly {} and nothing else.", probe.nonce),
        }
    }
}

pub fn validate(probe: &Probe, output: &str) -> Result<(), String> {
    let output = output.trim();
    match probe.kind.as_str() {
        "context" => if output==context_answer(&probe.nonce) {Ok(())}else{Err("Context anchors were not retained correctly".into())},
        "coding_medium" | "coding_large" => {
            let source = coding_source(output)?;
            let url = std::env::var("MUNDUSX_QUALIFICATION_EVALUATOR_URL").map_err(|_| "Coding evaluator is not configured")?;
            let token = std::env::var("MUNDUSX_OPERATOR_TOKEN").map_err(|_| "Coding evaluator authorization unavailable")?;
            let value = ureq::post(&url).set("Authorization", &format!("Bearer {token}"))
                .timeout(std::time::Duration::from_secs(10)).send_json(json!({"source":source,"level":probe.kind}))
                .map_err(|_| "Coding evaluator unavailable")?.into_json::<Value>().map_err(|_| "Invalid coding evaluation")?;
            if value.get("passed").and_then(Value::as_bool) == Some(true) { Ok(()) }
            else { Err(value.get("reason").and_then(Value::as_str).unwrap_or("Coding test cases failed").to_string()) }
        }
        "vision" => {
            let payload=output.strip_prefix("__MUNDUSX_OPENAI_TOOL_RESULT_V1__").ok_or("Expected structured image response")?;
            let body:Value=serde_json::from_str(payload).map_err(|_| "Invalid vision response")?;
            let answer:Value=serde_json::from_str(body.pointer("/message/content").and_then(Value::as_str).ok_or("Vision answer missing")?).map_err(|_| "Vision answer must be JSON")?;
            if answer == crate::vision_probe::expected(&probe.nonce) {Ok(())}else{Err("Image quadrant challenge failed".into())}
        }
        "coding_basic" => {
            let value: Value = serde_json::from_str(output).map_err(|_| "Expected an expression JSON object")?;
            let expr = value.get("expression").and_then(Value::as_str).ok_or("Missing expression")?;
            // Execute only a bounded arithmetic grammar. No model-generated
            // imports, calls, I/O, loops or general-purpose code are executed.
            for (a,b,c) in [(2,3,4), (-3,5,7), (0,9,-4), (8,-2,0)] {
                if evaluate(expr, [a,b,c]) != Some(a*b+c) { return Err("Coding exercise failed executable arithmetic cases".into()); }
            }
            Ok(())
        }
        "native_tools" => {
            let payload = output.strip_prefix("__MUNDUSX_OPENAI_TOOL_RESULT_V1__").ok_or("Expected native tool response")?;
            let value: Value = serde_json::from_str(payload).map_err(|_| "Invalid native response JSON")?;
            let calls = value.pointer("/message/tool_calls").and_then(Value::as_array).ok_or("Missing native calls")?;
            if calls.len() != 1 || calls[0].pointer("/function/name").and_then(Value::as_str) != Some("mundusx_read_probe") { return Err("Unexpected native tool call".into()); }
            let args = calls[0].pointer("/function/arguments").and_then(Value::as_str).ok_or("Missing arguments")?;
            let args: Value = serde_json::from_str(args).map_err(|_| "Invalid tool arguments JSON")?;
            if args != json!({"nonce":probe.nonce}) { return Err("Incorrect native tool arguments".into()); }
            Ok(())
        }
        "tool_result" => {
            let payload = output.strip_prefix("__MUNDUSX_OPENAI_TOOL_RESULT_V1__").ok_or("Expected native result turn")?;
            let value: Value = serde_json::from_str(payload).map_err(|_| "Invalid result turn JSON")?;
            if value.pointer("/message/content").and_then(Value::as_str).map(str::trim) != Some(probe.nonce.as_str()) { return Err("Tool result was not consumed correctly".into()); }
            Ok(())
        }
        _ if output == probe.nonce => Ok(()),
        _ => Err("Incorrect probe response".into()),
    }
}

fn coding_source(output:&str)->Result<String,String> {
    let text=output.trim();
    let payload=text.strip_prefix("```json").and_then(|s|s.strip_suffix("```")).map(str::trim).unwrap_or(text);
    let value:Value=serde_json::from_str(payload).map_err(|_| "Expected complete source JSON")?;
    value.get("source").and_then(Value::as_str).filter(|s|s.len()<=16384).map(str::to_string).ok_or_else(||"Missing bounded source".into())
}

// Recursive descent with a length bound, depth bound, checked integer math,
// and complete-input consumption. This is a tiny exercise runner, not eval.
fn evaluate(input: &str, variables: [i64;3]) -> Option<i64> {
    struct Parser<'a> { bytes: &'a [u8], pos: usize, vars: [i64;3] }
    impl Parser<'_> {
        fn skip(&mut self) { while self.bytes.get(self.pos).is_some_and(u8::is_ascii_whitespace) { self.pos += 1; } }
        fn expr(&mut self, depth: u8) -> Option<i64> {
            if depth > 16 { return None; }
            let mut value = self.term(depth + 1)?;
            loop { self.skip(); match self.bytes.get(self.pos).copied() {
                Some(b'+') => { self.pos += 1; value = value.checked_add(self.term(depth+1)?)?; },
                Some(b'-') => { self.pos += 1; value = value.checked_sub(self.term(depth+1)?)?; },
                _ => return Some(value),
            } }
        }
        fn term(&mut self, depth: u8) -> Option<i64> {
            let mut value = self.atom(depth)?;
            loop { self.skip(); if self.bytes.get(self.pos) == Some(&b'*') { self.pos += 1; value = value.checked_mul(self.atom(depth)?)?; } else { return Some(value); } }
        }
        fn atom(&mut self, depth: u8) -> Option<i64> {
            self.skip(); let byte = *self.bytes.get(self.pos)?; self.pos += 1;
            match byte {
                b'a'..=b'c' => Some(self.vars[(byte-b'a') as usize]),
                b'(' => { let value = self.expr(depth+1)?; self.skip(); if self.bytes.get(self.pos) != Some(&b')') {return None;} self.pos += 1; Some(value) },
                b'-' if depth < 16 => self.atom(depth+1)?.checked_neg(),
                b'0'..=b'9' => { let mut n = i64::from(byte-b'0'); while let Some(b'0'..=b'9') = self.bytes.get(self.pos) { n = n.checked_mul(10)?.checked_add(i64::from(self.bytes[self.pos]-b'0'))?; self.pos += 1; } Some(n) },
                _ => None,
            }
        }
    }
    if input.len() > 256 { return None; }
    let mut parser = Parser { bytes: input.as_bytes(), pos:0, vars:variables };
    let value = parser.expr(0)?; parser.skip(); (parser.pos == parser.bytes.len()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn coding_runner_executes_cases_without_general_code() {
        assert_eq!(evaluate("a * b + c", [2,3,4]), Some(10));
        assert_eq!(evaluate("c+(b*a)", [-3,5,7]), Some(-8));
        for bad in ["__import__('os')", "a*b+c; exit()", "a+b", "a**b", "999999999999999999999999", "((((((((((((((((((((a))))))))))))))))))))"] {
            assert!(evaluate(bad, [2,3,4]).is_none() || evaluate(bad, [2,3,4]) != Some(10));
        }
    }
    #[test] fn native_probe_requires_a_real_call_and_exact_arguments() {
        let probe = Probe { kind:"native_tools".into(), job_id:"test".into(), nonce:"challenge".into(), status:"pending".into(),
            reason:None, stream_observed:false, prompt_tokens:None, completion_tokens:None, elapsed_ms:None, completed_at:None };
        let good = format!("__MUNDUSX_OPENAI_TOOL_RESULT_V1__{}", json!({"message":{"tool_calls":[{"function":{"name":"mundusx_read_probe","arguments":"{\"nonce\":\"challenge\"}"}}]}}));
        assert!(validate(&probe, &good).is_ok());
        assert!(validate(&probe, "I called mundusx_read_probe").is_err());
        assert!(validate(&probe, &good.replace("challenge", "wrong")).is_err());
        assert!(validate(&probe, &good.replace("mundusx_read_probe", "write_file")).is_err());
    }
    #[test] fn coding_fences_preserve_source_and_do_not_repair_invalid_json() {
        let raw="{\"source\":\"function solve(x){return x;}\"}";
        assert_eq!(coding_source(raw).unwrap(),coding_source(&format!("```json\n{raw}\n``` ")).unwrap());
        assert!(coding_source("```json\n{\"source\":\"truncated").is_err());
        assert!(coding_source(&format!("```json\n{raw}\n```\nadditional instructions")).is_err());
    }
    #[test] fn context_requires_three_independent_positions_not_just_the_final_token() {
        let probe=Probe {kind:"context".into(),job_id:"test".into(),nonce:"abcdef0123456789abcdef0123456789".into(),status:"pending".into(),reason:None,stream_observed:false,prompt_tokens:None,completion_tokens:None,elapsed_ms:None,completed_at:None};
        let answer=context_answer(&probe.nonce);assert!(validate(&probe,&answer).is_ok());
        assert!(validate(&probe,&probe.nonce).is_err());assert!(validate(&probe,answer.split('|').last().unwrap()).is_err());
    }
}
