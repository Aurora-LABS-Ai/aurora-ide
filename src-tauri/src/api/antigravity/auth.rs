//! Antigravity sign-in and token lifecycle.
//!
//! Three ways an account becomes usable, all ending in [`finish_sign_in`]:
//!
//! - **Sign in**: Google's browser flow for desktop clients. Aurora listens on
//!   a random loopback port, the browser lands there with a code, and the code
//!   is exchanged (PKCE plus the client secret every desktop client carries).
//! - **Import**: the refresh token Antigravity IDE keeps in its own state
//!   database (`antigravityUnifiedStateSync.oauthToken`). The database is
//!   opened read-only and never written.
//! - Both then refresh once, read who the account is, and look up the Google
//!   Cloud project Antigravity bills it to (`loadCodeAssist`), onboarding the
//!   account first when it has never used Antigravity.
//!
//! Google refresh tokens are not single-use. Aurora and the IDE refreshing
//! the same sign-in each get their own access token and neither is logged
//! out, so unlike Codex there is no token chain to keep in step.

use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

use super::accounts::{self, AccountSource};
use super::{
    client_metadata, user_agent, ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET,
    GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, LOAD_CODE_ASSIST_URL,
    LOGIN_SCOPES, ONBOARD_USER_URL,
};

/// Refresh when the access token has less than this left. Google's last an
/// hour; five minutes covers a slow first byte on a long request.
const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// `onboardUser` is a long-running operation; Antigravity polls it.
const ONBOARD_ATTEMPTS: u32 = 10;
const ONBOARD_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);

const SIGNED_OUT_MSG: &str = "Not signed in to Antigravity. Open Settings \u{2192} Providers \u{2192} Antigravity and sign in.";

// ---------------------------------------------------------------------------
// Stored shape
// ---------------------------------------------------------------------------

/// What one sign-in leaves behind. Everything the card shows is here, so a
/// reopen never needs the network to say who is signed in.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredAuth {
    pub access_token: String,
    pub refresh_token: String,
    /// Epoch milliseconds; `0` when unknown, which counts as expired.
    #[serde(default)]
    pub expires_at_ms: i64,
    /// Google's stable account id (`userinfo.id`).
    #[serde(default)]
    pub google_id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// The Cloud project requests are billed to. Every generation request
    /// names it; without one the backend answers 403.
    #[serde(default)]
    pub project_id: Option<String>,
    /// `free-tier`, `standard-tier`, … as `loadCodeAssist` reports it.
    #[serde(default)]
    pub tier_id: Option<String>,
    /// The tier's display name, when the backend sends one.
    #[serde(default)]
    pub tier_name: Option<String>,
    #[serde(default)]
    pub signed_in_at: Option<String>,
    #[serde(default)]
    pub last_refresh: Option<String>,
}

