use super::{encode_query_component, latest_user_message, ToolAnswer, ToolSource};
use crate::contracts::ChatMessage;
use regex::Regex;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_SPORTS_URL: &str = "https://www.thesportsdb.com/api/v1/json";
const DEFAULT_FREE_KEY: &str = "123";

pub fn execute(messages: &[ChatMessage]) -> Result<Option<ToolAnswer>, String> {
    let Some(message) = latest_user_message(messages) else {
        return Ok(None);
    };
    if !has_sports_result_intent(&message) {
        return Ok(None);
    }
    let date = requested_utc_date(&message);
    let matchup = extract_matchup(&message);
    let (payload, provider_limited) = fetch_events(matchup.as_deref(), &date)?;
    let query_terms = sports_query_terms(&message);
    let events = payload["event"]
        .as_array()
        .or_else(|| payload["events"].as_array())
        .into_iter()
        .flatten()
        .filter(|event| event_matches(event, &query_terms, matchup.as_deref(), &date))
        .take(5)
        .collect::<Vec<_>>();
    if events.is_empty() {
        let limitation = if provider_limited {
            " The configured free sports provider returns a limited event set; configure MUNDUSX_SPORTS_API_KEY for broader coverage."
        } else {
            ""
        };
        return Err(format!(
            "No matching sports result was returned for {date}.{limitation}"
        ));
    }

    let mut sources = Vec::new();
    let lines = events
        .into_iter()
        .map(|event| {
            let id = text(event, "idEvent").unwrap_or_default();
            let home = text(event, "strHomeTeam").unwrap_or("Home team");
            let away = text(event, "strAwayTeam").unwrap_or("Away team");
            let home_score = text(event, "intHomeScore");
            let away_score = text(event, "intAwayScore");
            let status = text(event, "strStatus").unwrap_or("status unavailable");
            let league = text(event, "strLeague").unwrap_or("competition unavailable");
            let event_date = text(event, "dateEvent").unwrap_or(&date);
            let source_url = if id.is_empty() {
                "https://www.thesportsdb.com/".to_string()
            } else {
                format!("https://www.thesportsdb.com/event/{id}")
            };
            sources.push(ToolSource {
                title: format!("{home} vs {away}"),
                url: source_url,
                provider: "TheSportsDB".to_string(),
            });
            match (home_score, away_score) {
                (Some(home_score), Some(away_score)) => format!(
                    "- **{home} {home_score}–{away_score} {away}** — {league}, {event_date} ({status})"
                ),
                _ => format!(
                    "- **{home} vs {away}** — {league}, {event_date} ({status}; no final score reported)"
                ),
            }
        })
        .collect::<Vec<_>>();
    let source_links = sources
        .iter()
        .enumerate()
        .map(|(index, source)| format!("[{}]({})", index + 1, source.url))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(Some(ToolAnswer::fresh(
        "sports_results",
        format!(
            "Verified sports information for {date} (UTC):\n{}\n\nSources: {source_links}",
            lines.join("\n")
        ),
        sources,
        120,
    )))
}

fn has_sports_result_intent(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    let result_word = Regex::new(
        r"\b(score|scores|result|results|match|game|fixture|played|won|lost|drew|draw)\b",
    )
    .expect("sports result regex")
    .is_match(&lower);
    let sport_word = Regex::new(r"\b(football|soccer|basketball|baseball|cricket|tennis|rugby|hockey|volleyball|nfl|nba|nhl|mlb|epl|premier league|champions league|world cup)\b")
        .expect("sport name regex")
        .is_match(&lower);
    let time_word =
        Regex::new(r"\b(today|tonight|yesterday|tomorrow|latest|live|now|\d{4}-\d{2}-\d{2})\b")
            .expect("sports time regex")
            .is_match(&lower);
    result_word && (sport_word || time_word || lower.contains(" vs ") || lower.contains(" v "))
}

fn extract_matchup(message: &str) -> Option<String> {
    Regex::new(r"(?i)\b([[:alnum:]][[:alnum:] .'-]{1,60})\s+(?:vs\.?|v\.)\s+([[:alnum:]][[:alnum:] .'-]{1,60})")
        .expect("sports matchup regex")
        .captures(message)
        .map(|captures| {
            let home = captures.get(1).map(|value| value.as_str()).unwrap_or_default();
            let away = captures.get(2).map(|value| value.as_str()).unwrap_or_default();
            format!("{} vs {}", clean_team_name(home), clean_team_name(away))
        })
        .filter(|value| value != " vs ")
}

fn clean_team_name(value: &str) -> String {
    let without_prefix = Regex::new(r"(?i)^(?:what(?:'s| is| was)?|who won|score|result|match|game|today|yesterday|tomorrow|the)+\s+")
        .expect("team prefix regex")
        .replace(value.trim(), "")
        .trim()
        .to_string();
    Regex::new(r"(?i)\s+(?:today|tonight|yesterday|tomorrow|latest|live|now)\s*[?!.]*$")
        .expect("team suffix regex")
        .replace(&without_prefix, "")
        .trim_matches(|character: char| character.is_whitespace() || "?!.,”\"".contains(character))
        .to_string()
}

