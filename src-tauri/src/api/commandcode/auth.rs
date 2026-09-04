//! Command Code credential lifecycle.
//!
//! `~/.commandcode/auth.json` is the single source of truth, shared with
//! the Command Code CLI. It holds one long-lived key and no refresh token:
//!
//! ```json
//! {
//!   "apiKey": "user_…",
//!   "userId": "…",
//!   "userName": "Aurora-LABS-Ai",
//!   "keyName": "…",
//!   "authenticatedAt": "2026-09-03T…"
//! }
//! ```
//!
//! So there is no token refresh here and no expiry check. Reading the file
//! is the whole of "get me a credential", and Aurora's own sign-in writes
//! the same file, which signs the CLI in at the same time.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::{
    COMMANDCODE_CALLBACK_PORT, COMMANDCODE_CALLBACK_PORT_RANGE, COMMANDCODE_FALLBACK_VERSION,
    COMMANDCODE_STUDIO_AUTH_URL, COMMANDCODE_STUDIO_KEYS_URL, COMMANDCODE_STUDIO_ORIGIN,
};

// ---------------------------------------------------------------------------
// Stored credential
// ---------------------------------------------------------------------------

/// What the sign-in callback delivers and what `auth.json` stores. Field
/// names are the CLI's, because Aurora writes the file the CLI reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAuth {
    pub api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authenticated_at: Option<String>,
}

/// Where the key Aurora will actually send came from.
///
/// Order matters and is the whole point of the type: a key pasted on the
/// provider page is an explicit choice by the user and outranks whatever
/// happens to be lying in `~/.commandcode`, so someone can point Aurora at
/// a second account without disturbing the CLI they use daily.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    /// Pasted into the provider row in Aurora, stored like every other
    /// provider key.
    Pasted,
    /// Found in `~/.commandcode/auth.json`, put there by `cmd login` or by
    /// Aurora's own browser sign-in.
    Cli,
}

/// What the settings card renders. Never carries the key itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeAuthStatus {
    /// Whether `~/.commandcode/auth.json` holds a usable key. Named for
    /// the CLI specifically, because a pasted key lives in the provider
    /// row and the frontend already knows about that one.
    pub signed_in: bool,
    pub user_name: Option<String>,
    pub key_name: Option<String>,
    pub authenticated_at: Option<String>,
    /// Where the credential was found, for the "signed in via the CLI"
    /// line in the card.
    pub auth_path: Option<String>,
    /// Whether the Command Code CLI is installed on this machine at all.
    /// Drives which half of the card leads: detected install and a sign-in
    /// button, or "paste a key from your dashboard".
    pub cli_installed: bool,
    /// The `x-command-code-version` this machine will send, and whether it
    /// came from an installed CLI or the built-in floor.
    pub cli_version: String,
    pub cli_version_detected: bool,
    /// Where the Studio issues API keys, so the card can link straight to
    /// it instead of describing the path in prose.
    pub dashboard_url: &'static str,
}

/// `~/.commandcode`, or `None` when the home directory cannot be resolved.
#[must_use]
pub fn commandcode_home() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".commandcode"))
}

fn auth_file_path() -> Result<PathBuf, String> {
    commandcode_home()
        .map(|dir| dir.join("auth.json"))
        .ok_or_else(|| "Couldn't locate your home directory to read ~/.commandcode.".to_string())
}

/// Read the stored credential. `Ok(None)` means "not signed in", which is
/// a normal state and not an error.
pub fn read_auth() -> Result<Option<StoredAuth>, String> {
    let path = auth_file_path()?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Couldn't read {}: {err}", path.display())),
    };
    let parsed: StoredAuth = serde_json::from_str(&raw).map_err(|err| {
        format!(
            "{} isn't valid Command Code credentials ({err}). Run `cmd login` to rewrite it.",
            path.display()
        )
    })?;
    if parsed.api_key.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(parsed))
}

/// Write the credential, creating `~/.commandcode` when it does not exist.
///
/// Preserves any sibling keys the CLI wrote that Aurora does not model, so
/// signing in from Aurora never drops CLI state it did not put there.
pub fn write_auth(auth: &StoredAuth) -> Result<(), String> {
    let path = auth_file_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Couldn't create {}: {err}", parent.display()))?;
    }

    let mut merged = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    let fresh = serde_json::to_value(auth)
        .map_err(|err| format!("Couldn't serialize Command Code credentials: {err}"))?;
    if let Some(fields) = fresh.as_object() {
        for (key, value) in fields {
            merged.insert(key.clone(), value.clone());
        }
    }

    let body = serde_json::to_string_pretty(&Value::Object(merged))
        .map_err(|err| format!("Couldn't serialize Command Code credentials: {err}"))?;
    std::fs::write(&path, body).map_err(|err| {
        format!(
            "Couldn't write Command Code credentials to {}: {err}",
            path.display()
        )
    })?;
    restrict_permissions(&path);
    Ok(())
}