impl StoredAuth {
    fn is_fresh(&self, now_ms: i64) -> bool {
        !self.access_token.is_empty() && self.expires_at_ms - now_ms > REFRESH_SKEW_MS
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn read_entry(id: &str) -> Result<accounts::StoredAccount, String> {
    accounts::load()?
        .get(id)
        .cloned()
        .ok_or_else(|| format!("No stored Antigravity account {id}."))
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// Sign-in state for the settings card. camelCase on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAuthStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub name: Option<String>,
    pub project_id: Option<String>,
    pub tier_id: Option<String>,
    pub tier_name: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub signed_in_at: Option<String>,
    pub last_refresh: Option<String>,
}

impl AntigravityAuthStatus {
    fn signed_out() -> Self {
        Self {
            signed_in: false,
            email: None,
            name: None,
            project_id: None,
            tier_id: None,
            tier_name: None,
            expires_at_ms: None,
            signed_in_at: None,
            last_refresh: None,
        }
    }

    pub fn from_stored(auth: &StoredAuth) -> Self {
        Self {
            signed_in: true,
            email: auth.email.clone(),
            name: auth.name.clone(),
            project_id: auth.project_id.clone(),
            tier_id: auth.tier_id.clone(),
            tier_name: auth.tier_name.clone(),
            expires_at_ms: (auth.expires_at_ms > 0).then_some(auth.expires_at_ms),
            signed_in_at: auth.signed_in_at.clone(),
            last_refresh: auth.last_refresh.clone(),
        }
    }
}

/// Sign-in state of the main account, straight from Aurora's store.
pub fn status() -> Result<AntigravityAuthStatus, String> {
    Ok(accounts::load()?
        .main()
        .map_or_else(AntigravityAuthStatus::signed_out, |a| {
            AntigravityAuthStatus::from_stored(&a.auth)
        }))
}

/// Forget the main account. Only Aurora's list changes; the next account, if
/// any, becomes main. The grant itself is not revoked: an imported one is
/// still the IDE's sign-in.
pub fn logout() -> Result<(), String> {
    match accounts::load()?.main() {
        Some(main) => accounts::remove(&main.id.clone()),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Google endpoints
// ---------------------------------------------------------------------------

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[derive(Debug, Deserialize)]
pub(super) struct TokenResponse {
    pub(super) access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

/// Google's token error body: `{"error": "invalid_grant", "error_description": …}`.
fn token_error_text(status: reqwest::StatusCode, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let code = parsed
        .as_ref()
        .and_then(|v| v.get("error"))
        .and_then(Value::as_str);
    let detail = parsed
        .as_ref()
        .and_then(|v| v.get("error_description"))
        .and_then(Value::as_str);
    match (code, detail) {
        (Some("invalid_grant"), _) => {
            "Google no longer accepts this sign-in (it was revoked or expired). Sign in again."
                .to_string()
        }
        (Some(code), Some(detail)) => format!("{code}: {detail}"),
        (Some(code), None) => code.to_string(),
        _ => format!("HTTP {status}: {}", truncate(body, 200)),
    }
}

async fn post_token(form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let response = http()
        .post(GOOGLE_TOKEN_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(form)
        .send()
        .await
        .map_err(|err| format!("Couldn't reach Google: {err}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(token_error_text(status, &body));
    }
    serde_json::from_str(&body)
        .map_err(|err| format!("Google sent an unreadable token reply: {err}"))
}

pub(super) async fn refresh_grant(refresh_token: &str) -> Result<TokenResponse, String> {
    post_token(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", ANTIGRAVITY_CLIENT_ID),
        ("client_secret", ANTIGRAVITY_CLIENT_SECRET),
    ])
    .await
}

fn apply_tokens(auth: &mut StoredAuth, tokens: &TokenResponse) {
    auth.access_token = tokens.access_token.clone();
    // Google usually leaves the refresh token out of a refresh reply; the
    // stored one stays valid.
    if let Some(refresh) = tokens.refresh_token.as_deref().filter(|r| !r.is_empty()) {
        auth.refresh_token = refresh.to_string();
    }
    auth.expires_at_ms = now_ms() + tokens.expires_in.unwrap_or(3600).max(60) * 1000;
    auth.last_refresh = Some(chrono::Utc::now().to_rfc3339());
}

pub(super) async fn fetch_userinfo(access_token: &str) -> Result<Value, String> {
    let response = http()
        .get(GOOGLE_USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|err| format!("Couldn't read the Google account: {err}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Couldn't read the Google account (HTTP {status}): {}",
            truncate(&body, 200)
        ));
    }
    serde_json::from_str(&body).map_err(|err| format!("Unreadable Google account reply: {err}"))
}

fn apply_userinfo(auth: &mut StoredAuth, info: &Value) {
    let text = |key: &str| {
        info.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    auth.google_id = text("id").or_else(|| auth.google_id.take());
    auth.email = text("email").or_else(|| auth.email.take());
    auth.name = text("name").or_else(|| auth.name.take());
}

async fn post_cloud_code(url: &str, access_token: &str, body: &Value) -> Result<Value, String> {
    let response = http()
        .post(url)
        .bearer_auth(access_token)
        .header(reqwest::header::USER_AGENT, user_agent())
        .json(body)
        .send()
        .await
        .map_err(|err| format!("Couldn't reach Antigravity: {err}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Antigravity answered HTTP {status}: {}",
            truncate(&text, 300)
        ));
    }
    serde_json::from_str(&text).map_err(|err| format!("Unreadable Antigravity reply: {err}"))
}

/// `cloudaicompanionProject` arrives as a bare string or as `{id}`.
fn project_of(value: Option<&Value>) -> Option<String> {
    let value = value?;
    value
        .as_str()
        .or_else(|| value.get("id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// What `loadCodeAssist` says about an account.
#[derive(Debug, Default, PartialEq)]
pub(super) struct CodeAssistInfo {
    pub project_id: Option<String>,
    pub tier_id: Option<String>,
    pub tier_name: Option<String>,
    /// The tier to onboard into when there is no project yet.
    pub onboard_tier: String,
    /// Why the account cannot use Antigravity, when the backend says so.
    pub ineligible: Option<String>,
}

pub(super) fn parse_code_assist(load: &Value) -> CodeAssistInfo {
    let tier_text = |tier: Option<&Value>, key: &str| {
        tier.and_then(|t| t.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    // A paid tier, when present, is the plan the account is on.
    let tier = load
        .get("paidTier")
        .filter(|t| t.get("id").is_some())
        .or_else(|| load.get("currentTier"));
    let onboard_tier = load
        .get("allowedTiers")
        .and_then(Value::as_array)
        .and_then(|tiers| {
            tiers
                .iter()
                .find(|t| t.get("isDefault").and_then(Value::as_bool) == Some(true))
        })
        .and_then(|t| t.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("legacy-tier")
        .to_string();
    let ineligible = load
        .get("ineligibleTiers")
        .and_then(Value::as_array)
        .and_then(|tiers| tiers.first())
        .and_then(|t| t.get("reasonMessage"))
        .and_then(Value::as_str)
        .map(str::to_string);
    CodeAssistInfo {
        project_id: project_of(load.get("cloudaicompanionProject")),
        tier_id: tier_text(tier, "id"),
        tier_name: tier_text(tier, "name"),
        onboard_tier,
        ineligible,
    }
}

/// The account's project and tier, onboarding it first when it has none.
pub(super) async fn resolve_project(access_token: &str) -> Result<CodeAssistInfo, String> {
    let metadata = client_metadata();
    let load = post_cloud_code(
        LOAD_CODE_ASSIST_URL,
        access_token,
        &json!({ "metadata": metadata }),
    )
    .await?;
    let mut info = parse_code_assist(&load);
    if info.project_id.is_some() {
        return Ok(info);
    }

    let body = json!({ "tierId": info.onboard_tier, "metadata": metadata });
    for attempt in 0..ONBOARD_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(ONBOARD_INTERVAL).await;
        }
        let op = post_cloud_code(ONBOARD_USER_URL, access_token, &body).await?;
        if op.get("done").and_then(Value::as_bool) == Some(true) {
            info.project_id = project_of(op.pointer("/response/cloudaicompanionProject"));
            break;
        }
    }
    if info.project_id.is_none() {
        return Err(match info.ineligible.take() {
            Some(reason) => format!("This Google account can't use Antigravity: {reason}"),
            None => "Antigravity didn't assign this Google account a project. Open Antigravity once with this account, then try again.".to_string(),
        });
    }
    Ok(info)
}

fn apply_code_assist(auth: &mut StoredAuth, info: CodeAssistInfo) {
    auth.project_id = info.project_id.or_else(|| auth.project_id.take());
    auth.tier_id = info.tier_id.or_else(|| auth.tier_id.take());
    auth.tier_name = info.tier_name.or_else(|| auth.tier_name.take());
}

/// Who the account is and where it bills, then into the list. Shared by
/// sign-in and import so both produce the same entry.
async fn finish_sign_in(
    tokens: &TokenResponse,
    refresh_token: &str,
    source: AccountSource,
) -> Result<AntigravityAuthStatus, String> {
    let mut auth = StoredAuth {
        refresh_token: refresh_token.to_string(),
        signed_in_at: Some(chrono::Utc::now().to_rfc3339()),
        ..StoredAuth::default()
    };
    apply_tokens(&mut auth, tokens);
    if auth.refresh_token.is_empty() {
        return Err(
            "Google didn't return a refresh token, so Aurora couldn't stay signed in. Try again."
                .to_string(),
        );
    }
    let info = fetch_userinfo(&auth.access_token).await?;
    apply_userinfo(&mut auth, &info);
    let assist = resolve_project(&auth.access_token).await?;
    apply_code_assist(&mut auth, assist);

    let status = AntigravityAuthStatus::from_stored(&auth);
    tokio::task::spawn_blocking(move || accounts::upsert(auth, source))
        .await
        .map_err(|err| format!("Saving the account failed: {err}"))??;
    Ok(status)
}

// ---------------------------------------------------------------------------
// Access tokens for requests
// ---------------------------------------------------------------------------

/// What one request needs: whose token, the token, and the project to name.
#[derive(Debug, Clone)]
pub struct AntigravityAccess {
    pub account_id: String,
    pub access_token: String,
    pub project_id: String,
}

fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// A valid token for the main account.
pub async fn fresh_access() -> Result<AntigravityAccess, String> {
    let main = tokio::task::spawn_blocking(accounts::load)
        .await
        .map_err(|err| format!("Accounts task failed: {err}"))??
        .main()
        .map(|a| a.id.clone())
        .ok_or(SIGNED_OUT_MSG)?;
    fresh_access_for(&main).await
}

/// A valid token for one named account, refreshing within five minutes of
/// expiry and filling in a missing project.
pub async fn fresh_access_for(id: &str) -> Result<AntigravityAccess, String> {
    refresh_account(id, None).await
}

/// The backend answered 401 to `rejected`: refresh even though the clock says
/// the token is still good, unless a parallel turn already did.
pub async fn access_after_rejection(
    rejected: &AntigravityAccess,
) -> Result<AntigravityAccess, String> {
    refresh_account(&rejected.account_id, Some(&rejected.access_token)).await
}

/// Single-flight: re-read inside the lock and stop if someone else already
/// refreshed.
async fn refresh_account(id: &str, rejected: Option<&str>) -> Result<AntigravityAccess, String> {
    let _guard = refresh_lock().lock().await;
    let mut auth = {
        let id = id.to_string();
        tokio::task::spawn_blocking(move || read_entry(&id))
            .await
            .map_err(|err| format!("Accounts task failed: {err}"))??
            .auth
    };
    let needs_refresh = match rejected {
        Some(token) => auth.access_token == token,
        None => !auth.is_fresh(now_ms()),
    };
    let mut changed = false;
    if needs_refresh {
        let tokens = refresh_grant(&auth.refresh_token).await.map_err(|err| {
            crate::logging::log_warn(
                "antigravity.auth",
                &format!("refresh failed for account {id}: {err}"),
            );
            format!("Antigravity sign-in refresh failed: {err}")
        })?;
        apply_tokens(&mut auth, &tokens);
        changed = true;
    }
    if auth.project_id.is_none() {
        let info = resolve_project(&auth.access_token).await?;
        apply_code_assist(&mut auth, info);
        changed = true;
    }
    if changed {
        let (id_owned, saved) = (id.to_string(), auth.clone());
        tokio::task::spawn_blocking(move || accounts::write_auth_for(&id_owned, saved))
            .await
            .map_err(|err| format!("Accounts task failed: {err}"))??;
    }
    Ok(AntigravityAccess {
        account_id: id.to_string(),
        access_token: auth.access_token,
        project_id: auth.project_id.unwrap_or_default(),
    })
}

// ---------------------------------------------------------------------------
// Import from Antigravity IDE
// ---------------------------------------------------------------------------

/// Antigravity IDE's VS Code-style global state database.
pub(super) fn ide_state_db() -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        dirs::config_dir()
    } else if cfg!(target_os = "macos") {
        dirs::home_dir().map(|h| h.join("Library").join("Application Support"))
    } else {
        dirs::config_dir()
    }?;
    Some(
        base.join("Antigravity IDE")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb"),
    )
}

const IDE_TOKEN_KEY: &str = "antigravityUnifiedStateSync.oauthToken";

pub(super) fn read_ide_token_value(path: &std::path::Path) -> Result<String, String> {
    use rusqlite::{Connection, OpenFlags};
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| {
        format!(
            "Couldn't open Antigravity IDE's settings ({}): {err}",
            path.display()
        )
    })?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(3));
    conn.query_row(
        "SELECT value FROM ItemTable WHERE key = ?1",
        [IDE_TOKEN_KEY],
        |row| row.get::<_, String>(0),
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => {
            "Antigravity IDE isn't signed in on this computer. Sign in there first, or use Sign in here."
                .to_string()
        }
        other => format!("Couldn't read Antigravity IDE's sign-in: {other}"),
    })
}

/// Every length-delimited field of a protobuf message, recursively, plus the
/// contents of any field that is itself base64 of a protobuf message. The IDE
/// stores the token as base64(protobuf{…, base64(protobuf{access, type,
/// refresh, …})}); only the token strings matter, and their prefixes say
/// which is which, so no schema is needed.
fn collect_strings(bytes: &[u8], depth: u32, out: &mut Vec<String>) {
    if depth > 6 {
        return;
    }
    let mut i = 0usize;
    while i < bytes.len() {
        let Some((key, used)) = read_varint(&bytes[i..]) else {
            return;
        };
        i += used;
        match key & 7 {
            0 => {
                let Some((_, used)) = read_varint(&bytes[i..]) else {
                    return;
                };
                i += used;
            }
            1 => i += 8,
            5 => i += 4,
            2 => {
                let Some((len, used)) = read_varint(&bytes[i..]) else {
                    return;
                };
                i += used;
                let Some(field) = usize::try_from(len).ok().and_then(|n| bytes.get(i..i + n))
                else {
                    return;
                };
                i += field.len();
                if let Ok(text) = std::str::from_utf8(field) {
                    out.push(text.to_string());
                    if let Ok(decoded) =
                        base64::engine::general_purpose::STANDARD.decode(text.trim())
                    {
                        collect_strings(&decoded, depth + 1, out);
                    }
                }
                collect_strings(field, depth + 1, out);
            }
            _ => return,
        }
    }
}

fn read_varint(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    for (i, byte) in bytes.iter().enumerate().take(10) {
        value |= u64::from(byte & 0x7f) << (7 * i);
        if byte & 0x80 == 0 {
            return Some((value, i + 1));
        }
    }
    None
}

/// The refresh token inside the IDE's stored value.
pub(super) fn refresh_token_from_ide_value(value: &str) -> Option<String> {
    let outer = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .ok()?;
    let mut strings = Vec::new();
    collect_strings(&outer, 0, &mut strings);
    strings
        .into_iter()
        .find(|s| s.starts_with("1//") && s.len() > 20 && !s.contains(char::is_whitespace))
}

/// Copy the account Antigravity IDE is signed into. Reads the IDE's database
/// once; never writes it.
pub async fn import_from_ide() -> Result<AntigravityAuthStatus, String> {
    let path = ide_state_db().ok_or("Couldn't find where Antigravity IDE keeps its settings.")?;
    if !path.exists() {
        return Err(format!(
            "Antigravity IDE isn't installed for this user (no {}).",
            path.display()
        ));
    }
    let value = tokio::task::spawn_blocking(move || read_ide_token_value(&path))
        .await
        .map_err(|err| format!("Import task failed: {err}"))??;
    let refresh = refresh_token_from_ide_value(&value)
        .ok_or("Antigravity IDE's sign-in is in a format Aurora doesn't recognise.")?;
    let tokens = refresh_grant(&refresh).await?;
    finish_sign_in(&tokens, &refresh, AccountSource::AntigravityImport).await
}

// ---------------------------------------------------------------------------
// Browser sign-in (loopback)
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

struct PendingLogin {
    shutdown: oneshot::Sender<()>,
}

fn pending_login() -> &'static std::sync::Mutex<Option<PendingLogin>> {
    static PENDING: std::sync::OnceLock<std::sync::Mutex<Option<PendingLogin>>> =
        std::sync::OnceLock::new();
    PENDING.get_or_init(|| std::sync::Mutex::new(None))
}

const CALLBACK_PATH: &str = "/oauth-callback";

pub(super) fn authorize_url(redirect_uri: &str, challenge: &str, state: &str) -> String {
    let scope = LOGIN_SCOPES.join(" ");
    reqwest::Url::parse_with_params(
        GOOGLE_AUTHORIZE_URL,
        &[
            ("client_id", ANTIGRAVITY_CLIENT_ID),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri),
            ("scope", scope.as_str()),
            ("state", state),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            // A refresh token is only issued with offline access, and only
            // re-issued for an account that already granted it when consent
            // is shown again.
            ("access_type", "offline"),
            ("prompt", "consent select_account"),
        ],
    )
    .map(|url| url.to_string())
    .unwrap_or_default()
}

/// Start the browser sign-in. Binds a loopback port and returns the authorize
/// URL plus a receiver that resolves once the callback landed and the account
/// was saved. Any sign-in already waiting is cancelled first.
pub async fn begin_login() -> Result<
    (
        String,
        oneshot::Receiver<Result<AntigravityAuthStatus, String>>,
    ),
    String,
> {
    cancel_login();
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|err| format!("Couldn't open a local port for the sign-in: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Couldn't read the sign-in port: {err}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let verifier = b64url(&random_bytes::<32>());
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = b64url(&random_bytes::<16>());
    let url = authorize_url(&redirect_uri, &challenge, &state);

    let (done_tx, done_rx) = oneshot::channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    *pending_login().lock().unwrap_or_else(|p| p.into_inner()) = Some(PendingLogin {
        shutdown: shutdown_tx,
    });
    tokio::spawn(run_callback_server(
        listener,
        state,
        verifier,
        redirect_uri,
        done_tx,
        shutdown_rx,
    ));
    Ok((url, done_rx))
}

/// Abort a pending browser sign-in.
pub fn cancel_login() {
    if let Some(pending) = pending_login()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    {
        let _ = pending.shutdown.send(());
    }
}

async fn run_callback_server(
    listener: TcpListener,
    expected_state: String,
    verifier: String,
    redirect_uri: String,
    done: oneshot::Sender<Result<AntigravityAuthStatus, String>>,
    mut shutdown: oneshot::Receiver<()>,
) {
    let outcome = loop {
        let accepted = tokio::select! {
            _ = &mut shutdown => break Err("Sign-in was cancelled.".to_string()),
            accepted = listener.accept() => accepted,
        };
        let Ok((mut stream, _)) = accepted else {
            continue;
        };
        let mut buf = vec![0u8; 8192];
        let n = match stream.read(&mut buf).await {
            Ok(n) if n > 0 => n,
            _ => continue,
        };
        let request = String::from_utf8_lossy(&buf[..n]);
        let Some(target) = request.split_whitespace().nth(1) else {
            continue;
        };
        let Ok(url) = reqwest::Url::parse(&format!("http://127.0.0.1{target}")) else {
            continue;
        };
        if url.path() != CALLBACK_PATH {
            let _ = respond(&mut stream, 404, "Not found").await;
            continue;
        }
        let params: std::collections::HashMap<String, String> =
            url.query_pairs().into_owned().collect();

        if let Some(error) = params.get("error") {
            let message = params.get("error_description").unwrap_or(error).to_string();
            let _ = respond(&mut stream, 200, &error_page(&message)).await;
            break Err(message);
        }
        if params.get("state") != Some(&expected_state) {
            let _ = respond(
                &mut stream,
                400,
                &error_page("The sign-in link didn't match this session. Try again from Aurora."),
            )
            .await;
            break Err("The sign-in reply didn't match this session.".to_string());
        }
        let Some(code) = params.get("code") else {
            let _ = respond(
                &mut stream,
                400,
                &error_page("The sign-in reply was missing its code."),
            )
            .await;
            break Err("The sign-in reply was missing its code.".to_string());
        };

        let tokens = post_token(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &redirect_uri),
            ("client_id", ANTIGRAVITY_CLIENT_ID),
            ("client_secret", ANTIGRAVITY_CLIENT_SECRET),
            ("code_verifier", &verifier),
        ])
        .await;
        let result = match tokens {
            Ok(tokens) => {
                let refresh = tokens.refresh_token.clone().unwrap_or_default();
                finish_sign_in(&tokens, &refresh, AccountSource::SignIn).await
            }
            Err(err) => Err(format!("Signing in didn't complete: {err}")),
        };
        let page = match &result {
            Ok(_) => callback_page(
                "Signed in to Antigravity",
                "You can close this tab and return to Aurora.",
            ),
            Err(err) => error_page(err),
        };
        let _ = respond(&mut stream, 200, &page).await;
        break result;
    };

    *pending_login().lock().unwrap_or_else(|p| p.into_inner()) = None;
    let _ = done.send(outcome);
}

async fn respond(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn callback_page(title: &str, detail: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Aurora</title></head>\
         <body style=\"margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;\
         background:#101014;color:#e8e8ec;font-family:system-ui,-apple-system,'Segoe UI',sans-serif\">\
         <div style=\"text-align:center;max-width:420px;padding:24px\">\
         <div style=\"font-size:18px;font-weight:600;margin-bottom:8px\">{}</div>\
         <div style=\"font-size:14px;color:#9a9aa4;line-height:1.5\">{}</div>\
         </div></body></html>",
        html_escape(title),
        html_escape(detail)
    )
}

fn error_page(message: &str) -> String {
    callback_page("Sign-in didn't complete", message)
}

fn truncate(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(max).collect();
    format!("{head}\u{2026}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Protobuf length-delimited field `field` holding `payload`.
    fn ld(field: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![(field << 3) | 2];
        let mut len = payload.len();
        loop {
            let byte = (len & 0x7f) as u8;
            len >>= 7;
            if len == 0 {
                out.push(byte);
                break;
            }
            out.push(byte | 0x80);
        }
        out.extend_from_slice(payload);
        out
    }

    /// The IDE's shape: base64(outer{sentinel, inner-as-base64}), inner
    /// holding access token, token type, refresh token and an expiry varint.
    #[test]
    fn the_refresh_token_is_found_inside_the_ides_nested_value() {
        let mut inner = ld(1, b"ya29.access-token-value");
        inner.extend(ld(2, b"Bearer"));
        inner.extend(ld(3, b"1//0refresh-token-value-0123456789"));
        inner.extend([0x20, 0x96, 0x01]); // field 4, varint
        let inner_b64 = base64::engine::general_purpose::STANDARD.encode(&inner);
        let mut outer = ld(1, b"oauthTokenInfoSentinelKey");
        outer.extend(ld(2, &ld(1, inner_b64.as_bytes())));
        let value = base64::engine::general_purpose::STANDARD.encode(&outer);

        assert_eq!(
            refresh_token_from_ide_value(&value).as_deref(),
            Some("1//0refresh-token-value-0123456789")
        );
    }

    #[test]
    fn a_value_without_a_refresh_token_is_not_recognised() {
        let value = base64::engine::general_purpose::STANDARD.encode(ld(1, b"ya29.only-access"));
        assert!(refresh_token_from_ide_value(&value).is_none());
        assert!(refresh_token_from_ide_value("not base64 at all !!").is_none());
    }

    /// The shape the probe saw on a free account, plus the paid-tier case.
    #[test]
    fn code_assist_reply_gives_project_and_plan() {
        let free = json!({
            "currentTier": { "id": "free-tier", "name": "Antigravity Free" },
            "allowedTiers": [{ "id": "free-tier", "isDefault": true }],
            "cloudaicompanionProject": "useful-wave-1a2b3",
            "paidTier": { "id": "free-tier" }
        });
        let info = parse_code_assist(&free);
        assert_eq!(info.project_id.as_deref(), Some("useful-wave-1a2b3"));
        assert_eq!(info.tier_id.as_deref(), Some("free-tier"));
        assert_eq!(info.onboard_tier, "free-tier");

        let paid = json!({
            "currentTier": { "id": "free-tier" },
            "paidTier": { "id": "g1-pro-tier", "name": "Google AI Pro" },
            "cloudaicompanionProject": { "id": "p-9" }
        });
        let info = parse_code_assist(&paid);
        assert_eq!(info.project_id.as_deref(), Some("p-9"));
        assert_eq!(info.tier_name.as_deref(), Some("Google AI Pro"));
        assert_eq!(info.onboard_tier, "legacy-tier", "no default tier listed");
    }

    #[test]
    fn an_ineligible_account_says_why() {
        let info = parse_code_assist(&json!({
            "ineligibleTiers": [{ "reasonMessage": "Not available in your country." }]
        }));
        assert!(info.project_id.is_none());
        assert_eq!(
            info.ineligible.as_deref(),
            Some("Not available in your country.")
        );
    }

    #[test]
    fn authorize_url_asks_for_offline_access_with_pkce() {
        let url = authorize_url("http://127.0.0.1:5555/oauth-callback", "CHAL", "ST");
        let parsed = reqwest::Url::parse(&url).expect("valid url");
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], ANTIGRAVITY_CLIENT_ID);
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5555/oauth-callback");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["code_challenge"], "CHAL");
        assert_eq!(q["code_challenge_method"], "S256");
        assert!(q["scope"].contains("https://www.googleapis.com/auth/cloud-platform"));
    }

    #[test]
    fn invalid_grant_tells_the_user_to_sign_in_again() {
        let text = token_error_text(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#,
        );
        assert!(text.contains("Sign in again"), "{text}");
    }

    #[test]
    fn freshness_needs_a_token_and_five_minutes_left() {
        let now = 1_000_000_000;
        let mut auth = StoredAuth {
            access_token: "t".into(),
            expires_at_ms: now + 10 * 60 * 1000,
            ..StoredAuth::default()
        };
        assert!(auth.is_fresh(now));
        auth.expires_at_ms = now + 60 * 1000;
        assert!(!auth.is_fresh(now));
        auth.expires_at_ms = 0;
        assert!(!auth.is_fresh(now), "unknown expiry counts as expired");
    }
}
