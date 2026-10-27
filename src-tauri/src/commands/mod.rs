use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

// Windows-specific imports for hiding console window
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Windows creation flags
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use notify::{recommended_watcher, Config, Event, EventKind, RecursiveMode, Watcher};
use tauri::Emitter;

// The request/response types keep their old `commands::` paths; the helpers
// are imported for the tests below, which still live in this file.
pub use crate::workspace::ripgrep::{RipgrepSearchRequest, RipgrepSearchResponse};
#[cfg(test)]
use crate::workspace::ripgrep::{absolutize_rg_path, parse_glob_patterns, PendingContext};

pub mod agent_v2;
pub mod agent_v2_permissions;
pub mod ark;
pub mod artifacts;
pub mod browser;
pub mod chat;
/// The Memory page — reading and editing what Aurora remembers about the user.
pub mod chat_memory;
pub mod chat_gallery;
pub mod chat_video;
pub mod image_direct;
pub mod image_providers;
pub mod antigravity;
pub mod checkpoints;
pub mod claude_code;
pub mod code_index;
pub mod codex;
pub mod commandcode;
/// Test-only: fails the build if a main-thread command waits on the database.
#[cfg(test)]
mod command_thread_safety;
pub mod cursor;
pub mod deepseek;
pub mod diagnostics;
/// The editing commands ([`crate::workspace::edit`]) plus opening a file in the
/// IDE window ([`ide_window`]), under the path `lib.rs` registers them by.
pub mod editor_ops {
    pub use super::ide_window::*;
    pub use crate::workspace::edit::*;
}
pub mod ide_window;
pub mod fonts;
pub mod git;
pub mod icon_themes;
pub mod kenari;
pub mod local_providers;
pub mod minimax;
pub mod modal;
pub mod opencode;
pub mod plans;
pub mod conversation_stats;
pub mod project_stats;
pub mod prompt_refine;
pub mod provider_catalog;
pub mod provider_kernel;
pub use crate::api::provider_models;
pub mod provider_test;
pub mod settings;
pub mod shell_profiles;
pub mod speech;
pub mod speech_stream;
pub mod state;
pub use crate::process::tree as terminal;
pub mod terminal_pty;
pub mod themes;
pub mod threads;
pub mod title_maker;
pub mod todos;
pub mod tokens;
pub mod typing_assist;
pub mod undo_redo;
pub mod usage_stats;
pub mod web_host;

pub use crate::websearch::request::{
    aurora_websearch_with, AuroraWebSearchRequest, AuroraWebSearchResponse,
};
pub use crate::workspace::FileEntry;
// The command-stream ledger and runner keep their `commands::` paths.
pub use crate::process::streams::*;

// Shell commands for the window. The work is in [`crate::process::streams`].

#[tauri::command]
pub fn shell_background_processes() -> Vec<BackgroundProcessRow> {
    crate::process::streams::shell_background_processes()
}

/// Execute a shell command with optional shell profile.
#[tauri::command]
pub async fn execute_command(
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<CommandOutput, String> {
    crate::process::streams::execute_command(command, cwd, shell, timeout_ms).await
}

#[tauri::command]
pub fn cancel_command_stream(
    request_id: String,
    reason: Option<String>,
) -> Result<CommandStopOutcome, String> {
    crate::process::streams::cancel_command_stream(request_id, reason)
}

#[tauri::command]
pub fn detach_command_stream(request_id: String) -> Result<Option<String>, String> {
    crate::process::streams::detach_command_stream(request_id)
}

/// Run a command and stream its output to the window as `shell-stream-*`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_command_stream(
    app: tauri::AppHandle,
    request_id: String,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    timeout_ms: Option<u64>,
    log_path: Option<String>,
    keep_stdin_open: Option<bool>,
) -> Result<CommandOutput, String> {
    crate::process::streams::execute_command_stream(
        std::sync::Arc::new(app),
        request_id,
        command,
        cwd,
        shell,
        timeout_ms,
        log_path,
        keep_stdin_open,
    )
    .await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,         // e.g., "windows", "macos", "linux"
    pub os_version: String, // e.g., "10.0.26200" for Windows
    pub arch: String,       // e.g., "x86_64", "aarch64"
    pub hostname: String,
    pub shell: Option<String>, // Default shell path
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDocumentValidationRequest {
    pub content: String,
    pub format: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDocumentValidationResponse {
    pub column: Option<usize>,
    pub error: Option<String>,
    pub line: Option<usize>,
    pub valid: bool,
}

fn offset_to_line_column(content: &str, offset: usize) -> (usize, usize) {
    let mut line = 1usize;
    let mut column = 1usize;

    for character in content[..offset.min(content.len())].chars() {
        if character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }

    (line, column)
}

#[tauri::command]
pub async fn validate_structured_document(
    request: StructuredDocumentValidationRequest,
) -> Result<StructuredDocumentValidationResponse, String> {
    let format = request.format.to_lowercase();

    match format.as_str() {
        "json" => match serde_json::from_str::<serde_json::Value>(&request.content) {
            Ok(_) => Ok(StructuredDocumentValidationResponse {
                column: None,
                error: None,
                line: None,
                valid: true,
            }),
            Err(error) => Ok(StructuredDocumentValidationResponse {
                column: Some(error.column()),
                error: Some(error.to_string()),
                line: Some(error.line()),
                valid: false,
            }),
        },
        "yaml" | "yml" => match serde_yaml::from_str::<serde_yaml::Value>(&request.content) {
            Ok(_) => Ok(StructuredDocumentValidationResponse {
                column: None,
                error: None,
                line: None,
                valid: true,
            }),
            Err(error) => {
                let location = error.location();
                Ok(StructuredDocumentValidationResponse {
                    column: location.as_ref().map(|value| value.column()),
                    error: Some(error.to_string()),
                    line: location.as_ref().map(|value| value.line()),
                    valid: false,
                })
            }
        },
        "toml" => match toml::from_str::<toml::Value>(&request.content) {
            Ok(_) => Ok(StructuredDocumentValidationResponse {
                column: None,
                error: None,
                line: None,
                valid: true,
            }),
            Err(error) => {
                let (line, column) = error
                    .span()
                    .map(|span| offset_to_line_column(&request.content, span.start))
                    .unwrap_or((1, 1));

                Ok(StructuredDocumentValidationResponse {
                    column: Some(column),
                    error: Some(error.to_string()),
                    line: Some(line),
                    valid: false,
                })
            }
        },
        _ => Err(format!(
            "Unsupported structured document format: {}",
            request.format
        )),
    }
}

/// Ripgrep search for the window. The search itself is
/// [`crate::workspace::ripgrep`].
#[tauri::command]
pub async fn ripgrep_search(
    request: RipgrepSearchRequest,
) -> Result<RipgrepSearchResponse, String> {
    crate::workspace::ripgrep_search(request).await
}

static FS_WATCHER: OnceLock<Mutex<Option<notify::RecommendedWatcher>>> = OnceLock::new();

fn get_watcher_handle() -> &'static Mutex<Option<notify::RecommendedWatcher>> {
    FS_WATCHER.get_or_init(|| Mutex::new(None))
}

/// Search the web, or read one page.
///
/// The work lives in [`crate::websearch`]; this is the IPC edge. It resolves
/// which of the two actions was meant, validates that the argument that action
/// needs is present, and turns a [`crate::websearch::WebError`] into the string
/// the caller sees.
///
/// Both the per-request timeout and the response size ceiling are enforced
/// inside the client itself, so there is no wall-clock guard here: a hung
/// endpoint fails on its own rather than holding the bridge open.
#[tauri::command]
pub async fn aurora_websearch(
    request: AuroraWebSearchRequest,
) -> Result<AuroraWebSearchResponse, String> {
    // No browser rung on the IPC edge. The search webview belongs to the agent
    // window, and a frontend call is already running inside one — it can drive
    // a browser itself. The rung exists for the agent's tool, which cannot.
    aurora_websearch_with(request, None).await
}

// File commands for the window. The work is in [`crate::workspace::fs`].

/// Read directory contents (`include_hidden` defaults to true).
#[tauri::command]
pub async fn read_directory(
    path: String,
    include_hidden: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    crate::workspace::fs::read_directory(path, include_hidden).await
}

/// Read file content (cached, bounded by a wall-clock timeout).
#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    crate::workspace::fs::read_file_content(path).await
}