/// Owner-only on Unix. A no-op on Windows, where the user profile
/// directory already carries the ACL that matters.
#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {}

/// The bearer key for one request, and where it came from.
///
/// Two ways in, deliberately, because they suit different users:
///
/// 1. **A key pasted on the provider page**, stored in the provider row
///    like every other provider's key. Needs no CLI and no browser round
///    trip. This is the path for someone who just wants to paste a key
///    from the Studio dashboard and get on with it.
/// 2. **`~/.commandcode/auth.json`**, written by `cmd login` or by
///    Aurora's own browser sign-in. Someone who already uses the CLI is
///    signed in the moment they add the provider, with nothing to paste.
///
/// The pasted key wins when both exist. It is the more specific
/// instruction, and it lets Aurora run a different account from the one
/// the terminal is using.
pub fn resolve_api_key(row_key: &str) -> Result<(String, KeySource), String> {
    let pasted = row_key.trim();
    if !pasted.is_empty() {
        return Ok((pasted.to_string(), KeySource::Pasted));
    }
    match read_auth()? {
        Some(auth) => Ok((auth.api_key, KeySource::Cli)),
        None => Err(
            "No Command Code key. Paste one from your Studio dashboard \
             (https://commandcode.ai/studio) into the provider's API key field, sign in from \
             Settings \u{2192} Providers \u{2192} Command Code, or run `cmd login` in a terminal."
                .to_string(),
        ),
    }
}

/// Status for the settings card.
pub fn status() -> Result<CommandCodeAuthStatus, String> {
    let auth = read_auth()?;
    let (version, detected) = cli_version_detail();
    Ok(CommandCodeAuthStatus {
        signed_in: auth.is_some(),
        user_name: auth.as_ref().and_then(|a| a.user_name.clone()),
        key_name: auth.as_ref().and_then(|a| a.key_name.clone()),
        authenticated_at: auth.as_ref().and_then(|a| a.authenticated_at.clone()),
        auth_path: auth_file_path().ok().map(|p| p.display().to_string()),
        cli_installed: detected,
        cli_version: version,
        cli_version_detected: detected,
        dashboard_url: COMMANDCODE_STUDIO_KEYS_URL,
    })
}

/// Forget the credential.
///
/// Deletes `auth.json` outright rather than blanking fields, because every
/// field in it belongs to the account. This signs the CLI out too, which
/// is the honest reading of one shared credential file: the alternative
/// would leave `cmd` authenticated against an account Aurora says it has
/// signed out of.
pub fn logout() -> Result<(), String> {
    let path = auth_file_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "Couldn't remove Command Code credentials at {}: {err}",
            path.display()
        )),
    }
}

/// Write a pasted key into the shared `auth.json`.
///
/// Not the normal paste path. A key pasted on the provider page is stored
/// in the provider row like every other provider's, and
/// [`resolve_api_key`] prefers it. This exists for the user who wants the
/// paste to sign their CLI in as well, so `cmd` and Aurora end up on the
/// same account without a second sign-in.
pub fn store_pasted_key(api_key: &str) -> Result<(), String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Paste your Command Code API key first.".to_string());
    }
    write_auth(&StoredAuth {
        api_key: key.to_string(),
        user_id: None,
        user_name: None,
        key_name: None,
        authenticated_at: Some(now_rfc3339()),
    })
}

// ---------------------------------------------------------------------------
// CLI version
// ---------------------------------------------------------------------------

/// The `x-command-code-version` value to send.
///
/// The header is mandatory (a request without it is `403 upgrade_required`)
/// but only floor-checked, so any value at or above the backend's current
/// minimum works. Reading the version of the CLI installed on this machine
/// means the floor tracks itself as the user updates, instead of Aurora
/// carrying a constant that silently rots until every request fails.
#[must_use]
pub fn cli_version() -> String {
    cli_version_detail().0
}

fn cli_version_detail() -> (String, bool) {
    static CACHED: OnceLock<(String, bool)> = OnceLock::new();
    CACHED
        .get_or_init(|| match detect_installed_cli_version() {
            Some(version) => (version, true),
            None => (COMMANDCODE_FALLBACK_VERSION.to_string(), false),
        })
        .clone()
}

