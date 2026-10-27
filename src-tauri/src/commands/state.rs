//! Saved workspace / editor / explorer state. The bodies are written once in
//! `host_commands::settings`; these lock the window's database and call them.

use std::sync::Mutex;
use tauri::State;

use crate::db::{Database, EditorState, ExplorerState, WorkspaceState};
use crate::host_commands::settings as core;

fn locked<T>(
    db: &State<'_, Mutex<Database>>,
    f: impl FnOnce(&Database) -> Result<T, String>,
) -> Result<T, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    f(&db)
}

#[tauri::command(async)]
pub fn save_workspace_state(state: WorkspaceState, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    locked(&db, |db| core::save_workspace_state(db, &state))
}

/// By path, or the most recent workspace when none is given.
#[tauri::command(async)]
pub fn get_workspace_state(
    workspace_path: Option<String>,
    db: State<'_, Mutex<Database>>,
) -> Result<Option<WorkspaceState>, String> {
    locked(&db, |db| core::get_workspace_state(db, workspace_path.as_deref()))
}

/// Recently opened workspaces, newest first.
#[tauri::command(async)]
pub fn list_recent_workspaces(
    limit: Option<usize>,
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<WorkspaceState>, String> {
    locked(&db, |db| core::list_recent_workspaces(db, limit))
}

#[tauri::command(async)]
pub fn save_editor_state(state: EditorState, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    locked(&db, |db| core::save_editor_state(db, &state))
}

#[tauri::command(async)]
pub fn get_editor_state(
    file_path: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Option<EditorState>, String> {
    locked(&db, |db| core::get_editor_state(db, &file_path))
}

#[tauri::command(async)]
pub fn save_explorer_state(state: ExplorerState, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    locked(&db, |db| core::save_explorer_state(db, &state))
}

#[tauri::command(async)]
pub fn get_explorer_state(
    workspace_path: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Option<ExplorerState>, String> {
    locked(&db, |db| core::get_explorer_state(db, &workspace_path))
}
