use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use subtle::ConstantTimeEq;

const INVALID: &str = "MUNDUSX_CHAT_API_KEYS must be a JSON array of unique {id, key} entries; IDs use 1-80 letters, digits, underscores or hyphens and keys use 32-256 visible ASCII characters";

#[derive(Deserialize)]
struct Entry {
    id: String,
    key: String,
}

pub struct ApiKey {
    id: String,
    hash: [u8; 32],
}

pub fn parse(raw: Option<&str>) -> Result<Option<Vec<ApiKey>>, &'static str> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let entries: Vec<Entry> = serde_json::from_str(raw).map_err(|_| INVALID)?;
    let mut ids = BTreeSet::new();
    let mut hashes = BTreeSet::new();
    let mut keys = Vec::new();
    for entry in entries {
        if entry.id.is_empty()
            || entry.id.len() > 80
            || !entry
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !(32..=256).contains(&entry.key.len())
            || !entry.key.bytes().all(|b| (0x21..=0x7e).contains(&b))
        {
            return Err(INVALID);
        }
        let hash: [u8; 32] = Sha256::digest(entry.key.as_bytes()).into();
        if !ids.insert(entry.id.clone()) || !hashes.insert(hash) {
            return Err(INVALID);
        }
        keys.push(ApiKey { id: entry.id, hash });
    }
    Ok(Some(keys))
}

pub fn protected(method: &str, path: &str) -> bool {
    method != "OPTIONS"
        && (path == "/v1/models"
            || path == "/v1/chat/completions"
            || path.starts_with("/v1/chat/completions/"))
}

pub fn authenticate(
    header: Option<&str>,
    keys: &[ApiKey],
    service_token: Option<&str>,
) -> Option<String> {
    let (scheme, token) = header?.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Bearer") || token.is_empty() {
        return None;
    }
    let hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let mut identity = None;
    for key in keys {
        if bool::from(key.hash.ct_eq(&hash)) {
            identity = Some(key.id.clone());
        }
    }
    // Browser Chat uses the server-only operator credential to reach this gateway.
    if let Some(service) = service_token.filter(|value| !value.is_empty()) {
        let service_hash: [u8; 32] = Sha256::digest(service.as_bytes()).into();
        if bool::from(service_hash.ct_eq(&hash)) {
            return Some("internal-chat-service".into());
        }
    }
    identity
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "test-only-key-01234567890123456789";
    #[test]
    fn validates_configuration_without_disclosing_secrets() {
        assert!(parse(None).unwrap().is_none());
        assert!(parse(Some("[]")).unwrap().unwrap().is_empty());
        for raw in [
            "",
            "null",
            "{}",
            "secret-invalid-json",
            r#"[{"id":"a","key":"short"}]"#,
        ] {
            assert_eq!(parse(Some(raw)).err(), Some(INVALID));
        }
        let duplicate = format!(r#"[{{"id":"a","key":"{KEY}"}},{{"id":"b","key":"{KEY}"}}]"#);
        assert!(parse(Some(&duplicate)).is_err());
    }
    #[test]
    fn enforces_keys_and_supports_internal_service_only_when_matching() {
        let raw = format!(r#"[{{"id":"vscode-alice","key":"{KEY}"}}]"#);
        let keys = parse(Some(&raw)).unwrap().unwrap();
        assert_eq!(
            authenticate(Some(&format!("Bearer {KEY}")), &keys, None).as_deref(),
            Some("vscode-alice")
        );
        assert!(authenticate(None, &keys, None).is_none());
        assert!(authenticate(Some("Bearer wrong"), &keys, None).is_none());
        assert!(authenticate(Some(&format!("Basic {KEY}")), &keys, None).is_none());
        assert!(authenticate(Some(&format!("Bearer {KEY}")), &[], None).is_none());
        assert_eq!(
            authenticate(Some("Bearer internal"), &[], Some("internal")).as_deref(),
            Some("internal-chat-service")
        );
        assert!(protected("GET", "/v1/models"));
        assert!(protected("POST", "/v1/chat/completions/id/cancel"));
        assert!(protected("GET", "/v1/chat/completions/id"));
        assert!(!protected("OPTIONS", "/v1/chat/completions"));
        assert!(!protected("POST", "/v1/nodes/register"));
    }
    #[test]
    fn http_routes_reject_unauthorized_requests_before_processing() {
        if std::env::var("MUNDUSX_API_KEY_TEST_CHILD").is_err() {
            let raw = format!(r#"[{{"id":"vscode-alice","key":"{KEY}"}}]"#);
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "chat_api_keys::tests::http_routes_reject_unauthorized_requests_before_processing"])
                .env("MUNDUSX_API_KEY_TEST_CHILD", "1")
                .env("MUNDUSX_CHAT_API_KEYS", raw)
                .env("MUNDUSX_OPERATOR_TOKEN", "internal-test-token")
                .env("MUNDUSX_ADMIN_LOGIN_ENABLED", "false")
                .status().unwrap();
            assert!(status.success());
            return;
        }
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::{Arc, Mutex};
        for (method, path, token, expected) in [
            ("GET", "/v1/models", "", "401"),
            ("POST", "/v1/chat/completions", "wrong", "401"),
            ("GET", "/v1/chat/completions/id", "", "401"),
            ("POST", "/v1/chat/completions/id/cancel", "", "401"),
            ("GET", "/v1/models", KEY, "200"),
            ("GET", "/v1/models", "internal-test-token", "200"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let handler = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                crate::handle_connection(
                    stream,
                    Arc::new(Mutex::new(crate::ControlPlaneState::default())),
                    Arc::new(Mutex::new(crate::SupabaseSyncStatus::disabled(
                        crate::StorageSource::LocalJsonOnly,
                    ))),
                    None,
                    crate::StorageSource::LocalJsonOnly,
                );
            });
            let mut client = TcpStream::connect(address).unwrap();
            client
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let header = if token.is_empty() {
                String::new()
            } else {
                format!("Authorization: Bearer {token}\r\n")
            };
            client.write_all(format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n{header}Content-Length: 0\r\n\r\n").as_bytes()).unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            handler.join().unwrap();
            assert!(
                response.starts_with(&format!("HTTP/1.1 {expected}")),
                "{method} {path}: {response}"
            );
            assert!(!response.contains(KEY));
        }
    }
}
