//! Aurora for other agents, and the web: `aurora agent` tasks the window
//! runs (`cli_task_*`), the bridge that says Aurora is open and accepting
//! work, the MCP connection details and live connections, and the page/web
//! search the IDE chat uses. Bodies in [`crate::cli_delegate::commands`] and
//! [`crate::websearch::request`]; the window calls the same ones.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::cli_delegate::commands::{self as delegate, BridgePublish, CliTaskBinding};
use crate::websearch::request::{aurora_websearch_with, AuroraWebSearchRequest};

pub const COMMANDS: &[&str] = &[
    "cli_task_bind",
    "cli_task_fail",
    "cli_task_pending",
    "cli_task_claim",
    "aurora_bridge_publish",
    "aurora_bridge_clear",
    "aurora_mcp_client_config",
    "aurora_mcp_clients",
    "aurora_websearch",
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
        "cli_task_bind" => {
            let binding: CliTaskBinding = get!("binding");
            done(delegate::cli_task_bind(binding).await)
        }
        "cli_task_fail" => {
            let task_id: String = get!("taskId");
            let turn_id: String = get!("turnId");
            let error: String = get!("error");
            done(delegate::cli_task_fail(task_id, turn_id, error).await)
        }
        "cli_task_pending" => done(delegate::cli_task_pending().await),
        "cli_task_claim" => done(delegate::cli_task_claim(get!("taskId")).await),
        "aurora_bridge_publish" => {
            let state: BridgePublish = get!("state");
            done(delegate::aurora_bridge_publish(state).await)
        }
        "aurora_bridge_clear" => done(delegate::aurora_bridge_clear().await),
        "aurora_mcp_client_config" => done(delegate::aurora_mcp_client_config().await),
        "aurora_mcp_clients" => done(delegate::aurora_mcp_clients().await),
        "aurora_websearch" => {
            let request: AuroraWebSearchRequest = get!("request");
            // No browser rung: that needs the window's search webview.
            done(aurora_websearch_with(request, None).await)
        }
        _ => return None,
    })
}
