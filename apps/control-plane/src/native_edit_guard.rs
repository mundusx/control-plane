// File-tool preconditions also run at the gateway so older agents cannot bypass them.
fn observed_file_key(path:&str)->Option<String> {
    let normalized=path.replace('\\',"/");
    if normalized.split('/').any(|part|part=="..") {return None;}
    if normalized.as_bytes().get(1)==Some(&b':') {Some(normalized.to_ascii_lowercase())}
    else if normalized.starts_with('/') {Some(normalized)} else {None}
}

/// The contributor has no filesystem authority. Validate against the client's
/// observed read result, then let its exact-match edit tool check current disk.
pub fn validate(payload:&serde_json::Value,message:&serde_json::Value)->Result<(),String> {
    if message["content"].as_str().is_none_or(|s|s.trim().is_empty())
        && message["tool_calls"].as_array().is_none_or(|calls|calls.is_empty()) {
        return Err("native model returned no content or tool call; response is not complete".into());
    }
    let Some(tools)=payload["tools"].as_array() else {return Ok(())};
    if !["read_file","list_dir","replace_string_in_file"].iter().all(|name|
        tools.iter().any(|tool|tool["function"]["name"].as_str()==Some(name))) {return Ok(());}
    let Some(calls)=message["tool_calls"].as_array() else {return Ok(())};
    let messages=payload["messages"].as_array().ok_or("native edit precondition failed: missing history")?;
    let start=messages.iter().rposition(|m|m["role"]=="user" && m["content"].as_str().is_some_and(|s|s.contains("<userRequest>"))).map_or(0,|i|i+1);
    // Mentioning a path in a negative instruction must not grant edit scope.
    let scoped_files:Vec<String>=start.checked_sub(1).and_then(|i|messages[i]["content"].as_str())
        .and_then(|s|s.split_once("<userRequest>")?.1.split_once("</userRequest>").map(|(s,_)|s.trim()))
        .filter(|s|["fix ","edit ","update "].iter().any(|prefix|s.to_ascii_lowercase().starts_with(prefix)))
        .and_then(|s| {
            let tail=s.split_once(' ')?.1.trim_start();
            let path=if let Some(quote)=tail.chars().next().filter(|c|matches!(c,'"' | '\'' | '`')) {
                tail[quote.len_utf8()..].split_once(quote)?.0
            } else {tail.split_whitespace().next()?};
            let path=path.trim_end_matches(['.',',',';','?']);
            if !path.rsplit(['/', '\\']).next().is_some_and(|name|name.contains('.')) {return None;}
            observed_file_key(path)
        }).into_iter().collect();
    let mut changed=std::collections::HashSet::new();
    for call in calls {
        let name=call["function"]["name"].as_str().unwrap_or("");
        if name=="insert_edit_into_file" || name=="multi_replace_string_in_file" {
            return Err("native edit precondition failed: use one read-grounded replace_string_in_file per turn".into());
        }
        if name!="replace_string_in_file" && name!="create_file" {continue;}
        let args:serde_json::Value=serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or(""))
            .map_err(|_|"native edit precondition failed: invalid arguments")?;
        let key=args["filePath"].as_str().and_then(observed_file_key)
            .ok_or("native edit precondition failed: expected an absolute filePath without traversal")?;
        if !scoped_files.is_empty() && !scoped_files.contains(&key) {
            return Err("native edit precondition failed: mutation target is outside the explicit files in the current userRequest; editor focus does not authorize a different target".into());
        }
        if !changed.insert(key.clone()) {return Err("native edit precondition failed: multiple mutations of the same path require separate observed turns".into());}
        let observed=messages[start..].iter().rev().find_map(|result| {
            if result["role"]!="tool" {return None;}
            let id=result["tool_call_id"].as_str()?;
            let read=messages[start..].iter().filter_map(|m|m["tool_calls"].as_array()).flatten().find(|c|
                c["id"].as_str()==Some(id) && c["function"]["name"]=="read_file")?;
            let read_args:serde_json::Value=serde_json::from_str(read["function"]["arguments"].as_str()?).ok()?;
            if read_args["filePath"].as_str().and_then(observed_file_key).as_ref()!=Some(&key) {return None;}
            let text=result["content"].as_str()?;
            if text.trim_start().to_ascii_lowercase().starts_with("error") {return Some(None);}
            Some(Some(text))
        }).flatten();
        if name=="create_file" {
            if observed.is_some() {return Err("native edit precondition failed: target was already read; do not recreate it".into());}
        } else {
            let old=args["oldString"].as_str().filter(|s|!s.is_empty())
                .ok_or("native edit precondition failed: oldString must be nonempty")?;
            if !observed.is_some_and(|text|text.contains(old)) {
                return Err("native edit precondition failed: read the exact target and use its observed oldString before replacing it".into());
            }
        }
    }
    Ok(())
}

