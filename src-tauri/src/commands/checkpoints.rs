//! The window's checkpoint commands. The bodies are written once in
//! [`crate::checkpoints::commands`], which `aurora serve` serves too; these
//! hand them the managed checkpoint state and the app as the database access.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::checkpoints::commands as core;
pub use crate::checkpoints::commands::{CheckpointResponse, CheckpointState, RestoreResponse};
use crate::checkpoints::Checkpoint;
use crate::db::DatabaseAccess;
use crate::paths;

fn db(app: AppHandle) -> Arc<dyn DatabaseAccess> {
    Arc::new(app)
}

/// Initialize checkpoint service (called on app startup)
#[tauri::command]
pub async fn checkpoint_init(
    _app: tauri::AppHandle,
    checkpoint_state: State<'_, CheckpointState>,
) -> Result<(), String> {
    checkpoint_state.init(paths::checkpoints_dir());
    Ok(())
}

#[tauri::command]
pub async fn checkpoint_ensure_initialized(
    workspace_path: String,
    checkpoint_state: State<'_, CheckpointState>,
) -> Result<(), String> {
    core::ensure_initialized(&checkpoint_state, workspace_path).await
}

/// Create a checkpoint for the current workspace state
/// Called when user sends a message
#[tauri::command]
pub async fn checkpoint_create(
    workspace_path: String,
    thread_id: String,
    message_id: String,
    checkpoint_state: State<'_, CheckpointState>,
    app: AppHandle,
) -> Result<CheckpointResponse, String> {
    core::create(&checkpoint_state, db(app), workspace_path, thread_id, message_id).await
}

/// Restore workspace to a specific checkpoint and delete all messages after it
#[tauri::command]
pub async fn checkpoint_restore(
    workspace_path: String,
    thread_id: String,
    checkpoint_id: String,
    checkpoint_state: State<'_, CheckpointState>,
    app: AppHandle,
) -> Result<RestoreResponse, String> {
    core::restore(&checkpoint_state, db(app), workspace_path, thread_id, checkpoint_id).await
}

#[tauri::command]
pub async fn checkpoint_list(thread_id: String, app: AppHandle) -> Result<Vec<Checkpoint>, String> {
    core::list(db(app), thread_id).await
}

#[tauri::command]
pub async fn checkpoint_get_by_message(
    message_id: String,
    app: AppHandle,
) -> Result<Option<Checkpoint>, String> {
    core::get_by_message(db(app), message_id).await
}

/// Delete all checkpoints for a thread (used when deleting a thread)
#[tauri::command]
pub async fn checkpoint_delete_thread(
    thread_id: String,
    workspace_path: Option<String>,
    checkpoint_state: State<'_, CheckpointState>,
    app: AppHandle,
) -> Result<(), String> {
    core::delete_thread(&checkpoint_state, db(app), thread_id, workspace_path).await
}

#[tauri::command]
pub async fn checkpoint_delete_workspace(
    workspace_path: String,
    checkpoint_state: State<'_, CheckpointState>,
    app: AppHandle,
) -> Result<(), String> {
    core::delete_workspace(&checkpoint_state, db(app), workspace_path).await
}

#[tauri::command]
pub async fn checkpoint_is_initialized(
    workspace_path: String,
    checkpoint_state: State<'_, CheckpointState>,
) -> Result<bool, String> {
    core::is_initialized(&checkpoint_state, workspace_path).await
}

#[tauri::command]
pub async fn checkpoint_get_enabled(workspace_path: String, app: AppHandle) -> Result<bool, String> {
    core::get_enabled(db(app), workspace_path).await
}

#[tauri::command]
pub async fn checkpoint_set_enabled(
    workspace_path: String,
    enabled: bool,
    app: AppHandle,
) -> Result<(), String> {
    core::set_enabled(db(app), workspace_path, enabled).await
}
