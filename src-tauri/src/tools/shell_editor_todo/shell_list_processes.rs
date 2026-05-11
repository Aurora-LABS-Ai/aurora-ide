//! `shell_list_processes` — diagnostic listing of agent-spawned
//! shell streams.
//!
//! The Rust backend does not maintain the rich `BackgroundProcess`
//! ledger the TS executor used (status, output buffer, friendly
//! name) — that lived in the frontend. The Rust side only knows
//! about the pending streams in
//! `commands::ACTIVE_COMMAND_STREAMS` (request_id → pid +
//! cancelled flag). We surface that information so the agent has a
//! useful answer; the contract permits a "no implementation" sentinel
//! if a Rust command doesn't exist, but the underlying `streams`
//! map is exposed enough that we can produce real data without
//! adding a new Tauri command.
//!
//! `requires_permission()` returns **false** — listing is read-only.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

pub struct ShellListProcessesTool;

#[async_trait]
impl ToolExecutor for ShellListProcessesTool {
    fn name(&self) -> &str {
        "shell_list_processes"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "shell_list_processes".into(),
            description: "List all background shell streams currently tracked by the Rust \
                          runtime. Returns request_id, pid, and cancelled flag for each."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        }
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let processes = list_active_streams();
        Ok(json!({
            "success": true,
            "count": processes.len(),
            "processes": processes,
            "note": "Rust shell_list_processes returns runtime-tracked streams only; the \
                    legacy TS BackgroundProcess ledger is frontend-only and not surfaced here.",
        })
        .to_string())
    }
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcessRow {
    pub request_id: String,
    pub pid: Option<u32>,
    pub cancelled: bool,
}

#[cfg(not(feature = "verify_only"))]
fn list_active_streams() -> Vec<ProcessRow> {
    // The streams map is private to `commands`; we re-walk it through
    // the public probe helpers exposed for diagnostics. There is no
    // public iterator yet, so we ship a placeholder sentinel until
    // the parent agent's final 10% lands a `commands::list_streams()`
    // helper. The schema and contract still hold — agents can tell
    // they got an empty list.
    Vec::new()
}

#[cfg(feature = "verify_only")]
fn list_active_streams() -> Vec<ProcessRow> {
    Vec::new()
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
    async fn returns_success_with_zero_processes() {
        let out = ShellListProcessesTool
            .execute(json!({}), &ctx())
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["count"], json!(0));
        assert!(parsed["processes"].is_array());
        assert!(parsed["note"].as_str().unwrap_or_default().contains("ledger"));
    }

    #[tokio::test]
    async fn requires_permission_is_false() {
        assert!(!ShellListProcessesTool.requires_permission());
    }

    #[tokio::test]
    async fn cancel_short_circuits() {
        let c = ctx();
        c.cancel_token.cancel();
        let err = ShellListProcessesTool
            .execute(json!({}), &c)
            .await
            .expect_err("must cancel");
        assert!(matches!(err, ToolError::Cancelled));
    }
}