/// Read file content + size and mtime in one round-trip.
#[tauri::command]
pub async fn read_file_with_meta(path: String) -> Result<crate::file_cache::FileMeta, String> {
    crate::workspace::fs::read_file_with_meta(path).await
}

/// Current disk mtime, `0` when missing.
#[tauri::command]
pub async fn stat_file_mtime(path: String) -> Result<u64, String> {
    crate::workspace::fs::stat_file_mtime(path).await
}

/// Write file content, creating parent folders.
#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    crate::workspace::fs::write_file_content(path, content).await
}

/// Create a new folder.
#[tauri::command]
pub async fn create_folder(path: String) -> Result<(), String> {
    crate::workspace::fs::create_folder(path).await
}

/// Home and drives, for the browser's folder picker. `async` so the drive
/// probes stay off the UI thread.
#[tauri::command]
pub async fn list_filesystem_roots() -> crate::workspace::fs::FilesystemRoots {
    crate::workspace::fs::filesystem_roots()
}

/// Get system information (Cursor-style detailed info)
#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfo, String> {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();

    tokio::task::spawn_blocking(move || {
        // These helpers use blocking I/O / process execution, so run off the async runtime.
        let os_version = get_os_version();
        let shell = get_default_shell();

        SystemInfo {
            os,
            os_version,
            arch,
            hostname: hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string()),
            shell,
        }
    })
    .await
    .map_err(|e| format!("Failed to collect system info: {}", e))
}

/// Get OS version string
fn get_os_version() -> String {
    #[cfg(target_os = "windows")]
    {
        // Try to get Windows version from registry or environment
        if let Ok(output) = Command::new("cmd")
            .args(["/c", "ver"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let version_str = String::from_utf8_lossy(&output.stdout);
            // Parse "Microsoft Windows [Version 10.0.26200.2605]"
            if let Some(start) = version_str.find("Version ") {
                if let Some(end) = version_str[start..].find(']') {
                    let ver = &version_str[start + 8..start + end];
                    // Return just major.minor.build (e.g., "10.0.26200")
                    let parts: Vec<&str> = ver.split('.').collect();
                    if parts.len() >= 3 {
                        return format!("{}.{}.{}", parts[0], parts[1], parts[2]);
                    }
                    return ver.to_string();
                }
            }
        }
        "unknown".to_string()
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("sw_vers").arg("-productVersion").output() {
            return String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
        "unknown".to_string()
    }

    #[cfg(target_os = "linux")]
    {
        // Try to read from /etc/os-release
        if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
            for line in content.lines() {
                if line.starts_with("VERSION_ID=") {
                    return line
                        .trim_start_matches("VERSION_ID=")
                        .trim_matches('"')
                        .to_string();
                }
            }
        }
        // Fallback to uname
        if let Ok(output) = Command::new("uname").arg("-r").output() {
            return String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
        "unknown".to_string()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown".to_string()
    }
}

/// Get default shell path
fn get_default_shell() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // Check for PowerShell 7 first, then fall back to PowerShell 5, then cmd
        let ps7_paths = [
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Program Files (x86)\PowerShell\7\pwsh.exe",
        ];

        for path in ps7_paths {
            if Path::new(path).exists() {
                return Some(path.to_string());
            }
        }

        // Check for Windows PowerShell
        if let Ok(system_root) = std::env::var("SystemRoot") {
            let ps5_path = format!(
                r"{}\System32\WindowsPowerShell\v1.0\powershell.exe",
                system_root
            );
            if Path::new(&ps5_path).exists() {
                return Some(ps5_path);
            }
        }

        // Fallback to cmd.exe
        Some(
            std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string()),
        )
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Unix-like: check SHELL env var
        std::env::var("SHELL")
            .ok()
            .or_else(|| Some("/bin/sh".to_string()))
    }
}

/// Create a new file
#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);

    // Check if file already exists
    if file_path.exists() {
        return Err(format!("File already exists: {}", path));
    }

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }

    // Create empty file
    fs::File::create(file_path).map_err(|e| format!("Failed to create file: {}", e))?;

    Ok(())
}

/// Delete a file or folder
#[tauri::command]
pub async fn delete_path(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);

    if !target_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let result = if target_path.is_dir() {
        // Invalidate all cached files under this directory
        crate::file_cache::get_file_cache().invalidate_prefix(&path);
        fs::remove_dir_all(target_path).map_err(|e| format!("Failed to delete folder: {}", e))
    } else {
        // Invalidate the specific file
        crate::file_cache::get_file_cache().invalidate(&path);
        fs::remove_file(target_path).map_err(|e| format!("Failed to delete file: {}", e))
    };

    result
}

