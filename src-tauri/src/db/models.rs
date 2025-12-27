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
// THREAD STATE (for future use)
// ============================================================

/// Thread/conversation state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadState {
    pub id: String,
    pub title: String,
    pub summary: Option<String>,
    pub messages: Vec<Message>,
    pub created_at: String, // ISO string or timestamp string
    pub updated_at: String, // ISO string or timestamp string
}

/// Chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    #[serde(alias = "sender")]
    pub role: String, // "user", "assistant", "system", "tool"
    pub content: String,
    pub timestamp: String, // ISO string or timestamp string
    pub tool_calls: Option<Vec<ToolCall>>,
    pub thinking: Option<String>,
    #[serde(default)]
    pub isThinking: Option<bool>,
    #[serde(default)]
    pub tools: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub timeline: Option<serde_json::Value>,
    #[serde(rename = "toolProposal", default)]
    pub tool_proposal: Option<serde_json::Value>,
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
// APP SETTINGS
// ============================================================

/// Application setting (key-value)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSetting {
    pub key: String,
    pub value: String,  // JSON string value
    pub updated_at: String,
}

// ============================================================
// LLM PROVIDER
// ============================================================

/// LLM Provider configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LLMProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub context_window: i64,
    pub max_output_tokens: i64,
    pub supports_thinking: bool,
    pub supports_tool_stream: bool,
    pub enabled: bool,
    pub is_custom: bool,
    pub custom_models: Option<Vec<String>>,
    pub custom_headers: Option<serde_json::Value>,
    pub custom_params: Option<serde_json::Value>,
    pub provider_type: Option<String>,
    pub default_temperature: Option<f64>,
    pub default_max_tokens: Option<i64>,
    pub requires_api_key: bool,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

// ============================================================
// TOOL SETTINGS
// ============================================================

/// Per-tool approval setting
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSetting {
    pub tool_name: String,
    pub approval_mode: String,  // 'auto' | 'always_ask' | 'deny'
    pub updated_at: String,
}

// ============================================================
// SETTINGS STATE (Complete app settings)
// ============================================================

/// Complete application settings state
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    // General settings
    pub selected_model: String,
    pub auto_approve_tools: bool,
    pub font_size: i32,
    pub theme: String,
    pub thinking_enabled: bool,
    pub max_tokens: i32,
    pub temperature: f64,
    
    // Autosave settings
    pub auto_save: String,
    pub auto_save_delay: i32,
    
    // Tool settings
    pub max_tool_calls_per_request: i32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            selected_model: "glm:glm-4.7".to_string(),
            auto_approve_tools: false,
            font_size: 14,
            theme: "dark".to_string(),
            thinking_enabled: true,
            max_tokens: 8192,
            temperature: 1.0,
            auto_save: "off".to_string(),
            auto_save_delay: 1000,
            max_tool_calls_per_request: 25,
        }
    }
}
