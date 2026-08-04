//! `delete_path` — delete a file OR a folder.
//!
//! Unifies the old `file_delete` + `folder_delete`. A file deletes
//! directly; a directory requires an explicit `recursive: true` so the
//! model can't wipe a tree by mistake. Refuses to delete the workspace
//! root. Irreversible (the checkpoint system is the safety net).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::tools::shell_editor_todo::{FileChangedPayload, IdeEventSink};

use super::resolve_path;

pub struct DeletePathTool {
    sink: Arc<dyn IdeEventSink>,
}

impl DeletePathTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for DeletePathTool {
    fn name(&self) -> &str {
        "delete_path"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "delete_path".into(),
            description: "Delete a file or a folder. Deleting a folder (with all its contents) \
                          requires recursive=true. Irreversible."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The full path to delete (file or folder)." },
                    "recursive": { "type": "boolean", "default": false, "description": "Required (true) to delete a non-empty/any folder." }
                },
                "required": ["path"],
                "additionalProperties": false,
            }),
        }
    }

    /// Destructive mutation — High-risk. Always gate.
    fn requires_permission(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let path = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`path` must be a string".into()))?;
        let recursive = input
            .get("recursive")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let resolved = resolve_path(path, ctx.workspace_root.as_deref())?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let raw_path = path.to_string();

        // Guard rail: never delete the workspace root itself.
        if let Some(root) = ctx.workspace_root.as_deref() {
            if let Ok(canonical_root) = dunce::canonicalize(root) {
                if resolved == canonical_root {
                    return Err(ToolError::PolicyViolation(
                        "refusing to delete the workspace root".into(),
                    ));
                }
            }
        }

        let result = tokio::task::spawn_blocking(move || -> Result<bool, String> {
            let p = Path::new(&resolved_str);
            if !p.exists() {
                return Err(format!("Path does not exist: {resolved_str}"));
            }
            let is_dir = p.is_dir();
            if is_dir {
                if !recursive {
                    return Err(format!(
                        "{resolved_str} is a folder. Pass recursive=true to delete a folder and its contents."
                    ));
                }
                crate::file_cache::get_file_cache().invalidate_prefix(&resolved_str);
                std::fs::remove_dir_all(p).map_err(|e| format!("Failed to delete folder: {e}"))?;
            } else {
                crate::file_cache::get_file_cache().invalidate(&resolved_str);
                std::fs::remove_file(p).map_err(|e| format!("Failed to delete file: {e}"))?;
            }
            Ok(is_dir)
        })
        .await
        .map_err(|err| ToolError::Execution(format!("delete_path task panicked: {err}")))?;

        match result {
            Ok(is_dir) => {
                let payload = FileChangedPayload::deleted(
                    resolved.to_string_lossy().to_string(),
                    is_dir,
                    "delete_path",
                )
                .with_tool_call_id(ctx.tool_call_id.clone());
                if let Err(emit_err) = self.sink.emit_file_changed(&payload) {
                    eprintln!("[delete_path] emit_file_changed failed for {raw_path}: {emit_err}");
                }

                Ok(serde_json::to_string(&json!({
                    "success": true,
                    "message": format!("Deleted: {raw_path}"),
                    "path": raw_path,
                    "isDirectory": is_dir,
                    "fullPath": resolved.to_string_lossy(),
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
            thread_id: "s".into(),
            workspace_root: workspace,
            allow_outside_workspace: false,
            cancel_token: CancellationToken::new(),
        }
    }

    fn tool() -> Arc<dyn ToolExecutor> {
        Arc::new(DeletePathTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )))
    }

    #[tokio::test]
    async fn deletes_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("d.txt"), "x").unwrap();
        let out = tool()
            .execute(
                serde_json::json!({ "path": "d.txt" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert!(!tmp.path().join("d.txt").exists());
    }

    #[tokio::test]
    async fn refuses_folder_without_recursive() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("sub")).unwrap();
        let out = tool()
            .execute(
                serde_json::json!({ "path": "sub" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("recursive=true"));
        assert!(tmp.path().join("sub").exists());
    }

    #[tokio::test]
    async fn deletes_folder_with_recursive() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("sub/inner")).unwrap();
        std::fs::write(tmp.path().join("sub/inner/f.txt"), "x").unwrap();
        let out = tool()
            .execute(
                serde_json::json!({ "path": "sub", "recursive": true }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert!(!tmp.path().join("sub").exists());
    }
}
