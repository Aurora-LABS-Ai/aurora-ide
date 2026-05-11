//! `read_lints` — fire-and-forget Tauri event asking the frontend to
//! return Monaco diagnostics for the given files.
//!
//! Emits the `"agent_read_lints"` channel via the [`IdeEventSink`]
//! with payload `{ paths }`. The frontend independently posts the
//! lint results back via existing channels (see Phase 3 contract
//! §1.7 — frontend wiring is out of scope).
//!
//! Returns a placeholder acknowledgement string so the agent can
//! continue its turn; the contract calls this out as
//! "lints requested for {paths}" in spirit.
//!
//! `requires_permission()` returns **false** — read-only operation.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::ide_event_sink::IdeEventSink;

pub struct ReadLintsTool {
    sink: Arc<dyn IdeEventSink>,
}

impl ReadLintsTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for ReadLintsTool {
    fn name(&self) -> &str {
        "read_lints"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "read_lints".into(),
            description: "Read linter/diagnostic errors from files. Returns TypeScript, \
                          JavaScript, Rust, and other language errors detected by the \
                          editor. If no path provided, checks all open files."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Array of file paths to check for lint errors. If empty, checks all open files."
                    }
                },
                "required": []
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let paths: Vec<String> = match input.get("paths") {
            Some(Value::Array(arr)) => arr
                .iter()
                .map(|v| {
                    v.as_str()
                        .ok_or_else(|| {
                            ToolError::InvalidInput(
                                "`paths` must be an array of strings".into(),
                            )
                        })
                        .map(str::to_string)
                })
                .collect::<Result<Vec<_>, _>>()?,
            None | Some(Value::Null) => Vec::new(),
            Some(_) => {
                return Err(ToolError::InvalidInput(
                    "`paths` must be an array of strings".into(),
                ))
            }
        };

        self.sink
            .emit_read_lints(&paths)
            .map_err(|e| ToolError::Execution(format!("failed to emit read_lints event: {e}")))?;

        let display = if paths.is_empty() {
            "all open files".to_string()
        } else {
            paths.join(", ")
        };

        Ok(json!({
            "success": true,
            "paths": paths,
            "message": format!("lints requested for {display}"),
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
        let tool = ReadLintsTool::new(Arc::new(NoopIdeEventSink));
        assert!(!tool.requires_permission());
    }

    #[tokio::test]
    async fn empty_paths_emits_open_files_request() {
        let sink = RecordingIdeEventSink::new();
        let tool = ReadLintsTool::new(sink.clone());
        let out = tool.execute(json!({}), &ctx()).await.expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], json!(true));
        assert!(parsed["message"]
            .as_str()
            .unwrap_or_default()
            .contains("all open files"));

        match &sink.events()[0] {
            RecordedEvent::ReadLints { paths } => assert!(paths.is_empty()),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn paths_array_round_trips() {
        let sink = RecordingIdeEventSink::new();
        let tool = ReadLintsTool::new(sink.clone());
        let _ = tool
            .execute(json!({"paths":["a.rs","b.rs"]}), &ctx())
            .await
            .expect("ok");
        match &sink.events()[0] {
            RecordedEvent::ReadLints { paths } => {
                assert_eq!(paths, &vec!["a.rs".to_string(), "b.rs".to_string()]);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_paths_not_array() {
        let tool = ReadLintsTool::new(Arc::new(NoopIdeEventSink));
        let err = tool
            .execute(json!({"paths": "single.rs"}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn rejects_non_string_path_entry() {
        let tool = ReadLintsTool::new(Arc::new(NoopIdeEventSink));
        let err = tool
            .execute(json!({"paths": [123]}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