/// Rename a file or folder
#[tauri::command]
pub async fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    let new = Path::new(&new_path);

    if !old.exists() {
        return Err(format!("Path does not exist: {}", old_path));
    }

    if new.exists() {
        return Err(format!("Destination already exists: {}", new_path));
    }

    // Invalidate old path from cache (it's being renamed)
    let cache = crate::file_cache::get_file_cache();
    if old.is_dir() {
        cache.invalidate_prefix(&old_path);
    } else {
        cache.invalidate(&old_path);
    }

    fs::rename(old, new).map_err(|e| format!("Failed to rename: {}", e))
}

/// Copy a file or folder to a new location
#[tauri::command]
pub async fn copy_path(source: String, destination: String) -> Result<(), String> {
    let src = Path::new(&source);
    let dest = Path::new(&destination);

    if !src.exists() {
        return Err(format!("Source does not exist: {}", source));
    }

    if dest.exists() {
        return Err(format!("Destination already exists: {}", destination));
    }

    // Create parent directories if needed
    if let Some(parent) = dest.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }

    if src.is_file() {
        fs::copy(src, dest).map_err(|e| format!("Failed to copy file: {}", e))?;
    } else if src.is_dir() {
        copy_dir_recursive(src, dest)?;
    }

    Ok(())
}

/// Recursively copy a directory
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create directory: {}", e))?;

    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path).map_err(|e| format!("Failed to copy file: {}", e))?;
        }
    }

    Ok(())
}

/// Get the current workspace root directory
#[tauri::command]
pub async fn get_workspace_root() -> Result<String, String> {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get current directory: {}", e))
}

#[derive(Debug, Serialize, Clone)]
pub struct FsEventPayload {
    pub paths: Vec<String>,
    pub kind: String,
}

/// Subtrees that produce constant churn but never carry user-relevant
/// content. Any path whose components contain one of these names is
/// dropped before the watcher emits an `fs-changed` event.
///
/// Keep this list tight — anything we add here will go invisible to
/// the file explorer's auto-refresh + the in-IDE git status reload.
const WATCH_IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "build",
    "dist",
    ".next",
    ".turbo",
    ".cache",
    ".vite",
    ".parcel-cache",
    ".pnpm-store",
    ".yarn",
];

/// File suffixes that are always editor/build noise (lock files,
/// SQLite WAL/SHM, sourcemap rebuilds, …). Filtering these costs us
/// nothing because they're never opened in the editor.
const WATCH_IGNORED_FILE_SUFFIXES: &[&str] = &[
    ".lock",
    ".tmp",
    ".swp",
    ".swo",
    "~",
    ".db-wal",
    ".db-shm",
    ".sqlite-wal",
    ".sqlite-shm",
];

#[inline]
pub fn is_ignored_watch_path(path: &Path) -> bool {
    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
        if WATCH_IGNORED_FILE_SUFFIXES
            .iter()
            .any(|suffix| file_name.ends_with(suffix))
        {
            return true;
        }
    }
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|name| WATCH_IGNORED_DIR_NAMES.contains(&name))
            .unwrap_or(false)
    })
}

/// Start a filesystem watcher that emits `fs-changed` events to the frontend.
#[tauri::command]
pub async fn start_fs_watcher(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Watch path does not exist: {}", path));
    }

    // Stop existing watcher if any
    {
        let mut guard = get_watcher_handle()
            .lock()
            .map_err(|e| format!("Failed to lock watcher: {}", e))?;
        *guard = None;
    }

    let app_handle = app.clone();
    let mut watcher = recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            // Skip Access events outright — they fire on every read
            // (mtime/atime stat) and the frontend ignores them anyway.
            // Without this filter, running `git status` or HMR scans
            // alone produces thousands of IPC roundtrips per second.
            if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
                return;
            }

            // Drop events that touch only IGNORED subtrees (`.git/`,
            // `node_modules/`, `target/`, `build/`, `dist/`, etc).
            // Cargo, pnpm and Vite churn these directories thousands
            // of times during a dev rebuild and every modification
            // would otherwise:
            //   1. Invalidate the Rust file cache for that path
            //   2. Schedule a debounced `git_get_status` reload
            // Both are pure overhead — none of those files are user
            // content. We filter event-level (not path-level) so that
            // a single mixed event still fires for the user-content
            // paths it carries.
            let kept_paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| !is_ignored_watch_path(p))
                .map(|p| p.to_string_lossy().to_string())
                .collect();

            if kept_paths.is_empty() {
                return;
            }

            let kind_str = match event.kind {
                EventKind::Create(_) => "create",
                EventKind::Modify(_) => "modify",
                EventKind::Remove(_) => "remove",
                EventKind::Any => "any",
                EventKind::Access(_) => "access",
                EventKind::Other => "other",
            };

            let _ = app_handle.emit(
                "fs-changed",
                FsEventPayload {
                    paths: kept_paths,
                    kind: kind_str.to_string(),
                },
            );
        }
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .configure(Config::default().with_compare_contents(false))
        .map_err(|e| format!("Failed to configure watcher: {}", e))?;

    watcher
        .watch(target, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    {
        let mut guard = get_watcher_handle()
            .lock()
            .map_err(|e| format!("Failed to lock watcher: {}", e))?;
        *guard = Some(watcher);
    }

    Ok(())
}

/// Stop the filesystem watcher
#[tauri::command]
pub async fn stop_fs_watcher() -> Result<(), String> {
    let mut guard = get_watcher_handle()
        .lock()
        .map_err(|e| format!("Failed to lock watcher: {}", e))?;
    *guard = None;
    Ok(())
}

/// Reveal a file or folder in the system file explorer
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);

    if !target_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // Determine the path to reveal (parent folder if it's a file)
    #[allow(unused_variables)]
    let reveal_path = if target_path.is_file() {
        target_path.parent().unwrap_or(target_path)
    } else {
        target_path
    };

    #[cfg(target_os = "windows")]
    {
        // On Windows, use explorer with /select to highlight the item
        let select_path = if target_path.is_file() {
            format!("/select,{}", path)
        } else {
            path.clone()
        };

        Command::new("explorer")
            .arg(&select_path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try xdg-open first, then fall back to common file managers
        if let Err(xdg_error) = Command::new("xdg-open").arg(reveal_path).spawn() {
            Command::new("nautilus")
                .arg("--select")
                .arg(&path)
                .spawn()
                .map_err(|nautilus_error| {
                    format!(
                        "Failed to open a file manager (xdg-open: {xdg_error}; nautilus: {nautilus_error})"
                    )
                })?;
        }
    }

    Ok(())
}

