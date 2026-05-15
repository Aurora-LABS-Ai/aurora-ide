//! `file_create` — create a NEW file. Fails if the path already exists.
//!
//! Mirrors the TS `fileCreateExecutor` JSON shape (`success`,
//! `pending`, `path`, `fullPath`, `bytes`). Calls
//! `crate::commands::create_file` to enforce the
//! "must-not-exist" precondition, then writes the initial content.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::tools::shell_editor_todo::{FileChangedPayload, IdeEventSink};

use super::resolve_path_for_create;

pub struct FileCreateTool {
    sink: Arc<dyn IdeEventSink>,
}

impl FileCreateTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for FileCreateTool {
    fn name(&self) -> &str {
        "file_create"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "file_create".into(),
            description: "Create a NEW file that does not exist yet. Creates parent directories \
                          automatically. FAILS if the file already exists; use file_write to \
                          overwrite."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The full path of the new file." },
                    "content": { "type": "string", "default": "", "description": "Initial content (empty string by default)." }
                },
                "required": ["path"],
                "additionalProperties": false,
            }),
        }
    }

    /// Mutates the user's workspace — must consult the permission gate
    /// so the Settings → Tools `auto`/`always_ask`/`deny` mode is
    /// honoured (matches the legacy TS Medium-risk classification).
    fn requires_permission(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let path = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`path` must be a string".into()))?;
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let resolved = resolve_path_for_create(path, ctx.workspace_root.as_deref())?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let raw_path = path.to_string();
        let bytes = content.len();

        let content_for_event = content.clone();
        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let file_path = Path::new(&resolved_str);
            if file_path.exists() {
                return Err(format!("File already exists: {}", resolved_str));
            }
            if let Some(parent) = file_path.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create directories: {e}"))?;
                }
            }
            std::fs::write(file_path, content.as_bytes())
                .map_err(|e| format!("Failed to create file: {e}"))?;
            crate::file_cache::get_file_cache().invalidate(&resolved_str);
            Ok(())
        })
        .await
        .map_err(|err| ToolError::Execution(format!("file_create task panicked: {err}")))?;

        match result {
            Ok(()) => {
                let payload = FileChangedPayload::created(
                    resolved.to_string_lossy().to_string(),
                    content_for_event,
                    "file_create",
                )
                .with_tool_call_id(ctx.tool_call_id.clone());
                if let Err(emit_err) = self.sink.emit_file_changed(&payload) {
                    eprintln!(
                        "[file_create] emit_file_changed failed for {raw_path}: {emit_err}"
                    );
                }

                Ok(serde_json::to_string(&json!({
                    "success": true,
                    "pending": false,
                    "message": format!("File created: {raw_path}"),
                    "path": raw_path,
                    "fullPath": resolved.to_string_lossy(),
                    "bytes": bytes,
                }))
                .unwrap())
            }
            Err(err) => Ok(serde_json::to_string(&json!({
                "success": false,
                "error": err,
                "path": raw_path,
                "fullPath": resolved.to_string_lossy(),
            }))
            .unwrap()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::tool_executor::ToolContext;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn ctx_for(workspace: Option<std::path::PathBuf>) -> ToolContext {
        ToolContext {
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            session_id: "s".into(),
            workspace_root: workspace,
            cancel_token: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn creates_new_file_with_content() {
        let tmp = tempfile::tempdir().unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileCreateTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let result = tool
            .execute(
                serde_json::json!({ "path": "new.txt", "content": "hi" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(std::fs::read_to_string(tmp.path().join("new.txt")).unwrap(), "hi");
    }

    #[tokio::test]
    async fn fails_when_file_exists() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("x.txt"), "old").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileCreateTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let result = tool
            .execute(
                serde_json::json!({ "path": "x.txt", "content": "new" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("already exists"));
    }
}
