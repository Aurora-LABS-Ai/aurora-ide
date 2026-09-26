//! Claude subscription credential lifecycle — Aurora's own store.
//!
//! Design rules:
//!
//! - **Aurora's file, nobody else's.** Tokens live in Aurora's account list
//!   ([`super::accounts`]). Claude Code's own `.credentials.json` is never
//!   written. It is read by [`import_from_cli`] (the Import button) and,
//!   for accounts that came from there, while refreshing: if Claude Code
//!   already refreshed that account, its file holds the live pair.
//! - **Refresh the way Claude Code does** (`utils/auth.ts`
//!   `checkAndRefreshOAuthTokenIfNeeded` / `handleOAuth401Error`): five
//!   minutes early, before a request; on a 401 use the stored token if a
//!   parallel turn already replaced it, else refresh regardless of the
//!   clock; same body and scopes; keep the old refresh token when none
//!   comes back; re-read the profile when the plan is missing.
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

/// A sign-in whose response did not say how long its refresh token lasts is
/// assumed to last this long — Claude Code's own default (`bF`, 30 days).
const DEFAULT_REFRESH_LIFETIME_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Warn this long before the refresh token runs out (Claude Code: 3 days).
const REFRESH_WARNING_MS: i64 = 3 * 24 * 60 * 60 * 1000;

/// How long a started sign-in stays valid before its PKCE secret is
/// discarded. Long enough for a slow consent screen, short enough that a
/// forgotten tab cannot be completed a day later.
const PENDING_TTL_MS: i64 = 30 * 60 * 1000;

const TOKEN_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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
    /// When the refresh token itself stops working, epoch ms; `0` unknown.
    /// Refreshing does not necessarily move it, so past this date the account
    /// needs a new sign-in whatever Aurora does. Claude Code 2.1.282 tracks
    /// the same date (`refreshTokenExpiresAt`) and warns three days ahead.
    #[serde(default)]
    pub refresh_expires_at_ms: i64,
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

    /// Whole days until the refresh token runs out, only once that is three
    /// days or fewer away. Claude Code's `omt()`: no warning when the date is
    /// unknown or already past, or when the access token outlives the
    /// refresh token by more than the warning window (the date is then not
    /// what ends the sign-in).
    fn sign_in_again_in_days(&self, now_ms: i64) -> Option<i64> {
        let until = self.refresh_expires_at_ms;
        if until <= 0 {
            return None;
        }
        if self.expires_at_ms > until + REFRESH_WARNING_MS {
            return None;
        }
        let left = until - now_ms;
        if left <= 0 || left > REFRESH_WARNING_MS {
            return None;
        }
        const DAY_MS: i64 = 24 * 60 * 60 * 1000;
        Some((left + DAY_MS - 1) / DAY_MS)
    }
}

/// The account requests go to, as `(id, credentials)`.
fn read_main() -> Result<Option<(String, StoredAuth)>, String> {
    Ok(super::accounts::load()?
        .main()
        .map(|a| (a.id.clone(), a.auth.clone())))
}

