//! The checkpoint commands, written once for every host: the window's
//! `#[tauri::command]`s (`commands/checkpoints.rs`) and
//! `host_commands::checkpoints` both call these with the host's
//! [`CheckpointState`] and database.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::{Checkpoint, CheckpointService};
use crate::db::DatabaseAccess;
use crate::host_commands::run_db;

/// Checkpoint service state wrapper
pub struct CheckpointState {
    pub service: Mutex<Option<Arc<CheckpointService>>>,
}

impl Default for CheckpointState {
    fn default() -> Self {
        Self::new()
    }
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

    /// The service, or the error every command gives before `init`.
    fn require(&self) -> Result<Arc<CheckpointService>, String> {
        self.service
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?
            .as_ref()
            .cloned()
            .ok_or_else(|| "Checkpoint service not initialized".to_string())
    }

    /// The service if it was started; deletes go ahead without one.
    fn optional(&self) -> Result<Option<Arc<CheckpointService>>, String> {
        Ok(self
            .service
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?
            .as_ref()
            .cloned())
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

/// Make sure the workspace has its checkpoint repository.
pub async fn ensure_initialized(state: &CheckpointState, workspace_path: String) -> Result<(), String> {
    let service = state.require()?;
    tokio::task::spawn_blocking(move || service.ensure_initialized(&workspace_path))
        .await
        .map_err(|e| format!("Checkpoint initialization task failed: {}", e))?
        .map_err(|e| format!("Failed to initialize checkpoint workspace: {}", e))
}

/// Create a checkpoint for the current workspace state
/// Called when user sends a message
pub async fn create(
    state: &CheckpointState,
    db: Arc<dyn DatabaseAccess>,
    workspace_path: String,
    thread_id: String,
    message_id: String,
) -> Result<CheckpointResponse, String> {
    // First check if checkpoints are enabled for this workspace
    let enabled_path = workspace_path.clone();
    let enabled = run_db(db.clone(), move |db| {
        db.workspace()
            .get_checkpoint_enabled(&enabled_path)
            .map_err(|e| format!("Failed to check checkpoint enabled: {}", e))
    })
    .await?;

    if !enabled {
        return Ok(CheckpointResponse {
            success: false,
            checkpoint: None,
            error: Some("Checkpoints disabled for this workspace".to_string()),
        });
    }

    let service = state.require()?;

    let checkpoint_result = tokio::task::spawn_blocking(move || {
        service.create_checkpoint(&workspace_path, &thread_id, &message_id)
    })
    .await
    .map_err(|e| format!("Checkpoint task failed: {}", e))?;

    match checkpoint_result {
        Ok(checkpoint) => {
            // Save to database
            run_db(db, move |db| {
                Ok(match db.checkpoints().save(&checkpoint) {
                    Err(e) => CheckpointResponse {
                        success: false,
                        checkpoint: None,
                        error: Some(format!("Failed to save checkpoint to database: {}", e)),
                    },
                    Ok(_) => CheckpointResponse {
                        success: true,
                        checkpoint: Some(checkpoint),
                        error: None,
                    },
                })
            })
            .await
        }
        Err(e) => Ok(CheckpointResponse {
            success: false,
            checkpoint: None,
            error: Some(format!("Failed to create checkpoint: {}", e)),
        }),
    }
}

/// Restore workspace to a specific checkpoint and delete all messages after it
pub async fn restore(
    state: &CheckpointState,
    db: Arc<dyn DatabaseAccess>,
    workspace_path: String,
    thread_id: String,
    checkpoint_id: String,
) -> Result<RestoreResponse, String> {
    let service = state.require()?;

    let restore_id = checkpoint_id.clone();
    let restore_result = tokio::task::spawn_blocking(move || {
        service.restore_checkpoint(&workspace_path, &restore_id)
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
    run_db(db, move |db| {
        Ok(
            match db
                .checkpoints()
                .delete_after_checkpoint(&thread_id, &checkpoint_id)
            {
                Ok(deleted_message_ids) => RestoreResponse {
                    success: true,
                    deleted_message_ids,
                    error: None,
                },
                Err(e) => RestoreResponse {
                    success: false,
                    deleted_message_ids: Vec::new(),
                    error: Some(format!("Failed to cleanup checkpoints: {}", e)),
                },
            },
        )
    })
    .await
}

/// Get all checkpoints for a thread
pub async fn list(db: Arc<dyn DatabaseAccess>, thread_id: String) -> Result<Vec<Checkpoint>, String> {
    run_db(db, move |db| {
        db.checkpoints()
            .list_by_thread(&thread_id)
            .map_err(|e| format!("Failed to list checkpoints: {}", e))
    })
    .await
}

/// Get checkpoint by message ID
pub async fn get_by_message(
    db: Arc<dyn DatabaseAccess>,
    message_id: String,
) -> Result<Option<Checkpoint>, String> {
    run_db(db, move |db| {
        db.checkpoints()
            .get_by_message_id(&message_id)
            .map_err(|e| format!("Failed to get checkpoint: {}", e))
    })
    .await
}

/// Delete all checkpoints for a thread (used when deleting a thread)
pub async fn delete_thread(
    state: &CheckpointState,
    db: Arc<dyn DatabaseAccess>,
    thread_id: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    // Delete from database
    run_db(db, move |db| {
        db.checkpoints()
            .delete_by_thread(&thread_id)
            .map_err(|e| format!("Failed to delete checkpoints from database: {}", e))
    })
    .await?;

    // Optionally delete the workspace checkpoints (git repo)
    if let Some(ws_path) = workspace_path {
        if let Some(service) = state.optional()? {
            let _ = tokio::task::spawn_blocking(move || service.delete_workspace_checkpoints(&ws_path))
                .await;
        }
    }

    Ok(())
}

/// Delete all checkpoints for a workspace
pub async fn delete_workspace(
    state: &CheckpointState,
    db: Arc<dyn DatabaseAccess>,
    workspace_path: String,
) -> Result<(), String> {
    // Delete workspace checkpoints from database
    let db_path = workspace_path.clone();
    run_db(db, move |db| {
        db.checkpoints().delete_by_workspace(&db_path).map_err(|e| {
            format!(
                "Failed to delete workspace checkpoints from database: {}",
                e
            )
        })
    })
    .await?;

    // Delete workspace checkpoint repo state
    if let Some(service) = state.optional()? {
        let _ = tokio::task::spawn_blocking(move || service.delete_workspace_checkpoints(&workspace_path))
            .await;
    }

    Ok(())
}

/// Check if checkpoint service is initialized for a workspace
pub async fn is_initialized(state: &CheckpointState, workspace_path: String) -> Result<bool, String> {
    let service = state.require()?;
    tokio::task::spawn_blocking(move || service.is_initialized(&workspace_path))
        .await
        .map_err(|e| format!("Checkpoint init check task failed: {}", e))
}

/// Get checkpoint enabled setting for a workspace
pub async fn get_enabled(db: Arc<dyn DatabaseAccess>, workspace_path: String) -> Result<bool, String> {
    run_db(db, move |db| {
        db.workspace()
            .get_checkpoint_enabled(&workspace_path)
            .map_err(|e| format!("Failed to get checkpoint enabled: {}", e))
    })
    .await
}

/// Set checkpoint enabled setting for a workspace
pub async fn set_enabled(
    db: Arc<dyn DatabaseAccess>,
    workspace_path: String,
    enabled: bool,
) -> Result<(), String> {
    run_db(db, move |db| {
        db.workspace()
            .set_checkpoint_enabled(&workspace_path, enabled)
            .map_err(|e| format!("Failed to set checkpoint enabled: {}", e))
    })
    .await
}
