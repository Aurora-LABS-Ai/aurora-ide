//! Tauri commands for the Codex (ChatGPT) provider.
//!
//! Thin wrappers over [`crate::api::codex`] — the auth/usage logic is
//! tauri-free; this layer only adds the system-browser open for the
//! PKCE login and the IPC surface for the settings card.

use tauri_plugin_shell::ShellExt;

use crate::api::codex::accounts;
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

/// Sign out of the account serving requests. Only removes Aurora's own
/// entry — Codex CLI keeps whatever it is signed into.
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

/// One row in the account switcher.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountRow {
    pub account_id: String,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub added_at: String,
    /// The account the user chose. Exactly one row is true.
    pub is_main: bool,
    /// The account the next request will use — differs from `isMain` only
    /// while main is exhausted.
    pub is_active: bool,
    /// When this account's window is expected back. Detail, not a decision:
    /// whether it is spent *right now* is [`Self::spent`], resolved here
    /// against one clock rather than re-derived in the view on every render.
    pub exhausted_until_ms: Option<i64>,
    /// This account cannot serve until its window resets.
    pub spent: bool,
    /// `None` when its usage could not be read; the row still lists, because
    /// an account you cannot poll is not an account you have lost.
    pub usage: Option<CodexUsageSnapshot>,
    pub usage_error: Option<String>,
}

/// Every stored account, with the pooled credit total.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountsSnapshot {
    pub accounts: Vec<CodexAccountRow>,
    /// Credits summed across every account whose balance parsed as a number.
    pub total_credits: Option<f64>,
    /// True when at least one account reports unlimited credits — a total is
    /// meaningless then, and the card says "unlimited" instead of a figure.
    pub any_unlimited: bool,
    /// How many accounts contributed to `totalCredits`, so the card never
    /// implies it summed four when it could only read two.
    pub counted: usize,
    pub total: usize,
}

/// List the accounts and poll each one's usage.
///
/// Polled concurrently: four accounts served serially would make the card sit
/// blank for four round trips, and they are independent requests to the same
/// endpoint. One account failing leaves its row present with `usageError` set
/// rather than dropping it — a row you cannot poll is still a row you can make
/// main.
#[tauri::command]
pub async fn codex_accounts_list() -> Result<CodexAccountsSnapshot, String> {
    let store = accounts::load();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let active_id = store.active_id(now_ms);

    let polls = store.accounts.iter().map(|account| {
        let id = account.account_id.clone();
        async move { (id.clone(), usage::fetch_usage_for(&id).await) }
    });
    let results: std::collections::HashMap<String, Result<CodexUsageSnapshot, String>> =
        futures_util::future::join_all(polls).await.into_iter().collect();

    let mut total_credits = 0.0_f64;
    let mut counted = 0usize;
    let mut any_unlimited = false;
    let mut rows = Vec::with_capacity(store.accounts.len());

    for account in &store.accounts {
        let polled = results.get(&account.account_id);
        let usage = polled.and_then(|r| r.as_ref().ok()).cloned();
        let usage_error = polled.and_then(|r| r.as_ref().err()).cloned();

        if let Some(credits) = usage.as_ref().and_then(|u| u.credits.as_ref()) {
            if credits.unlimited {
                any_unlimited = true;
            } else if let Some(balance) = credits.balance.as_deref().and_then(parse_balance) {
                total_credits += balance;
                counted += 1;
            }
        }

        rows.push(CodexAccountRow {
            account_id: account.account_id.clone(),
            email: account.email.clone(),
            plan_type: account.plan_type.clone(),
            added_at: account.added_at.clone(),
            is_main: store.main_account_id.as_deref() == Some(account.account_id.as_str()),
            is_active: active_id.as_deref() == Some(account.account_id.as_str()),
            exhausted_until_ms: account.exhausted_until_ms,
            spent: account.is_exhausted(now_ms),
            usage,
            usage_error,
        });
    }

    Ok(CodexAccountsSnapshot {
        total: rows.len(),
        accounts: rows,
        total_credits: (counted > 0).then_some(total_credits),
        any_unlimited,
        counted,
    })
}

/// The balance arrives as a string and its formatting is the backend's
/// business, not ours — `"1000"`, `"1,000"` and `"$1,000.00"` have all been
/// seen on endpoints of this shape. Strip anything that is not part of a
/// number rather than trusting one format, and return `None` instead of `0`
/// when nothing numeric is left, so an unreadable balance is excluded from the
/// total rather than silently counted as empty.
fn parse_balance(raw: &str) -> Option<f64> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    cleaned.parse::<f64>().ok()
}

/// Make this account the one that serves requests.
#[tauri::command]
pub async fn codex_account_set_main(account_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || accounts::set_main(&account_id))
        .await
        .map_err(|err| format!("Set-main task failed: {err}"))?
}

/// Forget one account. Codex CLI is unaffected.
#[tauri::command]
pub async fn codex_account_remove(account_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || accounts::remove(&account_id))
        .await
        .map_err(|err| format!("Remove task failed: {err}"))?
}

/// Clear the "spent" mark so this account is eligible again — for when the
/// user knows the window reset sooner than the backend implied.
#[tauri::command]
pub async fn codex_account_clear_limit(account_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || accounts::clear_exhausted(&account_id))
        .await
        .map_err(|err| format!("Clear-limit task failed: {err}"))?
}

/// Add whatever Codex CLI is signed into, without disturbing it.
#[tauri::command]
pub async fn codex_account_import_cli() -> Result<String, String> {
    tokio::task::spawn_blocking(auth::import_from_cli)
        .await
        .map_err(|err| format!("Import task failed: {err}"))?
}
