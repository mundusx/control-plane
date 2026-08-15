use super::latest_user_message;
use crate::contracts::ChatMessage;
use regex::Regex;

pub fn requires_live_data(messages: &[ChatMessage]) -> bool {
    let Some(message) = latest_user_message(messages) else {
        return false;
    };
    let normalized = message.to_ascii_lowercase();
    let explicit_time = Regex::new(
        r"\b(today|tonight|now|right now|currently|latest|live|breaking|recent|this week|this month|tomorrow|yesterday)\b",
    )
    .expect("freshness time regex")
    .is_match(&normalized);
    let changing_role = Regex::new(
        r"\b(who (?:is|are) (?:the )?(?:current )?(?:president|prime minister|chancellor|ceo|head coach|manager)|current (?:president|prime minister|chancellor|ceo|leader|office holder))\b",
    )
    .expect("changing role regex")
    .is_match(&normalized);
    let changing_value = Regex::new(
        r"\b(current|latest)\b.*\b(price|rate|score|result|version|release|status|ranking|standings|schedule|news)\b|\b(price|rate|score|result|version|release|status|ranking|standings|schedule|news)\b.*\b(now|today|current|latest)\b",
    )
    .expect("changing value regex")
    .is_match(&normalized);

    explicit_time || changing_role || changing_value
}

#[cfg(test)]
mod tests {
    use super::requires_live_data;
    use crate::contracts::ChatMessage;

    fn messages(content: &str) -> Vec<ChatMessage> {
        vec![ChatMessage {
            role: "user".to_string(),
            content: serde_json::Value::String(content.to_string()),
        }]
    }

    #[test]
    fn detects_freshness_without_stealing_stable_questions() {
        assert!(requires_live_data(&messages(
            "Who is the current president of Germany?"
        )));
        assert!(requires_live_data(&messages(
            "What was the Liverpool match result today?"
        )));
        assert!(requires_live_data(&messages("What is Bitcoin worth now?")));
        assert!(!requires_live_data(&messages(
            "Explain electric current in simple terms."
        )));
        assert!(!requires_live_data(&messages(
            "What is the capital of the Philippines?"
        )));
    }
}
