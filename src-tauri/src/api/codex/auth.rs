//! Codex credential lifecycle — shared with Codex CLI.
//!
//! `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) is the single
//! source of truth. Design rules:
//!
//! - **Read-modify-write on the raw JSON.** The file is Codex CLI's; we
//!   only touch the keys we own (`tokens.*`, `last_refresh`) and preserve
//!   everything else verbatim so a CLI upgrade adding fields never loses
//!   data to Aurora's serializer.
//! - **Rotation-safe refresh.** OpenAI rotates refresh tokens. Refreshes
//!   are single-flight behind an async mutex, the file is re-read inside
//!   the lock (the CLI may have refreshed meanwhile), and the new pair is
//!   written back immediately so the CLI keeps working.
//! - **No Tauri types.** The browser open happens in the command layer;
//!   this module only knows tokens, PKCE, and a loopback listener.

use std::path::PathBuf;

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

use super::{CODEX_CLIENT_ID, CODEX_ISSUER};

/// Fixed OAuth loopback port — `http://localhost:1455/auth/callback` is
/// the redirect URI registered for the Codex client id.
const OAUTH_PORT: u16 = 1455;

/// Refresh when the access token has less than this long to live.
const REFRESH_SKEW_SECS: i64 = 60;

// ---------------------------------------------------------------------------
// Paths + file IO
// ---------------------------------------------------------------------------

/// `$CODEX_HOME` or `~/.codex`.
pub fn codex_home() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("CODEX_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir().map(|home| home.join(".codex"))
}

fn auth_file_path() -> Result<PathBuf, String> {
    codex_home()
        .map(|dir| dir.join("auth.json"))
        .ok_or_else(|| "Could not resolve the home directory.".to_string())
}

/// Read Codex CLI's own file. Only an import source now — see
/// [`read_auth_value`].
fn read_cli_auth_value() -> Result<Option<Value>, String> {
    let path = auth_file_path()?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Failed to read {}: {err}", path.display())),
    };
    serde_json::from_str::<Value>(&raw)
        .map(Some)
        .map_err(|err| format!("{} is not valid JSON: {err}", path.display()))
}

fn write_cli_auth_value(value: &Value) -> Result<(), String> {
    let path = auth_file_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    let rendered = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Failed to serialize credentials: {err}"))?;
    std::fs::write(&path, rendered)
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))
}

/// The credentials the next request should use.
///
/// Aurora's own account list wins when it has anything in it; Codex CLI's
/// `auth.json` is the fallback, which is what makes this change invisible to
/// someone with one account who never opens the switcher. Everything
/// downstream — `status`, `fresh_access`, the refresh race handling — is
/// unchanged, because an account stores the identical value shape.
fn read_auth_value() -> Result<Option<Value>, String> {
    let store = super::accounts::load();
    if let Some(active) = store.active(chrono::Utc::now().timestamp_millis()) {
        return Ok(Some(active.auth.clone()));
    }
    read_cli_auth_value()
}

/// Persist a rotated token pair.
///
/// Routed by the account id **inside the value**, not by whichever account is
/// active right now: a refresh that started before a failover has to land on
/// the account it was actually for, or it would overwrite the credentials of
/// the account that just took over.
fn write_auth_value(value: &Value) -> Result<(), String> {
    if let Some(account_id) = identity_of(value) {
        if super::accounts::load().get(&account_id).is_some() {
            return super::accounts::write_auth_for(&account_id, value.clone());
        }
    }
    write_cli_auth_value(value)
}

