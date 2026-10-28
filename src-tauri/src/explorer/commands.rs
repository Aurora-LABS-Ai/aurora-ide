//! The window's explorer commands. The tree itself is [`super::service`]; the
//! workspace open, the save and the watcher are [`super::ops`], which
//! `host_commands::explorer` serves to other hosts too.

use std::sync::Arc;

use tauri::{AppHandle, State};

use super::ops;
use super::state::ExplorerStateHandle;
use super::types::ExplorerSnapshot;
use crate::db::DatabaseAccess;

/// Open a workspace and build the explorer tree in Rust.
#[tauri::command]
pub async fn explorer_open_workspace(
    app: AppHandle,
    path: String,
    show_hidden: Option<bool>,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    let db: Arc<dyn DatabaseAccess> = Arc::new(app.clone());
    ops::open_workspace(&explorer_state, db, Arc::new(app), path, show_hidden).await
}

/// Refresh the full explorer tree from disk.
#[tauri::command(async)]
pub fn explorer_refresh(
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    explorer_state.lock_manager().refresh()
}

/// Apply file system changes to the Rust-owned explorer tree.
#[tauri::command(async)]
pub fn explorer_apply_fs_changes(
    paths: Vec<String>,
    kind: Option<String>,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    explorer_state.lock_manager().apply_fs_changes(&paths, kind.as_deref())
}

/// Toggle a folder in the Rust-owned explorer tree.
#[tauri::command(async)]
pub fn explorer_toggle_folder(
    folder_id: String,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    explorer_state.lock_manager().toggle_folder(&folder_id)
}

/// Expand a folder in the Rust-owned explorer tree.
#[tauri::command(async)]
pub fn explorer_expand_folder(
    folder_id: String,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    explorer_state.lock_manager().expand_folder(&folder_id)
}

/// Select a file in the Rust-owned explorer state.
#[tauri::command(async)]
pub fn explorer_select_file(
    file_id: Option<String>,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    explorer_state.lock_manager().select_file(file_id)
}

/// Reveal a file by expanding its parent folders in Rust.
#[tauri::command(async)]
pub fn explorer_reveal_file(
    file_path: String,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    explorer_state.lock_manager().reveal_file(&file_path)
}

/// Collapse the visible explorer tree.
#[tauri::command(async)]
pub fn explorer_collapse_all(
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<ExplorerSnapshot, String> {
    explorer_state.lock_manager().collapse_all()
}

/// Persist the current Rust-owned explorer state to the database.
#[tauri::command]
pub async fn explorer_save_state(
    app: AppHandle,
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<(), String> {
    ops::save_state(&explorer_state, Arc::new(app)).await
}

/// Get the current Rust-owned explorer snapshot.
#[tauri::command(async)]
pub fn explorer_get_state(
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<Option<ExplorerSnapshot>, String> {
    Ok(explorer_state.lock_manager().get_snapshot())
}

/// Clear the Rust-owned explorer workspace.
#[tauri::command(async)]
pub fn explorer_clear_workspace(
    explorer_state: State<'_, ExplorerStateHandle>,
) -> Result<(), String> {
    ops::clear_workspace(&explorer_state);
    Ok(())
}
