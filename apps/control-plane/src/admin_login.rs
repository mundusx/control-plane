use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

const SESSION_COOKIE: &str = "__Host-mx_admin";
const STATE_COOKIE: &str = "__Host-mx_admin_state";
const SESSION_SECONDS: u64 = 8 * 60 * 60;
const MAX_ENTRIES: usize = 4096;
const DEFAULT_PUBLIC_ORIGIN: &str = "https://control.mundusx.ai";
const LEGACY_PUBLIC_ORIGIN: &str = "https://mundusx.ai";

#[derive(Default)]
struct LoginState {
    challenges: BTreeMap<String, u64>,
    sessions: BTreeMap<String, (String, u64)>,
}

fn state() -> &'static Mutex<LoginState> {
    static STATE: OnceLock<Mutex<LoginState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(LoginState::default()))
}

fn now() -> u64 {
    super::now_unix_seconds_u64()
}
fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
pub fn enabled() -> bool {
    super::auth_disabled_flag_enabled(std::env::var("MUNDUSX_ADMIN_LOGIN_ENABLED").ok().as_deref())
}
fn origin() -> String {
    let value = std::env::var("MUNDUSX_ADMIN_PUBLIC_ORIGIN")
        .unwrap_or_else(|_| DEFAULT_PUBLIC_ORIGIN.into());
    if value.trim_end_matches('/') == LEGACY_PUBLIC_ORIGIN {
        DEFAULT_PUBLIC_ORIGIN.into()
    } else {
        value.trim_end_matches('/').to_string()
    }
}
fn chat_origin() -> String {
    std::env::var("MUNDUSX_ADMIN_CHAT_ORIGIN").unwrap_or_else(|_| "https://chat.mundusx.ai".into())
}
fn allowed(email: &str) -> bool {
    email_allowed(
        email,
        &std::env::var("MUNDUSX_ADMIN_EMAILS").unwrap_or_default(),
    )
}
fn email_allowed(email: &str, list: &str) -> bool {
    !email.is_empty()
        && list
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .any(|candidate| candidate.eq_ignore_ascii_case(email))
}
fn valid_origin(value: &str) -> bool {
    value.starts_with("https://")
        && value.len() > 8
        && !value[8..].contains(['/', '?', '#', '@', '\\'])
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-.:/".contains(&b))
}
fn configured() -> bool {
    valid_origin(&origin())
        && valid_origin(&chat_origin())
        && std::env::var("MUNDUSX_ADMIN_SSO_SECRET").is_ok_and(|s| s.len() >= 32)
}
fn cookie<'a>(headers: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    super::header_value(headers, "cookie")?
        .split(';')
        .find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name).then_some(value)
        })
}
fn set_cookie(name: &str, value: &str, seconds: u64) -> String {
    format!(
        "Set-Cookie: {name}={value}; Path=/; Max-Age={seconds}; Secure; HttpOnly; SameSite=Lax\r\n"
    )
}
fn response(status: &str, body: &str, extra: &str) -> String {
    format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}
fn redirect(location: &str, cookies: &str) -> String {
    response(
        "303 See Other",
        "",
        &format!("Location: {location}\r\n{cookies}"),
    )
}
fn login_page(message: &str) -> String {
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin sign-in · MundusX</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&amp;display=swap"><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#071019;color:#f6fbff;font-family:"Space Grotesk",system-ui,sans-serif}}main{{box-sizing:border-box;width:min(420px,calc(100% - 32px));padding:32px;border:1px solid #26303b;border-radius:16px;background:#0b1420}}h1{{margin:0 0 12px;font-size:26px}}p{{color:#b4bbc4;line-height:1.6}}a{{display:block;text-align:center;padding:13px;border-radius:9px;background:#2459df;color:white;text-decoration:none;font-weight:700}}small{{display:block;margin-top:20px;color:#b4bbc4}}</style></head><body><main><h1>Control plane</h1><p>{message}</p><a href="/auth/start">Continue with Google</a><small>Access is restricted to approved administrators.</small></main></body></html>"#
    )
}