/// Stable identity for one set of credentials.
pub(super) fn identity_of(auth: &Value) -> Option<String> {
    let tokens = auth.get("tokens");
    if let Some(id) = tokens
        .and_then(|t| t.get("account_id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        return Some(id.to_string());
    }
    let id_token = tokens
        .and_then(|t| t.get("id_token"))
        .and_then(Value::as_str)?;
    account_id_from_claims(&jwt_claims(id_token)?)
}

/// Email and plan for the account list, straight from the id token.
pub(super) fn display_of(auth: &Value) -> (Option<String>, Option<String>) {
    let Some(id_token) = auth
        .get("tokens")
        .and_then(|t| t.get("id_token"))
        .and_then(Value::as_str)
    else {
        return (None, None);
    };
    let Some(claims) = jwt_claims(id_token) else {
        return (None, None);
    };
    (
        claim_str(&claims, "email"),
        openai_auth_claims(&claims).and_then(|a| claim_str(a, "chatgpt_plan_type")),
    )
}

/// Copy whatever Codex CLI is signed into onto Aurora's list, without
/// disturbing the CLI. Returns the account id.
pub fn import_from_cli() -> Result<String, String> {
    let auth = read_cli_auth_value()?
        .ok_or("Codex CLI is not signed in on this machine (no ~/.codex/auth.json).")?;
    if auth
        .get("tokens")
        .and_then(|t| t.get("id_token"))
        .and_then(Value::as_str)
        .is_none()
    {
        return Err(
            "Codex CLI is in API-key mode, not signed in to ChatGPT — nothing to import."
                .to_string(),
        );
    }
    super::accounts::upsert(auth)
}

// ---------------------------------------------------------------------------
// JWT claims
// ---------------------------------------------------------------------------

/// Decode a JWT's payload without verifying the signature — we only read
/// display metadata (email, plan) and the expiry of tokens we were handed
/// over TLS by the issuer itself.
fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn claim_str(claims: &Value, key: &str) -> Option<String> {
    claims.get(key)?.as_str().map(str::to_string)
}

/// The OpenAI-namespaced claim block (`https://api.openai.com/auth`).
fn openai_auth_claims(claims: &Value) -> Option<&Value> {
    claims.get("https://api.openai.com/auth")
}

fn account_id_from_claims(claims: &Value) -> Option<String> {
    claim_str(claims, "chatgpt_account_id")
        .or_else(|| openai_auth_claims(claims).and_then(|a| claim_str(a, "chatgpt_account_id")))
        .or_else(|| {
            claims
                .get("organizations")?
                .as_array()?
                .first()?
                .get("id")?
                .as_str()
                .map(str::to_string)
        })
}

fn access_token_expiry_unix(access_token: &str) -> Option<i64> {
    jwt_claims(access_token)?.get("exp")?.as_i64()
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// Sign-in state surfaced to the settings card. camelCase on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatus {
    pub signed_in: bool,
    /// `"chatgpt"` (subscription) or `"apikey"` when the CLI is in
    /// API-key mode (which Aurora does not route through this provider).
    pub auth_mode: Option<String>,
    pub email: Option<String>,
    /// ChatGPT plan, e.g. `"plus"`, `"pro"`, `"team"`.
    pub plan_type: Option<String>,
    pub account_id: Option<String>,
    pub last_refresh: Option<String>,
}

impl CodexAuthStatus {
    fn signed_out() -> Self {
        Self {
            signed_in: false,
            auth_mode: None,
            email: None,
            plan_type: None,
            account_id: None,
            last_refresh: None,
        }
    }
}

/// Current sign-in state, straight from `auth.json`.
pub fn status() -> Result<CodexAuthStatus, String> {
    let Some(auth) = read_auth_value()? else {
        return Ok(CodexAuthStatus::signed_out());
    };
    let tokens = auth.get("tokens");
    let id_token = tokens
        .and_then(|t| t.get("id_token"))
        .and_then(Value::as_str);
    let Some(id_token) = id_token else {
        // API-key-only file (or empty stub) — not a ChatGPT sign-in.
        return Ok(CodexAuthStatus {
            auth_mode: auth
                .get("auth_mode")
                .and_then(Value::as_str)
                .map(str::to_string),
            ..CodexAuthStatus::signed_out()
        });
    };
    let claims = jwt_claims(id_token).unwrap_or(Value::Null);
    let plan_type = openai_auth_claims(&claims).and_then(|a| claim_str(a, "chatgpt_plan_type"));
    Ok(CodexAuthStatus {
        signed_in: true,
        auth_mode: auth
            .get("auth_mode")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| Some("chatgpt".to_string())),
        email: claim_str(&claims, "email"),
        plan_type,
        account_id: tokens
            .and_then(|t| t.get("account_id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| account_id_from_claims(&claims)),
        last_refresh: auth
            .get("last_refresh")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Sign out of the account currently serving requests.
///
/// This used to `remove_file` Codex CLI's own `auth.json`, so signing out of
/// Codex in Aurora signed the user out of the CLI too — on a machine where
/// both are used daily, that is someone else's credentials being deleted by a
/// button that does not say so. Now it only drops Aurora's own entry. The CLI
/// file is deleted only in the legacy case where Aurora has no list of its own
/// and that file genuinely IS the credential Aurora was using.
pub fn logout() -> Result<(), String> {
    let store = super::accounts::load();
    if let Some(active) = store.active(chrono::Utc::now().timestamp_millis()) {
        return super::accounts::remove(&active.account_id);
    }
    let path = auth_file_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Failed to remove {}: {err}", path.display())),
    }
}

// ---------------------------------------------------------------------------
// Access tokens + refresh
// ---------------------------------------------------------------------------

/// What the adapter needs to authenticate one request.
#[derive(Debug, Clone)]
pub struct CodexAccess {
    pub access_token: String,
    pub account_id: Option<String>,
}

fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn access_from_value(auth: &Value) -> Option<CodexAccess> {
    let tokens = auth.get("tokens")?;
    let access_token = tokens.get("access_token")?.as_str()?.to_string();
    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            tokens
                .get("id_token")
                .and_then(Value::as_str)
                .and_then(jwt_claims)
                .as_ref()
                .and_then(account_id_from_claims)
        });
    Some(CodexAccess {
        access_token,
        account_id,
    })
}

fn access_is_fresh(access: &CodexAccess) -> bool {
    match access_token_expiry_unix(&access.access_token) {
        Some(exp) => exp - chrono::Utc::now().timestamp() > REFRESH_SKEW_SECS,
        // No parseable expiry — assume usable and let a 401 trigger the
        // forced refresh path.
        None => true,
    }
}

const SIGNED_OUT_MSG: &str =
    "Not signed in to ChatGPT. Open Settings \u{2192} Providers \u{2192} Codex and sign in.";

/// A valid access token, refreshing through the OAuth token endpoint when
/// the stored one is expired (or `force` is set, e.g. after a 401).
pub async fn fresh_access(force: bool) -> Result<CodexAccess, String> {
    let auth = read_auth_value()?.ok_or(SIGNED_OUT_MSG)?;
    if let Some(access) = access_from_value(&auth) {
        if !force && access_is_fresh(&access) {
            return Ok(access);
        }
    } else {
        return Err(SIGNED_OUT_MSG.to_string());
    }

    let _guard = refresh_lock().lock().await;

    // Re-read inside the lock: a parallel Aurora turn — or Codex CLI
    // itself — may have already rotated the pair.
    let auth = read_auth_value()?.ok_or(SIGNED_OUT_MSG)?;
    let access = access_from_value(&auth).ok_or(SIGNED_OUT_MSG)?;
    if !force && access_is_fresh(&access) {
        return Ok(access);
    }

    let refresh_token = auth
        .get("tokens")
        .and_then(|t| t.get("refresh_token"))
        .and_then(Value::as_str)
        .ok_or("Stored ChatGPT credentials have no refresh token — sign in again.")?
        .to_string();

    match request_refresh(&refresh_token).await {
        Ok(tokens) => {
            let updated = apply_token_response(auth, &tokens)?;
            write_auth_value(&updated)?;
            access_from_value(&updated).ok_or_else(|| "Refresh produced no tokens.".to_string())
        }
        Err(err) => {
            // Rotation race: if the CLI refreshed between our read and the
            // request, our refresh token is stale but the file now holds a
            // fresh pair. Use it instead of failing the turn.
            if let Some(current) = read_auth_value()?.as_ref().and_then(access_from_value) {
                if current.access_token != access.access_token && access_is_fresh(&current) {
                    return Ok(current);
                }
            }
            Err(format!(
                "ChatGPT token refresh failed: {err}. Sign in again from Settings \u{2192} Providers \u{2192} Codex."
            ))
        }
    }
}

/// A valid access token for ONE named account, refreshing if needed.
///
/// [`fresh_access`] answers "who is serving requests right now"; this answers
/// "this specific account", which is what the switcher needs to show four
/// usage bars without making any of them the active one. Refreshing as a side
/// effect is deliberate and free: the card is usually the first thing opened
/// after a break, so the accounts are warm by the time one is picked.
pub async fn fresh_access_for(account_id: &str, force: bool) -> Result<CodexAccess, String> {
    let read = |id: &str| -> Result<Value, String> {
        super::accounts::load()
            .get(id)
            .map(|a| a.auth.clone())
            .ok_or_else(|| format!("No stored Codex account {id}."))
    };

    let auth = read(account_id)?;
    let access = access_from_value(&auth).ok_or("Those stored credentials have no access token.")?;
    if !force && access_is_fresh(&access) {
        return Ok(access);
    }

    let _guard = refresh_lock().lock().await;
    // Re-read inside the lock — a turn running on this account may have
    // rotated the pair while we waited.
    let auth = read(account_id)?;
    let access = access_from_value(&auth).ok_or("Those stored credentials have no access token.")?;
    if !force && access_is_fresh(&access) {
        return Ok(access);
    }

    let refresh_token = auth
        .get("tokens")
        .and_then(|t| t.get("refresh_token"))
        .and_then(Value::as_str)
        .ok_or("Those stored credentials have no refresh token — sign in to that account again.")?
        .to_string();

    let tokens = request_refresh(&refresh_token)
        .await
        .map_err(|err| format!("Token refresh failed for that account: {err}"))?;
    let updated = apply_token_response(auth, &tokens)?;
    super::accounts::write_auth_for(account_id, updated.clone())?;
    access_from_value(&updated).ok_or_else(|| "Refresh produced no tokens.".to_string())
}

#[derive(Debug, serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    #[allow(dead_code)]
    expires_in: Option<u64>,
}

async fn request_refresh(refresh_token: &str) -> Result<TokenResponse, String> {
    let response = reqwest::Client::new()
        .post(format!("{CODEX_ISSUER}/oauth/token"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CODEX_CLIENT_ID),
        ])
        .send()
        .await
        .map_err(|err| format!("network error: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", truncate(&body, 200)));
    }
    response
        .json::<TokenResponse>()
        .await
        .map_err(|err| format!("bad token response: {err}"))
}

