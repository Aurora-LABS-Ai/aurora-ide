//! Tauri commands for the Command Code provider.
//!
//! Thin wrappers over [`crate::api::commandcode`]. The auth and catalog
//! logic is tauri-free; this layer adds the system-browser open for the
//! sign-in and the IPC surface the provider card talks to.
//!
//! Two ways to get a key, both first-class:
//!
//! - Paste one from the Studio dashboard into the provider row. Needs no
//!   CLI, no browser round trip, and stores like every other provider key.
//! - Let Aurora find `~/.commandcode/auth.json`, or write it via
//!   [`commandcode_auth_login`]. Someone already running `cmd` is signed
//!   in the moment they add the provider.

use serde::Serialize;

use tauri_plugin_shell::ShellExt;

use crate::api::commandcode::auth::{self, CommandCodeAuthStatus};
use crate::api::commandcode::usage::{self, CommandCodeUsageSnapshot};
use crate::api::commandcode::COMMANDCODE_MODELS_URL;

/// How long the browser sign-in may take before we give up.
const LOGIN_TIMEOUT_SECS: u64 = 300;

/// One row of the model catalog, as the provider page renders it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeModel {
    pub id: String,
    pub name: String,
    /// Tokens. `None` when the catalog omits it rather than defaulted to a
    /// guess, because a wrong context window silently truncates a thread.
    pub context_length: Option<u32>,
}

/// Whether the CLI is installed, whether a key is on disk, and which
/// version header this machine will send.
#[tauri::command]
pub async fn commandcode_auth_status() -> Result<CommandCodeAuthStatus, String> {
    tokio::task::spawn_blocking(auth::status)
        .await
        .map_err(|err| format!("Status task failed: {err}"))?
}

/// Run the browser sign-in end to end: open the Studio URL, wait for the
/// loopback callback, write `~/.commandcode/auth.json`, and report back.
///
/// Optional. Pasting a key on the provider page does the same job without
/// leaving the window; this exists because it is the shorter path for
/// anyone who already has a Command Code account open in a browser.
#[tauri::command]
pub async fn commandcode_auth_login(app: tauri::AppHandle) -> Result<CommandCodeAuthStatus, String> {
    let (auth_url, done) = auth::begin_login().await?;

    // Same deprecation note as the Codex command: the shell plugin is what
    // Aurora bundles, and its `open` behaves identically to the opener
    // plugin we do not ship.
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

    commandcode_auth_status().await
}

/// Abort a pending browser sign-in.
#[tauri::command]
pub async fn commandcode_auth_cancel_login() -> Result<(), String> {
    auth::cancel_login();
    Ok(())
}

/// Remove `~/.commandcode/auth.json`.
///
/// This signs the Command Code CLI out too, because it is one shared
/// credential file. A key pasted into the provider row is untouched: that
/// one is Aurora's own and is cleared by clearing the field.
#[tauri::command]
pub async fn commandcode_auth_logout() -> Result<CommandCodeAuthStatus, String> {
    tokio::task::spawn_blocking(auth::logout)
        .await
        .map_err(|err| format!("Sign-out task failed: {err}"))??;
    commandcode_auth_status().await
}

/// Copy a pasted key into the shared `auth.json`, signing the CLI in.
///
/// Not required to use the provider. Offered because someone who pastes a
/// key into Aurora usually wants `cmd` on the same account rather than a
/// second sign-in in a terminal.
#[tauri::command]
pub async fn commandcode_auth_store_key(api_key: String) -> Result<CommandCodeAuthStatus, String> {
    tokio::task::spawn_blocking(move || auth::store_pasted_key(&api_key))
        .await
        .map_err(|err| format!("Key store task failed: {err}"))??;
    commandcode_auth_status().await
}

/// Plan, rolling spend windows and credit balance.
///
/// `api_key` is the provider row's key; empty falls back to the CLI's stored
/// one, the same order a real request uses.
#[tauri::command]
pub async fn commandcode_usage_get(api_key: String) -> Result<CommandCodeUsageSnapshot, String> {
    usage::fetch(&api_key).await
}

/// Fetch the model catalog.
///
/// `api_key` is the provider row's key; empty falls back to the CLI's
/// stored one, the same order a real request uses. The catalog is the same
/// on every plan: an out-of-plan model is listed here and refused at
/// request time, so nothing is filtered out on the way through.
#[tauri::command]
pub async fn commandcode_list_models(api_key: String) -> Result<Vec<CommandCodeModel>, String> {
    let (key, _source) = tokio::task::spawn_blocking(move || auth::resolve_api_key(&api_key))
        .await
        .map_err(|err| format!("Key lookup task failed: {err}"))??;

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|err| format!("Couldn't build the HTTP client: {err}"))?;

    let response = client
        .get(COMMANDCODE_MODELS_URL)
        .header("Authorization", format!("Bearer {key}"))
        .header("x-command-code-version", auth::cli_version())
        .send()
        .await
        .map_err(|err| format!("Couldn't reach Command Code: {err}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Command Code returned {} for the model list: {}",
            status.as_u16(),
            body.chars().take(300).collect::<String>()
        ));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|err| format!("Couldn't read the Command Code model list: {err}"))?;

    let rows = parsed
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "The Command Code model list had no `data` array.".to_string())?;

    let models: Vec<CommandCodeModel> = rows
        .iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.to_string();
            if id.is_empty() {
                return None;
            }
            let name = row
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let context_length = row
                .get("context_length")
                .and_then(serde_json::Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n > 0);
            Some(CommandCodeModel {
                id,
                name,
                context_length,
            })
        })
        .collect();

    if models.is_empty() {
        return Err("Command Code returned an empty model list.".to_string());
    }
    Ok(models)
}
