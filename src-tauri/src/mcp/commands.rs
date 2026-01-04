//! MCP Tauri Commands
//! 
//! Exposes MCP functionality to the frontend via Tauri commands

use super::manager::MCP_MANAGER;
use super::types::*;

/// Load MCP config and get all servers
#[tauri::command]
pub async fn mcp_load_servers() -> Result<Vec<McpServerState>, String> {
    MCP_MANAGER.load_config()
}

/// Get all MCP server states
#[tauri::command]
pub async fn mcp_get_servers() -> Result<Vec<McpServerState>, String> {
    Ok(MCP_MANAGER.get_servers())
}

/// Get a specific MCP server
#[tauri::command]
pub async fn mcp_get_server(id: String) -> Result<McpServerState, String> {
    MCP_MANAGER.get_server(&id)
        .ok_or_else(|| format!("Server '{}' not found", id))
}

/// Add a new MCP server
#[tauri::command]
pub async fn mcp_add_server(config: McpServerConfig) -> Result<McpServerState, String> {
    MCP_MANAGER.add_server(config)
}

/// Remove an MCP server
#[tauri::command]
pub async fn mcp_remove_server(id: String) -> Result<(), String> {
    MCP_MANAGER.remove_server(&id)
}

/// Update an MCP server
#[tauri::command]
pub async fn mcp_update_server(config: McpServerConfig) -> Result<McpServerState, String> {
    MCP_MANAGER.update_server(config)
}

/// Toggle MCP server enabled state
#[tauri::command]
pub async fn mcp_toggle_server(id: String, enabled: bool) -> Result<McpServerState, String> {
    MCP_MANAGER.toggle_server(&id, enabled)
}

/// Connect to an MCP server
#[tauri::command]
pub async fn mcp_connect_server(id: String) -> Result<McpServerState, String> {
    MCP_MANAGER.connect_server(&id)
}

/// Disconnect from an MCP server
#[tauri::command]
pub async fn mcp_disconnect_server(id: String) -> Result<(), String> {
    MCP_MANAGER.disconnect_server(&id)
}

/// Call a tool on an MCP server
#[tauri::command]
pub async fn mcp_call_tool(request: McpToolCallRequest) -> Result<McpToolCallResult, String> {
    MCP_MANAGER.call_tool(request)
}

/// Get all tools from all connected MCP servers
#[tauri::command]
pub async fn mcp_get_all_tools() -> Result<Vec<(String, McpToolInfo)>, String> {
    Ok(MCP_MANAGER.get_all_tools())
}

/// Get the MCP config file path
#[tauri::command]
pub async fn mcp_get_config_path() -> Result<String, String> {
    super::config::McpConfig::config_path()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine config path".to_string())
}