/// Merge a token response into the raw `auth.json` value, preserving every
/// key we don't own.
fn apply_token_response(mut auth: Value, tokens: &TokenResponse) -> Result<Value, String> {
    if !auth.is_object() {
        auth = json!({});
    }
    let obj = auth.as_object_mut().expect("ensured object above");
    obj.insert("auth_mode".into(), json!("chatgpt"));
    obj.insert(
        "last_refresh".into(),
        json!(chrono::Utc::now().to_rfc3339()),
    );
    let tokens_slot = obj.entry("tokens").or_insert_with(|| json!({}));
    if !tokens_slot.is_object() {
        *tokens_slot = json!({});
    }
    let t = tokens_slot.as_object_mut().expect("ensured object above");
    t.insert("access_token".into(), json!(tokens.access_token));
    if let Some(refresh) = &tokens.refresh_token {
        t.insert("refresh_token".into(), json!(refresh));
    }
    if let Some(id_token) = &tokens.id_token {
        t.insert("id_token".into(), json!(id_token));
        if let Some(account_id) = jwt_claims(id_token)
            .as_ref()
            .and_then(account_id_from_claims)
        {
            t.insert("account_id".into(), json!(account_id));
        }
    }
    Ok(auth)
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
// Browser (PKCE) login
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

/// Start the browser sign-in flow.
///
/// Binds the loopback listener, and returns the authorize URL (for the
/// command layer to open in the system browser) plus a receiver that
/// resolves once the callback landed and `auth.json` was written. Any
/// previously pending login is aborted first.
pub async fn begin_login() -> Result<(String, oneshot::Receiver<Result<(), String>>), String> {
    cancel_login();

    let verifier = b64url(&random_bytes::<32>());
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = b64url(&random_bytes::<16>());
    let redirect_uri = format!("http://localhost:{OAUTH_PORT}/auth/callback");

    let listener = TcpListener::bind(("127.0.0.1", OAUTH_PORT))
        .await
        .map_err(|err| {
            format!(
                "Couldn't open the sign-in port ({OAUTH_PORT}): {err}. \
                 Close any other Codex sign-in in progress and try again."
            )
        })?;

    let auth_url = format!(
        "{CODEX_ISSUER}/oauth/authorize?{}",
        url_query(&[
            ("response_type", "code"),
            ("client_id", CODEX_CLIENT_ID),
            ("redirect_uri", &redirect_uri),
            ("scope", "openid profile email offline_access"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("state", &state),
            ("originator", super::CODEX_ORIGINATOR),
        ])
    );

    let (done_tx, done_rx) = oneshot::channel::<Result<(), String>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
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

    Ok((auth_url, done_rx))
}

/// Abort a pending browser login (drops the listener; the awaiting
/// command resolves with a cancellation error).
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
    done: oneshot::Sender<Result<(), String>>,
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

        let (path, query) = match target.split_once('?') {
            Some((path, query)) => (path, query),
            None => (target, ""),
        };
        if path != "/auth/callback" {
            let _ = respond(&mut stream, 404, "Not found").await;
            continue;
        }

        let params = parse_query(query);
        if let Some(error) = params.get("error") {
            let message = params.get("error_description").unwrap_or(error).to_string();
            let _ = respond(&mut stream, 200, &error_page(&message)).await;
            break Err(message);
        }
        if params.get("state").map(String::as_str) != Some(expected_state.as_str()) {
            let _ = respond(
                &mut stream,
                400,
                &error_page("The sign-in link didn't match this session. Try again from Aurora."),
            )
            .await;
            break Err("State mismatch on OAuth callback.".to_string());
        }
        let Some(code) = params.get("code") else {
            let _ = respond(
                &mut stream,
                400,
                &error_page("The sign-in response was missing its authorization code."),
            )
            .await;
            break Err("Missing authorization code.".to_string());
        };

        match exchange_code(code, &verifier, &redirect_uri).await {
            Ok(tokens) => {
                // Built from an empty object, NOT from whatever is signed in
                // now: this callback may be adding a second account, and
                // merging one account's tokens into another's stored blob is
                // how you end up with an entry whose id and credentials
                // disagree. `apply_token_response` writes every field a
                // sign-in owns, so there is nothing to inherit.
                //
                // It also lands in Aurora's own list rather than Codex CLI's
                // file, so adding an account here never signs the CLI out of
                // the one it was using.
                let result = apply_token_response(json!({}), &tokens)
                    .and_then(super::accounts::upsert)
                    .map(|_| ());
                match result {
                    Ok(()) => {
                        let _ = respond(&mut stream, 200, &success_page()).await;
                        break Ok(());
                    }
                    Err(err) => {
                        let _ = respond(
                            &mut stream,
                            200,
                            &error_page(
                                "Aurora couldn't save the sign-in. Check the app and try again.",
                            ),
                        )
                        .await;
                        break Err(err);
                    }
                }
            }
            Err(err) => {
                let _ = respond(
                    &mut stream,
                    200,
                    &error_page("Signing in didn't complete. Return to Aurora and try again."),
                )
                .await;
                break Err(format!("Token exchange failed: {err}"));
            }
        }
    };

    *pending_login().lock().unwrap_or_else(|p| p.into_inner()) = None;
    let _ = done.send(outcome);
}

