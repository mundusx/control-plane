use super::{encode_query_component, latest_user_message, ToolAnswer, ToolSource};
use crate::contracts::ChatMessage;
use regex::Regex;
use serde_json::Value;
use std::time::Duration;

#[derive(Clone, Debug, Eq, PartialEq)]
struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

pub fn execute(messages: &[ChatMessage]) -> Result<Option<ToolAnswer>, String> {
    let Some(query) = latest_user_message(messages) else {
        return Ok(None);
    };
    let base = std::env::var("MUNDUSX_WEB_SEARCH_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "Trusted web search is not configured (set MUNDUSX_WEB_SEARCH_URL).".to_string()
        })?;
    if !base.starts_with("https://") && !base.starts_with("http://127.0.0.1:") {
        return Err("web search provider URL must use HTTPS".to_string());
    }
    let separator = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{separator}q={}", encode_query_component(&query));
    let agent = ureq::AgentBuilder::new().redirects(0).build();
    let mut request = agent
        .get(&url)
        .set("Accept", "application/json")
        .set("User-Agent", "MundusX-Control-Plane/0.1 web-search-tool")
        .timeout(Duration::from_secs(12));
    if let Ok(key) = std::env::var("MUNDUSX_WEB_SEARCH_API_KEY") {
        if !key.trim().is_empty() {
            let header = std::env::var("MUNDUSX_WEB_SEARCH_API_KEY_HEADER")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "X-Subscription-Token".to_string());
            request = request.set(&header, key.trim());
        }
    }
    let payload = request
        .call()
        .map_err(|error| format!("trusted web search failed: {error}"))?
        .into_json::<Value>()
        .map_err(|error| format!("trusted web search returned invalid JSON: {error}"))?;
    let results = parse_results(&payload);
    if results.is_empty() {
        return Err("Trusted web search returned no usable HTTPS results.".to_string());
    }
    let sources = results
        .iter()
        .map(|result| ToolSource {
            title: result.title.clone(),
            url: result.url.clone(),
            provider: "configured_web_search".to_string(),
        })
        .collect::<Vec<_>>();
    let rendered = results
        .iter()
        .enumerate()
        .map(|(index, result)| {
            format!(
                "{}. [{}]({}) — {}",
                index + 1,
                result.title,
                result.url,
                result.snippet
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(Some(ToolAnswer::fresh(
        "web_search",
        format!(
            "I found these current sources. Their snippets are evidence from the search provider, not independent model knowledge:\n\n{rendered}"
        ),
        sources,
        300,
    )))
}

fn parse_results(payload: &Value) -> Vec<SearchResult> {
    payload["web"]["results"]
        .as_array()
        .or_else(|| payload["results"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|result| {
            let title = result["title"].as_str()?.trim();
            let url = result["url"].as_str()?.trim();
            if title.is_empty() || !url.starts_with("https://") {
                return None;
            }
            let snippet = result["description"]
                .as_str()
                .or_else(|| result["snippet"].as_str())
                .map(sanitize_snippet)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "No provider snippet available.".to_string());
            Some(SearchResult {
                title: truncate_chars(title, 160),
                url: url.to_string(),
                snippet,
            })
        })
        .take(5)
        .collect()
}

fn sanitize_snippet(snippet: &str) -> String {
    let without_html = Regex::new(r"<[^>]+>")
        .expect("search snippet html regex")
        .replace_all(snippet, " ");
    truncate_chars(
        &without_html
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
        400,
    )
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        truncated.push('…');
    }
    truncated
}

#[cfg(test)]
mod tests {
    use super::parse_results;

    #[test]
    fn parses_common_search_shapes_and_rejects_non_https_sources() {
        let payload = serde_json::json!({
            "web": {"results": [
                {"title": "Official result", "url": "https://example.com/result", "description": "<b>Current</b> verified information."},
                {"title": "Unsafe", "url": "http://127.0.0.1/private", "description": "Do not use"}
            ]}
        });
        let results = parse_results(&payload);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Official result");
        assert_eq!(results[0].snippet, "Current verified information.");
    }
}
