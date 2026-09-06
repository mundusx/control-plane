use super::{latest_user_message, ToolAnswer, ToolSource};
use crate::contracts::ChatMessage;
use regex::Regex;
use serde_json::Value;
use std::collections::BTreeSet;

const DEFAULT_WEATHER_URL: &str = "https://wttr.in";

pub fn execute(messages: &[ChatMessage]) -> Result<Option<ToolAnswer>, String> {
    let Some(message) = latest_user_message(messages) else {
        return Ok(None);
    };
    let normalized = normalize_weather_typos(&message);
    if !has_weather_intent(&normalized) || is_weather_resource_request(&normalized) {
        return Ok(None);
    }
    if has_non_weather_compound_intent(&normalized) {
        return Ok(None);
    }

    let Some(location) = extract_weather_location(&normalized) else {
        return Ok(Some(ToolAnswer::clarification(
            "weather_clarification",
            "Which city or location would you like the weather for?",
        )));
    };
    let day_offset = weather_day_offset(&normalized);
    let payload = fetch_weather(&location)?;
    let content = if day_offset == 0 {
        format_current_weather(&location, &payload)?
    } else {
        format_forecast(&location, day_offset, &payload)?
    };
    Ok(Some(ToolAnswer::fresh(
        "weather",
        content,
        vec![ToolSource {
            title: format!("Weather for {location}"),
            url: weather_url(&location),
            provider: "wttr.in".to_string(),
        }],
        600,
    )))
}

fn normalize_weather_typos(message: &str) -> String {
    let replacements = [
        ("wheather", "weather"),
        ("whether", "weather"),
        ("weater", "weather"),
        ("forcast", "forecast"),
        ("temprature", "temperature"),
    ];
    replacements
        .iter()
        .fold(message.to_string(), |text, (from, to)| {
            Regex::new(&format!(r"(?i)\b{}\b", regex::escape(from)))
                .expect("weather typo regex")
                .replace_all(&text, *to)
                .into_owned()
        })
}

fn has_weather_intent(message: &str) -> bool {
    Regex::new(r"(?i)\b(weather|forecast|temperature|temp|humidity|wind)\b")
        .expect("weather intent regex")
        .is_match(message)
}

fn is_weather_resource_request(message: &str) -> bool {
    let asks = Regex::new(
        r"(?i)\b(recommend|suggest|find|list|share|provide|show|which|what|best|reliable|official|use|using)\b",
    )
    .expect("weather resource verb regex");
    let resources = Regex::new(
        r"(?i)\b(websites?|sites?|apps?|applications?|resources?|sources?|services?|tools?|providers?|portals?)\b",
    )
    .expect("weather resource noun regex");
    asks.is_match(message) && resources.is_match(message)
}

fn has_non_weather_compound_intent(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    let connector =
        Regex::new(r"\b(and|also|then|finally|next)\b|[.;]").expect("compound connector regex");
    if !connector.is_match(&lower) {
        return false;
    }
    Regex::new(
        r"\b(who|write|create|code|program|explain|summarize|translate|solve|calculate|introduce yourself|mundusx)\b",
    )
    .expect("compound intent regex")
    .is_match(&lower)
}

fn extract_weather_location(message: &str) -> Option<String> {
    let patterns = [
        r"(?i)\b(?:weather|forecast|temperature|temp)\s+(?:in|for|at|of)\s+(.+)$",
        r"(?i)\b(?:weather|forecast|temperature|temp)\s+(?:is|will\s+be)(?:\s+(?:in|for|at|of))?\s+(.+)$",
        r"(?i)\b(?:weather|forecast|temperature|temp)\s+(.+)$",
    ];
    for pattern in patterns {
        let captures = Regex::new(pattern)
            .expect("weather location regex")
            .captures(message);
        if let Some(location) = captures
            .and_then(|capture| capture.get(1))
            .and_then(|value| clean_location(value.as_str()))
        {
            return Some(location);
        }
    }

    let leading = Regex::new(
        r"(?i)([[:alpha:]][[:alpha:]\s.'-]*?)\s+(?:weather|forecast|temperature|temp)\b",
    )
    .expect("leading weather location regex")
    .captures(message)
    .and_then(|capture| capture.get(1))
    .and_then(|value| clean_location(value.as_str()))?;
    let mut words = leading.split_whitespace().collect::<Vec<_>>();
    while words.first().is_some_and(|word| is_non_place_word(word)) {
        words.remove(0);
    }
    if words.is_empty() || words.len() > 4 || words.iter().any(|word| is_non_place_word(word)) {
        return None;
    }
    reject_non_place_location(words.join(" "))
}

