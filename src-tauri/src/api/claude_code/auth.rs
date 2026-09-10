//! Claude subscription credential lifecycle — Aurora's own store.
//!
//! Design rules:
//!
//! - **Aurora's file, nobody else's.** Tokens live at
//!   `<root>/auth/claude-code-auth.json`. The user's `~/.claude` directory
//!   is never opened, read, or written: whatever Claude Code itself is
//!   signed into is its own business, and the only way into Aurora is the
//!   Sign in button on the Providers page.
//! - **Manual PKCE flow.** [`begin_login`] returns the authorize URL; the
//!   user finishes in a browser and pastes the code (`code#state`, or the
//!   whole callback URL) into [`complete_login`]. No loopback port to bind,
//!   nothing to time out waiting on.
//! - **Rotation-safe refresh.** Refreshes are single-flight behind an async
//!   mutex, the file is re-read inside the lock, and the new pair is written
//!   atomically (write-then-rename) so a half-written file never exists.
//! - **No Tauri types.** This module knows tokens, PKCE and JSON; the command
//!   layer is a thin wrapper.

use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::{
    CLAUDE_AUTHORIZE_URL, CLAUDE_CODE_CLIENT_ID, CLAUDE_MANUAL_REDIRECT_URL, CLAUDE_PROFILE_URL,
    CLAUDE_TOKEN_URL, INFERENCE_SCOPE, LOGIN_SCOPES, REFRESH_SCOPES,
};

/// Bumped only for a shape change the loader cannot read.
const STORE_VERSION: u32 = 1;

/// Refresh when the access token has less than this long to live. Claude
/// Code uses the same five minutes.
const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

/// How long a started sign-in stays valid before its PKCE secret is
/// discarded. Long enough for a slow consent screen, short enough that a
/// forgotten tab cannot be completed a day later.
const PENDING_TTL_MS: i64 = 30 * 60 * 1000;

const TOKEN_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

const SIGNED_OUT_MSG: &str =
    "Not signed in to Claude. Open Settings \u{2192} Providers \u{2192} Claude Code and sign in.";

// ---------------------------------------------------------------------------
// Stored shape
// ---------------------------------------------------------------------------

/// What one sign-in leaves behind. Everything the card shows is here, so a
/// reopen never needs the network to say who is signed in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAuth {
    #[serde(default)]
    pub version: u32,
    pub access_token: String,
    pub refresh_token: String,
    /// Epoch milliseconds. `0` means the response carried no `expires_in`.
    #[serde(default)]
    pub expires_at_ms: i64,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub account_uuid: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub organization_uuid: Option<String>,
    /// `claude_max`, `claude_pro`, `claude_team`, `claude_enterprise`, …
    #[serde(default)]
    pub organization_type: Option<String>,
    #[serde(default)]
    pub rate_limit_tier: Option<String>,
    #[serde(default)]
    pub signed_in_at: Option<String>,
    #[serde(default)]
    pub last_refresh: Option<String>,
}

impl StoredAuth {
    fn has_inference_scope(&self) -> bool {
        self.scopes.iter().any(|s| s == INFERENCE_SCOPE)
    }

    fn is_fresh(&self, now_ms: i64) -> bool {
        // No expiry recorded: assume usable and let a 401 force the refresh.
        self.expires_at_ms == 0 || self.expires_at_ms - now_ms > REFRESH_SKEW_MS
    }
}

pub fn store_path() -> PathBuf {
    crate::paths::auth_dir().join("claude-code-auth.json")
}

fn read_store() -> Result<Option<StoredAuth>, String> {
    let path = store_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Failed to read {}: {err}", path.display())),
    };
    match serde_json::from_str::<StoredAuth>(&raw) {
        Ok(auth) if auth.version <= STORE_VERSION => Ok(Some(auth)),
        // A file from a newer Aurora is left alone rather than truncated.
        Ok(auth) => Err(format!(
            "{} was written by a newer Aurora (version {}). Update Aurora or sign in again.",
            path.display(),
            auth.version
        )),
        Err(err) => Err(format!(
            "{} is not readable ({err}). Sign out and sign in again.",
            path.display()
        )),
    }
}

