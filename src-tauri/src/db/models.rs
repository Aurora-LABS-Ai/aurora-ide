use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

// ============================================================
// WORKSPACE STATE
// ============================================================

/// Workspace state representing open tabs and panel layout
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceState {
    pub workspace_path: Option<String>,
    pub open_tabs: Vec<TabState>,
    pub panel_sizes: Option<PanelSizes>,
    pub last_opened_at: String, // ISO timestamp string from frontend
}

impl WorkspaceState {
    /// Convert the ISO timestamp string to OffsetDateTime
    pub fn get_last_opened_at(&self) -> OffsetDateTime {
        OffsetDateTime::parse(&self.last_opened_at, &time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| OffsetDateTime::now_utc())
    }
}

/// Individual tab state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabState {
    pub path: String,
    pub is_active: bool,
    pub is_dirty: bool,
}

/// Panel size configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelSizes {
    pub explorer: f64,  // Percentage (0-100)
    pub editor: f64,    // Percentage (0-100)
    pub chat: f64,      // Percentage (0-100)
}

// ============================================================
// EDITOR STATE
// ============================================================

/// Editor state for a specific file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorState {
    pub file_path: String,
    pub cursor_line: Option<u32>,
    pub cursor_col: Option<u32>,
    pub scroll_offset: Option<f64>,
    pub folded_regions: Option<Vec<FoldedRegion>>,
    pub last_edited_at: String, // ISO timestamp string from frontend
}

impl EditorState {
    /// Convert the ISO timestamp string to OffsetDateTime
    pub fn get_last_edited_at(&self) -> OffsetDateTime {
        OffsetDateTime::parse(&self.last_edited_at, &time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| OffsetDateTime::now_utc())
    }
}

/// A folded/collapsed code region
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FoldedRegion {
    pub start_line: u32,
    pub end_line: u32,
}

// ============================================================
// EXPLORER STATE
// ============================================================

/// File explorer state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplorerState {
    pub workspace_path: String,
    pub expanded_folders: Vec<String>,
    pub selected_file: Option<String>,
}

// ============================================================
// THREAD STATE
// ============================================================

/// Thread/conversation state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadState {
    pub id: String,
    pub title: String,
    pub summary: Option<String>,
    pub messages: Vec<Message>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

/// Chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub role: String, // "user", "assistant", "system", "tool"
    pub content: String,
    pub timestamp: OffsetDateTime,
    pub tool_calls: Option<Vec<ToolCall>>,
}

/// Tool call in a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub result: Option<String>,
}

// ============================================================
// SETTINGS STATE
// ============================================================

/// Application setting
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Setting {
    pub key: String,
    pub value: serde_json::Value,
}
