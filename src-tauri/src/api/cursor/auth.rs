//! Cursor credential lifecycle.
//!
//! Two stores, one direction, and a sign-in of our own:
//!
//! - **Cursor's own `state.vscdb`** (the desktop editor's globalStorage
//!   SQLite) is a *seed*. It holds `cursorAuth/accessToken`,
//!   `cursorAuth/refreshToken`, and display metadata. Aurora opens it
//!   **read-only** and never writes to it. Since Cursor's 2026-10 update the
//!   editor keeps its session there in a form that is not a bearer token any
//!   more (631 opaque characters, no JWT segments), so the seed is only used
//!   when it still parses as a JWT; otherwise the card says so and offers the
//!   browser sign-in.
//! - **The browser sign-in** ([`begin_login`] / [`wait_login`]) is Cursor's
//!   own CLI deep-link flow: a PKCE challenge on `cursor.com/loginDeepControl`,
//!   approved in any browser, then `api2.cursor.sh/auth/poll` hands back a
//!   real access/refresh pair. Probed live on 2026-10-29 (a 60-day session
//!   JWT, a refresh JWT, and the usage endpoint answering with the plan).
//! - **`<root>/auth/cursor-auth.json`** is Aurora's own store. Everything we
//!   sign in to or rotate lands here.
//!
//! This is the opposite of [`crate::api::codex::auth`], which writes back into
//! `~/.codex/auth.json` so the Codex CLI keeps working. The asymmetry is
//! deliberate: `auth.json` is a small JSON file Codex CLI expects third
//! parties to touch, whereas `state.vscdb` is a live database backing a
//! running editor. A write race there corrupts someone's Cursor install, and
//! no amount of convenience is worth that.
//!
//! Because both sides can rotate independently — Cursor refreshes when the
//! user opens the editor, we refresh when a turn needs a token — [`load`]
//! reconciles them by expiry and takes whichever token lives longer.
//!
//! No Tauri types here; the command layer wraps this.

use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;

use super::{
    CURSOR_API_BASE, CURSOR_LOGIN_URL, CURSOR_POLL_PATH, CURSOR_REFRESH_PATH,
};

/// Refresh when the access token has less than this long to live. Cursor's
/// session tokens are ~2 months, so a wide skew costs nothing and keeps a
/// long-running turn from expiring mid-stream.
const REFRESH_SKEW_SECS: i64 = 30 * 60;

/// The `ItemTable` keys Cursor stores its session under.
const KEY_ACCESS: &str = "cursorAuth/accessToken";
const KEY_REFRESH: &str = "cursorAuth/refreshToken";
const KEY_EMAIL: &str = "cursorAuth/cachedEmail";
const KEY_MEMBERSHIP: &str = "cursorAuth/stripeMembershipType";

const SIGNED_OUT_MSG: &str = "Not signed in to Cursor. Open Settings \u{2192} Providers \
                              \u{2192} Cursor and sign in with your browser.";

/// How long a browser sign-in may stay unapproved before it is given up.
pub const LOGIN_TIMEOUT_SECS: u64 = 300;

// ---------------------------------------------------------------------------
// Aurora's own store
// ---------------------------------------------------------------------------

/// What Aurora persists about a Cursor sign-in. Snake_case on disk — this
/// file is ours, not a wire payload.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredCredentials {
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    /// Cursor's Stripe membership slug, e.g. `pro`, `pro_plus`, `free_trial`.
    #[serde(default)]
    pub membership: Option<String>,
    /// RFC3339, set when *Aurora* last rotated the pair. `None` means the
    /// tokens came straight from the Cursor install and we have not yet had
    /// to refresh them.
    #[serde(default)]
    pub last_refresh: Option<String>,
}

impl StoredCredentials {
    fn is_usable(&self) -> bool {
        !self.access_token.trim().is_empty()
    }
}

fn store_path() -> PathBuf {
    crate::paths::auth_dir().join("cursor-auth.json")
}

fn read_store() -> Result<Option<StoredCredentials>, String> {
    let path = store_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Failed to read {}: {err}", path.display())),
    };
    match serde_json::from_str::<StoredCredentials>(&raw) {
        Ok(creds) if creds.is_usable() => Ok(Some(creds)),
        // A truncated or hand-mangled store is not worth failing a turn over
        // — the Cursor install can re-seed it. Treat it as absent.
        _ => Ok(None),
    }
}

