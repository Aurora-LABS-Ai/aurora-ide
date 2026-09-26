//! Tauri commands for the Claude Code (claude.ai subscription) provider.
//!
//! Thin wrappers over [`crate::api::claude_code`] — the auth/usage logic is
//! tauri-free; this layer is only the IPC surface for the settings card.
//!
//! The sign-in is a two-step manual flow, and the split is the point: the
//! card shows the link from [`claude_code_auth_begin`], the user finishes in
//! any browser (even on another machine), and pastes what the page shows
//! into [`claude_code_auth_complete`]. Nothing here opens a browser or
//! listens on a port. Claude Code's own credentials are read by
//! [`claude_code_account_import_cli`] and when refreshing an imported
//! account; they are never written.

use crate::api::claude_code::accounts::{self, AccountSource};
use crate::api::claude_code::auth::{self, ClaudeCodeAuthStatus};
use crate::api::claude_code::usage::{self, ClaudeCodeUsageSnapshot};

/// Sign-in state of the main account, from Aurora's own account list.
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

/// Sign out of the main account. Only Aurora's list changes.
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

/// One row in the account list.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeAccountRow {
    pub id: String,
    pub added_at: String,
    pub source: AccountSource,
    /// The account chats go to. Exactly one row is true.
    pub is_main: bool,
    pub status: ClaudeCodeAuthStatus,
    /// `None` when its usage could not be read; the row still lists.
    pub usage: Option<ClaudeCodeUsageSnapshot>,
    pub usage_error: Option<String>,
}

/// Every stored account, each with its own usage.
///
/// Polled concurrently: the requests are independent, and serially the list
/// would sit blank for one round trip per account.
#[tauri::command]
pub async fn claude_code_accounts_list() -> Result<Vec<ClaudeCodeAccountRow>, String> {
    let store = tokio::task::spawn_blocking(accounts::load)
        .await
        .map_err(|err| format!("Accounts task failed: {err}"))??;
    let main_id = store.main().map(|a| a.id.clone());

    let polls = store.accounts.iter().map(|account| {
        let id = account.id.clone();
        async move { usage::fetch_usage_for(&id).await }
    });
    let results = futures_util::future::join_all(polls).await;

    Ok(store
        .accounts
        .iter()
        .zip(results)
        .map(|(account, polled)| {
            let (usage, usage_error) = match polled {
                Ok(snap) => (Some(snap), None),
                Err(err) => (None, Some(err)),
            };
            ClaudeCodeAccountRow {
                id: account.id.clone(),
                added_at: account.added_at.clone(),
                source: account.source,
                is_main: main_id.as_deref() == Some(account.id.as_str()),
                status: ClaudeCodeAuthStatus::from_stored(&account.auth),
                usage,
                usage_error,
            }
        })
        .collect())
}

/// Send chats to this account.
#[tauri::command]
pub async fn claude_code_account_set_main(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || accounts::set_main(&id))
        .await
        .map_err(|err| format!("Set-main task failed: {err}"))?
}

/// Forget one account. Claude Code on this machine is unaffected.
#[tauri::command]
pub async fn claude_code_account_remove(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || accounts::remove(&id))
        .await
        .map_err(|err| format!("Remove task failed: {err}"))?
}

/// Copy the account Claude Code is signed into. Reads Claude Code's
/// credentials once; never writes them.
#[tauri::command]
pub async fn claude_code_account_import_cli() -> Result<ClaudeCodeAuthStatus, String> {
    auth::import_from_cli().await
}
