//! Tauri commands for the Codex (ChatGPT) provider.
//!
//! Thin wrappers over [`crate::api::codex`] — the auth/usage logic is
//! tauri-free; this layer only adds the system-browser open for the
//! PKCE login and the IPC surface for the settings card.

use tauri_plugin_shell::ShellExt;

use crate::api::codex::auth::{self, CodexAuthStatus};
use crate::api::codex::usage::{self, CodexUsageSnapshot};

/// How long the browser sign-in may take before we give up.
const LOGIN_TIMEOUT_SECS: u64 = 300;

/// Current sign-in state (reads `~/.codex/auth.json` — a Codex CLI
/// login is picked up automatically).
#[tauri::command]
pub async fn codex_auth_status() -> Result<CodexAuthStatus, String> {
    tokio::task::spawn_blocking(auth::status)
        .await
        .map_err(|err| format!("Status task failed: {err}"))?
}

/// Run the browser PKCE sign-in end to end: open the authorize URL in
/// the system browser, wait for the loopback callback, persist the
/// tokens, and return the resulting status.
#[tauri::command]
pub async fn codex_auth_login(app: tauri::AppHandle) -> Result<CodexAuthStatus, String> {
    let (auth_url, done) = auth::begin_login().await?;

    // The shell plugin is what Aurora ships; its `open` is deprecated in
    // favor of tauri-plugin-opener, which we don't bundle. Same behavior.
    #[allow(deprecated)]
    app.shell()
        .open(&auth_url, None)
        .map_err(|err| format!("Couldn't open the browser: {err}"))?;

    let outcome =
        tokio::time::timeout(std::time::Duration::from_secs(LOGIN_TIMEOUT_SECS), done).await;

    match outcome {
        Ok(Ok(result)) => result?,
        Ok(Err(_)) => return Err("Sign-in was cancelled.".to_string()),
        Err(_) => {
            auth::cancel_login();
            return Err("Sign-in timed out. Try again.".to_string());
        }
    }

    codex_auth_status().await
}

/// Abort a pending browser sign-in.
#[tauri::command]
pub async fn codex_auth_cancel_login() -> Result<(), String> {
    auth::cancel_login();
    Ok(())
}

/// Sign out by removing the shared credential file. NOTE: this also
/// signs out Codex CLI on this machine — the UI confirms before calling.
#[tauri::command]
pub async fn codex_auth_logout() -> Result<(), String> {
    tokio::task::spawn_blocking(auth::logout)
        .await
        .map_err(|err| format!("Logout task failed: {err}"))?
}

/// Live subscription usage (5-hour + weekly windows) for the card.
#[tauri::command]
pub async fn codex_usage_get() -> Result<CodexUsageSnapshot, String> {
    usage::fetch_usage().await
}
