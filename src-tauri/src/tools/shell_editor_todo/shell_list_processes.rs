//! `shell_list_processes` — list the authoritative Rust ledger of
//! agent-spawned background processes.
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

    /// Reads the process table; starts and stops nothing.
    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "shell_list_processes".into(),
            description: "List background processes started by shell_spawn. Returns the same \
                          process ID accepted by shell_kill and shell_read_output, plus name, \
                          command, working directory, OS pid, start time, and outputFile. To see \
                          what a process has printed, call shell_read_output with its process ID — \
                          it reads by line and can wait for new output instead of being polled."
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
        let count = processes.len();
        Ok(json!({
            "success": true,
            "count": count,
            "processes": processes,
            "message": if count == 0 {
                "No background processes are running."
            } else {
                "Background processes are ready to inspect or stop with shell_kill."
            },
        })
        .to_string())
    }
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcessRow {
    pub process_id: String,
    pub request_id: String,
    pub name: Option<String>,
    pub command: String,
    pub cwd: Option<String>,
    pub pid: Option<u32>,
    pub cancelled: bool,
    pub started_at_ms: u64,
    /// File the process's output is mirrored into. Prefer `shell_read_output`
    /// over reading it directly — it tracks line position and can wait for new
    /// output rather than being polled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_file: Option<String>,
}

#[cfg(not(feature = "verify_only"))]
fn list_active_streams() -> Vec<ProcessRow> {
    crate::commands::list_command_streams()
        .into_iter()
        .map(|stream| ProcessRow {
            process_id: stream.process_id,
            request_id: stream.request_id,
            name: stream.name,
            command: stream.command,
            cwd: stream.cwd,
            pid: stream.pid,
            cancelled: stream.cancelled,
            started_at_ms: stream.started_at_ms,
            output_file: stream.log_path,
        })
        .collect()
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
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    #[tokio::test]
    async fn returns_a_consistent_process_snapshot() {
        let out = ShellListProcessesTool
            .execute(json!({}), &ctx())
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], json!(true));
        let processes = parsed["processes"].as_array().expect("process array");
        assert_eq!(parsed["count"], json!(processes.len()));
        assert!(!parsed["message"].as_str().unwrap_or_default().is_empty());
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
