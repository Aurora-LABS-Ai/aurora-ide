//! Tauri commands for the Claude Code (claude.ai subscription) provider.
//!
//! Thin wrappers over [`crate::api::claude_code`] — the auth/usage logic is
//! tauri-free; this layer is only the IPC surface for the settings card.
//!
//! The sign-in is a two-step manual flow, and the split is the point: the
//! card shows the link from [`claude_code_auth_begin`], the user finishes in
//! any browser (even on another machine), and pastes what the page shows
//! into [`claude_code_auth_complete`]. Nothing here opens a browser or
//! listens on a port, and nothing here reads the user's own `~/.claude`.

use crate::api::claude_code::auth::{self, ClaudeCodeAuthStatus};
use crate::api::claude_code::usage::{self, ClaudeCodeUsageSnapshot};

/// Current sign-in state, from Aurora's own credential file.
#[tauri::command]
pub async fn claude_code_auth_status() -> Result<ClaudeCodeAuthStatus, String> {
    tokio::task::spawn_blocking(auth::status)
        .await
        .map_err(|err| format!("Status task failed: {err}"))?
}

/// Start a sign-in. Returns the authorize URL for the user to open; the
/// PKCE secret it belongs to stays in memory until the code is pasted.
#[tauri::command]
pub async fn claude_code_auth_begin() -> Result<String, String> {
    Ok(auth::begin_login())
}

/// Finish the sign-in with the code (or callback address) the user pasted.
/// Exchanges it, saves the tokens, and returns the resulting status.
#[tauri::command]
pub async fn claude_code_auth_complete(input: String) -> Result<ClaudeCodeAuthStatus, String> {
    auth::complete_login(&input).await
}

/// Abandon a started sign-in so its link can no longer be completed.
#[tauri::command]
pub async fn claude_code_auth_cancel() -> Result<(), String> {
    auth::cancel_login();
    Ok(())
}

/// Sign out. Only Aurora's own credential file is removed.
#[tauri::command]
pub async fn claude_code_auth_logout() -> Result<(), String> {
    tokio::task::spawn_blocking(auth::logout)
        .await
        .map_err(|err| format!("Logout task failed: {err}"))?
}

/// Live plan usage (five-hour + seven-day windows) for the card.
#[tauri::command]
pub async fn claude_code_usage_get() -> Result<ClaudeCodeUsageSnapshot, String> {
    usage::fetch_usage().await
}