fn write_store(creds: &StoredCredentials) -> Result<(), String> {
    let path = store_path();
    let rendered = serde_json::to_string_pretty(creds)
        .map_err(|err| format!("Failed to serialize Cursor credentials: {err}"))?;
    // Write-then-rename so a crash mid-write cannot leave a half file that
    // reads as "signed out" on next launch.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, rendered)
        .map_err(|err| format!("Failed to write {}: {err}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|err| format!("Failed to replace {}: {err}", path.display()))?;
    restrict_permissions(&path);
    Ok(())
}

/// Owner-only on Unix. Windows inherits the parent ACL, which is already
/// per-user under `%LOCALAPPDATA%`.
#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {}

fn clear_store() -> Result<(), String> {
    let path = store_path();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Failed to remove {}: {err}", path.display())),
    }
}

// ---------------------------------------------------------------------------
// Cursor's install
// ---------------------------------------------------------------------------

/// Where the Cursor desktop app keeps `state.vscdb`.
///
/// `CURSOR_STATE_DB` overrides it, which is what makes a portable or
/// non-standard install reachable without a code change.
pub fn cursor_state_db() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("CURSOR_STATE_DB") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    let suffix = ["Cursor", "User", "globalStorage", "state.vscdb"];

    #[cfg(target_os = "windows")]
    let base = dirs::config_dir(); // %APPDATA%

    #[cfg(target_os = "macos")]
    let base = dirs::home_dir().map(|h| h.join("Library").join("Application Support"));

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let base = dirs::config_dir(); // ~/.config

    Some(suffix.iter().fold(base?, |acc, part| acc.join(part)))
}

/// What the Cursor install told us besides a usable token: whether it is
/// there at all, whether its session is in a form Aurora cannot use, and the
/// display metadata that is readable either way.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallInfo {
    pub detected: bool,
    /// The editor is signed in, but its stored session is not a bearer token
    /// Aurora can send (Cursor's 2026-10 format). The browser sign-in is the
    /// way in.
    pub session_unusable: bool,
    pub email: Option<String>,
    pub membership: Option<String>,
}

/// Read the four `cursorAuth/*` keys out of Cursor's SQLite.
///
/// Opened read-only. If that fails — Cursor is running and the WAL sidecar
/// isn't readable, most likely — the file is copied to a scratch path and
/// read from there rather than giving up, because "sign in to Cursor" is
/// unhelpful advice when the user plainly *is* signed in.
fn read_cursor_install_full() -> Result<(Option<StoredCredentials>, InstallInfo), String> {
    let Some(db) = cursor_state_db() else {
        return Ok((None, InstallInfo::default()));
    };
    if !db.is_file() {
        return Ok((None, InstallInfo::default()));
    }
    let rows = match query_item_table(&db) {
        Ok(rows) => rows,
        Err(direct_err) => {
            let scratch = crate::paths::auth_dir().join("cursor-state.snapshot.vscdb");
            std::fs::copy(&db, &scratch).map_err(|copy_err| {
                format!(
                    "Could not read Cursor's session database ({direct_err}), and copying it \
                     failed too: {copy_err}"
                )
            })?;
            let copied = query_item_table(&scratch);
            let _ = std::fs::remove_file(&scratch);
            copied?
        }
    };
    Ok(install_from_rows(&rows))
}

/// Interpret the install's rows. A session is usable only when its access
/// token is a JWT: that is what Cursor's servers take as a bearer, and what
/// the editor stored until its 2026-10 update. Anything else is reported as
/// present-but-unusable so the card can send the user to the browser
/// sign-in instead of "connecting" a token that 401s on every call.
fn install_from_rows(
    rows: &std::collections::HashMap<String, String>,
) -> (Option<StoredCredentials>, InstallInfo) {
    let email = non_empty(rows.get(KEY_EMAIL));
    let membership = non_empty(rows.get(KEY_MEMBERSHIP));
    let access = rows.get(KEY_ACCESS).cloned().unwrap_or_default();
    let mut info = InstallInfo {
        detected: true,
        session_unusable: false,
        email: email.clone(),
        membership: membership.clone(),
    };
    if access.trim().is_empty() {
        return (None, info);
    }
    if jwt_claims(&access).is_none() {
        info.session_unusable = true;
        return (None, info);
    }
    (
        Some(StoredCredentials {
            access_token: access,
            refresh_token: non_empty(rows.get(KEY_REFRESH)),
            email,
            membership,
            last_refresh: None,
        }),
        info,
    )
}