#[derive(Deserialize)]
struct Assertion {
    kind: String,
    email: String,
    nonce: String,
    audience: String,
    expires: u64,
}
fn verify_assertion(
    token: &str,
    nonce: &str,
    audience: &str,
    secret: &str,
    now: u64,
) -> Option<Assertion> {
    if token.len() > 8192 || secret.len() < 32 {
        return None;
    }
    let (body, signature) = token.split_once('.')?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(body.as_bytes());
    mac.verify_slice(&hex::decode(signature).ok()?).ok()?;
    let claims: Assertion = serde_json::from_slice(&hex::decode(body).ok()?).ok()?;
    (claims.kind == "mundusx-admin-login-v1"
        && claims.nonce == nonce
        && claims.audience == audience
        && claims.expires > now
        && claims.expires <= now.saturating_add(90))
    .then_some(claims)
}

pub fn session_authorized(method: &str, headers: &BTreeMap<String, String>) -> bool {
    if !enabled() {
        return false;
    }
    // Browsers attach cookies automatically; require the exact origin on writes.
    if !matches!(method, "GET" | "HEAD")
        && super::header_value(headers, "origin") != Some(origin().as_str())
    {
        return false;
    }
    let Some(token) = cookie(headers, SESSION_COOKIE) else {
        return false;
    };
    let mut state = state().lock().expect("admin sessions");
    state.sessions.retain(|_, (_, expiry)| *expiry > now());
    state
        .sessions
        .get(token)
        .is_some_and(|(email, _)| allowed(email))
}

pub fn browser_page(method: &str, path: &str) -> bool {
    method == "GET"
        && (path == "/"
            || super::OperatorPage::from_path(path).is_some()
            || path.starts_with("/nodes/")
            || path.starts_with("/jobs/"))
}

pub fn admin_mutation(method: &str, path: &str) -> bool {
    matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
        && (path.starts_with("/actions/")
            || path.starts_with("/v1/nodes/")
            || matches!(path, "/v1/admission-policy" | "/v1/tool-rewards" | "/v1/skills"))
}

pub fn public_request(method: &str, path: &str) -> bool {
    // Viewing operations and submitting inference are public. Conversation
    // storage and internal harness APIs retain their existing service auth.
    browser_page(method, path)
        || (method == "GET"
            && matches!(
                path,
                "/v1/status"
                    | "/v1/skills"
                    | "/v1/planner/status"
                    | "/v1/nodes"
                    | "/v1/admission-policy"
                    | "/v1/jobs"
                    | "/v1/job-events"
                    | "/v1/credits"
            ))
        || (method == "GET" && path.starts_with("/v1/jobs/"))
        || (method == "POST" && path == "/v1/jobs")
}