/// Find `command-code/package.json` in a global `node_modules` reachable
/// from `PATH`, without spawning npm.
///
/// Two layouts cover the common installs: the Windows/nvm one, where the
/// shim directory itself holds `node_modules`, and the Unix prefix one,
/// where `bin/` sits beside `lib/node_modules`.
fn detect_installed_cli_version() -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidates = [
            dir.join("node_modules/command-code/package.json"),
            dir.join("../lib/node_modules/command-code/package.json"),
        ];
        for candidate in candidates {
            let Ok(raw) = std::fs::read_to_string(&candidate) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if let Some(version) = value.get("version").and_then(Value::as_str) {
                if !version.trim().is_empty() {
                    return Some(version.trim().to_string());
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Browser sign-in
// ---------------------------------------------------------------------------

struct PendingLogin {
    shutdown: oneshot::Sender<()>,
}

fn pending_login() -> &'static std::sync::Mutex<Option<PendingLogin>> {
    static PENDING: OnceLock<std::sync::Mutex<Option<PendingLogin>>> = OnceLock::new();
    PENDING.get_or_init(|| std::sync::Mutex::new(None))
}

/// Start the browser sign-in.
///
/// Binds a loopback listener, and returns the Studio URL for the command
/// layer to open plus a receiver that resolves once the callback landed
/// and `auth.json` was written. Any pending sign-in is aborted first.
///
/// Unlike an OAuth redirect, the browser never navigates to the callback.
/// The Studio page issues the key and `fetch`es it to the loopback port as
/// a cross-origin POST, so the handler answers the preflight and echoes
/// the allowed origin back. Without those headers the browser discards the
/// response and the page reports a failure Aurora never sees.
pub async fn begin_login() -> Result<(String, oneshot::Receiver<Result<(), String>>), String> {
    cancel_login();

    let state = random_state();
    let (listener, port) = bind_callback_listener().await?;
    let callback_url = format!("http://localhost:{port}/callback");

    let auth_url = format!(
        "{COMMANDCODE_STUDIO_AUTH_URL}?callback={}&state={}",
        percent_encode(&callback_url),
        percent_encode(&state)
    );

    let (done_tx, done_rx) = oneshot::channel::<Result<(), String>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    *pending_login().lock().unwrap_or_else(|p| p.into_inner()) = Some(PendingLogin {
        shutdown: shutdown_tx,
    });

    tokio::spawn(run_callback_server(listener, state, done_tx, shutdown_rx));

    Ok((auth_url, done_rx))
}

/// Abort a pending sign-in. Drops the listener, so the awaiting command
/// resolves with a cancellation error.
pub fn cancel_login() {
    if let Some(pending) = pending_login()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    {
        let _ = pending.shutdown.send(());
    }
}

async fn bind_callback_listener() -> Result<(TcpListener, u16), String> {
    let mut last_err = None;
    for offset in 0..COMMANDCODE_CALLBACK_PORT_RANGE {
        let port = COMMANDCODE_CALLBACK_PORT + offset;
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok((listener, port)),
            Err(err) => last_err = Some(err),
        }
    }
    Err(format!(
        "Couldn't open a sign-in port in {}\u{2013}{}: {}. Close any `cmd login` still running \
         and try again.",
        COMMANDCODE_CALLBACK_PORT,
        COMMANDCODE_CALLBACK_PORT + COMMANDCODE_CALLBACK_PORT_RANGE - 1,
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "no port available".into())
    ))
}

async fn run_callback_server(
    listener: TcpListener,
    expected_state: String,
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

        let Some((method, body)) = read_request(&mut stream).await else {
            continue;
        };

        if method == "OPTIONS" {
            let _ = respond(&mut stream, 204, "").await;
            continue;
        }
        if method != "POST" {
            let _ = respond(
                &mut stream,
                405,
                r#"{"success":false,"error":"method not allowed"}"#,
            )
            .await;
            continue;
        }

        let callback: Value = match serde_json::from_str(&body) {
            Ok(value) => value,
            Err(_) => {
                let _ = respond(
                    &mut stream,
                    400,
                    r#"{"success":false,"error":"invalid JSON"}"#,
                )
                .await;
                continue;
            }
        };

        let field = |key: &str| {
            callback
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|value| !value.is_empty())
        };

        let Some(api_key) = field("apiKey") else {
            let _ = respond(
                &mut stream,
                400,
                r#"{"success":false,"error":"missing apiKey"}"#,
            )
            .await;
            continue;
        };

        // A mismatched state means the POST did not come from the sign-in
        // this process started. Answer the browser normally so the Studio
        // page does not hang, and keep waiting for the real one.
        if field("state").as_deref() != Some(expected_state.as_str()) {
            let _ = respond(
                &mut stream,
                400,
                r#"{"success":false,"error":"state mismatch"}"#,
            )
            .await;
            continue;
        }

        let stored = StoredAuth {
            api_key,
            user_id: field("userId"),
            user_name: field("userName"),
            key_name: field("keyName"),
            authenticated_at: Some(now_rfc3339()),
        };

        break match write_auth(&stored) {
            Ok(()) => {
                let _ = respond(&mut stream, 200, r#"{"success":true}"#).await;
                Ok(())
            }
            Err(err) => {
                let _ = respond(
                    &mut stream,
                    500,
                    r#"{"success":false,"error":"could not store key"}"#,
                )
                .await;
                Err(err)
            }
        };
    };

    let _ = done.send(outcome);
    pending_login()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
}