fn read_account(id: &str) -> Result<StoredAuth, String> {
    super::accounts::load()?
        .get(id)
        .map(|a| a.auth.clone())
        .ok_or_else(|| format!("No stored Claude account {id}."))
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
    /// When the sign-in itself ends (refresh token expiry), when known.
    pub refresh_expires_at_ms: Option<i64>,
    /// Set only in the last three days before that: the card asks the user
    /// to sign in again before chats stop.
    pub sign_in_again_in_days: Option<i64>,
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
            refresh_expires_at_ms: None,
            sign_in_again_in_days: None,
        }
    }

    pub fn from_stored(auth: &StoredAuth) -> Self {
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
            refresh_expires_at_ms: (auth.refresh_expires_at_ms > 0)
                .then_some(auth.refresh_expires_at_ms),
            sign_in_again_in_days: auth.sign_in_again_in_days(now_ms()),
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

/// Sign-in state of the main account, straight from Aurora's store.
pub fn status() -> Result<ClaudeCodeAuthStatus, String> {
    Ok(read_main()?.as_ref().map_or_else(ClaudeCodeAuthStatus::signed_out, |(_, auth)| {
        ClaudeCodeAuthStatus::from_stored(auth)
    }))
}

/// Forget the main account. Only Aurora's list changes; the next account,
/// if any, becomes main.
pub fn logout() -> Result<(), String> {
    match read_main()? {
        Some((id, _)) => super::accounts::remove(&id),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Import from Claude Code
// ---------------------------------------------------------------------------

/// Claude Code's config home: `$CLAUDE_CONFIG_DIR`, else `~/.claude` — the
/// same resolution as its `getClaudeConfigHomeDir`.
fn claude_config_home() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("CLAUDE_CONFIG_DIR") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir().map(|home| home.join(".claude"))
}

/// The `claudeAiOauth` block Claude Code writes to `.credentials.json`
/// (`utils/auth.ts`, `saveOAuthTokensIfNeeded`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliOauth {
    access_token: Option<String>,
    refresh_token: Option<String>,
    /// Epoch milliseconds.
    expires_at: Option<i64>,
    /// Epoch milliseconds; written by Claude Code 2.1.x, absent in older files.
    refresh_token_expires_at: Option<i64>,
    #[serde(default)]
    scopes: Vec<String>,
    /// `max`, `pro`, `team`, `enterprise`.
    subscription_type: Option<String>,
    rate_limit_tier: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliCredentials {
    claude_ai_oauth: Option<CliOauth>,
}

/// Turn Claude Code's credential file into Aurora's shape. Pure, so the
/// parsing is testable without a real file.
fn stored_from_cli(raw: &str) -> Result<StoredAuth, String> {
    let creds: CliCredentials = serde_json::from_str(raw)
        .map_err(|err| format!("Claude Code's credentials file is not readable ({err})."))?;
    let oauth = creds
        .claude_ai_oauth
        .ok_or("Claude Code is not signed in to a Claude plan on this machine (it may be using an API key).")?;
    let access_token = oauth
        .access_token
        .filter(|t| !t.is_empty())
        .ok_or("Claude Code's sign-in has no access token. Run `claude` and sign in, then import again.")?;
    let refresh_token = oauth
        .refresh_token
        .filter(|t| !t.is_empty())
        .ok_or("Claude Code's sign-in has no refresh token, so Aurora could not keep it working. Use Sign in instead.")?;
    let now = chrono::Utc::now().to_rfc3339();
    Ok(StoredAuth {
        version: STORE_VERSION,
        access_token,
        refresh_token,
        expires_at_ms: oauth.expires_at.unwrap_or(0),
        refresh_expires_at_ms: oauth.refresh_token_expires_at.unwrap_or(0),
        scopes: oauth.scopes,
        account_uuid: None,
        email: None,
        display_name: None,
        organization_uuid: None,
        // Claude Code stores `max`; the status mapping passes that through.
        organization_type: oauth.subscription_type,
        rate_limit_tier: oauth.rate_limit_tier,
        signed_in_at: Some(now.clone()),
        last_refresh: Some(now),
    })
}

/// Copy the account Claude Code is signed into onto Aurora's list.
///
/// Reads Claude Code's `.credentials.json` once and never writes it. The
/// copy shares Claude Code's sign-in: whichever app refreshes the token
/// first may leave the other holding an outdated one. An account added with
/// Sign in does not have that problem. Returns the status of the imported
/// account.
pub async fn import_from_cli() -> Result<ClaudeCodeAuthStatus, String> {
    let path = claude_config_home()
        .map(|dir| dir.join(".credentials.json"))
        .ok_or("Could not find your home folder.")?;
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "Claude Code is not signed in on this machine (no {}). On macOS it keeps the sign-in in the Keychain, which Aurora does not read.",
                path.display()
            ))
        }
        Err(err) => return Err(format!("Failed to read {}: {err}", path.display())),
    };
    let mut auth = stored_from_cli(&raw)?;
    if !auth.has_inference_scope() {
        return Err("Claude Code's sign-in cannot be used for chat (no inference access).".to_string());
    }

    // An expired token cannot read the profile, and the profile is what says
    // which account this is. Refresh the copy first; only Aurora's copy
    // changes.
    if !auth.is_fresh(now_ms()) {
        let tokens = request_refresh(&auth)
            .await
            .map_err(|err| format!("Claude Code's sign-in has expired and could not be refreshed: {err}. Run `claude` once, then import again."))?;
        auth = apply_refresh(auth, &tokens);
    }

    let profile = fetch_profile(&auth.access_token)
        .await
        .ok_or("Couldn't read which Claude account Claude Code is signed into. Check your connection and try again.")?;
    apply_profile(&mut auth, &profile);
    if auth.account_uuid.is_none() {
        return Err("Claude did not say which account this sign-in belongs to, so it was not imported.".to_string());
    }

    let status = ClaudeCodeAuthStatus::from_stored(&auth);
    tokio::task::spawn_blocking(move || {
        super::accounts::upsert(auth, super::accounts::AccountSource::ClaudeCodeImport)
    })
    .await
    .map_err(|err| format!("Import task failed: {err}"))??;
    Ok(status)
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
    /// Seconds the refresh token lasts. Newer servers send it; Claude Code
    /// 2.1.282 reads it on sign-in and refresh.
    refresh_token_expires_in: Option<i64>,
    scope: Option<String>,
    account: Option<TokenAccount>,
    organization: Option<TokenOrganization>,
}