fn non_empty(value: Option<&String>) -> Option<String> {
    value
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn query_item_table(
    db: &std::path::Path,
) -> Result<std::collections::HashMap<String, String>, String> {
    use rusqlite::{Connection, OpenFlags};

    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|err| format!("open {}: {err}", db.display()))?;

    let mut stmt = conn
        .prepare("SELECT key, value FROM ItemTable WHERE key IN (?1, ?2, ?3, ?4)")
        .map_err(|err| format!("prepare: {err}"))?;

    let rows = stmt
        .query_map(
            rusqlite::params![KEY_ACCESS, KEY_REFRESH, KEY_EMAIL, KEY_MEMBERSHIP],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|err| format!("query: {err}"))?;

    let mut out = std::collections::HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|err| format!("read row: {err}"))?;
        out.insert(key, unquote_json_string(&value));
    }
    Ok(out)
}

/// VS Code's `ItemTable` stores some values as JSON, so a token can arrive
/// either bare or wrapped in quotes. Unwrap only the string case; anything
/// else is passed through untouched.
fn unquote_json_string(raw: &str) -> String {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::String(inner)) => inner,
        _ => raw.to_string(),
    }
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

/// Decode a JWT payload without verifying the signature. We only read the
/// expiry of a token the issuer handed us over TLS — this is not a trust
/// decision, it is "should I refresh before spending a turn on it".
fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn expiry_unix(token: &str) -> Option<i64> {
    jwt_claims(token)?.get("exp")?.as_i64()
}

fn expires_at_rfc3339(token: &str) -> Option<String> {
    let exp = expiry_unix(token)?;
    chrono::DateTime::from_timestamp(exp, 0).map(|dt| dt.to_rfc3339())
}

