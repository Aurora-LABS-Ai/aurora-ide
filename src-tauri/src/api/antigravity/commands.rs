//! Commands for the Antigravity provider: `#[tauri::command]`s with
//! `desktop`, served to other hosts by `host_commands::sign_ins`.
//!
//! Thin wrappers over [`crate::api::antigravity`]; the auth logic is
//! tauri-free and this layer is only the IPC surface for the settings card.
//! Sign-in opens Google's page in the system browser and waits for the
//! loopback callback (desktop only). Import reads Antigravity IDE's sign-in
//! once and never writes it.

#[cfg(feature = "desktop")]
use tauri_plugin_shell::ShellExt;

use crate::api::antigravity::accounts::{self, AccountSource};
use crate::api::antigravity::auth::{self, AntigravityAuthStatus};
use crate::api::antigravity::models::{self, AntigravityCatalogue};
use crate::api::antigravity::quota::{self, AntigravityQuota};

/// How long the browser sign-in may take before Aurora stops listening.
#[cfg(feature = "desktop")]
const LOGIN_TIMEOUT_SECS: u64 = 300;

/// Sign-in state of the main account.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn antigravity_auth_status() -> Result<AntigravityAuthStatus, String> {
    tokio::task::spawn_blocking(auth::status)
        .await
        .map_err(|err| format!("Status task failed: {err}"))?
}

/// Run the browser sign-in end to end: open Google's page, wait for the
/// callback, save the account, return its status. Adding an account never
/// changes which one chats use.
#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn antigravity_auth_login(
    app: tauri::AppHandle,
) -> Result<AntigravityAuthStatus, String> {
    let (auth_url, done) = auth::begin_login().await?;

    // The shell plugin is what Aurora ships; its `open` is deprecated in
    // favor of tauri-plugin-opener, which we don't bundle. Same behavior.
    #[allow(deprecated)]
    app.shell()
        .open(&auth_url, None)
        .map_err(|err| format!("Couldn't open the browser: {err}"))?;

    match tokio::time::timeout(std::time::Duration::from_secs(LOGIN_TIMEOUT_SECS), done).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Sign-in was cancelled.".to_string()),
        Err(_) => {
            auth::cancel_login();
            Err("Sign-in timed out. Try again.".to_string())
        }
    }
}

/// Abort a pending browser sign-in.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn antigravity_auth_cancel_login() -> Result<(), String> {
    auth::cancel_login();
    Ok(())
}

/// Forget the main account. Only Aurora's list changes.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn antigravity_auth_logout() -> Result<(), String> {
    tokio::task::spawn_blocking(auth::logout)
        .await
        .map_err(|err| format!("Logout task failed: {err}"))?
}

/// One row in the account list.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAccountRow {
    pub id: String,
    pub added_at: String,
    pub source: AccountSource,
    /// The account chats go to. Exactly one row is true.
    pub is_main: bool,
    pub status: AntigravityAuthStatus,
    /// The least quota left in any of the account's buckets (weekly or
    /// 5-hour, any group), 0–100: the limit that stops it first. `None` when
    /// it could not be read.
    pub lowest_remaining_percent: Option<f64>,
    pub quota_error: Option<String>,
}

/// Every stored account, each with its own quota. Polled concurrently: the
/// requests are independent, and serially the list would wait one round trip
/// per account.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn antigravity_accounts_list() -> Result<Vec<AntigravityAccountRow>, String> {
    let store = tokio::task::spawn_blocking(accounts::load)
        .await
        .map_err(|err| format!("Accounts task failed: {err}"))??;
    let main_id = store.main().map(|a| a.id.clone());
    let polls = store.accounts.iter().map(|account| {
        let id = account.id.clone();
        async move { quota::fetch_quota_for(&id).await }
    });
    let results = futures_util::future::join_all(polls).await;
    Ok(store
        .accounts
        .iter()
        .zip(results)
        .map(|(account, polled)| {
            let (lowest, quota_error) = match polled {
                Ok(q) => (
                    q.groups
                        .iter()
                        .flat_map(|g| g.buckets.iter().map(|b| b.remaining_percent))
                        .reduce(f64::min),
                    None,
                ),
                Err(err) => (None, Some(err)),
            };
            AntigravityAccountRow {
                id: account.id.clone(),
                added_at: account.added_at.clone(),
                source: account.source,
                is_main: main_id.as_deref() == Some(account.id.as_str()),
                status: AntigravityAuthStatus::from_stored(&account.auth),
                lowest_remaining_percent: lowest,
                quota_error,
            }
        })
        .collect())
}

/// The main account's quota: per model group, a weekly bucket and (on paid
/// plans) a 5-hour one.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn antigravity_quota_get() -> Result<AntigravityQuota, String> {
    quota::fetch_quota().await
}

/// The main account's models, in Antigravity's picker order, with the quota
/// left on each.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn antigravity_models_list() -> Result<AntigravityCatalogue, String> {
    models::fetch_catalogue().await
}

/// Send chats to this account.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn antigravity_account_set_main(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || accounts::set_main(&id))
        .await
        .map_err(|err| format!("Set-main task failed: {err}"))?
}

/// Forget one account. Antigravity IDE on this machine is unaffected.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn antigravity_account_remove(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || accounts::remove(&id))
        .await
        .map_err(|err| format!("Remove task failed: {err}"))?
}

/// Copy the account Antigravity IDE is signed into.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn antigravity_account_import_ide() -> Result<AntigravityAuthStatus, String> {
    auth::import_from_ide().await
}