async fn exchange_code(
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let response = reqwest::Client::new()
        .post(format!("{CODEX_ISSUER}/oauth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", CODEX_CLIENT_ID),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|err| format!("network error: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", truncate(&body, 200)));
    }
    response
        .json::<TokenResponse>()
        .await
        .map_err(|err| format!("bad token response: {err}"))
}

// ---------------------------------------------------------------------------
// Tiny HTTP helpers (single-request loopback server)
// ---------------------------------------------------------------------------

fn url_query(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
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

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((percent_decode(k), percent_decode(v)))
        })
        .collect()
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

fn callback_page(title: &str, detail: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Aurora</title></head>\
         <body style=\"margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;\
         background:#101014;color:#e8e8ec;font-family:system-ui,-apple-system,'Segoe UI',sans-serif\">\
         <div style=\"text-align:center;max-width:420px;padding:24px\">\
         <div style=\"font-size:18px;font-weight:600;margin-bottom:8px\">{title}</div>\
         <div style=\"font-size:14px;color:#9a9aa4;line-height:1.5\">{detail}</div>\
         </div></body></html>"
    )
}

fn success_page() -> String {
    callback_page(
        "Signed in to ChatGPT",
        "You can close this tab and return to Aurora.",
    )
}

fn error_page(message: &str) -> String {
    callback_page("Sign-in didn't complete", message)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Unsigned JWT with the given JSON payload, for claim parsing tests.
    fn fake_jwt(payload: Value) -> String {
        let header = b64url(br#"{"alg":"none"}"#);
        let body = b64url(payload.to_string().as_bytes());
        format!("{header}.{body}.sig")
    }

    #[test]
    fn jwt_claims_roundtrip() {
        let token = fake_jwt(json!({ "email": "dev@example.com", "exp": 1234 }));
        let claims = jwt_claims(&token).expect("claims");
        assert_eq!(
            claim_str(&claims, "email").as_deref(),
            Some("dev@example.com")
        );
        assert_eq!(access_token_expiry_unix(&token), Some(1234));
        assert!(jwt_claims("not-a-jwt").is_none());
    }

    #[test]
    fn account_id_prefers_direct_then_namespaced_then_org() {
        let direct = json!({ "chatgpt_account_id": "acct_direct" });
        assert_eq!(
            account_id_from_claims(&direct).as_deref(),
            Some("acct_direct")
        );

        let namespaced =
            json!({ "https://api.openai.com/auth": { "chatgpt_account_id": "acct_ns" } });
        assert_eq!(
            account_id_from_claims(&namespaced).as_deref(),
            Some("acct_ns")
        );

        let org = json!({ "organizations": [{ "id": "org_1" }] });
        assert_eq!(account_id_from_claims(&org).as_deref(), Some("org_1"));
    }

    #[test]
    fn apply_token_response_preserves_unknown_keys() {
        let existing = json!({
            "auth_mode": "chatgpt",
            "cli_only_field": { "keep": true },
            "tokens": { "refresh_token": "old_refresh", "custom": "keep-me" }
        });
        let tokens = TokenResponse {
            access_token: "new_access".into(),
            refresh_token: Some("new_refresh".into()),
            id_token: Some(fake_jwt(json!({ "chatgpt_account_id": "acct_1" }))),
            expires_in: Some(3600),
        };
        let merged = apply_token_response(existing, &tokens).expect("merge");
        assert_eq!(merged["cli_only_field"]["keep"], true);
        assert_eq!(merged["tokens"]["custom"], "keep-me");
        assert_eq!(merged["tokens"]["access_token"], "new_access");
        assert_eq!(merged["tokens"]["refresh_token"], "new_refresh");
        assert_eq!(merged["tokens"]["account_id"], "acct_1");
        assert!(merged["last_refresh"].is_string());
    }

    #[test]
    fn query_encode_decode_roundtrip() {
        let raw = "a b+c/d=e&f";
        assert_eq!(percent_decode(&percent_encode(raw)), raw);
        let parsed = parse_query("code=abc%2F1&state=x+y");
        assert_eq!(parsed.get("code").map(String::as_str), Some("abc/1"));
        assert_eq!(parsed.get("state").map(String::as_str), Some("x y"));
    }
}