/// Write-then-rename, so a crash mid-write leaves the previous file whole.
fn write_store(auth: &StoredAuth) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    let rendered = serde_json::to_string_pretty(auth)
        .map_err(|err| format!("Failed to serialize credentials: {err}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, rendered)
        .map_err(|err| format!("Failed to write {}: {err}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|err| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to replace {}: {err}", path.display())
    })
}

fn remove_store() -> Result<(), String> {
    let path = store_path();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Failed to remove {}: {err}", path.display())),
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// Sign-in state surfaced to the settings card. camelCase on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeAuthStatus {
    pub signed_in: bool,
    /// The token can be used for inference. False for a sign-in that was
    /// granted every scope except `user:inference` — signed in, but unable
    /// to answer a chat, which the card has to say rather than imply.
    pub can_infer: bool,
    pub email: Option<String>,
    pub display_name: Option<String>,
    /// `max`, `pro`, `team`, `enterprise` — or `None` when unknown.
    pub plan: Option<String>,
    pub rate_limit_tier: Option<String>,
    pub account_uuid: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub signed_in_at: Option<String>,
    pub last_refresh: Option<String>,
}

impl ClaudeCodeAuthStatus {
    fn signed_out() -> Self {
        Self {
            signed_in: false,
            can_infer: false,
            email: None,
            display_name: None,
            plan: None,
            rate_limit_tier: None,
            account_uuid: None,
            expires_at_ms: None,
            signed_in_at: None,
            last_refresh: None,
        }
    }

    fn from_stored(auth: &StoredAuth) -> Self {
        Self {
            signed_in: true,
            can_infer: auth.has_inference_scope(),
            email: auth.email.clone(),
            display_name: auth.display_name.clone(),
            plan: plan_from_org_type(auth.organization_type.as_deref()),
            rate_limit_tier: auth.rate_limit_tier.clone(),
            account_uuid: auth.account_uuid.clone(),
            expires_at_ms: (auth.expires_at_ms > 0).then_some(auth.expires_at_ms),
            signed_in_at: auth.signed_in_at.clone(),
            last_refresh: auth.last_refresh.clone(),
        }
    }
}

/// `claude_max` → `max`, the way Claude Code labels the plan. Unknown types
/// are passed through with the `claude_` prefix trimmed rather than hidden,
/// so a plan Aurora has not heard of still shows as something.
pub(super) fn plan_from_org_type(org_type: Option<&str>) -> Option<String> {
    let raw = org_type?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(match raw {
        "claude_max" => "max".to_string(),
        "claude_pro" => "pro".to_string(),
        "claude_team" => "team".to_string(),
        "claude_enterprise" => "enterprise".to_string(),
        other => other.strip_prefix("claude_").unwrap_or(other).to_string(),
    })
}

/// Current sign-in state, straight from Aurora's store.
pub fn status() -> Result<ClaudeCodeAuthStatus, String> {
    Ok(read_store()?
        .as_ref()
        .map_or_else(ClaudeCodeAuthStatus::signed_out, ClaudeCodeAuthStatus::from_stored))
}

/// Forget the sign-in. Only Aurora's file is removed.
pub fn logout() -> Result<(), String> {
    remove_store()
}

// ---------------------------------------------------------------------------
// PKCE + the pending sign-in
// ---------------------------------------------------------------------------

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    use rand::RngCore;
    let mut buf = [0u8; N];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn url_query(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// One started sign-in: the PKCE secret and the state the callback must
/// echo. Held in memory only — never logged, never written.
struct PendingLogin {
    verifier: String,
    state: String,
    started_at_ms: i64,
}

fn pending_login() -> &'static std::sync::Mutex<Option<PendingLogin>> {
    static PENDING: std::sync::OnceLock<std::sync::Mutex<Option<PendingLogin>>> =
        std::sync::OnceLock::new();
    PENDING.get_or_init(|| std::sync::Mutex::new(None))
}

