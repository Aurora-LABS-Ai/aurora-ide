//! The window's Cursor commands. The bodies are written once in
//! [`crate::api::cursor::commands`], which `aurora serve` serves too; these
//! hand them the app as the database access.

use std::sync::Arc;

use tauri::AppHandle;

use crate::api::cursor::auth::CursorAuthStatus;
use crate::api::cursor::commands as core;
use crate::api::cursor::commands::CursorModelCatalogue;
use crate::api::cursor::usage::CursorUsageSnapshot;
use crate::db::{CursorModel, DatabaseAccess};

fn db(app: AppHandle) -> Arc<dyn DatabaseAccess> {
    Arc::new(app)
}

#[tauri::command]
pub async fn cursor_auth_status() -> Result<CursorAuthStatus, String> {
    core::auth_status().await
}

#[tauri::command]
pub async fn cursor_usage_get() -> Result<CursorUsageSnapshot, String> {
    core::usage_get().await
}

#[tauri::command]
pub async fn cursor_auth_connect() -> Result<CursorAuthStatus, String> {
    core::auth_connect().await
}

#[tauri::command]
pub async fn cursor_auth_sign_out(app: AppHandle) -> Result<(), String> {
    core::auth_sign_out(db(app)).await
}

#[tauri::command]
pub async fn cursor_models_list(app: AppHandle) -> Result<CursorModelCatalogue, String> {
    core::models_list(db(app)).await
}

#[tauri::command]
pub async fn cursor_models_list_enabled(app: AppHandle) -> Result<Vec<CursorModel>, String> {
    core::models_list_enabled(db(app)).await
}

#[tauri::command]
pub async fn cursor_models_refresh(app: AppHandle) -> Result<CursorModelCatalogue, String> {
    core::models_refresh(db(app)).await
}

#[tauri::command]
pub async fn cursor_model_set_enabled(
    model_id: String,
    enabled: bool,
    app: AppHandle,
) -> Result<bool, String> {
    core::model_set_enabled(db(app), model_id, enabled).await
}

#[tauri::command]
pub async fn cursor_models_set_enabled_bulk(
    model_ids: Vec<String>,
    enabled: bool,
    app: AppHandle,
) -> Result<usize, String> {
    core::models_set_enabled_bulk(db(app), model_ids, enabled).await
}

#[tauri::command]
pub async fn cursor_state_db_path() -> Result<Option<String>, String> {
    core::state_db_path().await
}
