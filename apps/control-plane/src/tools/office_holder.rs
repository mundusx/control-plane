use super::{encode_query_component, latest_user_message, ToolAnswer, ToolSource};
use crate::contracts::ChatMessage;
use regex::Regex;
use serde_json::Value;
use std::time::Duration;

const WIKIDATA_API: &str = "https://www.wikidata.org/w/api.php";
const WIKIDATA_SPARQL: &str = "https://query.wikidata.org/sparql";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Office {
    HeadOfState,
    HeadOfGovernment,
}

impl Office {
    fn property(self) -> &'static str {
        match self {
            Self::HeadOfState => "P35",
            Self::HeadOfGovernment => "P6",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::HeadOfState => "head of state",
            Self::HeadOfGovernment => "head of government",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OfficeRequest {
    office: Office,
    jurisdiction: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Entity {
    id: String,
    label: String,
}

pub fn execute(messages: &[ChatMessage]) -> Result<Option<ToolAnswer>, String> {
    let Some(message) = latest_user_message(messages) else {
        return Ok(None);
    };
    let Some(request) = parse_office_request(&message) else {
        return Ok(None);
    };
    let Some(jurisdiction) = request.jurisdiction else {
        return Ok(Some(ToolAnswer::clarification(
            "current_office_holder_clarification",
            "Which country or jurisdiction do you mean?",
        )));
    };
    let Some(country) = resolve_country(&jurisdiction)? else {
        return Ok(None);
    };
    let holders = fetch_holders(&country.id, request.office)?;
    if holders.is_empty() {
        return Err(format!(
            "Wikidata did not return a current {} for {}.",
            request.office.label(),
            country.label
        ));
    }
    let names = holders
        .iter()
        .map(|holder| holder.label.as_str())
        .collect::<Vec<_>>()
        .join(" and ");
    let source = format!("https://www.wikidata.org/wiki/{}", country.id);
    Ok(Some(ToolAnswer::fresh(
        "current_office_holder",
        format!(
            "The current {} of {} is {}. [Source: Wikidata]({source})",
            request.office.label(),
            country.label,
            names
        ),
        vec![ToolSource {
            title: format!("{} — current {}", country.label, request.office.label()),
            url: source,
            provider: "Wikidata".to_string(),
        }],
        21_600,
    )))
}

fn parse_office_request(message: &str) -> Option<OfficeRequest> {
    let lower = message.to_ascii_lowercase();
    let office = if Regex::new(r"\b(prime minister|chancellor|head of government)\b")
        .expect("government office regex")
        .is_match(&lower)
    {
        Office::HeadOfGovernment
    } else if Regex::new(r"\b(president|head of state)\b")
        .expect("state office regex")
        .is_match(&lower)
    {
        Office::HeadOfState
    } else {
        return None;
    };
    if !Regex::new(r"\b(who|current|currently|now)\b")
        .expect("current office intent regex")
        .is_match(&lower)
    {
        return None;
    }
    let jurisdiction = [
        r"(?i)\b(?:president|prime minister|chancellor|head of state|head of government)\s+(?:of|in|for)\s+(.+?)\s*[?!.]*$",
        r"(?i)\bwho\s+(?:is|are)\s+(.+?)(?:'s|’s)\s+(?:current\s+)?(?:president|prime minister|chancellor|head of state|head of government)\b",
        r"(?i)\bwho\s+(?:is|are)\s+(?:the\s+)?current\s+(.+?)\s+(?:president|prime minister|chancellor|head of state|head of government)\b",
        r"(?i)\bwho\s+(?:is|are)\s+(?:the\s+)?(.+?)\s+(?:president|prime minister|chancellor|head of state|head of government)\b",
    ]
    .iter()
    .find_map(|pattern| {
        Regex::new(pattern)
            .expect("office jurisdiction regex")
            .captures(message)
            .and_then(|captures| captures.get(1))
            .map(|value| {
                value
                    .as_str()
                    .trim_matches(|character: char| character.is_whitespace() || "?!.,”\"".contains(character))
                    .to_string()
            })
            .filter(|value| {
                !value.is_empty()
                    && !value.eq_ignore_ascii_case("current")
                    && !value.eq_ignore_ascii_case("the current")
            })
    });
    Some(OfficeRequest {
        office,
        jurisdiction,
    })
}

fn resolve_country(jurisdiction: &str) -> Result<Option<Entity>, String> {
    let url = format!(
        "{WIKIDATA_API}?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=8&search={}",
        encode_query_component(jurisdiction)
    );
    let payload = get_json(&url, "Wikidata country search")?;
    Ok(payload["search"].as_array().and_then(|results| {
        results.iter().find_map(|result| {
            let description = result["description"].as_str()?.to_ascii_lowercase();
            let country_like = description.contains("country")
                || description.contains("sovereign state")
                || description.contains("city-state");
            country_like.then(|| Entity {
                id: result["id"].as_str().unwrap_or_default().to_string(),
                label: result["label"].as_str().unwrap_or(jurisdiction).to_string(),
            })
        })
    }))
}

fn fetch_holders(country_id: &str, office: Office) -> Result<Vec<Entity>, String> {
    let query = format!(
        "SELECT DISTINCT ?holder ?holderLabel WHERE {{ wd:{country_id} wdt:{} ?holder . SERVICE wikibase:label {{ bd:serviceParam wikibase:language \"en\". }} }}",
        office.property()
    );
    let url = format!(
        "{WIKIDATA_SPARQL}?format=json&query={}",
        encode_query_component(&query)
    );
    let payload = get_json(&url, "Wikidata office-holder query")?;
    Ok(payload["results"]["bindings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|binding| {
            let uri = binding["holder"]["value"].as_str()?;
            let id = uri.rsplit('/').next()?.to_string();
            let label = binding["holderLabel"]["value"].as_str()?.to_string();
            (!id.is_empty() && !label.is_empty()).then_some(Entity { id, label })
        })
        .collect())
}

fn get_json(url: &str, context: &str) -> Result<Value, String> {
    ureq::get(url)
        .set("Accept", "application/json")
        .set("User-Agent", "MundusX-Control-Plane/0.1 freshness-tool")
        .timeout(Duration::from_secs(12))
        .call()
        .map_err(|error| format!("{context} failed: {error}"))?
        .into_json::<Value>()
        .map_err(|error| format!("{context} returned invalid JSON: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{parse_office_request, Office};

    #[test]
    fn parses_current_office_questions_and_requires_jurisdiction() {
        let president = parse_office_request("Who is the current president of Germany?")
            .expect("president request");
        assert_eq!(president.office, Office::HeadOfState);
        assert_eq!(president.jurisdiction.as_deref(), Some("Germany"));

        let prime_minister = parse_office_request("Who is India's prime minister now?")
            .expect("prime minister request");
        assert_eq!(prime_minister.office, Office::HeadOfGovernment);
        assert_eq!(prime_minister.jurisdiction.as_deref(), Some("India"));

        let adjective = parse_office_request("Who is the current Philippines president?")
            .expect("adjective president request");
        assert_eq!(adjective.office, Office::HeadOfState);
        assert_eq!(adjective.jurisdiction.as_deref(), Some("Philippines"));

        let ambiguous = parse_office_request("Who is the current president?")
            .expect("ambiguous president request");
        assert_eq!(ambiguous.jurisdiction, None);
        assert!(parse_office_request("Explain what a president does.").is_none());
    }
}