fn clean_location(value: &str) -> Option<String> {
    let mut location = Regex::new(
        r"(?i)\b(the\s+day\s+after\s+tomorrow|in\s+two\s+days|tomorrow(?:'s)?|right\s+now|today|now|currently|please|pls)\b",
    )
    .expect("weather date regex")
    .replace_all(value, "")
    .trim_matches(|character: char| character.is_whitespace() || "?!.,".contains(character))
    .to_string();
    location = Regex::new(r"(?i)^(?:in|for|at|of)\s+")
        .expect("weather preposition regex")
        .replace(&location, "")
        .trim()
        .to_string();
    location = Regex::new(r"(?i)\s+(?:and|with)\s+(?:humidity|wind|forecast|temperature|temp|conditions|rain|snow|uv|air quality)\b.*$")
        .expect("weather attribute regex")
        .replace(&location, "")
        .trim()
        .to_string();
    location = location.split_whitespace().collect::<Vec<_>>().join(" ");
    if !(2..=120).contains(&location.len()) {
        return None;
    }
    reject_non_place_location(location)
}

fn reject_non_place_location(location: String) -> Option<String> {
    let lower = location.to_ascii_lowercase();
    let rejected = [
        "nice",
        "like",
        "today",
        "tomorrow",
        "current",
        "currently",
        "now",
        "outside",
    ];
    if rejected.contains(&lower.as_str()) || location.split_whitespace().count() > 6 {
        None
    } else {
        Some(location)
    }
}

fn is_non_place_word(word: &str) -> bool {
    matches!(
        word.to_ascii_lowercase().as_str(),
        "what"
            | "whats"
            | "what's"
            | "the"
            | "how"
            | "hows"
            | "how's"
            | "is"
            | "show"
            | "tell"
            | "give"
            | "me"
            | "please"
            | "current"
    )
}

fn weather_day_offset(message: &str) -> usize {
    let lower = message.to_ascii_lowercase();
    if lower.contains("day after tomorrow") || lower.contains("in two days") {
        2
    } else if lower.contains("tomorrow") {
        1
    } else {
        0
    }
}

fn fetch_weather(location: &str) -> Result<Value, String> {
    let url = weather_url(location);
    ureq::get(&url)
        .set("Accept", "application/json")
        .set("User-Agent", "MundusX-Control-Plane/0.1 weather-tool")
        .timeout(std::time::Duration::from_secs(12))
        .call()
        .map_err(|error| format!("weather lookup failed for {location}: {error}"))?
        .into_json::<Value>()
        .map_err(|error| format!("weather lookup returned invalid data for {location}: {error}"))
}