pub fn before_validation(mut delta:serde_json::Value)->serde_json::Value {
    if let Some(object)=delta.as_object_mut() {object.remove("tool_calls");}
    delta
}

/// Ask the client's registered diagnostics tool after an observed mutation.
/// This is a deterministic tool handoff, not another inference/planning job.
pub fn diagnostics_shortcut(request:&crate::contracts::ChatCompletionRequest,id:&str,created:u64,model:&str)->Option<serde_json::Value> {
    if request.tool_choice.as_ref().is_some_and(|c|c.as_str()!=Some("auto")) {return None;}
    let tools=request.tools.as_ref()?.as_array()?;
    if !["read_file","list_dir"].iter().all(|name|tools.iter().any(|t|t["function"]["name"].as_str()==Some(name))) {return None;}
    let tool=tools.iter().find(|t|t["function"]["name"]=="get_errors")?;
    if tool.pointer("/function/parameters/properties/filePaths/type")?.as_str()!=Some("array")
        || tool.pointer("/function/parameters/properties/filePaths/items/type")?.as_str()!=Some("string") {return None;}
    let last=request.messages.last()?;
    if last.role!="tool" {return None;}
    let call_id=last.tool_call_id.as_deref()?;
    let calls=request.messages.iter().rev().find(|m|m.role=="assistant")?.tool_calls.as_ref()?.as_array()?;
    let call=calls.iter().find(|c|c["id"].as_str()==Some(call_id)
        && matches!(c["function"]["name"].as_str(),Some("create_file" | "replace_string_in_file" | "insert_edit_into_file")))?;
    let args:serde_json::Value=serde_json::from_str(call["function"]["arguments"].as_str()?).ok()?;
    let path=args["filePath"].as_str()?;observed_file_key(path)?;
    Some(serde_json::json!({"id":id,"created":created,"model":model,"object":"chat.completion",
        "choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","content":null,
            "tool_calls":[{"id":format!("call_verify_{id}"),"type":"function","function":{"name":"get_errors","arguments":serde_json::json!({"filePaths":[path]}).to_string()}}]}}],
        "mundusx":{"routing":"registered-diagnostics-shortcut","inference":false}}))
}