/// A token call that failed. `code` is the OAuth `error` field of a 400,
/// which is what the `invalid_scope` retry keys on (Claude Code's `Qxr`).
#[derive(Debug)]
struct TokenError {
    message: String,
    code: Option<String>,
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// The OAuth error code in a 400 body: `{"error": "invalid_scope"}`, or
/// `{"error": {"type": "invalid_scope"}}` in Anthropic's own envelope.
fn oauth_error_code(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?;
    error
        .as_str()
        .or_else(|| error.get("type").and_then(Value::as_str))
        .or_else(|| error.get("code").and_then(Value::as_str))
        .map(str::to_string)
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

async fn post_token(body: &Value) -> Result<TokenResponse, TokenError> {
    let plain = |message: String| TokenError {
        message,
        code: None,
    };
    let response = http()
        .post(CLAUDE_TOKEN_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .json(body)
        .send()
        .await
        .map_err(|err| plain(format!("network error: {err}")))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        if status.as_u16() == 401 {
            return Err(plain(
                "the code was not accepted (expired, already used, or from another sign-in)"
                    .to_string(),
            ));
        }
        return Err(TokenError {
            message: format!("HTTP {status}: {}", truncate(&text, 200)),
            code: (status.as_u16() == 400)
                .then(|| oauth_error_code(&text))
                .flatten(),
        });
    }
    response
        .json::<TokenResponse>()
        .await
        .map_err(|err| plain(format!("bad token response: {err}")))
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
        // A fresh sign-in with no stated lifetime gets Claude Code's 30 days.
        refresh_expires_at_ms: match tokens.refresh_token_expires_in {
            Some(secs) if secs > 0 => now_ms() + secs * 1000,
            _ => now_ms() + DEFAULT_REFRESH_LIFETIME_MS,
        },
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

    let status = ClaudeCodeAuthStatus::from_stored(&auth);
    super::accounts::upsert(auth, super::accounts::AccountSource::SignIn)?;
    Ok(status)
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
    /// The stored account this token belongs to, so a 401 retry refreshes
    /// that account even if the user switched main mid-turn.
    pub account_id: String,
    pub access_token: String,
}

fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn access_of(id: &str, auth: &StoredAuth) -> Result<ClaudeCodeAccess, String> {
    if !auth.has_inference_scope() {
        return Err(
            "This Claude sign-in cannot be used for chat (it was granted without inference access). Sign out and sign in again."
                .to_string(),
        );
    }
    Ok(ClaudeCodeAccess {
        account_id: id.to_string(),
        access_token: auth.access_token.clone(),
    })
}

fn read_entry(id: &str) -> Result<super::accounts::StoredAccount, String> {
    super::accounts::load()?
        .get(id)
        .cloned()
        .ok_or_else(|| format!("No stored Claude account {id}."))
}

/// A valid access token for the main account, refreshing through the token
/// endpoint when the stored one expires within five minutes.
pub async fn fresh_access() -> Result<ClaudeCodeAccess, String> {
    let (id, _) = read_main()?.ok_or(SIGNED_OUT_MSG)?;
    fresh_access_for(&id).await
}

/// A valid access token for one named account. The account list polls every
/// account's usage through this without making any of them main.
pub async fn fresh_access_for(id: &str) -> Result<ClaudeCodeAccess, String> {
    let auth = read_account(id)?;
    if auth.is_fresh(now_ms()) {
        return access_of(id, &auth);
    }
    refresh_account(id, None).await
}

/// The API answered 401 to `rejected`. Claude Code's `handleOAuth401Error`:
/// if the stored token is already a different one (a parallel turn refreshed
/// it), use that; otherwise refresh even though the clock says the token is
/// still good — the server's verdict wins over the local expiry.
pub async fn access_after_rejection(rejected: &ClaudeCodeAccess) -> Result<ClaudeCodeAccess, String> {
    refresh_account(&rejected.account_id, Some(&rejected.access_token)).await
}

/// Refresh one account, single-flight. Mirrors Claude Code's
/// `checkAndRefreshOAuthTokenIfNeeded`: re-read inside the lock and stop if
/// someone else already refreshed, then refresh, then on failure re-read once
/// more in case a parallel writer won.
///
/// An account imported from Claude Code shares its sign-in with Claude Code,
/// which refreshes on its own schedule. When Claude Code has already done the
/// refresh, its file holds the live pair and Aurora's may be dead, so the
/// file is checked before refreshing and again after a failed refresh. That
/// file is only read, never written.
async fn refresh_account(id: &str, rejected: Option<&str>) -> Result<ClaudeCodeAccess, String> {
    let _guard = refresh_lock().lock().await;

    let entry = read_entry(id)?;
    let auth = entry.auth;
    let needs_refresh = match rejected {
        Some(token) => auth.access_token == token,
        None => !auth.is_fresh(now_ms()),
    };
    if !needs_refresh {
        return access_of(id, &auth);
    }
    let imported = entry.source == super::accounts::AccountSource::ClaudeCodeImport;

    if imported {
        if let Some(adopted) = adopt_from_claude_code(&auth).await {
            super::accounts::write_auth_for(id, adopted.clone())?;
            return access_of(id, &adopted);
        }
    }

    let failed_token = auth.access_token.clone();
    match request_refresh(&auth).await {
        Ok(tokens) => {
            let mut updated = apply_refresh(auth, &tokens);
            // Claude Code re-reads the profile after a refresh when the plan
            // or tier is missing; a sign-in whose first profile read failed
            // fills in here instead of staying "Claude plan" forever.
            if updated.organization_type.is_none()
                || updated.rate_limit_tier.is_none()
                || updated.account_uuid.is_none()
            {
                if let Some(profile) = fetch_profile(&updated.access_token).await {
                    apply_profile(&mut updated, &profile);
                }
            }
            super::accounts::write_auth_for(id, updated.clone())?;
            access_of(id, &updated)
        }
        Err(err) => {
            if let Ok(current) = read_account(id) {
                if current.access_token != failed_token && current.is_fresh(now_ms()) {
                    return access_of(id, &current);
                }
                if imported {
                    // Claude Code refreshed first and our refresh token went
                    // with it. Its file has the pair that works now.
                    if let Some(adopted) = adopt_from_claude_code(&current).await {
                        super::accounts::write_auth_for(id, adopted.clone())?;
                        return access_of(id, &adopted);
                    }
                }
            }
            let hint = if imported {
                "Run `claude` once so Claude Code refreshes it, then try again, or sign in to this account from Aurora so it has its own sign-in."
            } else {
                "Sign in again from Settings \u{2192} Providers \u{2192} Claude Code."
            };
            crate::logging::log_warn(
                "claude_code.auth",
                &format!("refresh failed for account {id} (imported: {imported}): {err}"),
            );
            Err(format!("Claude token refresh failed: {err}. {hint}"))
        }
    }
}

/// Claude Code's current pair for the same account as `ours`, when it holds
/// a newer one that is still good. `None` whenever that cannot be shown:
/// no file, unreadable, expired too, or signed into a different account.
async fn adopt_from_claude_code(ours: &StoredAuth) -> Option<StoredAuth> {
    let path = claude_config_home()?.join(".credentials.json");
    let raw = tokio::fs::read_to_string(&path).await.ok()?;
    let theirs = stored_from_cli(&raw).ok()?;
    if theirs.access_token == ours.access_token || !theirs.is_fresh(now_ms()) {
        return None;
    }
    // Same refresh token means the same grant, so the same account. A
    // different one could be a rotation or a different account entirely;
    // only the profile can tell, and a mismatch or no answer means no.
    if theirs.refresh_token != ours.refresh_token {
        let ours_uuid = ours.account_uuid.as_deref()?;
        let profile = fetch_profile(&theirs.access_token).await?;
        let theirs_uuid = profile.get("account")?.get("uuid")?.as_str()?;
        if theirs_uuid != ours_uuid {
            return None;
        }
    }
    Some(adopt_pair(ours.clone(), theirs))
}

/// Take the token pair from Claude Code's copy, keep everything else Aurora
/// knows about the account.
fn adopt_pair(mut ours: StoredAuth, theirs: StoredAuth) -> StoredAuth {
    ours.access_token = theirs.access_token;
    ours.refresh_token = theirs.refresh_token;
    ours.expires_at_ms = theirs.expires_at_ms;
    if theirs.refresh_expires_at_ms > 0 {
        ours.refresh_expires_at_ms = theirs.refresh_expires_at_ms;
    }
    if !theirs.scopes.is_empty() {
        ours.scopes = theirs.scopes;
    }
    ours.last_refresh = Some(chrono::Utc::now().to_rfc3339());
    ours
}

async fn post_refresh(refresh_token: &str, scopes: &[String]) -> Result<TokenResponse, TokenError> {
    post_token(&serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLAUDE_CODE_CLIENT_ID,
        "scope": scopes.join(" "),
    }))
    .await
}

