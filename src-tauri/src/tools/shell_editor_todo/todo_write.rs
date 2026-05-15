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

        // Soft-clamp: if the model produced more than one in_progress
        // task, keep the first one and demote the rest to `pending`.
        // Returning a hard error here used to fail the entire turn and
        // surface a noisy red banner in the chat — the agent recovered
        // on the next iteration but the UX looked broken.
        let mut normalized_todos = todos.clone();
        let clamped = if in_progress_count > 1 {
            if let Some(arr_mut) = normalized_todos.as_array_mut() {
                let mut seen_first = false;
                for entry in arr_mut.iter_mut() {
                    if let Some(obj) = entry.as_object_mut() {
                        let status =
                            obj.get("status").and_then(Value::as_str).unwrap_or("");
                        if status == "in_progress" {
                            if seen_first {
                                obj.insert(
                                    "status".to_string(),
                                    Value::String("pending".into()),
                                );
                            } else {
                                seen_first = true;
                            }
                        }
                    }
                }
            }
            true
        } else {
            false
        };

        self.sink
            .emit_todo_write(&normalized_todos)
            .map_err(|e| ToolError::Execution(format!("failed to emit todo_write event: {e}")))?;

        let kept_in_progress = if in_progress_count >= 1 { 1 } else { 0 };
        let mut result = json!({
            "success": true,
            "count": arr.len(),
            "inProgressCount": kept_in_progress,
            "message": format!("recorded {} todos", arr.len()),
        });
        if clamped {
            result["warning"] = Value::String(format!(
                "todo_write received {} in_progress tasks; only one is permitted at a time. \
                 The first in_progress task was kept; the others were auto-demoted to pending. \
                 Next time, mark just one task as in_progress and flip the rest to pending.",
                in_progress_count
            ));
        }
        Ok(result.to_string())
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
    async fn clamps_multi_in_progress_and_warns() {
        // The new contract: multiple in_progress entries are soft-clamped
        // (first kept, rest demoted to `pending`) and the result carries
        // a `warning` field. Previously this returned `ToolError::InvalidInput`,
        // which presented as a hard red error in the chat UI even though
        // the agent would recover on the next iteration.
        let sink = RecordingIdeEventSink::new();
        let tool = TodoWriteTool::new(sink.clone());
        let dup = json!([
            {"content":"a","activeForm":"a","status":"in_progress"},
            {"content":"b","activeForm":"b","status":"in_progress"},
            {"content":"c","activeForm":"c","status":"in_progress"},
        ]);
        let out = tool
            .execute(json!({"todos": dup}), &ctx())
            .await
            .expect("ok — should clamp, not fail");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["inProgressCount"], json!(1));
        assert!(
            parsed["warning"]
                .as_str()
                .unwrap_or("")
                .contains("only one"),
            "expected warning about single in_progress, got: {parsed}"
        );
        // Emitted payload had its in_progress entries normalised.
        match &sink.events()[0] {
            RecordedEvent::TodoWrite { todos } => {
                let arr = todos.as_array().expect("array");
                let in_prog: Vec<_> = arr
                    .iter()
                    .filter(|t| t["status"] == "in_progress")
                    .collect();
                assert_eq!(in_prog.len(), 1, "exactly one in_progress should survive");
                assert_eq!(in_prog[0]["content"], "a", "first in_progress kept");
            }
            other => panic!("unexpected: {other:?}"),
        }
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
