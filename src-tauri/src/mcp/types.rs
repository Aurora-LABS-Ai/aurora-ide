//! MCP Types
//! 
//! Type definitions for MCP server configuration and state

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// MCP Server transport type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum McpTransportType {
    /// Standard I/O (spawn process)
    Stdio,
    /// Server-Sent Events (HTTP)
    Sse,
}

impl Default for McpTransportType {
    fn default() -> Self {
        Self::Stdio
    }
}

/// MCP Server configuration (matches Claude/Cursor format)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// Unique identifier for this server
    pub id: String,
    /// Display name
    pub name: String,
    /// Transport type (stdio or sse)
    #[serde(default)]
    pub transport: McpTransportType,
    /// Command to run (for stdio transport)
    pub command: Option<String>,
    /// Arguments for the command
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// URL for SSE transport
    pub url: Option<String>,
    /// Custom headers for SSE transport
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Whether this server is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Auto-start on Aurora launch
    #[serde(default)]
    pub auto_start: bool,
    /// Auto-approve all tool calls from this server (skip user confirmation)
    #[serde(default)]
    pub auto_approve: bool,
}

fn default_true() -> bool {
    true
}

impl McpServerConfig {
    /// Create a new stdio-based MCP server config
    #[allow(dead_code)]
    pub fn new_stdio(id: impl Into<String>, name: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            transport: McpTransportType::Stdio,
            command: Some(command.into()),
            args: Vec::new(),
            env: HashMap::new(),
            url: None,
            headers: HashMap::new(),
            enabled: true,
            auto_start: false,
            auto_approve: false,
        }
    }

    /// Create a new SSE-based MCP server config
    #[allow(dead_code)]
    pub fn new_sse(id: impl Into<String>, name: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            transport: McpTransportType::Sse,
            command: None,
            args: Vec::new(),
            env: HashMap::new(),
            url: Some(url.into()),
            headers: HashMap::new(),
            enabled: true,
            auto_start: false,
            auto_approve: false,
        }
    }

    /// Add arguments to the config (builder pattern)
    #[allow(dead_code)]
    pub fn with_args(mut self, args: Vec<String>) -> Self {
        self.args = args;
        self
    }

    /// Add environment variables to the config (builder pattern)
    #[allow(dead_code)]
    pub fn with_env(mut self, env: HashMap<String, String>) -> Self {
        self.env = env;
        self
    }
}

/// MCP Server connection status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum McpServerStatus {
    /// Not started
    Disconnected,
    /// Connecting to server
    Connecting,
    /// Connected and ready
    Connected,
    /// Connection failed
    Error,
}

impl Default for McpServerStatus {
    fn default() -> Self {
        Self::Disconnected
    }
}

/// MCP Tool definition (from server)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    /// Tool name
    pub name: String,
    /// Tool description
    pub description: Option<String>,
    /// JSON Schema for input parameters
    pub input_schema: Option<serde_json::Value>,
}

/// MCP Resource definition (from server)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceInfo {
    /// Resource URI
    pub uri: String,
    /// Resource name
    pub name: String,
    /// Resource description
    pub description: Option<String>,
    /// MIME type
    pub mime_type: Option<String>,
}

/// MCP Server state (runtime info)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerState {
    /// Server configuration
    pub config: McpServerConfig,
    /// Current status
    pub status: McpServerStatus,
    /// Error message if status is Error
    pub error: Option<String>,
    /// Available tools
    pub tools: Vec<McpToolInfo>,
    /// Available resources
    pub resources: Vec<McpResourceInfo>,
    /// Server info (name, version from server)
    pub server_info: Option<McpServerInfo>,
}

/// Server info returned by MCP server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    pub version: Option<String>,
}

impl McpServerState {
    pub fn new(config: McpServerConfig) -> Self {
        Self {
            config,
            status: McpServerStatus::Disconnected,
            error: None,
            tools: Vec::new(),
            resources: Vec::new(),
            server_info: None,
        }
    }
}

/// MCP Tool call request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallRequest {
    /// Server ID
    pub server_id: String,
    /// Tool name
    pub tool_name: String,
    /// Tool arguments
    pub arguments: Option<serde_json::Value>,
}

/// MCP Tool call result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallResult {
    /// Whether the call succeeded
    pub success: bool,
    /// Result content (if success)
    pub content: Option<Vec<McpToolContent>>,
    /// Error message (if failed)
    pub error: Option<String>,
    /// Whether the result is an error from the tool itself
    pub is_error: Option<bool>,
}

/// MCP Tool content item
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: Option<String>,
    pub data: Option<String>,
    pub mime_type: Option<String>,
}