/// Refresh with the full subscriber scope set; if the server refuses it
/// (`invalid_scope`), retry once with the scopes this token already has —
/// Claude Code 2.1.282's `tengu_oauth_refresh_invalid_scope_fallback`. A
/// token that cannot be widened still refreshes instead of failing.
async fn request_refresh(auth: &StoredAuth) -> Result<TokenResponse, String> {
    let wanted: Vec<String> = REFRESH_SCOPES.iter().map(|s| s.to_string()).collect();
    match post_refresh(&auth.refresh_token, &wanted).await {
        Ok(tokens) => Ok(tokens),
        Err(err) if should_retry_with_own_scopes(&err, &auth.scopes, &wanted) => {
            crate::logging::log_warn(
                "claude_code.auth",
                "refresh refused the full scope set; retrying with the token's own scopes",
            );
            post_refresh(&auth.refresh_token, &auth.scopes)
                .await
                .map_err(|e| e.to_string())
        }
        Err(err) => Err(err.to_string()),
    }
}

/// Only an `invalid_scope` refusal, and only when there is a different,
/// non-empty set to fall back to.
fn should_retry_with_own_scopes(err: &TokenError, own: &[String], wanted: &[String]) -> bool {
    err.code.as_deref() == Some("invalid_scope") && !own.is_empty() && own != wanted
}