pub fn handle(
    method: &str,
    path: &str,
    query: Option<&str>,
    headers: &BTreeMap<String, String>,
) -> Option<String> {
    if !enabled() || !path.starts_with("/auth/") {
        return None;
    }
    if !configured() {
        return Some(response(
            "503 Service Unavailable",
            "Admin login is not configured. Contact the operator.",
            "",
        ));
    }
    match (method, path) {
        ("GET", "/auth/login") => Some(response(
            "200 OK",
            &login_page("Sign in with your approved Google account."),
            "",
        )),
        ("GET", "/auth/start") => {
            let nonce = random_token();
            let mut state = state().lock().expect("admin challenges");
            state.challenges.retain(|_, expiry| *expiry > now());
            if state.challenges.len() >= MAX_ENTRIES {
                return Some(response(
                    "429 Too Many Requests",
                    "Please try again shortly.",
                    "",
                ));
            }
            state.challenges.insert(nonce.clone(), now() + 600);
            let return_to =
                super::escape_query_value(&format!("/api/auth/control-plane?state={nonce}"));
            Some(redirect(
                &format!(
                    "{}/api/auth/google/start?return_to={return_to}",
                    chat_origin()
                ),
                &set_cookie(STATE_COOKIE, &nonce, 600),
            ))
        }
        ("GET", "/auth/callback") => {
            let token = super::query_param(query, "assertion").unwrap_or("");
            let nonce = cookie(headers, STATE_COOKIE).unwrap_or("");
            let secret = std::env::var("MUNDUSX_ADMIN_SSO_SECRET").unwrap_or_default();
            let claims = verify_assertion(token, nonce, &origin(), &secret, now());
            let clear_state = set_cookie(STATE_COOKIE, "", 0);
            let mut state = state().lock().expect("admin callback");
            let valid_challenge = state
                .challenges
                .remove(nonce)
                .is_some_and(|expiry| expiry > now());
            let Some(claims) = claims.filter(|_| valid_challenge) else {
                return Some(response(
                    "403 Forbidden",
                    &login_page("The sign-in expired or could not be verified. Please try again."),
                    &clear_state,
                ));
            };
            if !allowed(&claims.email) {
                return Some(response(
                    "403 Forbidden",
                    &login_page("This Google account is not approved for admin access."),
                    &clear_state,
                ));
            }
            state.sessions.retain(|_, (_, expiry)| *expiry > now());
            if state.sessions.len() >= MAX_ENTRIES {
                return Some(response(
                    "429 Too Many Requests",
                    "Please try again shortly.",
                    &clear_state,
                ));
            }
            // A fresh opaque session prevents session fixation and allows logout revocation.
            if let Some(old) = cookie(headers, SESSION_COOKIE) {
                state.sessions.remove(old);
            }
            let session = random_token();
            state
                .sessions
                .insert(session.clone(), (claims.email, now() + SESSION_SECONDS));
            Some(redirect(
                "/",
                &(clear_state + &set_cookie(SESSION_COOKIE, &session, SESSION_SECONDS)),
            ))
        }
        ("POST", "/auth/logout") => {
            if super::header_value(headers, "origin") != Some(origin().as_str()) {
                return Some(response("403 Forbidden", "Invalid request origin.", ""));
            }
            if let Some(token) = cookie(headers, SESSION_COOKIE) {
                state().lock().expect("admin logout").sessions.remove(token);
            }
            Some(redirect("/", &set_cookie(SESSION_COOKIE, "", 0)))
        }
        _ => Some(response("404 Not Found", "Not found", "")),
    }
}

pub fn session_email(headers: &BTreeMap<String, String>) -> Option<String> {
    if !session_authorized("GET", headers) {
        return None;
    }
    let token = cookie(headers, SESSION_COOKIE)?;
    state()
        .lock()
        .ok()?
        .sessions
        .get(token)
        .map(|(email, _)| email.clone())
}