#[cfg(test)]
mod tests {
    use super::*;
    fn payload()->serde_json::Value {serde_json::json!({"tools":[
        {"function":{"name":"read_file"}},{"function":{"name":"list_dir"}},{"function":{"name":"replace_string_in_file"}}],
        "messages":[{"role":"user","content":"<editorContext>D:/sample/models/Student.js</editorContext><userRequest>Fix D:/sample/routes/studentRoutes.js syntax</userRequest>"},
        {"role":"assistant","content":null,"tool_calls":[{"id":"read1","function":{"name":"read_file","arguments":"{\"filePath\":\"D:/sample/routes/studentRoutes.js\"}"}}]},
        {"role":"tool","tool_call_id":"read1","content":"router.delete/:id', controller.delete);"}]})}
    fn edit(path:&str)->serde_json::Value {serde_json::json!({"role":"assistant","content":null,"tool_calls":[{"id":"edit1","type":"function","function":{"name":"replace_string_in_file","arguments":serde_json::json!({"filePath":path,"oldString":"router.delete/:id', controller.delete);","newString":"router.delete('/:id', controller.delete);"}).to_string()}}]})}
    #[test]
    fn focus_does_not_authorize_a_different_file_even_after_reading_it() {
        let mut p=payload();
        assert!(validate(&p,&edit("d:/sample/routes/studentRoutes.js")).is_ok());
        p["messages"][1]["tool_calls"][0]["function"]["arguments"]=serde_json::json!("{\"filePath\":\"D:/sample/models/Student.js\"}");
        assert!(validate(&p,&edit("D:/sample/models/Student.js")).unwrap_err().contains("outside the explicit files"));
    }
    #[test]
    fn negative_path_mentions_do_not_expand_scope_and_quoted_paths_work() {
        let mut p=payload();
        p["messages"][0]["content"]=serde_json::json!("<userRequest>Fix D:/sample/routes/studentRoutes.js syntax. Do not edit D:/sample/models/Student.js</userRequest>");
        p["messages"][1]["tool_calls"][0]["function"]["arguments"]=serde_json::json!("{\"filePath\":\"D:/sample/models/Student.js\"}");
        assert!(validate(&p,&edit("D:/sample/models/Student.js")).is_err());
        p["messages"][0]["content"]=serde_json::json!("<userRequest>Fix `D:/sample/my routes.js` syntax</userRequest>");
        p["messages"][1]["tool_calls"][0]["function"]["arguments"]=serde_json::json!("{\"filePath\":\"D:/sample/my routes.js\"}");
        assert!(validate(&p,&edit("D:/sample/my routes.js")).is_ok());
    }
    #[test]
    fn unobserved_stale_and_recreated_targets_are_rejected() {
        let mut p=payload();p["messages"][2]["content"]=serde_json::json!("different current text");
        assert!(validate(&p,&edit("D:/sample/routes/studentRoutes.js")).is_err());
        let p=payload();let mut call=edit("D:/sample/routes/studentRoutes.js");call["tool_calls"][0]["function"]["name"]=serde_json::json!("create_file");
        assert!(validate(&p,&call).unwrap_err().contains("do not recreate"));
        let mut p=payload();p["messages"].as_array_mut().unwrap().truncate(1);
        assert!(validate(&p,&edit("D:/sample/routes/studentRoutes.js")).is_err());
    }
    #[test]
    fn stream_holds_mutations_until_validation_then_releases_once() {
        let mut stream=crate::native_stream::NativeStream::default();
        let message=edit("D:/sample/routes/studentRoutes.js");
        let mut call=message["tool_calls"][0].clone();call["index"]=serde_json::json!(0);
        let public=before_validation(serde_json::json!({"tool_calls":[call]}));
        stream.push(&public).unwrap();assert!(stream.message().get("tool_calls").is_none());
        validate(&payload(),&message).unwrap();
        let remainder=stream.remainder(&message).unwrap();stream.push(&remainder).unwrap();
        assert_eq!(stream.message()["tool_calls"],message["tool_calls"]);
        assert_eq!(stream.remainder(&message).unwrap(),serde_json::json!({}));
        assert!(validate(&payload(),&edit("D:/sample/models/Student.js")).is_err());
    }
    #[test]
    fn empty_old_agent_results_are_not_successful_completions() {
        assert!(validate(&serde_json::json!({}),&serde_json::json!({"role":"assistant","content":""})).is_err());
    }
    #[test]
    fn withholding_tool_only_deltas_does_not_end_the_http_stream() {
        let held=before_validation(serde_json::json!({"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}));
        assert_eq!(held,serde_json::json!({}));
        let frame=crate::chat_gateway::sse_frame("");
        assert!(!frame.starts_with("0\r\n"));
        assert!(frame.contains(": keep-alive\n\n"));
    }
    #[test]
    fn mutation_gets_one_schema_valid_diagnostics_handoff_without_a_model_job() {
        let mut p=payload();p["tools"].as_array_mut().unwrap().push(serde_json::json!({"type":"function","function":{"name":"get_errors","parameters":{"type":"object","properties":{"filePaths":{"type":"array","items":{"type":"string"}}}}}}));
        p["messages"].as_array_mut().unwrap().push(edit("D:/sample/routes/studentRoutes.js"));
        p["messages"].as_array_mut().unwrap().push(serde_json::json!({"role":"tool","tool_call_id":"edit1","content":"replaced exact text"}));
        let r:crate::contracts::ChatCompletionRequest=serde_json::from_value(p.clone()).unwrap();
        let answer=diagnostics_shortcut(&r,"id",1,"model").unwrap();
        assert_eq!(answer["mundusx"]["inference"],false);
        let args:serde_json::Value=serde_json::from_str(answer["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["filePaths"],serde_json::json!(["D:/sample/routes/studentRoutes.js"]));
        p["messages"].as_array_mut().unwrap().push(answer["choices"][0]["message"].clone());
        p["messages"].as_array_mut().unwrap().push(serde_json::json!({"role":"tool","tool_call_id":"call_verify_id","content":"no errors"}));
        assert!(diagnostics_shortcut(&serde_json::from_value(p.clone()).unwrap(),"next",1,"model").is_none());
        p["tool_choice"]=serde_json::json!("none");
        assert!(diagnostics_shortcut(&serde_json::from_value(p).unwrap(),"next",1,"model").is_none());
    }
}
