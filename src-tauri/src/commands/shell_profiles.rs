//! Tauri commands backing Settings → Tools → Shell. The bodies are written
//! once in `host_commands::shell`, which `aurora serve` serves too; these hand
//! them the app as the database access. `shell_interactive_config` is the
//! window's own: only its PTY terminal asks for it.

use std::sync::Arc;

use tauri::AppHandle;

use crate::db::DatabaseAccess;
use crate::host_commands::shell as core;
use crate::shell::{kinds::ShellKind, ShellProfiles};

fn db(app: AppHandle) -> Arc<dyn DatabaseAccess> {
    Arc::new(app)
}

/// Everything the PTY terminal needs to open an interactive session.
///
/// The terminal used to build this itself, hardcoding
/// `C:\Program Files\Git\bin\bash.exe` and a bare `pwsh.exe`. That failed for
/// any user whose Git lived elsewhere — while Settings → Shells sat right there
/// listing the verified path it should have used. The registry is the single
/// source of truth for where shells are; this exposes it to the one consumer
/// that was still guessing.
///
/// `args` are the interactive flags only. The caller appends its own prompt
/// initialisation (a `-Command` string for PowerShell kinds, `PROMPT_COMMAND`
/// in `env` for POSIX ones) — that split is presentation, and it belongs to the
/// terminal, not here.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveShell {
    pub id: String,
    pub kind: ShellKind,
    pub label: String,
    pub exe: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// `true` for bash/sh/zsh, so the caller knows which prompt style to append
    /// without re-deriving it from `kind`.
    pub is_posix: bool,
}

/// Resolve a shell for an interactive PTY session.
///
/// `requested` takes a kind id (`"bash"`, `"pwsh"`) or a profile id; omit it for
/// the derived fallback. Returns `None` only when nothing usable is registered,
/// which the caller reports rather than silently substituting a guess.
#[tauri::command(async)]
pub fn shell_interactive_config(requested: Option<String>) -> Option<InteractiveShell> {
    let resolved = crate::shell::resolve_interactive(requested.as_deref())?;
    Some(InteractiveShell {
        id: resolved.profile_id,
        kind: resolved.kind,
        label: resolved.label,
        exe: resolved.exe,
        args: resolved.args,
        env: resolved.env,
        is_posix: resolved.kind.is_posix(),
    })
}

/// Async on purpose: a plain `#[tauri::command]` runs on the main thread, and
/// this once froze the window waiting on the database (see `core::profiles_get`).
#[tauri::command]
pub async fn shell_profiles_get(app: AppHandle) -> Result<ShellProfiles, String> {
    core::profiles_get(db(app)).await
}

#[tauri::command]
pub async fn shell_profiles_scan(app: AppHandle) -> Result<ShellProfiles, String> {
    core::profiles_scan(db(app)).await
}

#[tauri::command]
pub async fn shell_profiles_add(
    path: String,
    label: Option<String>,
    app: AppHandle,
) -> Result<ShellProfiles, String> {
    core::profiles_add(db(app), path, label).await
}

#[tauri::command]
pub async fn shell_profiles_remove(id: String, app: AppHandle) -> Result<ShellProfiles, String> {
    core::profiles_remove(db(app), id).await
}

#[tauri::command]
pub async fn shell_profiles_set_enabled(
    id: String,
    enabled: bool,
    app: AppHandle,
) -> Result<ShellProfiles, String> {
    core::profiles_set_enabled(db(app), id, enabled).await
}

#[tauri::command]
pub async fn shell_profiles_verify(id: String, app: AppHandle) -> Result<ShellProfiles, String> {
    core::profiles_verify(db(app), id).await
}

#[tauri::command]
pub async fn shell_tools_inventory() -> Vec<crate::shell::toolchain::FoundTool> {
    core::tools_inventory().await
}