fn apply_refresh(mut auth: StoredAuth, tokens: &TokenResponse) -> StoredAuth {
    auth.access_token = tokens.access_token.clone();
    if let Some(refresh) = tokens.refresh_token.as_deref().filter(|r| !r.is_empty()) {
        auth.refresh_token = refresh.to_string();
    }
    auth.expires_at_ms = expires_at_from(tokens.expires_in);
    // Claude Code keeps the stored date when a refresh does not restate it.
    if let Some(secs) = tokens.refresh_token_expires_in.filter(|s| *s > 0) {
        auth.refresh_expires_at_ms = now_ms() + secs * 1000;
    }
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
            refresh_expires_at_ms: 42,
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
                refresh_token_expires_in: None,
                scope: None,
                account: None,
                organization: None,
            },
        );
        assert_eq!(updated.access_token, "new_access");
        assert_eq!(updated.refresh_token, "old_refresh");
        assert_eq!(
            updated.refresh_expires_at_ms, 42,
            "a refresh that does not restate the sign-in's end keeps the stored one"
        );
        assert!(updated.expires_at_ms > now_ms());
        assert_eq!(updated.scopes, vec!["user:inference".to_string()]);
        assert!(updated.last_refresh.is_some());
    }

    /// The shape Claude Code writes (`saveOAuthTokensIfNeeded`), including a
    /// sibling key Aurora must ignore.
    #[test]
    fn reads_claude_codes_credentials_file() {
        let auth = stored_from_cli(
            r#"{
                "claudeAiOauth": {
                    "accessToken": "sk-ant-oat-a",
                    "refreshToken": "sk-ant-ort-r",
                    "expiresAt": 1790000000000,
                    "scopes": ["user:inference", "user:profile"],
                    "subscriptionType": "max",
                    "rateLimitTier": "default_claude_max_20x"
                },
                "mcpOAuth": {}
            }"#,
        )
        .expect("parses");
        assert_eq!(auth.access_token, "sk-ant-oat-a");
        assert_eq!(auth.refresh_token, "sk-ant-ort-r");
        assert_eq!(auth.expires_at_ms, 1_790_000_000_000);
        assert!(auth.has_inference_scope());
        let status = ClaudeCodeAuthStatus::from_stored(&auth);
        assert_eq!(status.plan.as_deref(), Some("max"));
        assert_eq!(status.rate_limit_tier.as_deref(), Some("default_claude_max_20x"));
    }

    /// When Claude Code refreshed an imported account first, Aurora takes
    /// its token pair but keeps who the account is — the CLI file carries no
    /// email or uuid, so copying it wholesale would blank the account row.
    #[test]
    fn adopting_claude_codes_pair_keeps_the_account_identity() {
        let ours = StoredAuth {
            version: STORE_VERSION,
            access_token: "old-a".into(),
            refresh_token: "old-r".into(),
            expires_at_ms: 1,
            refresh_expires_at_ms: 5,
            scopes: vec!["user:inference".into()],
            account_uuid: Some("acc-1".into()),
            email: Some("dev@example.com".into()),
            display_name: None,
            organization_uuid: Some("org-1".into()),
            organization_type: Some("claude_max".into()),
            rate_limit_tier: None,
            signed_in_at: None,
            last_refresh: None,
        };
        let theirs = stored_from_cli(
            r#"{"claudeAiOauth":{"accessToken":"new-a","refreshToken":"new-r","expiresAt":1790000000000,"refreshTokenExpiresAt":1792000000000,"scopes":["user:inference","user:profile"]}}"#,
        )
        .expect("parses");
        let adopted = adopt_pair(ours, theirs);
        assert_eq!(adopted.access_token, "new-a");
        assert_eq!(adopted.refresh_token, "new-r");
        assert_eq!(adopted.expires_at_ms, 1_790_000_000_000);
        assert_eq!(adopted.refresh_expires_at_ms, 1_792_000_000_000);
        assert_eq!(adopted.account_uuid.as_deref(), Some("acc-1"));
        assert_eq!(adopted.email.as_deref(), Some("dev@example.com"));
        assert_eq!(adopted.organization_type.as_deref(), Some("claude_max"));
        assert!(adopted.last_refresh.is_some());
    }

    #[test]
    fn refuses_a_credentials_file_it_cannot_keep_working() {
        assert!(stored_from_cli(r#"{}"#).is_err(), "API-key mode has no oauth block");
        assert!(
            stored_from_cli(r#"{"claudeAiOauth":{"accessToken":"a","expiresAt":1}}"#).is_err(),
            "no refresh token means the copy dies within hours"
        );
        assert!(stored_from_cli("not json").is_err());
    }

    /// Claude Code's `omt()`: warn only inside the last three days, round
    /// up to whole days, and stay quiet when the date is unknown or past.
    #[test]
    fn warns_to_sign_in_again_only_in_the_last_three_days() {
        const DAY: i64 = 24 * 60 * 60 * 1000;
        let now = 1_000_000_000_000;
        let mut auth = stored_from_cli(
            r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":0,"scopes":["user:inference"]}}"#,
        )
        .expect("parses");
        assert_eq!(auth.sign_in_again_in_days(now), None, "unknown end date");
        auth.refresh_expires_at_ms = now + 10 * DAY;
        assert_eq!(auth.sign_in_again_in_days(now), None, "too far off to mention");
        auth.refresh_expires_at_ms = now + 3 * DAY;
        assert_eq!(auth.sign_in_again_in_days(now), Some(3));
        auth.refresh_expires_at_ms = now + DAY / 2;
        assert_eq!(auth.sign_in_again_in_days(now), Some(1), "rounded up");
        auth.refresh_expires_at_ms = now - 1;
        assert_eq!(auth.sign_in_again_in_days(now), None, "already ended");
        auth.refresh_expires_at_ms = now + DAY;
        auth.expires_at_ms = now + 5 * DAY;
        assert_eq!(
            auth.sign_in_again_in_days(now),
            None,
            "the access token outlives it by more than the window"
        );
    }

    #[test]
    fn retries_with_its_own_scopes_only_on_invalid_scope() {
        let wanted = vec!["user:profile".to_string(), "user:inference".to_string()];
        let own = vec!["user:inference".to_string()];
        let err = |code: Option<&str>| TokenError {
            message: "HTTP 400".into(),
            code: code.map(str::to_string),
        };
        assert!(should_retry_with_own_scopes(&err(Some("invalid_scope")), &own, &wanted));
        assert!(!should_retry_with_own_scopes(&err(Some("invalid_grant")), &own, &wanted));
        assert!(!should_retry_with_own_scopes(&err(None), &own, &wanted));
        assert!(
            !should_retry_with_own_scopes(&err(Some("invalid_scope")), &wanted, &wanted),
            "same set again would fail the same way"
        );
        assert!(!should_retry_with_own_scopes(&err(Some("invalid_scope")), &[], &wanted));
    }

    #[test]
    fn reads_the_oauth_error_code_in_either_envelope() {
        assert_eq!(
            oauth_error_code(r#"{"error":"invalid_scope","error_description":"x"}"#).as_deref(),
            Some("invalid_scope")
        );
        assert_eq!(
            oauth_error_code(r#"{"type":"error","error":{"type":"invalid_scope","message":"x"}}"#)
                .as_deref(),
            Some("invalid_scope")
        );
        assert_eq!(oauth_error_code("<html>"), None);
    }

    #[test]
    fn freshness_uses_the_five_minute_skew() {
        let mut auth = StoredAuth {
            version: STORE_VERSION,
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at_ms: 0,
            refresh_expires_at_ms: 0,
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
            refresh_expires_at_ms: 0,
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
