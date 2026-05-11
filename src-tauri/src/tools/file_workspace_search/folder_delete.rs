//! `folder_delete` — recursively delete a folder. Wraps
//! `crate::commands::delete_path` and refuses to act on a file
//! (use `file_delete` instead).

use std::path::Path;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::resolve_path;

pub struct FolderDeleteTool;

#[async_trait]
impl ToolExecutor for FolderDeleteTool {
    fn name(&self) -> &str {
        "folder_delete"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "folder_delete".into(),
            description: "Delete a folder and all its contents recursively. Irreversible.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The full path of the folder to delete." }
                },
                "required": ["path"],
                "additionalProperties": false,
            }),
        }
    }

    /// Destructive recursive mutation — High-risk in the legacy TS
    /// classification. Always consult the permission gate.
    fn requires_permission(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let path = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`path` must be a string".into()))?;
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

        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let dir = Path::new(&resolved_str);
            if !dir.exists() {
                return Err(format!("Folder does not exist: {}", resolved_str));
            }
            if !dir.is_dir() {
                return Err(format!(
                    "Path is not a directory; use file_delete: {}",
                    resolved_str
                ));
            }
            crate::file_cache::get_file_cache().invalidate_prefix(&resolved_str);
            std::fs::remove_dir_all(dir).map_err(|e| format!("Failed to delete folder: {e}"))
        })
        .await
        .map_err(|err| ToolError::Execution(format!("folder_delete task panicked: {err}")))?;

        match result {
            Ok(()) => Ok(serde_json::to_string(&json!({
                "success": true,
                "message": format!("Folder deleted: {raw_path}"),
                "path": raw_path,
                "fullPath": resolved.to_string_lossy(),
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
    async fn deletes_folder_recursively() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("sub/inner")).unwrap();
        std::fs::write(tmp.path().join("sub/inner/file.txt"), "x").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FolderDeleteTool);
        let out = tool
            .execute(
                serde_json::json!({ "path": "sub" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert!(!tmp.path().join("sub").exists());
    }

    #[tokio::test]
    async fn refuses_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "x").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FolderDeleteTool);
        let out = tool
            .execute(
                serde_json::json!({ "path": "a.txt" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("not a directory"));
    }
}
