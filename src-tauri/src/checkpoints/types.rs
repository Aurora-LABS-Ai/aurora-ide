use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Checkpoint data stored for each user message
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// Unique checkpoint ID (Git commit hash)
    pub id: String,
    /// Associated message ID in the thread
    pub message_id: String,
    /// Thread ID this checkpoint belongs to
    pub thread_id: String,
    /// Workspace path this checkpoint is for
    pub workspace_path: String,
    /// Timestamp when checkpoint was created
    pub created_at: String,
}

/// Checkpoint operation errors
#[derive(Debug, Error)]
pub enum CheckpointError {
    #[error("Checkpoint not found: {0}")]
    CheckpointNotFound(String),

    #[error("Failed to initialize checkpoint repository: {0}")]
    InitializationFailed(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Restore failed: {0}")]
    RestoreError(String),
}

/// Result type for checkpoint operations
pub type CheckpointResult<T> = std::result::Result<T, CheckpointError>;
