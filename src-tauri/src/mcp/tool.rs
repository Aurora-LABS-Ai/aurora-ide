//! An MCP server's tool, run by the engine.
//!
//! Until Phase 4.1 (`DOCS/rust-core-extraction.md`) every `mcp_*` call went
//! the long way round: the engine parked a bridge executor, the window got
//! `agent_tool_pending`, asked the user if the server was not auto-approved,
//! called `mcp_call_tool` back into this process, formatted the answer and
//! posted it with `agent_post_tool_result`. A browser tab or a terminal has no
//! such window. This executor calls [`McpManager::call_tool`] directly and
//! renders the answer exactly as the window did (`executeMcpTool` in
//! `mcp-tools.ts`), so the model reads the same text either way:
//!
//! - success: each content item's text, else `[Binary data: <mime>]`, else
//!   the item as JSON, joined by newlines; nothing at all is
//!   "Tool executed successfully (no output)";
//! - failure: `{"error":"<message>","tool":"<name>"}` as the error text,
//!   which the runtime shows as `execution failed: …` like any bridged error.
//!
//! Approval follows the window's rule too: a server switched to auto-approve
//! never asks; otherwise the permission gate asks the way it asks for a
//! native tool (full workspace access and the global auto-approve switch
//! answer there). One difference: a denial reads `permission denied: user
//! denied <tool>` instead of the window's JSON envelope.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::ipc::AllowedTool;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::manager::McpManager;
use super::types::{McpToolCallRequest, McpToolCallResult, McpToolContent};

pub struct McpToolExecutor {
    manager: Arc<McpManager>,
    server_id: String,
    tool_name: String,
    /// The schema as the window advertises it (`turn_build::tools::mcp_tool`).
    tool: AllowedTool,
    /// The server's "auto-approve all tool calls" switch.
    auto_approve: bool,
}

impl std::fmt::Debug for McpToolExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpToolExecutor")
            .field("server_id", &self.server_id)
            .field("tool_name", &self.tool_name)
            .field("auto_approve", &self.auto_approve)
            .finish_non_exhaustive()
    }
}

impl McpToolExecutor {
    #[must_use]
    pub fn new(
        manager: Arc<McpManager>,
        server_id: String,
        tool_name: String,
        tool: AllowedTool,
        auto_approve: bool,
    ) -> Self {
        Self { manager, server_id, tool_name, tool, auto_approve }
    }
}

/// `JSON.stringify({ error, tool })`: the envelope every bridged failure wore.
#[must_use]
pub fn error_envelope(tool: &str, message: &str) -> String {
    serde_json::json!({ "error": message, "tool": tool }).to_string()
}

/// What `executeMcpTool` made of a call's answer: the text the model reads,
/// or the message it threw.
pub fn render_result(result: &McpToolCallResult) -> Result<String, String> {
    if !result.success {
        return Err(result
            .error
            .as_deref()
            .filter(|message| !message.is_empty())
            .unwrap_or("MCP tool call failed")
            .to_string());
    }
    let items: Vec<String> = result
        .content
        .iter()
        .flatten()
        .map(render_item)
        .collect();
    Ok(if items.is_empty() {
        "Tool executed successfully (no output)".to_string()
    } else {
        items.join("\n")
    })
}

fn render_item(item: &McpToolContent) -> String {
    if let Some(text) = item.text.as_deref().filter(|t| !t.is_empty()) {
        return text.to_string();
    }
    if item.data.as_deref().is_some_and(|d| !d.is_empty()) {
        let mime = item.mime_type.as_deref().filter(|m| !m.is_empty()).unwrap_or("unknown");
        return format!("[Binary data: {mime}]");
    }
    serde_json::to_string(item).unwrap_or_default()
}

#[async_trait]
impl ToolExecutor for McpToolExecutor {
    fn name(&self) -> &str {
        &self.tool.name
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: self.tool.name.clone(),
            description: self.tool.description.clone(),
            input_schema: self.tool.parameters.clone(),
        }
    }

    /// The server's switch, as the window read it (`shouldAutoApproveMcpTool`).
    fn requires_permission(&self) -> bool {
        !self.auto_approve
    }

    /// The same outer bound the bridge had, clear of the manager's own
    /// per-call ceiling, so the specific message wins when both would fire.
    fn timeout_policy(&self) -> Option<crate::tools::timeout::TimeoutPolicy> {
        Some(crate::agent_runtime::bridge::BRIDGE_TIMEOUT)
    }

    async fn execute(&self, input: Value, context: &ToolContext) -> Result<String, ToolError> {
        context.bail_if_cancelled()?;
        let request = McpToolCallRequest {
            server_id: self.server_id.clone(),
            tool_name: self.tool_name.clone(),
            arguments: Some(input),
        };
        let outcome = tokio::select! {
            biased;
            () = context.cancel_token.cancelled() => return Err(ToolError::Cancelled),
            outcome = self.manager.call_tool(request) => outcome,
        };
        let rendered = match outcome {
            Ok(result) => render_result(&result),
            Err(message) => Err(message),
        };
        rendered.map_err(|message| ToolError::Execution(error_envelope(&self.tool.name, &message)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(text: Option<&str>, data: Option<&str>, mime: Option<&str>) -> McpToolContent {
        McpToolContent {
            content_type: if data.is_some() { "image".into() } else { "text".into() },
            text: text.map(str::to_string),
            data: data.map(str::to_string),
            mime_type: mime.map(str::to_string),
        }
    }

    #[test]
    fn a_result_reads_as_the_window_rendered_it() {
        let ok = McpToolCallResult {
            success: true,
            content: Some(vec![
                item(Some("one"), None, None),
                item(None, Some("AAAA"), Some("image/png")),
                item(None, Some("AAAA"), None),
                item(Some(""), None, Some("text/plain")),
            ]),
            error: None,
            is_error: None,
        };
        assert_eq!(
            render_result(&ok).unwrap(),
            "one\n[Binary data: image/png]\n[Binary data: unknown]\n{\"type\":\"text\",\"text\":\"\",\"data\":null,\"mimeType\":\"text/plain\"}"
        );
        let empty = McpToolCallResult { success: true, content: Some(vec![]), error: None, is_error: None };
        assert_eq!(render_result(&empty).unwrap(), "Tool executed successfully (no output)");
        let none = McpToolCallResult { success: true, content: None, error: None, is_error: None };
        assert_eq!(render_result(&none).unwrap(), "Tool executed successfully (no output)");
    }

    #[test]
    fn a_failure_carries_the_servers_words_or_the_window_fallback() {
        let said = McpToolCallResult { success: false, content: None, error: Some("boom".into()), is_error: Some(true) };
        assert_eq!(render_result(&said).unwrap_err(), "boom");
        let silent = McpToolCallResult { success: false, content: None, error: Some(String::new()), is_error: Some(true) };
        assert_eq!(render_result(&silent).unwrap_err(), "MCP tool call failed");
        assert_eq!(
            error_envelope("mcp_github_whoami", "it \"broke\""),
            "{\"error\":\"it \\\"broke\\\"\",\"tool\":\"mcp_github_whoami\"}"
        );
    }
}