fn fetch_events(matchup: Option<&str>, date: &str) -> Result<(Value, bool), String> {
    let base = std::env::var("MUNDUSX_SPORTS_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SPORTS_URL.to_string());
    if !base.starts_with("https://") && !base.starts_with("http://127.0.0.1:") {
        return Err("sports provider URL must use HTTPS".to_string());
    }
    let key = std::env::var("MUNDUSX_SPORTS_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_FREE_KEY.to_string());
    let path = if let Some(matchup) = matchup {
        format!(
            "searchevents.php?e={}&d={date}",
            encode_query_component(matchup)
        )
    } else {
        format!("eventsday.php?d={date}")
    };
    let url = format!("{}/{key}/{path}", base.trim_end_matches('/'));
    let payload = ureq::get(&url)
        .set("Accept", "application/json")
        .set("User-Agent", "MundusX-Control-Plane/0.1 sports-tool")
        .timeout(Duration::from_secs(12))
        .call()
        .map_err(|error| format!("sports lookup failed: {error}"))?
        .into_json::<Value>()
        .map_err(|error| format!("sports lookup returned invalid JSON: {error}"))?;
    Ok((payload, key == DEFAULT_FREE_KEY))
}

fn event_matches(event: &Value, terms: &[String], matchup: Option<&str>, date: &str) -> bool {
    if let Some(event_date) = text(event, "dateEvent") {
        if event_date != date {
            return false;
        }
    }
    let haystack = [
        text(event, "strEvent").unwrap_or_default(),
        text(event, "strHomeTeam").unwrap_or_default(),
        text(event, "strAwayTeam").unwrap_or_default(),
        text(event, "strLeague").unwrap_or_default(),
        text(event, "strSport").unwrap_or_default(),
    ]
    .join(" ")
    .to_ascii_lowercase();
    if let Some(matchup) = matchup {
        return matchup
            .split(" vs ")
            .all(|team| haystack.contains(&team.to_ascii_lowercase()));
    }
    !terms.is_empty() && terms.iter().all(|term| haystack.contains(term))
}

fn sports_query_terms(message: &str) -> Vec<String> {
    let ignored = [
        "what",
        "whats",
        "what's",
        "was",
        "were",
        "is",
        "are",
        "the",
        "a",
        "an",
        "of",
        "for",
        "on",
        "in",
        "today",
        "tonight",
        "yesterday",
        "tomorrow",
        "latest",
        "live",
        "now",
        "score",
        "scores",
        "result",
        "results",
        "match",
        "game",
        "fixture",
        "played",
        "won",
        "lost",
        "drew",
        "draw",
        "please",
        "tell",
        "me",
        "football",
        "soccer",
        "basketball",
        "baseball",
        "cricket",
        "tennis",
        "rugby",
        "hockey",
        "volleyball",
    ];
    Regex::new(r"[[:alnum:]]+")
        .expect("sports terms regex")
        .find_iter(&message.to_ascii_lowercase())
        .map(|value| value.as_str().to_string())
        .filter(|word| word.len() > 1 && !ignored.contains(&word.as_str()))
        .collect()
}

fn requested_utc_date(message: &str) -> String {
    if let Some(date) = Regex::new(r"\b\d{4}-\d{2}-\d{2}\b")
        .expect("sports date regex")
        .find(message)
    {
        return date.as_str().to_string();
    }
    let lower = message.to_ascii_lowercase();
    let offset = if lower.contains("yesterday") {
        -1
    } else if lower.contains("tomorrow") {
        1
    } else {
        0
    };
    let days = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86_400) as i64
        + offset;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str().filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{
        civil_from_days, event_matches, extract_matchup, has_sports_result_intent,
        sports_query_terms,
    };

    #[test]
    fn identifies_sports_results_without_stealing_generic_math_results() {
        assert!(has_sports_result_intent(
            "What was the Liverpool football result today?"
        ));
        assert!(has_sports_result_intent("Arsenal vs Chelsea score today"));
        assert!(!has_sports_result_intent(
            "What is the result of 12 multiplied by 4?"
        ));
    }

    #[test]
    fn extracts_matchups_and_filters_events() {
        assert_eq!(
            extract_matchup("What was Arsenal vs Chelsea today?").as_deref(),
            Some("Arsenal vs Chelsea")
        );
        let event = serde_json::json!({
            "dateEvent": "2026-08-15",
            "strEvent": "Liverpool vs Arsenal",
            "strHomeTeam": "Liverpool",
            "strAwayTeam": "Arsenal",
            "strLeague": "English Premier League",
            "strSport": "Soccer"
        });
        assert!(event_matches(
            &event,
            &sports_query_terms("Liverpool football result today"),
            None,
            "2026-08-15"
        ));
    }

    #[test]
    fn converts_unix_days_to_utc_calendar_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_680), (2026, 8, 15));
    }
}
