//! `shell_kill` — wrapper around
//! [`crate::commands::cancel_command_stream`].
//!
//! Per the contract, `requires_permission()` returns **false**:
//! killing your own spawned process is safe and shouldn't prompt.
//!
//! The TS executor accepted both `processId` and `name`, with name
//! lookup walking a frontend-side `backgroundProcesses` Map. The Rust
//! side doesn't keep a process map of its own — the actual streams
//! live in `commands::ACTIVE_COMMAND_STREAMS` keyed by `request_id`.
//! We accept either `requestId` (preferred), `processId` (treated as
//! request_id for backwards compatibility), or `pid` (numeric, also
//! treated as a string). `name` is rejected with `InvalidInput`
//! because the Rust side has no name lookup.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

pub struct ShellKillTool;

#[async_trait]
impl ToolExecutor for ShellKillTool {
    fn name(&self) -> &str {
        "shell_kill"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "shell_kill".into(),
            description: "Kill a running background process spawned by shell_spawn. Pass either \
                          processId (the bg-… id returned by shell_spawn), requestId (the \
                          underlying stream id), or pid (the OS process id)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "processId": {"type": "string", "description": "The process ID returned by shell_spawn"},
                    "requestId": {"type": "string", "description": "The underlying stream request id"},
                    "pid": {"type": ["string", "number"], "description": "The OS process id"}
                },
                "required": []
            }),
        }
    }

    fn requires_permission(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        if input.get("name").is_some() {
            return Err(ToolError::InvalidInput(
                "`name` lookup is not supported by the Rust shell_kill — pass `requestId`, \
                 `processId`, or `pid` instead"
                    .into(),
            ));
        }

        let identifier = input
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                input
                    .get("processId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| {
                input.get("pid").and_then(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .or_else(|| v.as_u64().map(|n| n.to_string()))
                })
            });

        let identifier = identifier.ok_or_else(|| {
            ToolError::InvalidInput(
                "shell_kill requires `requestId`, `processId`, or `pid`".into(),
            )
        })?;

        match cancel_stream(identifier.clone()) {
            Ok(()) => Ok(json!({
                "success": true,
                "processId": identifier,
                "message": format!("Process {identifier} marked as terminated"),
            })
            .to_string()),
            Err(err) => Ok(json!({
                "success": false,
                "processId": identifier,
                "error": err,
            })
            .to_string()),
        }
    }
}

#[cfg(not(feature = "verify_only"))]
fn cancel_stream(request_id: String) -> Result<(), String> {
    crate::commands::cancel_command_stream(request_id)
}

// In the verify crate the global ACTIVE_COMMAND_STREAMS map is
// always empty (no real streams ever start), so the cancel command
// is a no-op equivalent: declare success the same way the production
// path would when given a missing request_id (it just returns Ok).
#[cfg(feature = "verify_only")]
fn cancel_stream(_request_id: String) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn ctx() -> ToolContext {
        ToolContext {
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            session_id: "s".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn requires_permission_is_false() {
        assert!(!ShellKillTool.requires_permission());
    }

    #[tokio::test]
    async fn rejects_missing_identifier() {
        let err = ShellKillTool
            .execute(json!({}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn rejects_name_lookup() {
        let err = ShellKillTool
            .execute(json!({"name": "watcher"}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn happy_path_returns_success_payload() {
        let out = ShellKillTool
            .execute(json!({"requestId": "req-123"}), &ctx())
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["processId"], json!("req-123"));
    }

    #[tokio::test]
    async fn coerces_numeric_pid() {
        let out = ShellKillTool
            .execute(json!({"pid": 4242}), &ctx())
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["processId"], json!("4242"));
    }
}
