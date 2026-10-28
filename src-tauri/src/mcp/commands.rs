//! MCP commands, for the window (`#[tauri::command]` with `desktop`) and for
//! any other host (`host_commands::mcp`). All async: config reads and writes
//! touch disk, and a sync command would run on the UI thread.
//!
//! State changes are also pushed as `mcp_servers_changed` to every window,
//! so callers may ignore return values and just render the event.

use super::manager::MCP_MANAGER;
use super::spawn::CommandCheck;
use super::types::*;

/// Re-read the config files and return every server.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_load_servers() -> Result<Vec<McpServerState>, String> {
    Ok(tokio::task::spawn_blocking(|| MCP_MANAGER.reload())
        .await
        .map_err(|e| e.to_string())?)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_get_servers() -> Result<Vec<McpServerState>, String> {
    Ok(MCP_MANAGER.list())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_get_server(id: String) -> Result<McpServerState, String> {
    MCP_MANAGER
        .get_server(&id)
        .ok_or_else(|| format!("Server '{}' not found", id))
}

/// The agent window's open project; loads that project's `.mcp.json`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_set_workspace(root: Option<String>) -> Result<Vec<McpServerState>, String> {
    tokio::task::spawn_blocking(move || MCP_MANAGER.set_workspace(root))
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_add_server(config: McpServerConfig) -> Result<McpServerState, String> {
    tokio::task::spawn_blocking(move || MCP_MANAGER.add_server(config))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_remove_server(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || MCP_MANAGER.remove_server(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_update_server(config: McpServerConfig) -> Result<McpServerState, String> {
    tokio::task::spawn_blocking(move || MCP_MANAGER.update_server(config))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_toggle_server(id: String, enabled: bool) -> Result<McpServerState, String> {
    tokio::task::spawn_blocking(move || MCP_MANAGER.toggle_server(&id, enabled))
        .await
        .map_err(|e| e.to_string())?
}

/// Start a server; a running one is returned as is.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_connect_server(id: String) -> Result<McpServerState, String> {
    MCP_MANAGER.connect_server(&id).await
}

/// Stop and start again.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_restart_server(id: String) -> Result<McpServerState, String> {
    MCP_MANAGER.restart_server(&id).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_disconnect_server(id: String) -> Result<(), String> {
    MCP_MANAGER.disconnect_server(&id)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_call_tool(request: McpToolCallRequest) -> Result<McpToolCallResult, String> {
    MCP_MANAGER.call_tool(request).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_get_all_tools() -> Result<Vec<(String, McpToolInfo)>, String> {
    Ok(MCP_MANAGER.get_all_tools())
}

/// Does this command exist, and which file would run? For the add form.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_check_command(command: String) -> Result<CommandCheck, String> {
    tokio::task::spawn_blocking(move || super::spawn::check(&command))
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mcp_get_config_path() -> Result<String, String> {
    super::config::McpConfig::config_path()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine config path".to_string())
}
