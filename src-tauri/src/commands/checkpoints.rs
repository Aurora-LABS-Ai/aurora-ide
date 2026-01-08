use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, State};

use crate::checkpoints::{Checkpoint, CheckpointService};
use crate::db::Database;

/// Checkpoint service state wrapper
pub struct CheckpointState {
    pub service: Mutex<Option<CheckpointService>>,
}

impl CheckpointState {
    pub fn new() -> Self {
        Self {
            service: Mutex::new(None),
        }
    }

    pub fn init(&self, app_data_dir: std::path::PathBuf) {
        let mut guard = self.service.lock().unwrap();
        if guard.is_none() {
            *guard = Some(CheckpointService::new(app_data_dir));
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
    app: tauri::AppHandle,
    checkpoint_state: State<'_, CheckpointState>,
) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    checkpoint_state.init(app_data_dir);
    Ok(())
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
        let enabled = db_guard.workspace()
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

    let guard = checkpoint_state.service.lock().unwrap();
    let service = guard.as_ref().ok_or("Checkpoint service not initialized")?;

    match service.create_checkpoint(&workspace_path, &thread_id, &message_id) {
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
    let guard = checkpoint_state.service.lock().unwrap();
    let service = guard.as_ref().ok_or("Checkpoint service not initialized")?;

    // First, restore the workspace files
    if let Err(e) = service.restore_checkpoint(&workspace_path, &checkpoint_id) {
        return Ok(RestoreResponse {
            success: false,
            deleted_message_ids: Vec::new(),
            error: Some(format!("Failed to restore checkpoint: {}", e)),
        });
    }

    // Delete checkpoints after this one and get the message IDs
    let db_guard = db.lock().map_err(|e| e.to_string())?;
    let deleted_message_ids = match db_guard.checkpoints().delete_after_checkpoint(&thread_id, &checkpoint_id) {
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
    db_guard.checkpoints()
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
    db_guard.checkpoints()
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
        db_guard.checkpoints()
            .delete_by_thread(&thread_id)
            .map_err(|e| format!("Failed to delete checkpoints from database: {}", e))?;
    }

    // Optionally delete the workspace checkpoints (git repo)
    if let Some(ws_path) = workspace_path {
        let guard = checkpoint_state.service.lock().unwrap();
        if let Some(service) = guard.as_ref() {
            let _ = service.delete_workspace_checkpoints(&ws_path);
        }
    }

    Ok(())
}

/// Check if checkpoint service is initialized for a workspace
#[tauri::command]
pub async fn checkpoint_is_initialized(
    workspace_path: String,
    checkpoint_state: State<'_, CheckpointState>,
) -> Result<bool, String> {
    let guard = checkpoint_state.service.lock().unwrap();
    let service = guard.as_ref().ok_or("Checkpoint service not initialized")?;
    Ok(service.is_initialized(&workspace_path))
}

/// Get checkpoint enabled setting for a workspace
#[tauri::command]
pub async fn checkpoint_get_enabled(
    workspace_path: String,
    db: State<'_, Mutex<Database>>,
) -> Result<bool, String> {
    let db_guard = db.lock().map_err(|e| e.to_string())?;
    db_guard.workspace()
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
    db_guard.workspace()
        .set_checkpoint_enabled(&workspace_path, enabled)
        .map_err(|e| format!("Failed to set checkpoint enabled: {}", e))
}
