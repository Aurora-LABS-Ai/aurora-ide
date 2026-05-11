//! `todo_write` — fire-and-forget Tauri event with the new task list.
//!
//! Emits `"agent_todo_write"` via the [`IdeEventSink`] with payload
//! `{ todos }`. The frontend `useTaskStore` updates from the event;
//! the tool result is just an acknowledgement counter.
//!
//! `requires_permission()` returns **false** — todo updates are
//! purely UI-state.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::ide_event_sink::IdeEventSink;

pub struct TodoWriteTool {
    sink: Arc<dyn IdeEventSink>,
}

impl TodoWriteTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for TodoWriteTool {
    fn name(&self) -> &str {
        "todo_write"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "todo_write".into(),
            description: "Create or update a task list to track progress on multi-step tasks. \
                          Replaces the previous list. Each task must have content (imperative \
                          form), activeForm (present continuous), and status (pending, \
                          in_progress, completed)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "description": "The complete updated todo list. Each call replaces the previous list.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": {"type": "string", "description": "Task description in imperative form (e.g. 'Fix the bug')"},
                                "activeForm": {"type": "string", "description": "Task description in present continuous form (e.g. 'Fixing the bug')"},
                                "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}
                            },
                            "required": ["content", "activeForm", "status"]
                        }
                    }
                },
                "required": ["todos"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let todos = input
            .get("todos")
            .ok_or_else(|| ToolError::InvalidInput("missing `todos` field".into()))?;
        let arr = todos
            .as_array()
            .ok_or_else(|| ToolError::InvalidInput("`todos` must be an array".into()))?;

        // Validate every entry has the three required fields with
        // string types — matches the TS schema.
        let mut in_progress_count = 0usize;
        for (idx, entry) in arr.iter().enumerate() {
            let obj = entry.as_object().ok_or_else(|| {
                ToolError::InvalidInput(format!("todos[{idx}] must be an object"))
            })?;
            for field in ["content", "activeForm", "status"] {
                if !obj.get(field).map(Value::is_string).unwrap_or(false) {
                    return Err(ToolError::InvalidInput(format!(
                        "todos[{idx}].{field} must be a string"
                    )));
                }
            }
            let status = obj.get("status").and_then(Value::as_str).unwrap_or("");
            match status {
                "pending" | "completed" => {}
                "in_progress" => in_progress_count += 1,
                other => {
                    return Err(ToolError::InvalidInput(format!(
                        "todos[{idx}].status `{other}` not in [pending,in_progress,completed]"
                    )))
                }
            }
        }

        if in_progress_count > 1 {
            return Err(ToolError::InvalidInput(format!(
                "todo_write requires at most ONE in_progress task; found {in_progress_count}"
            )));
        }

        self.sink
            .emit_todo_write(todos)
            .map_err(|e| ToolError::Execution(format!("failed to emit todo_write event: {e}")))?;

        Ok(json!({
            "success": true,
            "count": arr.len(),
            "inProgressCount": in_progress_count,
            "message": format!("recorded {} todos", arr.len()),
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

    fn sample() -> Value {
        json!([
            {"content":"Step 1","activeForm":"Doing step 1","status":"in_progress"},
            {"content":"Step 2","activeForm":"Doing step 2","status":"pending"},
        ])
    }

    #[tokio::test]
    async fn requires_permission_is_false() {
        let tool = TodoWriteTool::new(Arc::new(NoopIdeEventSink));
        assert!(!tool.requires_permission());
    }

    #[tokio::test]
    async fn happy_path_emits_event() {
        let sink = RecordingIdeEventSink::new();
        let tool = TodoWriteTool::new(sink.clone());
        let out = tool
            .execute(json!({"todos": sample()}), &ctx())
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["count"], json!(2));
        assert_eq!(parsed["inProgressCount"], json!(1));
        match &sink.events()[0] {
            RecordedEvent::TodoWrite { todos } => assert_eq!(todos, &sample()),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_two_in_progress() {
        let tool = TodoWriteTool::new(Arc::new(NoopIdeEventSink));
        let dup = json!([
            {"content":"a","activeForm":"a","status":"in_progress"},
            {"content":"b","activeForm":"b","status":"in_progress"},
        ]);
        let err = tool
            .execute(json!({"todos": dup}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn rejects_unknown_status() {
        let tool = TodoWriteTool::new(Arc::new(NoopIdeEventSink));
        let bad = json!([
            {"content":"a","activeForm":"a","status":"blocked"}
        ]);
        let err = tool
            .execute(json!({"todos": bad}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn rejects_missing_field() {
        let tool = TodoWriteTool::new(Arc::new(NoopIdeEventSink));
        let bad = json!([
            {"content":"a","status":"pending"}
        ]);
        let err = tool
            .execute(json!({"todos": bad}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn rejects_todos_not_array() {
        let tool = TodoWriteTool::new(Arc::new(NoopIdeEventSink));
        let err = tool
            .execute(json!({"todos": {"x":1}}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn empty_todos_clears_list() {
        let sink = RecordingIdeEventSink::new();
        let tool = TodoWriteTool::new(sink.clone());
        let out = tool
            .execute(json!({"todos": []}), &ctx())
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["count"], json!(0));
        match &sink.events()[0] {
            RecordedEvent::TodoWrite { todos } => assert_eq!(todos, &json!([])),
            other => panic!("unexpected: {other:?}"),
        }
    }
}
