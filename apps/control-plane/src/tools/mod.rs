mod freshness;
mod office_holder;
mod sports;
mod weather;
mod web_search;

use crate::contracts::ChatMessage;
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ToolSource {
    pub title: String,
    pub url: String,
    pub provider: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ToolAnswer {
    pub content: String,
    pub name: &'static str,
    pub status: &'static str,
    pub sources: Vec<ToolSource>,
    pub retrieved_at_epoch: Option<u64>,
    pub expires_at_epoch: Option<u64>,
    pub grounded: bool,
}

impl ToolAnswer {
    pub fn clarification(name: &'static str, content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            name,
            status: "clarification_required",
            sources: Vec::new(),
            retrieved_at_epoch: None,
            expires_at_epoch: None,
            grounded: true,
        }
    }

    pub fn fresh(
        name: &'static str,
        content: impl Into<String>,
        sources: Vec<ToolSource>,
        ttl_seconds: u64,
    ) -> Self {
        let retrieved_at = now_epoch_seconds();
        Self {
            content: content.into(),
            name,
            status: "completed",
            sources,
            retrieved_at_epoch: Some(retrieved_at),
            expires_at_epoch: Some(retrieved_at.saturating_add(ttl_seconds)),
            grounded: true,
        }
    }

    pub fn unavailable(name: &'static str, detail: impl AsRef<str>) -> Self {
        Self {
            content: format!(
                "I couldn't verify the current information right now. {}",
                detail.as_ref().trim()
            ),
            name,
            status: "unavailable",
            sources: Vec::new(),
            retrieved_at_epoch: Some(now_epoch_seconds()),
            expires_at_epoch: None,
            grounded: true,
        }
    }
}

pub fn execute(messages: &[ChatMessage]) -> Result<Option<ToolAnswer>, String> {
    if let Some(answer) = execute_safely("weather", || weather::execute(messages))? {
        return Ok(Some(answer));
    }
    if let Some(answer) = execute_safely("sports", || sports::execute(messages))? {
        return Ok(Some(answer));
    }
    if let Some(answer) =
        execute_safely("current_office_holder", || office_holder::execute(messages))?
    {
        return Ok(Some(answer));
    }
    if freshness::requires_live_data(messages) {
        return Ok(Some(match web_search::execute(messages) {
            Ok(Some(answer)) => answer,
            Ok(None) => ToolAnswer::unavailable(
                "web_search",
                "No trusted live-information provider matched this request.",
            ),
            Err(error) => ToolAnswer::unavailable("web_search", error),
        }));
    }
    Ok(None)
}

fn execute_safely<F>(name: &'static str, execute: F) -> Result<Option<ToolAnswer>, String>
where
    F: FnOnce() -> Result<Option<ToolAnswer>, String>,
{
    Ok(match execute() {
        Ok(answer) => answer,
        Err(error) => Some(ToolAnswer::unavailable(name, error)),
    })
}

pub fn latest_user_message(messages: &[ChatMessage]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|message| message.role.eq_ignore_ascii_case("user"))
        .map(ChatMessage::text)
        .filter(|content| !content.is_empty())
}

pub fn encode_query_component(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (*byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
