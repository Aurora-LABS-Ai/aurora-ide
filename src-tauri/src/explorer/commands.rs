use std::sync::Mutex;

use notify::{recommended_watcher, Config, Event, EventKind, RecursiveMode, Watcher};
use tauri::State;
use tauri::{AppHandle, Emitter};

use crate::commands::{is_ignored_watch_path, FsEventPayload};
use crate::db::Database;

use super::state::ExplorerStateHandle;
use super::types::ExplorerSnapshot;

/// Open a workspace and build the explorer tree in Rust.
#[tauri::command]
pub fn explorer_open_workspace(
    app: AppHandle,
    path: String,
    show_hidden: Option<bool>,
    db: State<'_, Mutex<Database>>,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    let persisted_state = {
        let database = db.lock().map_err(|error| error.to_string())?;
        database
            .explorer()
            .get(&path)
            .map_err(|error| format!("failed to load explorer state: {:?}", error))?
    };

    let handle = explorer_state.inner().clone();

    let snapshot = {
        let mut explorer = explorer_state.lock_manager();
        explorer.open_workspace(path, persisted_state, show_hidden.unwrap_or(true))?
    };

    start_workspace_watcher(app, handle, snapshot.root_path.clone())?;
    Ok(snapshot)
}

/// Refresh the full explorer tree from disk.
#[tauri::command]
pub fn explorer_refresh(
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    let mut explorer = explorer_state.lock_manager();
    explorer.refresh()
}

/// Apply file system changes to the Rust-owned explorer tree.
#[tauri::command]
pub fn explorer_apply_fs_changes(
    paths: Vec<String>,
    kind: Option<String>,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    let mut explorer = explorer_state.lock_manager();
    explorer.apply_fs_changes(&paths, kind.as_deref())
}

/// Toggle a folder in the Rust-owned explorer tree.
#[tauri::command]
pub fn explorer_toggle_folder(
    folder_id: String,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    let mut explorer = explorer_state.lock_manager();
    explorer.toggle_folder(&folder_id)
}

/// Expand a folder in the Rust-owned explorer tree.
#[tauri::command]
pub fn explorer_expand_folder(
    folder_id: String,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    let mut explorer = explorer_state.lock_manager();
    explorer.expand_folder(&folder_id)
}

/// Select a file in the Rust-owned explorer state.
#[tauri::command]
pub fn explorer_select_file(
    file_id: Option<String>,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    let mut explorer = explorer_state.lock_manager();
    explorer.select_file(file_id)
}

/// Reveal a file by expanding its parent folders in Rust.
#[tauri::command]
pub fn explorer_reveal_file(
    file_path: String,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    let mut explorer = explorer_state.lock_manager();
    explorer.reveal_file(&file_path)
}

/// Collapse the visible explorer tree.
#[tauri::command]
pub fn explorer_collapse_all(
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    let mut explorer = explorer_state.lock_manager();
    explorer.collapse_all()
}

/// Persist the current Rust-owned explorer state to the database.
#[tauri::command]
pub fn explorer_save_state(
    db: State<'_, Mutex<Database>>,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<(), String> {
    let persisted_state = {
        let explorer = explorer_state.lock_manager();
        explorer.persisted_state()
    };

    let Some(state) = persisted_state else {
        return Ok(());
    };

    let database = db.lock().map_err(|error| error.to_string())?;
    database
        .explorer()
        .save(&state)
        .map_err(|error| format!("failed to save explorer state: {:?}", error))
}

/// Get the current Rust-owned explorer snapshot.
#[tauri::command]
pub fn explorer_get_state(
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<Option<ExplorerSnapshot>, String> {
    let explorer = explorer_state.lock_manager();
    Ok(explorer.get_snapshot())
}

/// Clear the Rust-owned explorer workspace.
#[tauri::command]
pub fn explorer_clear_workspace(explorer_state: State<'_, ExplorerStateHandle>) {
    explorer_state.clear_watcher();
    let mut explorer = explorer_state.lock_manager();
    explorer.clear_workspace();
}

fn emit_explorer_snapshot(app: &AppHandle, snapshot: &ExplorerSnapshot) {
    let _ = app.emit("explorer-updated", snapshot);
}

fn emit_fs_event(app: &AppHandle, paths: Vec<String>, kind: &str) {
    let _ = app.emit(
        "fs-changed",
        FsEventPayload {
            paths,
            kind: kind.to_string(),
        },
    );
}

fn map_event_kind(event_kind: &EventKind) -> &'static str {
    match event_kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        EventKind::Any => "any",
        EventKind::Access(_) => "access",
        EventKind::Other => "other",
    }
}

fn start_workspace_watcher(
    app: AppHandle,
    explorer_state: ExplorerStateHandle,
    root_path: String,
) -> Result<(), String> {
    let target = std::path::Path::new(&root_path);
    if !target.exists() {
        return Err(format!("watch path does not exist: {}", root_path));
    }

    explorer_state.clear_watcher();

    let app_handle = app.clone();
    let state_handle = explorer_state.clone();

    let mut watcher = recommended_watcher(move |result: Result<Event, notify::Error>| {
        let Ok(event) = result else {
            return;
        };

        // Drop pure-metadata events (Access) and unclassified Other —
        // they fire on every read and the frontend ignores them.
        // Without this filter the watcher pumps thousands of useless
        // IPC events per second when cargo / vite / git are active.
        if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
            return;
        }

        // Filter out churn-only subtrees (`.git/`, `node_modules/`,
        // `target/`, `build/`, …). Keeping these would force the
        // explorer + git status reload pipeline to recompute on every
        // cargo rebuild and HMR cycle. The shared filter lives in
        // `commands::is_ignored_watch_path` so both the legacy
        // `start_fs_watcher` and this explorer-owned watcher behave
        // identically.
        let paths: Vec<String> = event
            .paths
            .iter()
            .filter(|path| !is_ignored_watch_path(path))
            .map(|path| path.to_string_lossy().to_string())
            .collect();

        if paths.is_empty() {
            return;
        }

        let kind = map_event_kind(&event.kind);

        emit_fs_event(&app_handle, paths.clone(), kind);

        let snapshot = {
            let mut explorer = state_handle.lock_manager();
            explorer.apply_fs_changes(&paths, Some(kind)).ok()
        };

        if let Some(snapshot) = snapshot {
            emit_explorer_snapshot(&app_handle, &snapshot);
        }
    })
    .map_err(|error| format!("failed to create explorer watcher: {}", error))?;

    watcher
        .configure(Config::default().with_compare_contents(false))
        .map_err(|error| format!("failed to configure explorer watcher: {}", error))?;

    watcher
        .watch(target, RecursiveMode::Recursive)
        .map_err(|error| format!("failed to watch explorer path: {}", error))?;

    explorer_state.replace_watcher(watcher);
    Ok(())
}
