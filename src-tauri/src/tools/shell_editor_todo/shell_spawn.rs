//! `shell_spawn` — gated wrapper that hands a long-running command
//! off to [`crate::commands::execute_command_stream`] and returns the
//! request_id immediately.
//!
//! Mirrors `src/tools/executors/shell-executors.ts::shellSpawnExecutor`.
//! The result content is the JSON `{ success, processId, command,
//! cwd, message }` shape that the existing TS executor produces, so
//! agent-prompt expectations don't change.
//!
//! The actual streaming happens off-task: the production
//! [`IdeEventSink::spawn_shell_stream`] invokes
//! `execute_command_stream` inside a `tokio::spawn`, so this tool's
//! `execute` returns as soon as the request is queued. Tests use the
//! recording sink to assert the request was queued correctly.
//!
//! `requires_permission()` returns **true**.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::agent_safety::bash_validation::{
    classify_intent, validate_command, validate_command_with_workspace, ExecutionMode,
};

use super::ide_event_sink::{IdeEventSink, ShellStreamRequest};
use super::shell_execute::map_bash_error;

const SHELL_EXECUTION_MODE: ExecutionMode = ExecutionMode::WorkspaceWrite;

pub struct ShellSpawnTool {
    sink: Arc<dyn IdeEventSink>,
}

impl ShellSpawnTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }

    fn make_process_id() -> String {
        // Matches the TS `bg-{counter}-{epoch}` shape closely enough
        // for the audit log; we use `uuid` for the counter half so
        // multi-window aurora sessions can't collide.
        let id = uuid::Uuid::new_v4().simple().to_string();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("bg-{}-{now}", &id[..8])
    }

    fn make_request_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

#[async_trait]
impl ToolExecutor for ShellSpawnTool {
    fn name(&self) -> &str {
        "shell_spawn"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "shell_spawn".into(),
            description: "Spawn a long-running background process (e.g. dev server, watch \
                          process). Returns a process ID for later management."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to spawn"
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Working directory. Defaults to workspace root."
                    },
                    "name": {
                        "type": "string",
                        "description": "Friendly name for this process for later reference"
                    }
                },
                "required": ["command"]
            }),
        }
    }

    fn requires_permission(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let command = input
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`command` must be a string".into()))?;
        if command.trim().is_empty() {
            return Err(ToolError::InvalidInput("`command` must not be empty".into()));
        }

        // Workspace-aware path validation when a folder is open;
        // workspace-free fallback otherwise. Mirrors the policy in
        // `shell_execute`.
        if let Some(workspace) = ctx.workspace_root.as_ref() {
            validate_command_with_workspace(command, SHELL_EXECUTION_MODE, workspace)
                .map_err(map_bash_error)?;
        } else {
            validate_command(command, SHELL_EXECUTION_MODE).map_err(map_bash_error)?;
        }

        let intent = classify_intent(command).as_str();

        let cwd = input
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                ctx.workspace_root
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string())
            });

        let process_id = Self::make_process_id();
        let request_id = Self::make_request_id();

        let req = ShellStreamRequest {
            request_id: request_id.clone(),
            command: command.to_string(),
            cwd: cwd.clone(),
            shell: None,
            timeout_ms: None,
        };

        self.sink
            .spawn_shell_stream(req)
            .await
            .map_err(|e| ToolError::Execution(format!("shell_spawn failed: {e}")))?;

        Ok(json!({
            "success": true,
            "processId": process_id,
            "requestId": request_id,
            "command": command,
            "intent": intent,
            "cwd": cwd,
            "message": format!("Background process started with ID: {process_id}"),
        })
        .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::shell_editor_todo::ide_event_sink::{
        NoopIdeEventSink, RecordedEvent, RecordingIdeEventSink,
    };
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
    async fn requires_permission_is_true() {
        assert!(ShellSpawnTool::new(Arc::new(NoopIdeEventSink)).requires_permission());
    }

    #[tokio::test]
    async fn happy_path_records_stream_request() {
        let sink = RecordingIdeEventSink::new();
        let tool = ShellSpawnTool::new(sink.clone());
        let out = tool
            .execute(
                json!({"command": "echo hi", "cwd": "/work"}),
                &ctx(),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["command"], json!("echo hi"));
        assert!(parsed["processId"]
            .as_str()
            .map(|s| s.starts_with("bg-"))
            .unwrap_or(false));

        let events = sink.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            RecordedEvent::ShellStream(req) => {
                assert_eq!(req.command, "echo hi");
                assert_eq!(req.cwd.as_deref(), Some("/work"));
            }
            other => panic!("expected ShellStream, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_validation_block() {
        let sink = RecordingIdeEventSink::new();
        let tool = ShellSpawnTool::new(sink.clone());
        let err = tool
            .execute(json!({"command": ":(){ :|:& };:"}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::PolicyViolation(_)));
        assert_eq!(sink.event_count(), 0, "must not have queued the stream");
    }

    #[tokio::test]
    async fn maps_sink_failure_to_execution_error() {
        let sink = RecordingIdeEventSink::new();
        sink.fail_next("could not spawn");
        let tool = ShellSpawnTool::new(sink.clone());
        let err = tool
            .execute(json!({"command": "echo hi"}), &ctx())
            .await
            .expect_err("must fail");
        match err {
            ToolError::Execution(msg) => assert!(msg.contains("could not spawn"), "got: {msg}"),
            other => panic!("expected Execution, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_empty_command() {
        let tool = ShellSpawnTool::new(Arc::new(NoopIdeEventSink));
        let err = tool
            .execute(json!({"command": ""}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