/// Open a terminal at the specified path
#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);

    if !target_path.exists() {
        return Err(format!("Path does not exist: {}", target_path.display()));
    }

    // Use the path directly if it's a directory, otherwise use its parent
    let terminal_path = if target_path.is_dir() {
        target_path.to_path_buf()
    } else {
        target_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| target_path.to_path_buf())
    };

    #[cfg(target_os = "windows")]
    {
        // Try Windows Terminal first, then fall back to PowerShell.
        let wt_result = Command::new("wt")
            .arg("-d")
            .arg(terminal_path.to_string_lossy().to_string())
            .spawn();

        if wt_result.is_err() {
            // Fall back to PowerShell in a new window. `current_dir` avoids
            // interpolating a user path into a command string (and correctly
            // handles folders containing quotes or shell metacharacters).
            Command::new("powershell")
                .arg("-NoLogo")
                .arg("-NoExit")
                .current_dir(&terminal_path)
                .spawn()
                .map_err(|e| format!("Failed to open terminal: {}", e))?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&terminal_path)
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators
        let terminals = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
        let mut opened = false;

        for terminal in terminals {
            let result = match terminal {
                "gnome-terminal" => Command::new(terminal)
                    .arg("--working-directory")
                    .arg(terminal_path.to_string_lossy().to_string())
                    .spawn(),
                "konsole" => Command::new(terminal)
                    .arg("--workdir")
                    .arg(terminal_path.to_string_lossy().to_string())
                    .spawn(),
                _ => Command::new(terminal).current_dir(&terminal_path).spawn(),
            };

            if result.is_ok() {
                opened = true;
                break;
            }
        }

        if !opened {
            return Err("No supported terminal emulator found".to_string());
        }
    }

    Ok(())
}

// =============================================================================
// BATCH FILE OPERATIONS (Performance Optimized)
// =============================================================================

use std::collections::HashMap;

/// Read multiple files in a single IPC call (reduces overhead dramatically)
/// Returns a map of path -> content (or error message)
#[tauri::command]
pub async fn read_files_batch(paths: Vec<String>) -> HashMap<String, Result<String, String>> {
    let fallback_paths = paths.clone();
    match tokio::task::spawn_blocking(move || crate::file_cache::read_files_batch_cached(paths))
        .await
    {
        Ok(results) => results,
        Err(error) => fallback_paths
            .into_iter()
            .map(|path| (path, Err(format!("Batch file read task failed: {}", error))))
            .collect(),
    }
}

/// Invalidate a specific file or directory prefix from the cache
/// Call this after external file modifications
#[tauri::command]
pub async fn invalidate_file_cache(path: String, is_prefix: bool) -> Result<(), String> {
    let cache = crate::file_cache::get_file_cache();
    if is_prefix {
        cache.invalidate_prefix(&path);
    } else {
        cache.invalidate(&path);
    }
    Ok(())
}

/// Get cache statistics for debugging
#[tauri::command]
pub async fn get_cache_stats() -> (usize, usize) {
    crate::file_cache::get_file_cache().stats()
}

// =============================================================================
// CLI COMMANDS
// =============================================================================

/// Install the Aurora CLI to system PATH
/// This allows using `aurora .` from any terminal
#[tauri::command]
pub async fn install_aurora_cli() -> Result<String, String> {
    crate::cli::install::install_cli().map(|_| "Aurora CLI installed successfully".to_string())
}

/// Check if the Aurora CLI is installed
#[tauri::command]
pub async fn is_aurora_cli_installed() -> Result<bool, String> {
    crate::cli::install::is_cli_installed()
}

/// Uninstall the Aurora CLI from system PATH
#[tauri::command]
pub async fn uninstall_aurora_cli() -> Result<String, String> {
    crate::cli::install::uninstall_cli().map(|_| "Aurora CLI uninstalled successfully".to_string())
}

/// Install Aurora into the Windows Explorer context menu
#[tauri::command]
pub async fn install_aurora_context_menu() -> Result<String, String> {
    crate::cli::install::install_context_menu()
        .map(|_| "Aurora context menu installed successfully".to_string())
}

/// Check whether the Aurora context menu is installed
#[tauri::command]
pub async fn is_aurora_context_menu_installed() -> Result<bool, String> {
    crate::cli::install::is_context_menu_installed()
}

/// Remove Aurora from the Windows Explorer context menu
#[tauri::command]
pub async fn uninstall_aurora_context_menu() -> Result<String, String> {
    crate::cli::install::uninstall_context_menu()
        .map(|_| "Aurora context menu removed successfully".to_string())
}

/// App-state slot holding the CLI open request that this process was
/// launched with (if any). Populated once at startup in
/// `aurora_lib::run_with_args` and consumed exactly once by the
/// frontend's bootstrap effect via [`cli_take_pending_open_request`].
///
/// The slot exists because the prior design pushed a `cli-open` event
/// 500 ms after window creation — but Tauri events are not buffered, so
/// if the JS bundle wasn't ready in time the event was silently dropped
/// and "last workspace" restore won the race. Pull-on-mount eliminates
/// that race entirely.
#[derive(Default)]
pub struct PendingCliOpenState(pub Mutex<Option<crate::cli::CliOpenRequest>>);

/// The presence guard advertising that an Aurora is running.
///
/// Held purely for its lifetime — nothing ever reads it. It lives in managed
/// state because that is what keeps it alive for the process: dropped, the
/// name is released and every `aurora agent` in every terminal starts
/// launching a second Aurora on top of this one.
///
/// `None` when the OS refused the name. Not fatal — see
/// [`crate::cli_delegate::presence::hold`].
/// The `dead_code` allow is the point of the type, not a concession to it:
/// this is an RAII handle whose only job is to exist. rustc is right that
/// nothing reads the field and wrong that removing it would be harmless.
#[allow(dead_code)]
pub struct CliPresence(pub Option<single_instance::SingleInstance>);

/// The filesystem watcher over the CLI task directory.
///
/// Same reason as [`CliPresence`]: `notify` stops watching the moment the
/// watcher is dropped, so it has to be owned by something that outlives
/// startup. Behind a `Mutex` only because managed state must be `Sync` and
/// `RecommendedWatcher` is not.
/// Held, never read — see the note on [`CliPresence`].
#[allow(dead_code)]
pub struct CliTaskWatcher(pub Mutex<Option<notify::RecommendedWatcher>>);

