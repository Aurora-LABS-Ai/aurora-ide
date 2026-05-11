//! `file_write` — overwrite (or create) a file with full contents.
//!
//! Wraps `crate::commands::write_file_content` (without going through
//! the Tauri IPC layer; we call the underlying `std::fs::write` plus
//! the file_cache invalidation directly so this tool is callable
//! from the Rust agent runtime). Mirrors the TS
//! `fileWriteExecutor` JSON response shape, omitting the
//! pending-changes UI plumbing (Sub-D's permission prompter is the
//! Rust-native equivalent).

use std::path::Path;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::resolve_path_for_create;

pub struct FileWriteTool;

#[async_trait]
impl ToolExecutor for FileWriteTool {
    fn name(&self) -> &str {
        "file_write"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "file_write".into(),
            description: "Completely replace the entire content of a file. Creates parent \
                          directories if missing. Use search_replace/multi_search_replace for \
                          targeted edits."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The full path of the file to write." },
                    "content": { "type": "string", "description": "The COMPLETE new content for the file." }
                },
                "required": ["path", "content"],
                "additionalProperties": false,
            }),
        }
    }

    /// Mutates the user's workspace — must consult the permission gate
    /// so the Settings → Tools `auto`/`always_ask`/`deny` mode is
    /// honoured (matches the legacy TS risk classification, where
    /// `file_write` was Medium-risk and required approval unless the
    /// user pre-approved it in Settings).
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
            .ok_or_else(|| ToolError::InvalidInput("`content` must be a string".into()))?
            .to_string();

        let resolved = resolve_path_for_create(path, ctx.workspace_root.as_deref())?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let raw_path = path.to_string();
        let bytes = content.len();

        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let file_path = Path::new(&resolved_str);
            if let Some(parent) = file_path.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create directories: {e}"))?;
                }
            }
            std::fs::write(file_path, content.as_bytes())
                .map_err(|e| format!("Failed to write file: {e}"))?;
            crate::file_cache::get_file_cache().invalidate(&resolved_str);
            Ok(())
        })
        .await
        .map_err(|err| ToolError::Execution(format!("file_write task panicked: {err}")))?;

        match result {
            Ok(()) => Ok(serde_json::to_string(&json!({
                "success": true,
                "pending": false,
                "message": format!("File written: {raw_path}"),
                "path": raw_path,
                "fullPath": resolved.to_string_lossy(),
                "bytes": bytes,
            }))
            .unwrap()),
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
    async fn writes_new_file_inside_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileWriteTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": "out.txt", "content": "hi" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(std::fs::read_to_string(tmp.path().join("out.txt")).unwrap(), "hi");
    }

    #[tokio::test]
    async fn rejects_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileWriteTool);
        let err = tool
            .execute(
                serde_json::json!({ "path": "../escape.txt", "content": "hi" }),
                &ctx_for(Some(workspace)),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PolicyViolation(_)));
    }
}
