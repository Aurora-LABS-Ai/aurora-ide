use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Represents a change to a file's content
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// The file path this change applies to
    pub file_path: String,
    /// Content before the change (for undo)
    pub old_content: String,
    /// Content after the change (for redo)
    pub new_content: String,
    /// Timestamp when change was made
    pub timestamp: i64,
    /// Source of the change (e.g., "user", "ai_tool", "file_write")
    pub source: String,
    /// Optional description of the change
    pub description: Option<String>,
}

impl FileChange {
    /// Create a new file change
    pub fn new(
        file_path: impl Into<String>,
        old_content: impl Into<String>,
        new_content: impl Into<String>,
        source: impl Into<String>,
    ) -> Self {
        Self {
            file_path: file_path.into(),
            old_content: old_content.into(),
            new_content: new_content.into(),
            timestamp: chrono::Utc::now().timestamp_millis(),
            source: source.into(),
            description: None,
        }
    }

    /// Create with a description
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

/// Undo/Redo operation errors
#[derive(Debug, Error)]
pub enum UndoRedoError {
    #[error("No more changes to undo for file: {0}")]
    NothingToUndo(String),

    #[error("No more changes to redo for file: {0}")]
    NothingToRedo(String),

    #[error("File not found in undo history: {0}")]
    FileNotFound(String),

    #[error("Failed to write file: {0}")]
    WriteError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Result type for undo/redo operations
pub type UndoRedoResult<T> = std::result::Result<T, UndoRedoError>;

/// State of undo/redo for a file
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUndoState {
    /// File path
    pub file_path: String,
    /// Whether undo is available
    pub can_undo: bool,
    /// Whether redo is available
    pub can_redo: bool,
    /// Number of undo steps available
    pub undo_count: usize,
    /// Number of redo steps available
    pub redo_count: usize,
}

/// Response from undo/redo operations
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRedoResponse {
    /// Whether the operation succeeded
    pub success: bool,
    /// The restored content (if any)
    pub content: Option<String>,
    /// Current undo/redo state for the file
    pub state: Option<FileUndoState>,
    /// Error message (if any)
    pub error: Option<String>,
}
