//! MCP servers: the list, adding, editing, switching on and off, starting and
//! stopping, and calling a tool. The bodies are [`crate::mcp::commands`],
//! which the window registers directly.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::mcp::commands as mcp;
use crate::mcp::types::{McpServerConfig, McpToolCallRequest};

pub const COMMANDS: &[&str] = &[
    "mcp_load_servers",
    "mcp_get_servers",
    "mcp_get_server",
    "mcp_set_workspace",
    "mcp_add_server",
    "mcp_remove_server",
    "mcp_update_server",
    "mcp_toggle_server",
    "mcp_connect_server",
    "mcp_restart_server",
    "mcp_disconnect_server",
    "mcp_call_tool",
    "mcp_get_all_tools",
    "mcp_check_command",
    "mcp_get_config_path",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    _ctx: &CommandContext,
    name: &str,
    args: &Value,
) -> Option<Result<Value, CommandError>> {
    let n = name;
    macro_rules! get {
        ($key:literal) => {
            match arg(n, args, $key) {
                Ok(v) => v,
                Err(e) => return Some(Err(e)),
            }
        };
    }
    Some(match name {
        "mcp_load_servers" => done(mcp::mcp_load_servers().await),
        "mcp_get_servers" => done(mcp::mcp_get_servers().await),
        "mcp_get_server" => done(mcp::mcp_get_server(get!("id")).await),
        "mcp_set_workspace" => done(mcp::mcp_set_workspace(get!("root")).await),
        "mcp_add_server" => {
            let config: McpServerConfig = get!("config");
            done(mcp::mcp_add_server(config).await)
        }
        "mcp_remove_server" => done(mcp::mcp_remove_server(get!("id")).await),
        "mcp_update_server" => {
            let config: McpServerConfig = get!("config");
            done(mcp::mcp_update_server(config).await)
        }
        "mcp_toggle_server" => {
            let id: String = get!("id");
            let enabled: bool = get!("enabled");
            done(mcp::mcp_toggle_server(id, enabled).await)
        }
        "mcp_connect_server" => done(mcp::mcp_connect_server(get!("id")).await),
        "mcp_restart_server" => done(mcp::mcp_restart_server(get!("id")).await),
        "mcp_disconnect_server" => done(mcp::mcp_disconnect_server(get!("id")).await),
        "mcp_call_tool" => {
            let request: McpToolCallRequest = get!("request");
            done(mcp::mcp_call_tool(request).await)
        }
        "mcp_get_all_tools" => done(mcp::mcp_get_all_tools().await),
        "mcp_check_command" => done(mcp::mcp_check_command(get!("command")).await),
        "mcp_get_config_path" => done(mcp::mcp_get_config_path().await),
        _ => return None,
    })
}