/// Build the authorize URL for one sign-in. Pure, so the shape is testable
/// without touching the pending slot.
fn authorize_url(challenge: &str, state: &str) -> String {
    let scope = LOGIN_SCOPES.join(" ");
    format!(
        "{CLAUDE_AUTHORIZE_URL}?{}",
        url_query(&[
            // Tells the consent page to show a code the user can copy.
            ("code", "true"),
            ("client_id", CLAUDE_CODE_CLIENT_ID),
            ("response_type", "code"),
            ("redirect_uri", CLAUDE_MANUAL_REDIRECT_URL),
            ("scope", &scope),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
        ])
    )
}

/// Start a sign-in: mint the PKCE pair, park it, and return the URL the
/// user opens. A previously started sign-in is replaced.
pub fn begin_login() -> String {
    let verifier = b64url(&random_bytes::<32>());
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = b64url(&random_bytes::<32>());
    let url = authorize_url(&challenge, &state);
    *pending_login().lock().unwrap_or_else(|p| p.into_inner()) = Some(PendingLogin {
        verifier,
        state,
        started_at_ms: now_ms(),
    });
    url
}

/// Drop a started sign-in so a stale paste cannot complete it.
pub fn cancel_login() {
    *pending_login().lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// What the user pasted, reduced to the code and (when present) the state.
///
/// Accepts every shape the consent page or a callback can produce: the
/// whole callback URL, `code#state` as the page shows it, a bare code, or a
/// `code=…&state=…` query string.
pub(super) fn parse_authorization_input(input: &str) -> (Option<String>, Option<String>) {
    let value = input.trim();
    if value.is_empty() {
        return (None, None);
    }

    let query = if let Some((_, rest)) = value.split_once('?') {
        // A URL — or anything with a query string. Drop a fragment first.
        Some(rest.split('#').next().unwrap_or("").to_string())
    } else if value.contains("code=") {
        Some(value.to_string())
    } else {
        None
    };
    if let Some(query) = query {
        let mut code = None;
        let mut state = None;
        for pair in query.split('&') {
            let Some((k, v)) = pair.split_once('=') else {
                continue;
            };
            match k {
                "code" => code = Some(percent_decode(v)),
                "state" => state = Some(percent_decode(v)),
                _ => {}
            }
        }
        return (code.filter(|c| !c.is_empty()), state.filter(|s| !s.is_empty()));
    }

    if let Some((code, state)) = value.split_once('#') {
        let code = code.trim();
        let state = state.trim();
        return (
            (!code.is_empty()).then(|| code.to_string()),
            (!state.is_empty()).then(|| state.to_string()),
        );
    }

    (Some(value.to_string()), None)
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    account: Option<TokenAccount>,
    organization: Option<TokenOrganization>,
}

#[derive(Debug, Deserialize)]
struct TokenAccount {
    uuid: Option<String>,
    email_address: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenOrganization {
    uuid: Option<String>,
}

fn parse_scopes(scope: Option<&str>) -> Vec<String> {
    scope
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(TOKEN_HTTP_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn post_token(body: &Value) -> Result<TokenResponse, String> {
    let response = http()
        .post(CLAUDE_TOKEN_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .json(body)
        .send()
        .await
        .map_err(|err| format!("network error: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(if status.as_u16() == 401 {
            "the code was not accepted (expired, already used, or from another sign-in)".to_string()
        } else {
            format!("HTTP {status}: {}", truncate(&text, 200))
        });
    }
    response
        .json::<TokenResponse>()
        .await
        .map_err(|err| format!("bad token response: {err}"))
}

/// Finish a sign-in with what the user pasted. Exchanges the code, pulls
/// the profile, writes the store, and returns the resulting status.
pub async fn complete_login(input: &str) -> Result<ClaudeCodeAuthStatus, String> {
    let (code, pasted_state) = parse_authorization_input(input);
    let Some(code) = code else {
        return Err("Paste the code from the sign-in page, or the full address it sent you to.".to_string());
    };

    // Take the pending sign-in out of the slot: a code is single-use, so a
    // second paste must start over rather than retry the same secret.
    let pending = pending_login()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .ok_or("This sign-in was not started from Aurora. Press Sign in again and use the new link.")?;
    if now_ms() - pending.started_at_ms > PENDING_TTL_MS {
        return Err("That sign-in link has expired. Press Sign in again to get a new one.".to_string());
    }
    if let Some(state) = pasted_state.as_deref() {
        if state != pending.state {
            return Err(
                "The code belongs to a different sign-in than the one Aurora started. Press Sign in again and use the new link."
                    .to_string(),
            );
        }
    }

    let tokens = post_token(&serde_json::json!({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": CLAUDE_MANUAL_REDIRECT_URL,
        "client_id": CLAUDE_CODE_CLIENT_ID,
        "code_verifier": pending.verifier,
        "state": pending.state,
    }))
    .await
    .map_err(|err| format!("Signing in didn't complete: {err}"))?;

    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or("The sign-in returned no refresh token, so it could not be kept.")?;
    let signed_in_at = chrono::Utc::now().to_rfc3339();
    let mut auth = StoredAuth {
        version: STORE_VERSION,
        access_token: tokens.access_token.clone(),
        refresh_token,
        expires_at_ms: expires_at_from(tokens.expires_in),
        scopes: parse_scopes(tokens.scope.as_deref()),
        account_uuid: tokens.account.as_ref().and_then(|a| a.uuid.clone()),
        email: tokens
            .account
            .as_ref()
            .and_then(|a| a.email_address.clone()),
        display_name: None,
        organization_uuid: tokens.organization.as_ref().and_then(|o| o.uuid.clone()),
        organization_type: None,
        rate_limit_tier: None,
        signed_in_at: Some(signed_in_at.clone()),
        last_refresh: Some(signed_in_at),
    };

    // Best effort: the profile names the plan and the person. Its failure
    // is not a failed sign-in — the token already works.
    if let Some(profile) = fetch_profile(&auth.access_token).await {
        apply_profile(&mut auth, &profile);
    }

    write_store(&auth)?;
    Ok(ClaudeCodeAuthStatus::from_stored(&auth))
}

fn expires_at_from(expires_in: Option<i64>) -> i64 {
    match expires_in {
        Some(secs) if secs > 0 => now_ms() + secs * 1000,
        _ => 0,
    }
}

/// `GET /api/oauth/profile` as a raw value; `None` on any failure.
async fn fetch_profile(access_token: &str) -> Option<Value> {
    let response = http()
        .get(CLAUDE_PROFILE_URL)
        .bearer_auth(access_token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

fn apply_profile(auth: &mut StoredAuth, profile: &Value) {
    let account = profile.get("account");
    let org = profile.get("organization");
    let s = |v: Option<&Value>, key: &str| -> Option<String> {
        v?.get(key)?.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    };
    if let Some(v) = s(account, "uuid") {
        auth.account_uuid = Some(v);
    }
    if let Some(v) = s(account, "email") {
        auth.email = Some(v);
    }
    if let Some(v) = s(account, "display_name") {
        auth.display_name = Some(v);
    }
    if let Some(v) = s(org, "uuid") {
        auth.organization_uuid = Some(v);
    }
    if let Some(v) = s(org, "organization_type") {
        auth.organization_type = Some(v);
    }
    if let Some(v) = s(org, "rate_limit_tier") {
        auth.rate_limit_tier = Some(v);
    }
}

// ---------------------------------------------------------------------------
// Access tokens + refresh
// ---------------------------------------------------------------------------

/// What the adapter needs to authenticate one request.
#[derive(Debug, Clone)]
pub struct ClaudeCodeAccess {
    pub access_token: String,
}

fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn access_of(auth: &StoredAuth) -> Result<ClaudeCodeAccess, String> {
    if !auth.has_inference_scope() {
        return Err(
            "This Claude sign-in cannot be used for chat (it was granted without inference access). Sign out and sign in again."
                .to_string(),
        );
    }
    Ok(ClaudeCodeAccess {
        access_token: auth.access_token.clone(),
    })
}

/// A valid access token, refreshing through the token endpoint when the
/// stored one is about to expire (or `force` is set, e.g. after a 401).
pub async fn fresh_access(force: bool) -> Result<ClaudeCodeAccess, String> {
    let auth = read_store()?.ok_or(SIGNED_OUT_MSG)?;
    if !force && auth.is_fresh(now_ms()) {
        return access_of(&auth);
    }

    let _guard = refresh_lock().lock().await;

    // Re-read inside the lock: a parallel turn may have already rotated it.
    let auth = read_store()?.ok_or(SIGNED_OUT_MSG)?;
    if !force && auth.is_fresh(now_ms()) {
        return access_of(&auth);
    }
    let failed_token = auth.access_token.clone();

    match request_refresh(&auth.refresh_token).await {
        Ok(tokens) => {
            let updated = apply_refresh(auth, &tokens);
            write_store(&updated)?;
            access_of(&updated)
        }
        Err(err) => {
            // Rotation race: another writer refreshed between our read and the
            // request. Their pair is the live one.
            if let Some(current) = read_store()? {
                if current.access_token != failed_token && current.is_fresh(now_ms()) {
                    return access_of(&current);
                }
            }
            Err(format!(
                "Claude token refresh failed: {err}. Sign in again from Settings \u{2192} Providers \u{2192} Claude Code."
            ))
        }
    }
}

async fn request_refresh(refresh_token: &str) -> Result<TokenResponse, String> {
    post_token(&serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLAUDE_CODE_CLIENT_ID,
        "scope": REFRESH_SCOPES.join(" "),
    }))
    .await
}

fn apply_refresh(mut auth: StoredAuth, tokens: &TokenResponse) -> StoredAuth {
    auth.access_token = tokens.access_token.clone();
    if let Some(refresh) = tokens.refresh_token.as_deref().filter(|r| !r.is_empty()) {
        auth.refresh_token = refresh.to_string();
    }
    auth.expires_at_ms = expires_at_from(tokens.expires_in);
    let scopes = parse_scopes(tokens.scope.as_deref());
    if !scopes.is_empty() {
        auth.scopes = scopes;
    }
    auth.last_refresh = Some(chrono::Utc::now().to_rfc3339());
    auth
}

fn truncate(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(max).collect();
    format!("{head}\u{2026}")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_carries_the_manual_redirect_and_pkce() {
        let url = authorize_url("chal_123", "state_456");
        assert!(url.starts_with(CLAUDE_AUTHORIZE_URL));
        assert!(url.contains("code=true"));
        assert!(url.contains(&format!("client_id={CLAUDE_CODE_CLIENT_ID}")));
        assert!(url.contains("redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"));
        assert!(url.contains("code_challenge=chal_123"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state_456"));
        assert!(url.contains("scope=org%3Acreate_api_key%20user%3Aprofile%20user%3Ainference"));
    }

    #[test]
    fn parses_the_code_hash_state_shape_the_consent_page_shows() {
        let (code, state) = parse_authorization_input("  abc123#st_9  ");
        assert_eq!(code.as_deref(), Some("abc123"));
        assert_eq!(state.as_deref(), Some("st_9"));
    }

    #[test]
    fn parses_a_pasted_callback_url() {
        let (code, state) = parse_authorization_input(
            "https://platform.claude.com/oauth/code/callback?code=ab%2Fc&state=xyz",
        );
        assert_eq!(code.as_deref(), Some("ab/c"));
        assert_eq!(state.as_deref(), Some("xyz"));
    }

    #[test]
    fn parses_a_bare_code_and_a_query_string() {
        assert_eq!(
            parse_authorization_input("onlycode"),
            (Some("onlycode".to_string()), None)
        );
        assert_eq!(
            parse_authorization_input("code=q1&state=s1"),
            (Some("q1".to_string()), Some("s1".to_string()))
        );
        assert_eq!(parse_authorization_input("   "), (None, None));
    }

    #[test]
    fn plan_labels_follow_claude_code() {
        assert_eq!(plan_from_org_type(Some("claude_max")).as_deref(), Some("max"));
        assert_eq!(plan_from_org_type(Some("claude_pro")).as_deref(), Some("pro"));
        assert_eq!(plan_from_org_type(Some("claude_new")).as_deref(), Some("new"));
        assert_eq!(plan_from_org_type(Some("")), None);
        assert_eq!(plan_from_org_type(None), None);
    }

    #[test]
    fn refresh_keeps_the_old_refresh_token_when_none_is_returned() {
        let auth = StoredAuth {
            version: STORE_VERSION,
            access_token: "old_access".into(),
            refresh_token: "old_refresh".into(),
            expires_at_ms: 1,
            scopes: vec!["user:inference".into()],
            account_uuid: None,
            email: None,
            display_name: None,
            organization_uuid: None,
            organization_type: None,
            rate_limit_tier: None,
            signed_in_at: None,
            last_refresh: None,
        };
        let updated = apply_refresh(
            auth,
            &TokenResponse {
                access_token: "new_access".into(),
                refresh_token: None,
                expires_in: Some(3600),
                scope: None,
                account: None,
                organization: None,
            },
        );
        assert_eq!(updated.access_token, "new_access");
        assert_eq!(updated.refresh_token, "old_refresh");
        assert!(updated.expires_at_ms > now_ms());
        assert_eq!(updated.scopes, vec!["user:inference".to_string()]);
        assert!(updated.last_refresh.is_some());
    }

    #[test]
    fn freshness_uses_the_five_minute_skew() {
        let mut auth = StoredAuth {
            version: STORE_VERSION,
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at_ms: 0,
            scopes: vec![],
            account_uuid: None,
            email: None,
            display_name: None,
            organization_uuid: None,
            organization_type: None,
            rate_limit_tier: None,
            signed_in_at: None,
            last_refresh: None,
        };
        let now = 1_000_000_000;
        assert!(auth.is_fresh(now), "no recorded expiry is assumed usable");
        auth.expires_at_ms = now + REFRESH_SKEW_MS + 1;
        assert!(auth.is_fresh(now));
        auth.expires_at_ms = now + REFRESH_SKEW_MS - 1;
        assert!(!auth.is_fresh(now));
    }

    #[test]
    fn profile_fills_what_the_token_response_lacked() {
        let mut auth = StoredAuth {
            version: STORE_VERSION,
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at_ms: 0,
            scopes: vec![],
            account_uuid: None,
            email: None,
            display_name: None,
            organization_uuid: None,
            organization_type: None,
            rate_limit_tier: None,
            signed_in_at: None,
            last_refresh: None,
        };
        apply_profile(
            &mut auth,
            &serde_json::json!({
                "account": { "uuid": "acc-1", "email": "dev@example.com", "display_name": "Dev" },
                "organization": { "uuid": "org-1", "organization_type": "claude_max", "rate_limit_tier": "default_claude_max_5x" }
            }),
        );
        assert_eq!(auth.account_uuid.as_deref(), Some("acc-1"));
        assert_eq!(auth.email.as_deref(), Some("dev@example.com"));
        assert_eq!(auth.display_name.as_deref(), Some("Dev"));
        assert_eq!(auth.organization_type.as_deref(), Some("claude_max"));
        assert_eq!(auth.rate_limit_tier.as_deref(), Some("default_claude_max_5x"));
        let status = ClaudeCodeAuthStatus::from_stored(&auth);
        assert_eq!(status.plan.as_deref(), Some("max"));
        assert!(!status.can_infer, "no inference scope means no chat");
    }
}