/// Read one request off the socket, returning its method and body.
///
/// Reads until the headers are complete, then until `Content-Length` bytes
/// of body have arrived. A single read is almost always enough for a
/// payload this small, but "almost always" is how a sign-in fails once in
/// a hundred tries with no way to tell why.
async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<(String, String)> {
    let mut raw = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];

    let header_end = loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        raw.extend_from_slice(&chunk[..n]);
        if let Some(index) = find_header_end(&raw) {
            break index;
        }
        if raw.len() > 64 * 1024 {
            return None;
        }
    };

    let head = String::from_utf8_lossy(&raw[..header_end]).to_string();
    let method = head.split_whitespace().next()?.to_string();
    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);

    let body_start = header_end + 4;
    while raw.len() < body_start + content_length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..n]);
    }

    let body = String::from_utf8_lossy(&raw[body_start.min(raw.len())..]).to_string();
    Some((method, body))
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn respond(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Access-Control-Allow-Origin: {COMMANDCODE_STUDIO_ORIGIN}\r\n\
         Access-Control-Allow-Methods: POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Access-Control-Allow-Private-Network: true\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

fn random_state() -> String {
    let mut bytes = [0u8; 32];
    getrandom_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Fill `buf` with random bytes, seeded from the same source the rest of
/// the crate uses.
fn getrandom_bytes(buf: &mut [u8]) {
    use sha2::{Digest, Sha256};
    // Mix a UUID (random per call) with the current instant so two calls in
    // the same nanosecond still differ.
    let seed = format!(
        "{}-{:?}",
        uuid::Uuid::new_v4(),
        std::time::SystemTime::now()
    );
    let mut digest = Sha256::digest(seed.as_bytes()).to_vec();
    while digest.len() < buf.len() {
        let more = Sha256::digest(&digest);
        digest.extend_from_slice(&more);
    }
    buf.copy_from_slice(&digest[..buf.len()]);
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_auth_round_trips_the_cli_field_names() {
        let raw = r#"{
            "apiKey": "user_abc",
            "userId": "u1",
            "userName": "Aurora-LABS-Ai",
            "keyName": "cli",
            "authenticatedAt": "2026-09-03T00:35:00.000Z"
        }"#;
        let parsed: StoredAuth = serde_json::from_str(raw).expect("parses the CLI's own file");
        assert_eq!(parsed.api_key, "user_abc");
        assert_eq!(parsed.user_name.as_deref(), Some("Aurora-LABS-Ai"));

        let written = serde_json::to_value(&parsed).expect("serializes");
        // camelCase, so the CLI can still read what Aurora writes.
        assert!(written.get("apiKey").is_some());
        assert!(written.get("authenticatedAt").is_some());
    }

    #[test]
    fn callback_url_survives_percent_encoding() {
        assert_eq!(
            percent_encode("http://localhost:5959/callback"),
            "http%3A%2F%2Flocalhost%3A5959%2Fcallback"
        );
    }

    #[test]
    fn state_is_random_per_call() {
        assert_ne!(random_state(), random_state());
        assert_eq!(random_state().len(), 64);
    }

    #[test]
    fn header_end_is_found_only_on_a_blank_line() {
        assert_eq!(find_header_end(b"POST / HTTP/1.1\r\n\r\nbody"), Some(15));
        assert_eq!(find_header_end(b"POST / HTTP/1.1\r\nHost: x\r\n"), None);
    }

    #[test]
    fn version_falls_back_when_no_cli_is_installed() {
        // Whatever this machine has, the value is non-empty and the flag
        // agrees with whether a real install was found.
        let (version, detected) = cli_version_detail();
        assert!(!version.is_empty());
        if !detected {
            assert_eq!(version, COMMANDCODE_FALLBACK_VERSION);
        }
    }
}
