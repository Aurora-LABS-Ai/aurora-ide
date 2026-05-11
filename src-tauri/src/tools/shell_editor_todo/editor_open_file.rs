//! `editor_open_file` — fire-and-forget Tauri event to focus a file
//! in Monaco.
//!
//! Emits the `"agent_editor_open"` channel via the
//! [`IdeEventSink`] with payload `{ path, line?, column? }`. Returns
//! a placeholder acknowledgement string — the frontend updates from
//! the event itself, not from the tool result.
//!
//! `requires_permission()` returns **false** — opening a tab is a
//! purely visual change.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::ide_event_sink::IdeEventSink;

pub struct EditorOpenFileTool {
    sink: Arc<dyn IdeEventSink>,
}

impl EditorOpenFileTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for EditorOpenFileTool {
    fn name(&self) -> &str {
        "editor_open_file"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "editor_open_file".into(),
            description: "Open a file in the code editor. Optionally navigate to a specific \
                          line and column (1-indexed)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "The full path of the file to open"},
                    "line": {"type": "number", "description": "Line number to navigate to (1-indexed)"},
                    "column": {"type": "number", "description": "Column number to navigate to (1-indexed)"}
                },
                "required": ["path"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let path = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`path` must be a string".into()))?;
        if path.is_empty() {
            return Err(ToolError::InvalidInput("`path` must not be empty".into()));
        }

        let line = input.get("line").and_then(Value::as_u64);
        let column = input.get("column").and_then(Value::as_u64);

        self.sink
            .emit_editor_open(path, line, column)
            .map_err(|e| ToolError::Execution(format!("failed to emit editor_open event: {e}")))?;

        Ok(json!({
            "success": true,
            "path": path,
            "line": line,
            "column": column,
            "message": format!("requested editor open for {path}"),
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
    async fn requires_permission_is_false() {
        let tool = EditorOpenFileTool::new(Arc::new(NoopIdeEventSink));
        assert!(!tool.requires_permission());
    }

    #[tokio::test]
    async fn emits_event_with_line_and_column() {
        let sink = RecordingIdeEventSink::new();
        let tool = EditorOpenFileTool::new(sink.clone());
        let out = tool
            .execute(json!({"path":"src/lib.rs","line":42,"column":7}), &ctx())
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], json!(true));

        let events = sink.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            RecordedEvent::EditorOpen { path, line, column } => {
                assert_eq!(path, "src/lib.rs");
                assert_eq!(*line, Some(42));
                assert_eq!(*column, Some(7));
            }
            other => panic!("unexpected event {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_missing_path() {
        let tool = EditorOpenFileTool::new(Arc::new(NoopIdeEventSink));
        let err = tool.execute(json!({}), &ctx()).await.expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn maps_sink_failure_to_execution() {
        let sink = RecordingIdeEventSink::new();
        sink.fail_next("emit boom");
        let tool = EditorOpenFileTool::new(sink.clone());
        let err = tool
            .execute(json!({"path":"x"}), &ctx())
            .await
            .expect_err("must fail");
        match err {
            ToolError::Execution(msg) => assert!(msg.contains("emit boom"), "got: {msg}"),
            other => panic!("expected Execution, got {other:?}"),
        }
    }
}
