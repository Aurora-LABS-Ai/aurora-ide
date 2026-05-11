//! `file_delete` — delete a file. Wraps `crate::commands::delete_path`
//! and returns the same JSON shape as the TS executor.

use std::path::Path;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::resolve_path;

pub struct FileDeleteTool;

#[async_trait]
impl ToolExecutor for FileDeleteTool {
    fn name(&self) -> &str {
        "file_delete"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "file_delete".into(),
            description: "Delete a file at the specified path. Irreversible.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The full path of the file to delete." }
                },
                "required": ["path"],
                "additionalProperties": false,
            }),
        }
    }

    /// Destructive mutation — High-risk in the legacy TS classification.
    /// Always consult the permission gate so the Settings → Tools mode
    /// (`auto`/`always_ask`/`deny`) is enforced.
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

        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let p = Path::new(&resolved_str);
            if !p.exists() {
                return Err(format!("Path does not exist: {}", resolved_str));
            }
            if p.is_dir() {
                return Err(format!(
                    "Path is a directory; use folder_delete: {}",
                    resolved_str
                ));
            }
            crate::file_cache::get_file_cache().invalidate(&resolved_str);
            std::fs::remove_file(p).map_err(|e| format!("Failed to delete file: {e}"))
        })
        .await
        .map_err(|err| ToolError::Execution(format!("file_delete task panicked: {err}")))?;

        match result {
            Ok(()) => Ok(serde_json::to_string(&json!({
                "success": true,
                "message": format!("File deleted: {raw_path}"),
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
    async fn deletes_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("d.txt"), "x").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileDeleteTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": "d.txt" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], true);
        assert!(!tmp.path().join("d.txt").exists());
    }

    #[tokio::test]
    async fn refuses_to_delete_directory() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("sub")).unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileDeleteTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": "sub" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("directory"));
    }
}