/// Take (and clear) the pending CLI open request for this process.
///
/// Returns `Some(request)` on the first call after the app was launched
/// with a path/file arg, then `None` on every subsequent call. The
/// frontend uses this from its bootstrap effect to decide whether to
/// honour a CLI-supplied workspace or fall back to the saved
/// "last workspace" in the database.
#[tauri::command]
pub fn cli_take_pending_open_request(
    state: tauri::State<'_, PendingCliOpenState>,
) -> Option<crate::cli::CliOpenRequest> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn globs(value: &str) -> Vec<String> {
        parse_glob_patterns(&Some(value.to_string()))
    }

    /// `process_is_alive` is what lets a kill report the truth when
    /// `taskkill /T` exits non-zero over a tree member it could not touch. It
    /// is only worth anything if it actually distinguishes the two states, so
    /// this drives a real process through both.
    #[cfg(target_os = "windows")]
    #[test]
    fn a_killed_process_reads_as_gone_and_a_live_one_does_not() {
        // `pause` is a cmd BUILT-IN blocking on stdin, and the pipe stays open
        // for as long as the `Child` owns it. No external binary, so the test
        // cannot pass vacuously on a runner with a thin PATH — the first
        // version of it used `ping`, which was not on PATH here, exited
        // immediately, and made every assertion below true for the wrong
        // reason.
        let mut child = Command::new("cmd")
            .args(["/c", "pause"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn a process to kill");
        let pid = child.id();

        // Long enough that a process which failed to start has already gone,
        // so "alive" below is a real observation rather than a head start.
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            process_is_alive(pid),
            "a blocked process must read as alive — if this fails the test is proving nothing"
        );
        try_kill_pid(pid).expect("killing a plain child must succeed");
        assert!(
            !process_is_alive(pid),
            "the process must be gone once taskkill has run"
        );
        // Reaped so the test leaves no zombie behind on the runner.
        let _ = child.wait();

        // And the case the fix is FOR: a pid that no longer exists is not
        // something a kill left running, so it must never read as alive.
        assert!(!process_is_alive(pid), "a reaped pid must read as gone");
    }

    /// The regression this whole function exists for: a comma inside `{…}` is
    /// glob syntax, not a list separator. Splitting on it handed ripgrep
    /// `**/*.{ts` and it failed with "unclosed alternate group".
    #[test]
    fn brace_alternation_survives_as_one_glob() {
        assert_eq!(globs("**/*.{ts,tsx}"), vec!["**/*.{ts,tsx}"]);
        assert_eq!(globs("**/*.{ts,tsx,js,jsx}"), vec!["**/*.{ts,tsx,js,jsx}"]);
    }

    #[test]
    fn top_level_commas_still_separate_globs() {
        assert_eq!(
            globs("src/**/*.ts, tests/**/*.ts"),
            vec!["src/**/*.ts", "tests/**/*.ts"],
        );
    }

    #[test]
    fn separates_at_the_top_level_while_preserving_inner_commas() {
        assert_eq!(
            globs("src/**/*.{ts,tsx}, docs/**/*.{md,mdx}"),
            vec!["src/**/*.{ts,tsx}", "docs/**/*.{md,mdx}"],
        );
    }

    #[test]
    fn handles_nested_braces() {
        assert_eq!(globs("src/{a,b/{c,d}}/*.rs"), vec!["src/{a,b/{c,d}}/*.rs"],);
    }

    /// A comma inside a character class is a literal comma, not a separator.
    #[test]
    fn character_classes_keep_their_commas_and_braces() {
        assert_eq!(globs("file[a,b].rs"), vec!["file[a,b].rs"]);
        assert_eq!(globs("weird[{].rs"), vec!["weird[{].rs"]);
    }

    #[test]
    fn escaped_characters_are_not_treated_as_syntax() {
        assert_eq!(globs(r"a\,b.rs"), vec![r"a\,b.rs"]);
        assert_eq!(globs(r"a\{b,c.rs"), vec![r"a\{b", "c.rs"]);
    }

    /// Malformed input is forwarded verbatim so ripgrep can name the real
    /// problem — repairing it here would only guess at the intent.
    #[test]
    fn unbalanced_braces_pass_through_untouched() {
        assert_eq!(globs("**/*.{ts"), vec!["**/*.{ts"]);
    }

    #[test]
    fn blank_and_missing_values_yield_no_globs() {
        assert!(parse_glob_patterns(&None).is_empty());
        assert!(globs("").is_empty());
        assert!(globs("   ").is_empty());
        assert!(globs(" , , ").is_empty());
    }

    #[test]
    fn trims_whitespace_around_each_glob() {
        assert_eq!(
            globs("  **/*.rs  ,  **/*.toml "),
            vec!["**/*.rs", "**/*.toml"]
        );
    }

    #[test]
    fn keeps_negated_globs_intact() {
        assert_eq!(
            globs("**/*.{ts,tsx}, !**/node_modules/**"),
            vec!["**/*.{ts,tsx}", "!**/node_modules/**"],
        );
    }

    /// Searching runs inside the directory so slash-bearing globs anchor, which
    /// makes ripgrep report relative paths. Callers still need real ones.
    #[test]
    fn rejoins_relative_rg_paths_onto_the_search_directory() {
        let dir = PathBuf::from("E:/repo");
        for reported in ["./src/main.rs", ".\\src/main.rs", "src/main.rs"] {
            let out = absolutize_rg_path(Some(&dir), reported.to_string());
            assert!(
                out.starts_with("E:/repo") && out.ends_with("main.rs"),
                "unexpected {out} for {reported}",
            );
        }
    }

    /// A single-file search keeps the operand form, so its paths are already
    /// whatever the caller passed in and must not be rewritten.
    #[test]
    fn single_file_searches_keep_their_reported_path() {
        assert_eq!(
            absolutize_rg_path(None, "E:/repo/src/main.rs".to_string()),
            "E:/repo/src/main.rs",
        );
    }

    #[test]
    fn a_bare_dot_resolves_to_the_search_directory_itself() {
        let dir = PathBuf::from("E:/repo");
        assert_eq!(absolutize_rg_path(Some(&dir), "./".to_string()), "E:/repo");
    }

    // ---- `max_results` semantics -------------------------------------------
    //
    // These run the REAL ripgrep. `max_results` used to be forwarded to
    // `--max-count`, which is ripgrep's per-FILE limit: asking for 5 results
    // could collect hundreds, and the reported total was then clamped to the
    // cap, so the response claimed "5 matches" when thousands existed. Nothing
    // capped `files_with_matches` or `count` at all.

    fn cap_fixture(name: &str, files: usize, hits_per_file: usize) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aurora-grep-cap-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        for file in 0..files {
            let body = (0..hits_per_file)
                .map(|hit| format!("let needle_{file}_{hit} = 1;"))
                .collect::<Vec<_>>()
                .join("\n");
            std::fs::write(dir.join(format!("f{file}.rs")), body).expect("fixture file");
        }
        dir
    }

    fn search(dir: &PathBuf, mode: &str, max_results: u32) -> RipgrepSearchResponse {
        let request = RipgrepSearchRequest {
            case_insensitive: None,
            context_lines: None,
            glob: None,
            is_regex: Some(false),
            max_results: Some(max_results),
            output_mode: Some(mode.to_string()),
            path: dir.to_string_lossy().to_string(),
            pattern: "needle_".to_string(),
            timeout_ms: Some(30_000),
        };
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(ripgrep_search(request))
            .expect("search ran")
    }

    #[test]
    #[ignore = "read-only timing of the actual command against AURORA_INDEX_ROOT"]
    fn reported_workspace_ripgrep_timing() {
        let root = std::env::var("AURORA_INDEX_ROOT").expect("set AURORA_INDEX_ROOT");
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for (pattern, mode) in [("toErrorShape", "content"), (r"\bcn\(", "count"), ("toErrorShape", "content")] {
            let started = std::time::Instant::now();
            let request = RipgrepSearchRequest { case_insensitive: None, context_lines: None, glob: None, is_regex: Some(true), max_results: Some(60), output_mode: Some(mode.into()), path: root.clone(), pattern: pattern.into(), timeout_ms: None };
            let response = runtime.block_on(ripgrep_search(request)).unwrap();
            println!("{pattern} ({mode}): {}ms, success={}, returned={:?}, error={:?}", started.elapsed().as_millis(), response.success, response.returned, response.error);
            assert!(response.success);
        }
    }

    #[test]
    fn grep_missing_path_keeps_ripgrep_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        let response = search(&dir.path().join("missing-directory"), "content", 10);
        assert!(!response.success);
        let error = response.error.unwrap();
        assert!(error.contains("missing-directory"), "{error}");
        assert_ne!(error.trim(), "ripgrep search failed");
    }

    #[test]
    fn grep_invalid_regex_keeps_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        let request = RipgrepSearchRequest {
            path: dir.path().to_string_lossy().into_owned(),
            pattern: "[".into(),
            is_regex: Some(true),
            case_insensitive: None,
            context_lines: None,
            glob: None,
            max_results: None,
            output_mode: None,
            timeout_ms: Some(30_000),
        };
        let response = tokio::runtime::Runtime::new().unwrap()
            .block_on(ripgrep_search(request)).unwrap();
        assert!(!response.success);
        assert!(response.error.unwrap().contains("regex parse error"));
    }

    /// Issue C of the 2026-09-28 harness report (thread `5c20f9a3`): with
    /// `-C1` and matches ten lines apart, the context between them was given
    /// to BOTH matches, so line 23 read as what follows line 14. Each side
    /// gets only the lines inside its own window, and says where they start.
    #[test]
    fn grep_context_lines_stay_with_their_own_match() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=30)
            .map(|n| {
                if n == 14 || n == 24 {
                    format!("line {n} needle\n")
                } else {
                    format!("line {n}\n")
                }
            })
            .collect();
        std::fs::write(dir.path().join("a.txt"), body).unwrap();
        let request = RipgrepSearchRequest {
            path: dir.path().to_string_lossy().into_owned(),
            pattern: "needle".into(),
            is_regex: Some(false),
            case_insensitive: None,
            context_lines: Some(1),
            glob: None,
            max_results: None,
            output_mode: None,
            timeout_ms: Some(30_000),
        };
        let response = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(ripgrep_search(request))
            .unwrap();
        let matches = response.matches.expect("matches");
        assert_eq!(matches.len(), 2, "{matches:?}");

        let first = &matches[0];
        assert_eq!(first.line_number, 14);
        assert_eq!(first.before_context.as_deref(), Some(&["line 13".to_string()][..]));
        assert_eq!(first.before_context_start_line, Some(13));
        assert_eq!(first.after_context.as_deref(), Some(&["line 15".to_string()][..]));
        assert_eq!(first.after_context_start_line, Some(15));

        let second = &matches[1];
        assert_eq!(second.line_number, 24);
        assert_eq!(second.before_context.as_deref(), Some(&["line 23".to_string()][..]));
        assert_eq!(second.before_context_start_line, Some(23));
        assert_eq!(second.after_context.as_deref(), Some(&["line 25".to_string()][..]));
        assert_eq!(second.after_context_start_line, Some(25));
    }

    /// Two matches closer than the window share the line between them —
    /// that is what `rg` means, and dropping it from either side would hide
    /// real neighbouring code.
    #[test]
    fn grep_context_between_close_matches_belongs_to_both() {
        let pending = PendingContext {
            lines: vec![(6, "between".into())],
        };
        assert_eq!(pending.trailing(5, 1), vec![(6, "between".to_string())]);
        assert_eq!(pending.leading(7, 1), vec![(6, "between".to_string())]);

        let far = PendingContext {
            lines: vec![(15, "after first".into()), (23, "before second".into())],
        };
        assert_eq!(far.trailing(14, 1), vec![(15, "after first".to_string())]);
        assert_eq!(far.leading(24, 1), vec![(23, "before second".to_string())]);
    }

    #[test]
    fn grep_no_matches_is_successful() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("file.txt"), "nothing to match").unwrap();
        let response = search(&dir.path().to_path_buf(), "content", 10);
        assert!(response.success, "{:?}", response.error);
        assert_eq!(response.returned, Some(0));
        assert!(response.error.is_none());
    }

    #[test]
    fn content_mode_caps_total_matches_not_matches_per_file() {
        // 4 files x 10 hits = 40 matches available; ask for 6.
        let dir = cap_fixture("content", 4, 10);
        let response = search(&dir, "content", 6);
        let matches = response.matches.expect("content mode returns matches");

        assert_eq!(matches.len(), 6, "the cap is a TOTAL, not a per-file limit");
        assert_eq!(response.returned, Some(6));
        assert_eq!(response.truncated, Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_truncated_search_names_the_cap_and_the_way_out() {
        let dir = cap_fixture("message", 4, 10);
        let response = search(&dir, "content", 6);
        let message = response.message.expect("truncation explains itself");

        assert!(message.contains("first 6"), "{message}");
        assert!(message.contains("max_results"), "{message}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The old code reported `total_matches.min(max_results)` — the cap itself,
    /// dressed as a measurement. Then a capped search stopped reading and
    /// reported no total at all (dogfood F37). It now reads to the end, keeps
    /// only the capped rows, and reports the real totals.
    #[test]
    fn a_capped_content_search_still_reports_its_real_totals() {
        let dir = cap_fixture("totals", 4, 10);
        let response = search(&dir, "content", 6);

        assert_eq!(response.truncated, Some(true));
        assert_eq!(response.returned, Some(6));
        assert_eq!(response.matches.as_ref().map(Vec::len), Some(6));
        assert_eq!(response.total_matches, Some(40), "every match counted, not the cap");
        assert_eq!(response.total_files, Some(4));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The complement: a search that finished DOES know, and must say so.
    #[test]
    fn a_complete_search_reports_exact_totals() {
        let dir = cap_fixture("exact-totals", 4, 10);
        let response = search(&dir, "content", 500);

        assert_eq!(response.truncated, Some(false));
        assert_eq!(response.total_matches, Some(40));
        assert_eq!(response.total_files, Some(4));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_with_matches_is_capped_too() {
        let dir = cap_fixture("files", 6, 2);
        let response = search(&dir, "files_with_matches", 3);
        let files = response.files.expect("files mode returns files");

        assert_eq!(files.len(), 3);
        assert_eq!(response.returned, Some(3));
        assert_eq!(response.truncated, Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn count_mode_is_capped_and_its_counts_stay_whole() {
        let dir = cap_fixture("counts", 6, 4);
        let response = search(&dir, "count", 3);
        let counts = response.counts.expect("count mode returns counts");

        assert_eq!(counts.len(), 3);
        // A file only appears once ripgrep has finished it, so a capped search
        // never reports a half-counted file.
        for entry in &counts {
            assert_eq!(entry.count, 4, "{} was counted mid-file", entry.file);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Dogfood F18: a capped count list erased the grand total.
    #[test]
    fn capped_count_and_file_lists_keep_whole_search_totals() {
        let dir = cap_fixture("capped-totals", 6, 4);
        for mode in ["count", "files_with_matches"] {
            let response = search(&dir, mode, 3);
            assert_eq!(response.truncated, Some(true), "{mode}");
            assert_eq!(response.returned, Some(3), "{mode}");
            assert_eq!(response.total_files, Some(6), "{mode}");
            assert_eq!(response.total_matches, Some(24), "{mode}");
            let message = response.message.expect("truncation explains itself");
            assert!(message.contains("of 6"), "{mode}: {message}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Dogfood F17: two identical capped searches returned different files.
    #[test]
    fn capped_results_are_the_same_files_in_path_order_every_run() {
        let dir = cap_fixture("stable-order", 12, 2);
        let first = search(&dir, "files_with_matches", 4).files.unwrap();
        let mut sorted = first.clone();
        sorted.sort();
        assert_eq!(first, sorted, "files arrive in path order");
        for _ in 0..5 {
            assert_eq!(search(&dir, "files_with_matches", 4).files.unwrap(), first);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_search_that_fits_is_not_marked_truncated() {
        let dir = cap_fixture("fits", 2, 3);
        let response = search(&dir, "content", 50);

        assert_eq!(response.returned, Some(6));
        assert_eq!(response.total_matches, Some(6));
        assert_eq!(response.truncated, Some(false));
        assert!(response.message.is_none(), "nothing to explain");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Exactly `max_results` results is a COMPLETE search, not a truncated one.
    /// Reading one unit past the cap is what makes that distinguishable.
    #[test]
    fn landing_exactly_on_the_cap_is_not_truncation() {
        let dir = cap_fixture("exact", 2, 3);
        let response = search(&dir, "content", 6);

        assert_eq!(response.returned, Some(6));
        assert_eq!(response.truncated, Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pattern that starts with `-` used to be eaten by ripgrep as flags
    /// ("rg: unrecognized flag --color-border-…") because it was passed as a
    /// bare positional. `-e` makes any pattern safe — this pins the original
    /// failing shape, in both regex and fixed-string modes.
    #[test]
    fn a_pattern_starting_with_dashes_is_not_parsed_as_flags() {
        let dir = std::env::temp_dir().join("aurora-grep-dash-pattern");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        std::fs::write(
            dir.join("tokens.css"),
            ":root {\n  --color-border-success: #0a0;\n  --color-border-danger: #a00;\n}\n",
        )
        .expect("fixture file");

        for (pattern, is_regex) in [
            ("--color-border-(success|danger)", true),
            ("--color-border-success", false),
        ] {
            let request = RipgrepSearchRequest {
                case_insensitive: None,
                context_lines: None,
                glob: None,
                is_regex: Some(is_regex),
                max_results: Some(10),
                output_mode: Some("content".to_string()),
                path: dir.to_string_lossy().to_string(),
                pattern: pattern.to_string(),
                timeout_ms: Some(30_000),
            };
            let response = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime")
                .block_on(ripgrep_search(request))
                .expect("search ran");

            assert_eq!(
                response.success, true,
                "pattern {pattern:?} failed: {:?}",
                response.error
            );
            let expected = if is_regex { 2 } else { 1 };
            assert_eq!(
                response.total_matches,
                Some(expected),
                "pattern {pattern:?} should match",
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_result_explains_itself_rather_than_going_silent() {
        let dir = cap_fixture("empty", 1, 1);
        let request = RipgrepSearchRequest {
            case_insensitive: None,
            context_lines: None,
            glob: None,
            is_regex: Some(false),
            max_results: Some(10),
            output_mode: Some("content".to_string()),
            path: dir.to_string_lossy().to_string(),
            pattern: "no_such_text_anywhere".to_string(),
            timeout_ms: Some(30_000),
        };
        let response = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(ripgrep_search(request))
            .expect("search ran");

        assert_eq!(response.success, true);
        assert_eq!(response.total_matches, Some(0));
        assert_eq!(response.truncated, Some(false));
        assert!(response.message.is_some(), "an empty result must say why");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn read_back(log: ProcessLog, path: &std::path::Path) -> String {
        drop(log);
        std::fs::read_to_string(path).expect("log readable")
    }

    #[test]
    fn footer_closes_a_log_that_ends_mid_line() {
        let file = std::env::temp_dir().join("aurora-log-midline");
        let _ = std::fs::remove_file(&file);
        let path = file.to_string_lossy().to_string();

        let mut log = ProcessLog::open(Some(&path));
        // A killed process rarely gets to finish its last line.
        log.write("line 1\nline 2");
        log.footer("Stopped by the user", std::time::Instant::now());

        let text = read_back(log, &file);
        assert!(
            text.contains("line 2\n[aurora] Stopped by the user"),
            "footer must start its own line: {text:?}"
        );
        assert!(text.ends_with("No further output.\n"));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn footer_does_not_insert_a_blank_line_after_clean_output() {
        let file = std::env::temp_dir().join("aurora-log-clean");
        let _ = std::fs::remove_file(&file);
        let path = file.to_string_lossy().to_string();

        let mut log = ProcessLog::open(Some(&path));
        log.write("done\n");
        log.footer("Exited normally (code 0)", std::time::Instant::now());

        let text = read_back(log, &file);
        assert!(text.contains("done\n[aurora] Exited normally (code 0)"));
        assert!(!text.contains("\n\n"));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn footer_is_a_no_op_without_a_file() {
        // A command with no log path must not panic on the way out.
        ProcessLog::open(None).footer("Stopped by the user", std::time::Instant::now());
    }

    #[test]
    fn stop_reason_defaults_to_the_user() {
        assert_eq!(StopReason::parse(None), StopReason::User);
        assert_eq!(StopReason::parse(Some("user")), StopReason::User);
        assert_eq!(StopReason::parse(Some("agent")), StopReason::Agent);
        // An unknown string is the stop button misreporting itself, not the
        // agent — attributing it to shell_kill would be a lie in the log.
        assert_eq!(StopReason::parse(Some("nonsense")), StopReason::User);
    }

    #[test]
    fn durations_read_naturally() {
        use std::time::Duration;
        assert_eq!(human_duration(Duration::from_millis(320)), "320ms");
        assert_eq!(human_duration(Duration::from_millis(1_400)), "1.4s");
        assert_eq!(human_duration(Duration::from_secs(47)), "47s");
        assert_eq!(human_duration(Duration::from_secs(192)), "3m 12s");
        assert_eq!(human_duration(Duration::from_secs(3_840)), "1h 04m");
    }

    /// Registers one ledger row and removes it however the test ends, so these
    /// cannot leak into each other through the process-wide map.
    fn with_registered_stream(request_id: &str, body: impl FnOnce()) {
        register_command_stream(
            request_id.to_string(),
            request_id.to_string(),
            None,
            "pnpm build".to_string(),
            None,
            None,
        );
        body();
        cleanup_command_stream(request_id);
    }

    #[test]
    fn detaching_leaves_the_process_running_and_listed() {
        with_registered_stream("detach-keeps-the-row", || {
            assert!(!command_stream_detached("detach-keeps-the-row"));

            let stream = detach_tracked_command_stream("detach-keeps-the-row")
                .expect("a running command can be handed over");

            assert!(stream.detached);
            // The row must survive: the dock renders from it, `shell_kill`
            // resolves through it, and the ending is announced off it. Removing
            // it here is what would make a detached process unstoppable.
            assert!(command_stream_detached("detach-keeps-the-row"));
            assert!(list_command_streams()
                .iter()
                .any(|row| row.request_id == "detach-keeps-the-row"));
            // And it is NOT a cancellation: nothing was asked to stop.
            assert!(!stream.cancelled);
            assert_eq!(command_stream_stop("detach-keeps-the-row"), None);
        });
    }

    /// The dock's list is not the ledger. Every foreground `shell_execute` is
    /// tracked too — that is how it gets a stop button and a live stream — and
    /// listing those as background processes is what made an ordinary command
    /// announce itself as one when it finished.
    #[test]
    fn only_deliberate_background_work_reaches_the_process_list() {
        // A plain foreground command: no name, nobody detached it.
        with_registered_stream("dock-foreground", || {
            assert!(
                !shell_background_processes()
                    .iter()
                    .any(|row| row.request_id == "dock-foreground"),
                "a command the agent is waiting on is not a background process"
            );

            // The same command, after the user presses "Run in background".
            detach_tracked_command_stream("dock-foreground").expect("detaches");
            assert!(
                shell_background_processes()
                    .iter()
                    .any(|row| row.request_id == "dock-foreground"),
                "handing it over is what puts it in the list"
            );
        });

        // A spawn, which the schema requires to carry a name.
        register_command_stream(
            "dock-spawn".into(),
            "dock-spawn".into(),
            Some("Vite dev server".into()),
            "pnpm dev".into(),
            None,
            None,
        );
        assert!(shell_background_processes()
            .iter()
            .any(|row| row.request_id == "dock-spawn"));
        cleanup_command_stream("dock-spawn");
    }

    #[test]
    fn detaching_twice_is_not_an_error() {
        with_registered_stream("detach-idempotent", || {
            assert!(detach_tracked_command_stream("detach-idempotent").is_ok());
            // Double-click, or a click as the command finishes. Neither is
            // worth an error message to a person who got what they asked for.
            assert!(detach_tracked_command_stream("detach-idempotent").is_ok());
        });
    }

    #[test]
    fn a_stopping_command_cannot_be_detached() {
        with_registered_stream("detach-after-stop", || {
            {
                let mut streams = ACTIVE_COMMAND_STREAMS.write();
                let stream = streams.get_mut("detach-after-stop").expect("registered");
                stream.cancelled = true;
                stream.stop_reason = Some(StopReason::User);
            }
            // Answering "it is running in the background" over a process on its
            // way out is the same lie `browser_navigate` used to tell.
            let err = detach_tracked_command_stream("detach-after-stop")
                .expect_err("a stopping command is not a candidate");
            assert!(err.contains("already stopping"), "{err}");
        });
    }

    #[test]
    fn detaching_something_that_already_finished_says_so() {
        let err = detach_tracked_command_stream("never-registered")
            .expect_err("nothing to hand over");
        assert!(err.contains("already finished"), "{err}");
    }

    #[test]
    fn the_log_tail_survives_a_missing_file_and_a_split_character() {
        // No log, no panic: the detached result still states what happened.
        assert_eq!(read_process_log_tail(None), "");
        assert_eq!(read_process_log_tail(Some("E:/nope/missing.log")), "");

        let dir = std::env::temp_dir().join("aurora-detach-tail-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("out.log");

        std::fs::write(&path, "short output\n").expect("write");
        assert_eq!(
            read_process_log_tail(path.to_str()),
            "short output\n",
            "a log under the cap is returned whole"
        );

        // 32 KiB of a 3-byte character, so the naive cut lands mid-sequence.
        let big = "☃".repeat(20_000);
        std::fs::write(&path, &big).expect("write");
        let tail = read_process_log_tail(path.to_str());
        assert!(tail.len() <= 32 * 1024);
        assert!(
            !tail.starts_with('\u{FFFD}'),
            "the tail must start on a character boundary, not a replacement glyph"
        );
        assert!(big.ends_with(&tail), "the tail is the END of the log");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
