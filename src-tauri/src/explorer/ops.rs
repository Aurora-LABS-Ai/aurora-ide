//! The explorer commands, written once for every host. The window's
//! `#[tauri::command]`s (`commands.rs` beside this) and
//! `host_commands::explorer` call these with the host's explorer state, its
//! database and its event sink. The tree lives with the engine, so every
//! front end shows the same project files.

use std::sync::Arc;

use notify::{recommended_watcher, Config, Event, EventKind, RecursiveMode, Watcher};

use super::state::ExplorerStateHandle;
use super::types::ExplorerSnapshot;
use crate::db::DatabaseAccess;
use crate::host_commands::run_db;
use crate::host_events::Events;
use crate::workspace::watch::{is_ignored_watch_path, FsEventPayload};

/// Open a workspace and build the explorer tree in Rust.
pub async fn open_workspace(
    state: &ExplorerStateHandle,
    db: Arc<dyn DatabaseAccess>,
    events: Events,
    path: String,
    show_hidden: Option<bool>,
) -> Result<ExplorerSnapshot, String> {
    let lookup = path.clone();
    let persisted_state = run_db(db, move |database| {
        database
            .explorer()
            .get(&lookup)
            .map_err(|error| format!("failed to load explorer state: {:?}", error))
    })
    .await?;

    let handle = state.clone();
    tokio::task::spawn_blocking(move || {
        let snapshot = {
            let mut explorer = handle.lock_manager();
            explorer.open_workspace(path, persisted_state, show_hidden.unwrap_or(true))?
        };
        start_workspace_watcher(events, handle, snapshot.root_path.clone())?;
        Ok(snapshot)
    })
    .await
    .map_err(|e| format!("Opening the workspace failed: {e}"))?
}

/// Persist the current Rust-owned explorer state to the database.
pub async fn save_state(state: &ExplorerStateHandle, db: Arc<dyn DatabaseAccess>) -> Result<(), String> {
    let persisted_state = {
        let explorer = state.lock_manager();
        explorer.persisted_state()
    };
    let Some(saved) = persisted_state else {
        return Ok(());
    };
    run_db(db, move |database| {
        database
            .explorer()
            .save(&saved)
            .map_err(|error| format!("failed to save explorer state: {:?}", error))
    })
    .await
}

/// Clear the Rust-owned explorer workspace.
pub fn clear_workspace(state: &ExplorerStateHandle) {
    state.clear_watcher();
    let mut explorer = state.lock_manager();
    explorer.clear_workspace();
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
    events: Events,
    explorer_state: ExplorerStateHandle,
    root_path: String,
) -> Result<(), String> {
    let target = std::path::Path::new(&root_path);
    if !target.exists() {
        return Err(format!("watch path does not exist: {}", root_path));
    }

    explorer_state.clear_watcher();

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
        // `workspace::watch::is_ignored_watch_path` so both the legacy
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

        let _ = events.emit(
            "fs-changed",
            FsEventPayload {
                paths: paths.clone(),
                kind: kind.to_string(),
            },
        );

        let snapshot = {
            let mut explorer = state_handle.lock_manager();
            explorer.apply_fs_changes(&paths, Some(kind)).ok()
        };

        if let Some(snapshot) = snapshot {
            let _ = events.emit("explorer-updated", &snapshot);
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
