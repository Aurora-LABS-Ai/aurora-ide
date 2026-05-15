use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::State;

use crate::checkpoints::{Checkpoint, CheckpointService};
use crate::db::Database;
use crate::paths;

/// Checkpoint service state wrapper
pub struct CheckpointState {
    pub service: Mutex<Option<Arc<CheckpointService>>>,
}

impl CheckpointState {
    pub fn new() -> Self {
        Self {
            service: Mutex::new(None),
        }
    }

    pub fn init(&self, app_data_dir: std::path::PathBuf) {
        // Use unwrap_or_else to recover from poisoned mutex (previous panic)
        let mut guard = self
            .service
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_none() {
            *guard = Some(Arc::new(CheckpointService::new(app_data_dir)));
        }
    }
}

/// Response for checkpoint operations
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointResponse {
    pub success: bool,
    pub checkpoint: Option<Checkpoint>,
    pub error: Option<String>,
}

/// Response for restore operations
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResponse {
    pub success: bool,
    pub deleted_message_ids: Vec<String>,
    pub error: Option<String>,
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

/// Create a checkpoint for the current workspace state
/// Called when user sends a message
#[tauri::command]
pub async fn checkpoint_ensure_initialized(
    workspace_path: String,
    checkpoint_state: State<'_, CheckpointState>,
) -> Result<(), String> {
    let service = {
        let guard = checkpoint_state
            .service
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        guard
            .as_ref()
            .cloned()
            .ok_or("Checkpoint service not initialized")?
    };

    let workspace_path_clone = workspace_path.clone();
    tokio::task::spawn_blocking(move || service.ensure_initialized(&workspace_path_clone))
        .await
        .map_err(|e| format!("Checkpoint initialization task failed: {}", e))?
        .map_err(|e| format!("Failed to initialize checkpoint workspace: {}", e))
}

/// Create a checkpoint for the current workspace state
/// Called when user sends a message
#[tauri::command]
pub async fn checkpoint_create(
    workspace_path: String,
    thread_id: String,
    message_id: String,
    checkpoint_state: State<'_, CheckpointState>,
    db: State<'_, Mutex<Database>>,
) -> Result<CheckpointResponse, String> {
    // First check if checkpoints are enabled for this workspace
    {
        let db_guard = db.lock().map_err(|e| e.to_string())?;
        let enabled = db_guard
            .workspace()
            .get_checkpoint_enabled(&workspace_path)
            .map_err(|e| format!("Failed to check checkpoint enabled: {}", e))?;

        if !enabled {
            return Ok(CheckpointResponse {
                success: false,
                checkpoint: None,
                error: Some("Checkpoints disabled for this workspace".to_string()),
            });
        }
    }

    let service = {
        let guard = checkpoint_state
            .service
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        guard
            .as_ref()
            .cloned()
            .ok_or("Checkpoint service not initialized")?
    };

    let workspace_path_clone = workspace_path.clone();
    let thread_id_clone = thread_id.clone();
    let message_id_clone = message_id.clone();

    let checkpoint_result = tokio::task::spawn_blocking(move || {
        service.create_checkpoint(&workspace_path_clone, &thread_id_clone, &message_id_clone)
    })
    .await
    .map_err(|e| format!("Checkpoint task failed: {}", e))?;

    match checkpoint_result {
        Ok(checkpoint) => {
            // Save to database
            let db_guard = db.lock().map_err(|e| e.to_string())?;
            if let Err(e) = db_guard.checkpoints().save(&checkpoint) {
                return Ok(CheckpointResponse {
                    success: false,
                    checkpoint: None,
                    error: Some(format!("Failed to save checkpoint to database: {}", e)),
                });
            }

            Ok(CheckpointResponse {
                success: true,
                checkpoint: Some(checkpoint),
                error: None,
            })
        }
        Err(e) => Ok(CheckpointResponse {
            success: false,
            checkpoint: None,
            error: Some(format!("Failed to create checkpoint: {}", e)),
        }),
    }
}

/// Restore workspace to a specific checkpoint and delete all messages after it
#[tauri::command]
pub async fn checkpoint_restore(
    workspace_path: String,
    thread_id: String,
    checkpoint_id: String,
    checkpoint_state: State<'_, CheckpointState>,
    db: State<'_, Mutex<Database>>,
) -> Result<RestoreResponse, String> {
    let service = {
        let guard = checkpoint_state
            .service
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        guard
            .as_ref()
            .cloned()
            .ok_or("Checkpoint service not initialized")?
    };

    let workspace_path_clone = workspace_path.clone();
    let checkpoint_id_clone = checkpoint_id.clone();

    let restore_result = tokio::task::spawn_blocking(move || {
        service.restore_checkpoint(&workspace_path_clone, &checkpoint_id_clone)
    })
    .await
    .map_err(|e| format!("Restore task failed: {}", e))?;

    // First, restore the workspace files
    if let Err(e) = restore_result {
        return Ok(RestoreResponse {
            success: false,
            deleted_message_ids: Vec::new(),
            error: Some(format!("Failed to restore checkpoint: {}", e)),
        });
    }

    // Delete checkpoints after this one and get the message IDs
    let db_guard = db.lock().map_err(|e| e.to_string())?;
    let deleted_message_ids = match db_guard
        .checkpoints()
        .delete_after_checkpoint(&thread_id, &checkpoint_id)
    {
        Ok(ids) => ids,
        Err(e) => {
            return Ok(RestoreResponse {
                success: false,
                deleted_message_ids: Vec::new(),
                error: Some(format!("Failed to cleanup checkpoints: {}", e)),
            });
        }
    };

    Ok(RestoreResponse {
        success: true,
        deleted_message_ids,
        error: None,
    })
}

/// Get all checkpoints for a thread
#[tauri::command]
pub async fn checkpoint_list(
    thread_id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<Checkpoint>, String> {
    let db_guard = db.lock().map_err(|e| e.to_string())?;
    db_guard
        .checkpoints()
        .list_by_thread(&thread_id)
        .map_err(|e| format!("Failed to list checkpoints: {}", e))
}

/// Get checkpoint by message ID
#[tauri::command]
pub async fn checkpoint_get_by_message(
    message_id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Option<Checkpoint>, String> {
    let db_guard = db.lock().map_err(|e| e.to_string())?;
    db_guard
        .checkpoints()
        .get_by_message_id(&message_id)
        .map_err(|e| format!("Failed to get checkpoint: {}", e))
}

/// Delete all checkpoints for a thread (used when deleting a thread)
#[tauri::command]
pub async fn checkpoint_delete_thread(
    thread_id: String,
    workspace_path: Option<String>,
    checkpoint_state: State<'_, CheckpointState>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    // Delete from database
    {
        let db_guard = db.lock().map_err(|e| e.to_string())?;
        db_guard
            .checkpoints()
            .delete_by_thread(&thread_id)
            .map_err(|e| format!("Failed to delete checkpoints from database: {}", e))?;
    }

    // Optionally delete the workspace checkpoints (git repo)
    if let Some(ws_path) = workspace_path {
        let service = {
            let guard = checkpoint_state
                .service
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            guard.as_ref().cloned()
        };

        if let Some(service) = service {
            let ws_path_clone = ws_path.clone();
            let _ = tokio::task::spawn_blocking(move || {
                service.delete_workspace_checkpoints(&ws_path_clone)
            })
            .await;
        }
    }

    Ok(())
}

/// Delete all checkpoints for a workspace
#[tauri::command]
pub async fn checkpoint_delete_workspace(
    workspace_path: String,
    checkpoint_state: State<'_, CheckpointState>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    // Delete workspace checkpoints from database
    {
        let db_guard = db.lock().map_err(|e| e.to_string())?;
        db_guard
            .checkpoints()
            .delete_by_workspace(&workspace_path)
            .map_err(|e| {
                format!(
                    "Failed to delete workspace checkpoints from database: {}",
                    e
                )
            })?;
    }

    // Delete workspace checkpoint repo state
    let service = {
        let guard = checkpoint_state
            .service
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        guard.as_ref().cloned()
    };

    if let Some(service) = service {
        let ws_path_clone = workspace_path.clone();
        let _ = tokio::task::spawn_blocking(move || {
            service.delete_workspace_checkpoints(&ws_path_clone)
        })
        .await;
    }

    Ok(())
}

/// Check if checkpoint service is initialized for a workspace
#[tauri::command]
pub async fn checkpoint_is_initialized(
    workspace_path: String,
    checkpoint_state: State<'_, CheckpointState>,
) -> Result<bool, String> {
    let service = {
        let guard = checkpoint_state
            .service
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        guard
            .as_ref()
            .cloned()
            .ok_or("Checkpoint service not initialized")?
    };

    let workspace_path_clone = workspace_path.clone();
    let result = tokio::task::spawn_blocking(move || service.is_initialized(&workspace_path_clone))
        .await
        .map_err(|e| format!("Checkpoint init check task failed: {}", e))?;

    Ok(result)
}

/// Get checkpoint enabled setting for a workspace
#[tauri::command]
pub async fn checkpoint_get_enabled(
    workspace_path: String,
    db: State<'_, Mutex<Database>>,
) -> Result<bool, String> {
    let db_guard = db.lock().map_err(|e| e.to_string())?;
    db_guard
        .workspace()
        .get_checkpoint_enabled(&workspace_path)
        .map_err(|e| format!("Failed to get checkpoint enabled: {}", e))
}

/// Set checkpoint enabled setting for a workspace
#[tauri::command]
pub async fn checkpoint_set_enabled(
    workspace_path: String,
    enabled: bool,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db_guard = db.lock().map_err(|e| e.to_string())?;
    db_guard
        .workspace()
        .set_checkpoint_enabled(&workspace_path, enabled)
        .map_err(|e| format!("Failed to set checkpoint enabled: {}", e))
}