fn is_fresh(token: &str) -> bool {
    match expiry_unix(token) {
        Some(exp) => exp - chrono::Utc::now().timestamp() > REFRESH_SKEW_SECS,
        // Unparseable expiry — assume usable and let a 401 force the refresh.
        None => true,
    }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/// Best available credentials, reconciling Aurora's store against the Cursor
/// install.
///
/// Both sides rotate independently, so "newest wins" is decided by token
/// expiry rather than file mtime — mtime moves when Cursor rewrites unrelated
/// keys in the same database.
pub fn load() -> Result<Option<StoredCredentials>, String> {
    load_full().map(|(creds, _)| creds)
}

/// [`load`], plus what the Cursor install reported about itself.
pub fn load_full() -> Result<(Option<StoredCredentials>, InstallInfo), String> {
    let ours = read_store()?;
    // A missing or unreadable Cursor install is not an error: the user may
    // have signed in through Aurora and since uninstalled the editor.
    let (theirs, info) = read_cursor_install_full().unwrap_or_default();

    Ok((reconcile(ours, theirs), info))
}

fn reconcile(
    ours: Option<StoredCredentials>,
    theirs: Option<StoredCredentials>,
) -> Option<StoredCredentials> {
    match (ours, theirs) {
        (None, None) => None,
        (Some(ours), None) => Some(ours),
        (None, Some(theirs)) => Some(theirs),
        (Some(ours), Some(theirs)) => {
            let ours_exp = expiry_unix(&ours.access_token).unwrap_or(i64::MIN);
            let theirs_exp = expiry_unix(&theirs.access_token).unwrap_or(i64::MIN);
            if theirs_exp > ours_exp {
                // Cursor refreshed more recently. Adopt its tokens but keep
                // the display metadata we already have if the install lost it.
                Some(StoredCredentials {
                    email: theirs.email.or(ours.email),
                    membership: theirs.membership.or(ours.membership),
                    ..theirs
                })
            } else {
                Some(StoredCredentials {
                    email: ours.email.or(theirs.email),
                    membership: ours.membership.or(theirs.membership),
                    ..ours
                })
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// Sign-in state for the settings card. camelCase on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAuthStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    /// Raw membership slug (`pro`, `pro_plus`, …). The frontend renders the
    /// label; keeping the slug means a plan Cursor adds tomorrow still shows
    /// something truthful rather than being mapped to "Unknown" here.
    pub membership: Option<String>,
    /// RFC3339 expiry of the current access token, when it carries one.
    pub expires_at: Option<String>,
    pub has_refresh_token: bool,
    /// Whether a Cursor desktop install was found to seed from.
    pub cursor_app_detected: bool,
    /// The install is signed in, but its session is in a form Aurora cannot
    /// send (Cursor's 2026-10 format): "Connect" cannot work, the browser
    /// sign-in can.
    pub cursor_app_session_unusable: bool,
    pub last_refresh: Option<String>,
}

impl CursorAuthStatus {
    fn signed_out(install: &InstallInfo) -> Self {
        Self {
            signed_in: false,
            email: None,
            membership: None,
            expires_at: None,
            has_refresh_token: false,
            cursor_app_detected: install.detected,
            cursor_app_session_unusable: install.session_unusable,
            last_refresh: None,
        }
    }
}

pub fn status() -> Result<CursorAuthStatus, String> {
    let (creds, install) = load_full()?;
    let Some(creds) = creds else {
        return Ok(CursorAuthStatus::signed_out(&install));
    };
    Ok(CursorAuthStatus {
        signed_in: true,
        email: creds.email.clone(),
        membership: creds.membership.clone(),
        expires_at: expires_at_rfc3339(&creds.access_token),
        has_refresh_token: creds
            .refresh_token
            .as_deref()
            .is_some_and(|t| !t.trim().is_empty()),
        cursor_app_detected: install.detected,
        cursor_app_session_unusable: install.session_unusable,
        last_refresh: creds.last_refresh.clone(),
    })
}

/// Copy the Cursor install's session into Aurora's own store.
///
/// Called by the settings card's "Connect" action. Aurora reads the install
/// on every [`load`] anyway, so this exists to give the user an explicit,
/// visible moment of consent rather than silently adopting a token the first
/// time a turn runs.
pub fn adopt_from_cursor_app() -> Result<CursorAuthStatus, String> {
    let (creds, install) = read_cursor_install_full()?;
    let Some(creds) = creds else {
        return Err(if install.session_unusable {
            "Your Cursor app is signed in, but since its latest update it keeps its session \
             in a form Aurora can't use. Sign in with your browser instead."
                .to_string()
        } else {
            "No Cursor session found. Sign in with your browser, or sign in to the Cursor \
             app first and try again."
                .to_string()
        });
    };
    write_store(&creds)?;
    status()
}

// ---------------------------------------------------------------------------
// Browser sign-in (Cursor's CLI deep-link flow)
// ---------------------------------------------------------------------------

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// One sign-in attempt: the page to approve and the secret that proves, at
/// poll time, that this process is the one that opened it.
#[derive(Debug, Clone)]
pub struct LoginAttempt {
    pub url: String,
    pub uuid: String,
    pub verifier: String,
}

/// A fresh PKCE pair and attempt id, and the page built from them.
#[must_use]
pub fn new_login_attempt() -> LoginAttempt {
    use rand::RngCore;
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let verifier = b64url(&raw);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let uuid = uuid::Uuid::new_v4().to_string();
    // Every value is URL-safe already (base64url and a UUID), so no encoding.
    let url = format!(
        "{CURSOR_LOGIN_URL}?challenge={challenge}&uuid={uuid}&mode=login&redirectTarget=cli"
    );
    LoginAttempt { url, uuid, verifier }
}

/// What one poll of `/auth/poll` said.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PollOutcome {
    /// Not approved yet (404 or 202, or a 2xx with no token in it).
    Pending,
    /// The sign-in landed.
    Tokens {
        access_token: String,
        refresh_token: Option<String>,
    },
    /// Cursor answered with something other than "not yet"; logged and
    /// retried, because the script this mirrors does the same and a passing
    /// 5xx must not end a sign-in the user is in the middle of.
    Odd(String),
}

fn parse_poll(status: u16, body: &str) -> PollOutcome {
    match status {
        202 | 404 => PollOutcome::Pending,
        200..=299 => {
            let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
            let access = value
                .get("accessToken")
                .or_else(|| value.get("apiKey"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|t| !t.is_empty());
            match access {
                Some(access) => PollOutcome::Tokens {
                    access_token: access.to_string(),
                    refresh_token: value
                        .get("refreshToken")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(str::to_string),
                },
                None => PollOutcome::Pending,
            }
        }
        other => PollOutcome::Odd(format!("HTTP {other} {}", truncate(body, 200))),
    }
}

struct PendingLogin {
    cancel: CancellationToken,
    /// Taken by [`wait_login`]; `None` once someone is waiting.
    done: Option<oneshot::Receiver<Result<CursorAuthStatus, String>>>,
}

fn pending_login() -> &'static std::sync::Mutex<Option<PendingLogin>> {
    static PENDING: std::sync::OnceLock<std::sync::Mutex<Option<PendingLogin>>> =
        std::sync::OnceLock::new();
    PENDING.get_or_init(|| std::sync::Mutex::new(None))
}

/// Start a browser sign-in and return the page to open.
///
/// Polling starts at once in the background and keeps going for
/// [`LOGIN_TIMEOUT_SECS`] whether or not anyone calls [`wait_login`]: a
/// sign-in approved while the card was closed still lands in the store. Any
/// earlier attempt is cancelled first.
pub fn begin_login() -> String {
    cancel_login();
    let attempt = new_login_attempt();
    let cancel = CancellationToken::new();
    let (done_tx, done_rx) = oneshot::channel();
    *pending_login().lock().unwrap_or_else(|p| p.into_inner()) = Some(PendingLogin {
        cancel: cancel.clone(),
        done: Some(done_rx),
    });
    let url = attempt.url.clone();
    tokio::spawn(async move {
        let result = poll_until_signed_in(attempt, cancel).await;
        let _ = done_tx.send(result);
    });
    url
}

/// Hold for the attempt started by [`begin_login`] to finish, one way or
/// another. A second waiter on the same attempt, or a wait with no attempt,
/// gets an error rather than hanging.
pub async fn wait_login() -> Result<CursorAuthStatus, String> {
    let done = pending_login()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_mut()
        .and_then(|pending| pending.done.take())
        .ok_or("No Cursor sign-in is in progress. Start one first.")?;
    match done.await {
        Ok(result) => result,
        Err(_) => Err("Sign-in was cancelled.".to_string()),
    }
}

/// Abort a pending browser sign-in. Safe when none is running.
pub fn cancel_login() {
    if let Some(pending) = pending_login()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    {
        pending.cancel.cancel();
    }
}

/// Poll `/auth/poll` until the page was approved, the attempt was cancelled,
/// or the timeout passed. Backs off from 1 s to 5 s between polls, the way
/// Cursor's own CLI does. On success the pair is written to Aurora's store
/// with the display metadata the install can still provide.
async fn poll_until_signed_in(
    attempt: LoginAttempt,
    cancel: CancellationToken,
) -> Result<CursorAuthStatus, String> {
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|err| format!("build HTTP client: {err}"))?;
    let poll_url = format!(
        "{CURSOR_API_BASE}{CURSOR_POLL_PATH}?uuid={}&verifier={}",
        attempt.uuid, attempt.verifier
    );
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(LOGIN_TIMEOUT_SECS);
    let mut interval_ms: u64 = 1000;
    let mut network_errors = 0u32;

    loop {
        if cancel.is_cancelled() {
            return Err("Sign-in was cancelled.".to_string());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Sign-in timed out before it was approved in the browser. Try again."
                .to_string());
        }
        let outcome = match http
            .get(&poll_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
        {
            Ok(response) => {
                network_errors = 0;
                let status = response.status().as_u16();
                let body = response.text().await.unwrap_or_default();
                parse_poll(status, &body)
            }
            Err(err) => {
                network_errors += 1;
                if network_errors > 30 {
                    return Err(format!("Could not reach Cursor to finish the sign-in: {err}"));
                }
                PollOutcome::Pending
            }
        };
        match outcome {
            PollOutcome::Tokens {
                access_token,
                refresh_token,
            } => {
                let (_, install) = read_cursor_install_full().unwrap_or_default();
                let creds = StoredCredentials {
                    access_token,
                    refresh_token,
                    // The session JWT carries no email; the install's cached
                    // one is the same account whenever the editor is signed in.
                    email: install.email,
                    membership: install.membership,
                    last_refresh: None,
                };
                write_store(&creds)?;
                crate::logging::log_info(
                    "cursor",
                    "browser sign-in completed; tokens stored in Aurora's own store",
                );
                // The attempt is over: a later cancel must not touch a new one.
                let _ = pending_login()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
                return status();
            }
            PollOutcome::Odd(what) => {
                crate::logging::log_warn("cursor", &format!("auth/poll answered {what}; retrying"));
            }
            PollOutcome::Pending => {}
        }
        tokio::select! {
            () = cancel.cancelled() => return Err("Sign-in was cancelled.".to_string()),
            () = tokio::time::sleep(std::time::Duration::from_millis(interval_ms)) => {}
        }
        interval_ms = (interval_ms * 12 / 10).min(5000);
    }
}

/// Forget Aurora's copy. Cursor's own install is left completely alone — the
/// user stays signed in there, which is the opposite of the Codex provider,
/// where signing out necessarily signs the CLI out too.
pub fn sign_out() -> Result<(), String> {
    clear_store()
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// A usable access token, refreshed when it is close to expiry (or when
/// `force` is set — the caller saw a 401 and the token was revoked early).
pub async fn fresh_access(force: bool) -> Result<String, String> {
    let creds = load()?.ok_or(SIGNED_OUT_MSG)?;
    if !force && is_fresh(&creds.access_token) {
        return Ok(creds.access_token);
    }

    let _guard = refresh_lock().lock().await;

    // Re-read inside the lock: a parallel turn — or the Cursor app — may
    // have rotated the pair while we waited.
    let creds = load()?.ok_or(SIGNED_OUT_MSG)?;
    if !force && is_fresh(&creds.access_token) {
        return Ok(creds.access_token);
    }

    let Some(refresh_token) = creds.refresh_token.clone().filter(|t| !t.trim().is_empty()) else {
        // No refresh token: the stored access token is all we have. Hand it
        // back and let the real upstream error speak, rather than inventing
        // a sign-in prompt for a token that may still work.
        return Ok(creds.access_token);
    };

    match request_refresh(&refresh_token).await {
        Ok(tokens) => {
            let updated = StoredCredentials {
                access_token: tokens.access_token.clone(),
                refresh_token: tokens.refresh_token.or(Some(refresh_token)),
                last_refresh: Some(chrono::Utc::now().to_rfc3339()),
                ..creds
            };
            write_store(&updated)?;
            Ok(updated.access_token)
        }
        Err(err) => {
            // Rotation race: the Cursor app may have refreshed between our
            // read and the request, leaving our refresh token stale while a
            // perfectly good pair sits in its database. Prefer that over
            // failing the turn.
            if let Ok(Some(current)) = load() {
                if current.access_token != creds.access_token && is_fresh(&current.access_token) {
                    return Ok(current.access_token);
                }
            }
            Err(format!(
                "Cursor token refresh failed: {err}. Sign in again from Settings \u{2192} \
                 Providers \u{2192} Cursor."
            ))
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

/// Exchange a refresh token for a fresh pair.
///
/// The **refresh** token is the bearer here — not the access token. The body
/// is an empty JSON object; the endpoint identifies the session entirely from
/// the credential.
async fn request_refresh(refresh_token: &str) -> Result<TokenResponse, String> {
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|err| format!("build HTTP client: {err}"))?;

    let response = http
        .post(format!("{CURSOR_API_BASE}{CURSOR_REFRESH_PATH}"))
        .bearer_auth(refresh_token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|err| format!("request failed: {err}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {} {}", status.as_u16(), truncate(&body, 200)));
    }
    let parsed: TokenResponse = serde_json::from_str(&body).map_err(|err| {
        format!(
            "unexpected refresh response ({err}): {}",
            truncate(&body, 200)
        )
    })?;
    if parsed.access_token.trim().is_empty() {
        return Err("refresh response carried no access token".to_string());
    }
    Ok(parsed)
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}\u{2026}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an unsigned JWT whose payload carries `exp`. Only the payload
    /// segment is ever read, so the header and signature are placeholders.
    fn jwt_with_exp(exp: i64) -> String {
        let payload = serde_json::json!({ "exp": exp }).to_string();
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        format!("header.{encoded}.signature")
    }

    #[test]
    fn expiry_is_read_from_the_payload() {
        let token = jwt_with_exp(1_800_000_000);
        assert_eq!(expiry_unix(&token), Some(1_800_000_000));
        assert!(expires_at_rfc3339(&token).is_some());
    }

    #[test]
    fn freshness_respects_the_skew() {
        let now = chrono::Utc::now().timestamp();
        assert!(is_fresh(&jwt_with_exp(now + REFRESH_SKEW_SECS + 60)));
        assert!(!is_fresh(&jwt_with_exp(now + REFRESH_SKEW_SECS - 60)));
        assert!(!is_fresh(&jwt_with_exp(now - 60)));
    }

    #[test]
    fn a_token_without_a_parseable_expiry_is_assumed_usable() {
        // Opaque tokens must not force a refresh on every single turn; the
        // 401 path is what corrects a genuinely dead one.
        assert!(is_fresh("not-a-jwt"));
        assert_eq!(expiry_unix("not-a-jwt"), None);
    }

    #[test]
    fn item_table_values_unwrap_json_strings_only() {
        assert_eq!(unquote_json_string("\"eyJhbGci\""), "eyJhbGci");
        assert_eq!(unquote_json_string("eyJhbGci"), "eyJhbGci");
        // An object value is not a token; pass it through rather than
        // silently producing something that looks like one.
        assert_eq!(unquote_json_string("{\"a\":1}"), "{\"a\":1}");
    }

    #[test]
    fn reconciliation_prefers_the_longer_lived_token() {
        let now = chrono::Utc::now().timestamp();
        let ours = StoredCredentials {
            access_token: jwt_with_exp(now + 100),
            email: Some("ours@example.com".into()),
            ..Default::default()
        };
        let theirs = StoredCredentials {
            access_token: jwt_with_exp(now + 10_000),
            membership: Some("pro_plus".into()),
            ..Default::default()
        };
        let ours_exp = expiry_unix(&ours.access_token).unwrap_or(i64::MIN);
        let theirs_exp = expiry_unix(&theirs.access_token).unwrap_or(i64::MIN);
        assert!(theirs_exp > ours_exp);
    }

    #[test]
    fn a_signed_out_status_still_reports_whether_cursor_is_installed() {
        let status = CursorAuthStatus::signed_out(&InstallInfo {
            detected: true,
            session_unusable: true,
            ..Default::default()
        });
        assert!(!status.signed_in);
        assert!(status.cursor_app_detected);
        assert!(status.cursor_app_session_unusable);
        assert!(!status.has_refresh_token);
    }

    fn rows(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    /// Cursor's 2026-10 editor stores a 631-character opaque value where the
    /// JWT used to be. Adopting it produced a bearer that 401'd on every
    /// call ("not logged in", "the access token carries no account id").
    #[test]
    fn an_install_session_that_is_not_a_jwt_is_reported_unusable_not_adopted() {
        let opaque = format!("cursor{}", "x".repeat(625));
        let (creds, info) = install_from_rows(&rows(&[
            (KEY_ACCESS, &opaque),
            (KEY_REFRESH, &opaque),
            (KEY_EMAIL, "someone@example.com"),
            (KEY_MEMBERSHIP, "pro_plus"),
        ]));
        assert!(creds.is_none(), "an opaque token must not become a bearer");
        assert_eq!(
            info,
            InstallInfo {
                detected: true,
                session_unusable: true,
                email: Some("someone@example.com".into()),
                membership: Some("pro_plus".into()),
            }
        );
        // The metadata still seeds a browser sign-in's display line.
        let jwt = jwt_with_exp(1_800_000_000);
        let (creds, info) = install_from_rows(&rows(&[(KEY_ACCESS, &jwt), (KEY_EMAIL, "a@b.c")]));
        assert_eq!(creds.unwrap().email.as_deref(), Some("a@b.c"));
        assert!(!info.session_unusable);
        let (creds, info) = install_from_rows(&rows(&[(KEY_EMAIL, "a@b.c")]));
        assert!(creds.is_none());
        assert!(info.detected && !info.session_unusable, "{info:?}");
    }

    #[test]
    fn a_login_attempt_links_its_challenge_to_its_verifier() {
        let a = new_login_attempt();
        let b = new_login_attempt();
        assert_ne!(a.verifier, b.verifier, "each attempt gets its own secret");
        let expected = b64url(&Sha256::digest(a.verifier.as_bytes()));
        assert!(a.url.starts_with(CURSOR_LOGIN_URL), "{}", a.url);
        assert!(a.url.contains(&format!("challenge={expected}")), "{}", a.url);
        assert!(a.url.contains(&format!("uuid={}", a.uuid)), "{}", a.url);
        assert!(a.url.ends_with("&mode=login&redirectTarget=cli"), "{}", a.url);
        assert!(!a.url.contains(&a.verifier), "the verifier never goes on the page");
        assert_eq!(a.verifier.len(), 43, "32 random bytes, base64url, no padding");
    }

    #[test]
    fn poll_replies_are_classified() {
        assert_eq!(parse_poll(404, ""), PollOutcome::Pending);
        assert_eq!(parse_poll(202, "{}"), PollOutcome::Pending);
        assert_eq!(parse_poll(200, "{}"), PollOutcome::Pending);
        assert_eq!(
            parse_poll(200, r#"{"accessToken":"at","refreshToken":"rt","authId":"x"}"#),
            PollOutcome::Tokens {
                access_token: "at".into(),
                refresh_token: Some("rt".into())
            }
        );
        // The script this mirrors accepts `apiKey` too (API-key mode, no refresh).
        assert_eq!(
            parse_poll(200, r#"{"apiKey":"k"}"#),
            PollOutcome::Tokens {
                access_token: "k".into(),
                refresh_token: None
            }
        );
        assert!(matches!(parse_poll(500, "boom"), PollOutcome::Odd(m) if m.contains("500")));
    }

    #[tokio::test]
    async fn waiting_with_no_attempt_or_after_a_cancel_does_not_hang() {
        cancel_login();
        let err = wait_login().await.unwrap_err();
        assert!(err.contains("No Cursor sign-in"), "{err}");
        // begin → cancel → wait: the waiter is released, not left hanging.
        let url = begin_login();
        assert!(url.starts_with(CURSOR_LOGIN_URL));
        cancel_login();
        let err = wait_login().await.unwrap_err();
        assert!(err.contains("No Cursor sign-in") || err.contains("cancelled"), "{err}");
    }

    /// Reads the real Cursor install on this machine.
    ///
    /// Ignored by default because it depends on the developer's own sign-in
    /// state. Run it with:
    ///
    /// ```text
    /// cargo test --lib api::cursor -- --ignored --nocapture
    /// ```
    ///
    /// Prints metadata only. Tokens are never logged — not their value, not
    /// a prefix, not a length that would narrow one.
    #[test]
    #[ignore = "reads the developer's local Cursor install"]
    fn reads_the_local_cursor_install() {
        let path = cursor_state_db();
        println!(
            "state.vscdb: {}",
            path.as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "<unresolved>".into())
        );
        println!(
            "  exists:     {}",
            path.as_ref().map(|p| p.is_file()).unwrap_or(false)
        );

        let status = status().expect("status must not error even when signed out");
        println!("  signedIn:   {}", status.signed_in);
        println!("  email:      {}", status.email.as_deref().unwrap_or("-"));
        println!(
            "  membership: {}",
            status.membership.as_deref().unwrap_or("-")
        );
        println!(
            "  expiresAt:  {}",
            status.expires_at.as_deref().unwrap_or("-")
        );
        println!("  refresh:    {}", status.has_refresh_token);
        println!("  detected:   {}", status.cursor_app_detected);

        // When an install is present and signed in, the pieces the session
        // layer depends on must all be there — an access token that parses
        // to a real expiry, and a refresh token to renew it with.
        if status.signed_in && status.cursor_app_detected {
            assert!(
                status.expires_at.is_some(),
                "a live Cursor session should carry a parseable JWT expiry"
            );
        }
    }
}