fn weather_url(location: &str) -> String {
    let base = std::env::var("MUNDUSX_WEATHER_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_WEATHER_URL.to_string());
    format!(
        "{}/{}?format=j1",
        base.trim_end_matches('/'),
        encode_path_component(location)
    )
}

fn encode_path_component(value: &str) -> String {
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

fn format_current_weather(requested_location: &str, payload: &Value) -> Result<String, String> {
    let current = payload["current_condition"]
        .as_array()
        .and_then(|values| values.first())
        .ok_or_else(|| {
            format!("weather lookup returned no current conditions for {requested_location}")
        })?;
    let place = weather_place(requested_location, payload);
    let condition =
        nested_value(current, &["weatherDesc", "0", "value"]).unwrap_or("current conditions");
    let observation = string_value(current, "localObsDateTime")
        .filter(|value| !value.is_empty())
        .map(|value| format!(" Observed {value}."))
        .unwrap_or_default();
    Ok(format!(
        "Weather for {place}: {condition}, {}C/{}F, feels like {}C/{}F, humidity {}%, wind {} km/h.{observation}",
        string_value(current, "temp_C").unwrap_or("?"),
        string_value(current, "temp_F").unwrap_or("?"),
        string_value(current, "FeelsLikeC").unwrap_or("?"),
        string_value(current, "FeelsLikeF").unwrap_or("?"),
        string_value(current, "humidity").unwrap_or("?"),
        string_value(current, "windspeedKmph").unwrap_or("?"),
    ))
}

fn format_forecast(
    requested_location: &str,
    day_offset: usize,
    payload: &Value,
) -> Result<String, String> {
    let forecast = payload["weather"]
        .as_array()
        .and_then(|values| values.get(day_offset))
        .ok_or_else(|| format!("weather lookup returned no forecast for {requested_location}"))?;
    let place = weather_place(requested_location, payload);
    let hourly = forecast["hourly"].as_array().and_then(|values| {
        values
            .iter()
            .find(|entry| string_value(entry, "time") == Some("1200"))
            .or_else(|| values.get(4))
            .or_else(|| values.first())
    });
    let condition = hourly
        .and_then(|entry| nested_value(entry, &["weatherDesc", "0", "value"]))
        .unwrap_or("forecast conditions");
    let rain = hourly
        .and_then(|entry| string_value(entry, "chanceofrain"))
        .map(|value| format!(", chance of rain {value}%"))
        .unwrap_or_default();
    let day_label = if day_offset == 1 {
        "tomorrow"
    } else {
        "the day after tomorrow"
    };
    Ok(format!(
        "Weather forecast for {place} {day_label} ({}): {condition}, high {}C/{}F, low {}C/{}F{rain}.",
        string_value(forecast, "date").unwrap_or("unknown date"),
        string_value(forecast, "maxtempC").unwrap_or("?"),
        string_value(forecast, "maxtempF").unwrap_or("?"),
        string_value(forecast, "mintempC").unwrap_or("?"),
        string_value(forecast, "mintempF").unwrap_or("?"),
    ))
}

fn weather_place(requested_location: &str, payload: &Value) -> String {
    let area = payload["nearest_area"]
        .as_array()
        .and_then(|values| values.first());
    let parts = [
        area.and_then(|value| nested_value(value, &["areaName", "0", "value"]))
            .unwrap_or(requested_location),
        area.and_then(|value| nested_value(value, &["region", "0", "value"]))
            .unwrap_or(""),
        area.and_then(|value| nested_value(value, &["country", "0", "value"]))
            .unwrap_or(""),
    ];
    let mut seen = BTreeSet::new();
    parts
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .filter(|part| seen.insert(part.to_ascii_lowercase()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn string_value<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

fn nested_value<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for part in path {
        current = if let Ok(index) = part.parse::<usize>() {
            current.as_array()?.get(index)?
        } else {
            current.get(*part)?
        };
    }
    current.as_str()
}

#[cfg(test)]
mod tests {
    use super::{
        extract_weather_location, format_current_weather, format_forecast,
        is_weather_resource_request, weather_day_offset,
    };

    #[test]
    fn extracts_common_weather_phrasings_without_stealing_resource_questions() {
        assert_eq!(
            extract_weather_location("weather in Warsaw please").as_deref(),
            Some("Warsaw")
        );
        assert_eq!(
            extract_weather_location("Weather is stuttgart tomorrow?").as_deref(),
            Some("stuttgart")
        );
        assert_eq!(
            extract_weather_location("new york city weather today").as_deref(),
            Some("new york city")
        );
        assert_eq!(extract_weather_location("how is the weather today?"), None);
        assert!(is_weather_resource_request(
            "Can you recommend weather-related websites or apps for New Zealand?"
        ));
        assert_eq!(
            weather_day_offset("Munich weather the day after tomorrow"),
            2
        );
    }

    #[test]
    fn formats_current_and_forecast_weather() {
        let payload = serde_json::json!({
            "nearest_area": [{"areaName": [{"value": "Stuttgart"}], "region": [{"value": "Baden-Wurttemberg"}], "country": [{"value": "Germany"}]}],
            "current_condition": [{"weatherDesc": [{"value": "Sunny"}], "temp_C": "24", "temp_F": "75", "FeelsLikeC": "23", "FeelsLikeF": "73", "humidity": "40", "windspeedKmph": "8"}],
            "weather": [{"date": "2026-08-14"}, {"date": "2026-08-15", "maxtempC": "27", "maxtempF": "81", "mintempC": "16", "mintempF": "61", "hourly": [{"time": "1200", "weatherDesc": [{"value": "Partly cloudy"}], "chanceofrain": "20"}]}]
        });
        assert!(format_current_weather("stuttgart", &payload)
            .unwrap()
            .contains("Weather for Stuttgart, Baden-Wurttemberg, Germany: Sunny, 24C/75F"));
        assert!(format_forecast("stuttgart", 1, &payload).unwrap().contains(
            "tomorrow (2026-08-15): Partly cloudy, high 27C/81F, low 16C/61F, chance of rain 20%"
        ));
    }
}