pub fn decorate(mut html: String, email: Option<&str>) -> String {
    let is_admin = email.is_some();
    if !is_admin {
        html = html.replace("</head>", r#"<style>fieldset:disabled button,fieldset:disabled input,fieldset:disabled select,fieldset:disabled textarea{opacity:.45;cursor:not-allowed;box-shadow:none}fieldset:disabled button{pointer-events:none}[data-admin-action]{display:none!important}</style></head>"#);
        let forms = regex::Regex::new(
            r#"(?is)(<form\b[^>]*\bmethod\s*=\s*["']post["'][^>]*>)(.*?)</form>"#,
        )
        .expect("admin forms regex");
        html = forms.replace_all(&html, |captures: &regex::Captures| {
            format!("{}<fieldset disabled style=\"border:0;margin:0;padding:0;min-width:0\">{}</fieldset><p>Admin sign-in is required to make changes.</p></form>", &captures[1], &captures[2])
        }).into_owned();
    }
    let control = if is_admin {
        r#"<form method="post" action="/auth/logout" style="margin:0"><button type="submit" style="font:inherit;padding:9px 14px;border:1px solid #26303b;border-radius:8px;background:#0b1420;color:#f6fbff;cursor:pointer">Log out</button></form>"#
    } else {
        r#"<a href="/auth/login" style="display:block;font:inherit;padding:9px 14px;border:1px solid #26303b;border-radius:8px;background:#0b1420;color:#f6fbff;text-decoration:none">Admin sign-in</a>"#
    };
    let (label, detail) = match email {
        Some(email) => ("Admin", super::escape_html(email)),
        None => ("Public access", "View only".to_string()),
    };
    let card = format!(
        r#"<div class="side-card" id="admin-account" style="display:grid;gap:10px;min-width:0"><div style="min-width:0"><strong>{label}</strong><div class="meta" title="{detail}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{detail}</div></div>{control}</div>"#
    );
    html = html.replace(r#"<div id="admin-account"></div>"#, &card);
    html
}

#[cfg(test)]
mod tests {
    use super::*;
    fn signed(value: serde_json::Value, secret: &str) -> String {
        let body = hex::encode(serde_json::to_vec(&value).unwrap());
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body.as_bytes());
        format!("{body}.{}", hex::encode(mac.finalize().into_bytes()))
    }
    #[test]
    fn verifies_signature_audience_nonce_and_expiry() {
        let secret = "test-secret-that-is-at-least-32-characters";
        let value = serde_json::json!({"kind":"mundusx-admin-login-v1","email":"admin@example.com","nonce":"challenge","audience":"https://control.mundusx.ai","expires":1060});
        let token = signed(value, secret);
        assert!(
            verify_assertion(&token, "challenge", "https://control.mundusx.ai", secret, 1000).is_some()
        );
        for (nonce, audience, key, time) in [
            ("wrong", "https://control.mundusx.ai", secret, 1000),
            ("challenge", "https://other.example", secret, 1000),
            (
                "challenge",
                "https://control.mundusx.ai",
                "another-secret-that-is-at-least-32-characters",
                1000,
            ),
            ("challenge", "https://control.mundusx.ai", secret, 1060),
            ("challenge", "https://control.mundusx.ai", secret, 0),
        ] {
            assert!(verify_assertion(&token, nonce, audience, key, time).is_none());
        }
        assert!(verify_assertion(
            &(token + "00"),
            "challenge",
            "https://control.mundusx.ai",
            secret,
            1000
        )
        .is_none());
    }
    #[test]
    fn allowlist_is_exact_and_empty_denies_everyone() {
        assert!(email_allowed(
            "admin@example.com",
            " other@example.com, ADMIN@example.com "
        ));
        assert!(!email_allowed("admin@example.com", ""));
        assert!(!email_allowed(
            "attacker@admin@example.com",
            "admin@example.com"
        ));
        assert!(!email_allowed("", ""));
    }

    #[test]
    fn public_views_disable_only_mutation_forms() {
        let page = r#"<head></head><body><div id="admin-account"></div><form method="get"><input name="filter"></form><form method="post" action="/actions/admission-policy"><input name="policy"><button>Apply</button></form></body>"#;
        let public = decorate(page.into(), None);
        assert!(public.contains("<form method=\"get\"><input name=\"filter\">"));
        assert!(public.contains("<fieldset disabled"));
        assert!(public.contains("fieldset:disabled button{pointer-events:none}"));
        assert!(public.contains("Admin sign-in"));
        assert!(!public.contains("action=\"/auth/logout\""));
        assert!(public.contains("Public access"));
        let admin = decorate(page.into(), Some("admin@example.com"));
        assert!(admin.contains("admin@example.com"));
        assert!(!admin.contains("<fieldset disabled"));
        assert!(admin.contains("action=\"/auth/logout\""));
        assert!(!public_request("POST", "/v1/nodes/policy-override"));
        assert!(!public_request("GET", "/v1/conversations/private/messages"));
    }
    #[test]
    fn protects_nested_operator_pages_without_intercepting_workers() {
        for path in ["/", "/nodes", "/nodes/node1", "/jobs/job1", "/settings"] {
            assert!(browser_page("GET", path));
        }
        for path in [
            "/health",
            "/v1/models",
            "/v1/jobs/next",
            "/v1/chat/completions",
        ] {
            assert!(!browser_page("GET", path));
        }
        assert!(!valid_origin("https://example.com/path"));
        assert!(!valid_origin("https://example.com\r\nInjected: header"));
        assert!(valid_origin("https://chat.mundusx.ai"));
    }

    #[test]
    fn admin_session_round_trip_and_revocation() {
        // Isolate environment variables and the session store from other tests.
        if std::env::var("MUNDUSX_ADMIN_TEST_CHILD").is_err() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "admin_login::tests::admin_session_round_trip_and_revocation",
                ])
                .env("MUNDUSX_ADMIN_TEST_CHILD", "1")
                .env("MUNDUSX_ADMIN_LOGIN_ENABLED", "true")
                .env("MUNDUSX_ADMIN_EMAILS", "admin@example.com")
                .env("MUNDUSX_ADMIN_PUBLIC_ORIGIN", "https://control.mundusx.ai")
                .env("MUNDUSX_ADMIN_CHAT_ORIGIN", "https://chat.mundusx.ai")
                .env(
                    "MUNDUSX_ADMIN_SSO_SECRET",
                    "test-secret-that-is-at-least-32-characters",
                )
                .env("MUNDUSX_AUTH_DISABLED", "true")
                .env("MUNDUSX_OPERATOR_TOKEN", "machine-test-token")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        let mut headers = BTreeMap::new();
        for path in [
            "/",
            "/settings",
            "/nodes/node1",
            "/v1/status",
            "/v1/jobs",
            "/v1/jobs/job1",
        ] {
            assert!(super::super::authorize_operator_request("GET", path, &headers).is_ok());
        }
        for path in [
            "/v1/jobs",
            "/v1/chat/completions",
            "/v1/jobs/complete",
            "/v1/jobs/delta",
        ] {
            assert!(super::super::authorize_operator_request("POST", path, &headers).is_ok());
        }
        for path in [
            "/v1/nodes/policy-override",
            "/v1/nodes/contribution-cap",
            "/v1/admission-policy",
            "/v1/tool-rewards",
            "/actions/admission-policy",
        ] {
            assert!(super::super::authorize_operator_request("POST", path, &headers).is_err());
        }
        assert!(super::super::requires_device_signature(
            "GET",
            "/v1/jobs/next"
        ));
        assert!(super::super::requires_device_signature(
            "POST",
            "/v1/jobs/complete"
        ));
        assert!(super::super::requires_device_signature(
            "POST",
            "/v1/jobs/delta"
        ));
        headers.insert("authorization".into(), "Bearer machine-test-token".into());
        assert!(super::super::authorize_operator_request(
            "POST",
            "/v1/nodes/policy-override",
            &headers
        )
        .is_ok());
        headers.clear();
        let start = handle("GET", "/auth/start", None, &headers).unwrap();
        let state_header = start
            .lines()
            .find(|line| line.starts_with("Set-Cookie:"))
            .unwrap()
            .trim_start_matches("Set-Cookie: ")
            .split(';')
            .next()
            .unwrap();
        let nonce = state_header.split_once('=').unwrap().1;
        headers.insert("cookie".into(), state_header.into());
        let token = signed(
            serde_json::json!({"kind":"mundusx-admin-login-v1","email":"admin@example.com","nonce":nonce,"audience":"https://control.mundusx.ai","expires":now()+60}),
            "test-secret-that-is-at-least-32-characters",
        );
        let query = format!("assertion={token}");
        let callback = handle("GET", "/auth/callback", Some(&query), &headers).unwrap();
        assert!(callback.starts_with("HTTP/1.1 303"));
        assert!(callback.contains("Secure; HttpOnly; SameSite=Lax"));
        assert!(!callback.contains("machine-test-token"));
        assert!(handle("GET", "/auth/callback", Some(&query), &headers)
            .unwrap()
            .starts_with("HTTP/1.1 403"));
        let session_cookie = callback
            .lines()
            .find(|line| line.starts_with("Set-Cookie: __Host-mx_admin="))
            .unwrap()
            .trim_start_matches("Set-Cookie: ")
            .split(';')
            .next()
            .unwrap();
        headers.insert("cookie".into(), session_cookie.into());
        assert!(session_authorized("GET", &headers));
        assert!(super::super::authorize_operator_request("GET", "/nodes/node1", &headers).is_ok());
        assert!(!session_authorized("POST", &headers));
        headers.insert("origin".into(), "https://evil.example".into());
        assert!(!session_authorized("POST", &headers));
        assert!(handle("POST", "/auth/logout", None, &headers)
            .unwrap()
            .starts_with("HTTP/1.1 403"));
        headers.insert("origin".into(), "https://control.mundusx.ai".into());
        assert!(session_authorized("POST", &headers));
        std::env::set_var("MUNDUSX_ADMIN_EMAILS", "");
        assert!(!session_authorized("GET", &headers));
        std::env::set_var("MUNDUSX_ADMIN_EMAILS", "admin@example.com");
        assert!(handle("POST", "/auth/logout", None, &headers)
            .unwrap()
            .contains("Max-Age=0"));
        assert!(handle("POST", "/auth/logout", None, &headers)
            .unwrap()
            .contains("Location: /\r\n"));
        assert!(!session_authorized("GET", &headers));
    }
}
