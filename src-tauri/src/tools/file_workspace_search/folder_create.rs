//! `folder_create` — create a directory (and any missing parents).
//! Wraps `crate::commands::create_folder`.

use std::path::Path;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::resolve_path_for_create;

pub struct FolderCreateTool;

#[async_trait]
impl ToolExecutor for FolderCreateTool {
    fn name(&self) -> &str {
        "folder_create"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "folder_create".into(),
            description: "Create a new folder/directory at the specified path. Creates parent \
                          directories if they do not exist."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The full path of the folder to create." }
                },
                "required": ["path"],
                "additionalProperties": false,
            }),
        }
    }

    /// Mutates the user's workspace — Medium-risk in the legacy TS
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
        let resolved = resolve_path_for_create(path, ctx.workspace_root.as_deref())?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let raw_path = path.to_string();

        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let dir = Path::new(&resolved_str);
            if dir.exists() {
                return Err(format!("Folder already exists: {}", resolved_str));
            }
            std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create folder: {e}"))
        })
        .await
        .map_err(|err| ToolError::Execution(format!("folder_create task panicked: {err}")))?;

        match result {
            Ok(()) => Ok(serde_json::to_string(&json!({
                "success": true,
                "message": format!("Folder created: {raw_path}"),
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
    async fn creates_nested_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FolderCreateTool);
        let out = tool
            .execute(
                serde_json::json!({ "path": "a/b/c" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert!(tmp.path().join("a/b/c").is_dir());
    }

    #[tokio::test]
    async fn fails_when_folder_exists() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("dup")).unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FolderCreateTool);
        let out = tool
            .execute(
                serde_json::json!({ "path": "dup" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("already exists"));
    }
}
