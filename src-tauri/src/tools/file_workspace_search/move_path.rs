//! `move_path` — move or rename a file OR a folder.
//!
//! Unifies the old `folder_move` (which only handled directories) and
//! closes the gap where there was no way to move/rename a *file* short
//! of read→write→delete. Named `move_path` rather than `file_move` so
//! the model isn't misled into thinking it's file-only.
//!
//! Backed by `std::fs::rename`. Returns a graceful `success:false`
//! payload for the expected "source missing" / "destination exists"
//! cases rather than failing loud, so the agent gets a recoverable
//! result.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::tools::shell_editor_todo::{FileChangedPayload, IdeEventSink};

use super::{resolve_path_for_create, resolve_path_for_read};

pub struct MovePathTool {
    sink: Arc<dyn IdeEventSink>,
}

impl MovePathTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for MovePathTool {
    fn name(&self) -> &str {
        "move_path"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "move_path".into(),
            description:
                "Move or rename a file OR a folder from one path to another. Fails if the \
                          source does not exist or the destination already exists."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "old_path": { "type": "string", "description": "The current full path (file or folder)." },
                    "new_path": { "type": "string", "description": "The new full path." }
                },
                "required": ["old_path", "new_path"],
                "additionalProperties": false,
            }),
        }
    }

    /// Mutates the user's workspace — Medium-risk. Always gate.
    fn requires_permission(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let old_path = input
            .get("old_path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`old_path` must be a string".into()))?;
        let new_path = input
            .get("new_path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`new_path` must be a string".into()))?;

        // Source may legitimately be missing (graceful success=false), so
        // resolve it with the read variant. Destination must not exist, so
        // resolve it with the create variant that validates the parent.
        // A move is a write — keep it workspace-bound regardless of the
        // out-of-workspace READ allowance.
        let resolved_old = resolve_path_for_read(old_path, ctx.workspace_root.as_deref(), false)?;
        let resolved_new = resolve_path_for_create(new_path, ctx.workspace_root.as_deref())?;
        let old_str = resolved_old.to_string_lossy().to_string();
        let new_str = resolved_new.to_string_lossy().to_string();
        let raw_old = old_path.to_string();
        let raw_new = new_path.to_string();

        let outcome = tokio::task::spawn_blocking(move || -> Result<bool, String> {
            let src = Path::new(&old_str);
            let dst = Path::new(&new_str);
            if !src.exists() {
                return Err(format!("Source path does not exist: {old_str}"));
            }
            if dst.exists() {
                return Err(format!("Destination already exists: {new_str}"));
            }
            let is_dir = src.is_dir();
            crate::file_cache::get_file_cache().invalidate(&old_str);
            if is_dir {
                crate::file_cache::get_file_cache().invalidate_prefix(&old_str);
            }
            std::fs::rename(src, dst).map_err(|e| format!("Failed to move: {e}"))?;
            Ok(is_dir)
        })
        .await
        .map_err(|err| ToolError::Execution(format!("move_path task panicked: {err}")))?;

        match outcome {
            Ok(is_dir) => {
                // A move is a delete of the old location plus a create of
                // the new one. Emitting both keeps open buffers, the
                // explorer tree, and the pending-changes UI in sync.
                let deleted = FileChangedPayload::deleted(
                    resolved_old.to_string_lossy().to_string(),
                    is_dir,
                    "move_path",
                )
                .with_tool_call_id(ctx.tool_call_id.clone());
                if let Err(emit_err) = self.sink.emit_file_changed(&deleted) {
                    eprintln!(
                        "[move_path] emit_file_changed (deleted) failed for {raw_old}: {emit_err}"
                    );
                }
                let created = if is_dir {
                    FileChangedPayload::folder_created(
                        resolved_new.to_string_lossy().to_string(),
                        "move_path",
                    )
                } else {
                    // Read the moved file's content so the explorer/diff UI
                    // can render the new node. Soft-fail to empty on error.
                    let content = std::fs::read_to_string(&resolved_new).unwrap_or_default();
                    FileChangedPayload::created(
                        resolved_new.to_string_lossy().to_string(),
                        content,
                        "move_path",
                    )
                }
                .with_tool_call_id(ctx.tool_call_id.clone());
                if let Err(emit_err) = self.sink.emit_file_changed(&created) {
                    eprintln!(
                        "[move_path] emit_file_changed (created) failed for {raw_new}: {emit_err}"
                    );
                }

                Ok(serde_json::to_string(&json!({
                    "success": true,
                    "message": format!("Moved: {raw_old} -> {raw_new}"),
                    "oldPath": raw_old,
                    "newPath": raw_new,
                    "isDirectory": is_dir,
                    "fullPath": resolved_new.to_string_lossy(),
                }))
                .unwrap())
            }
            Err(err) => Ok(serde_json::to_string(&json!({
                "success": false,
                "error": err,
                "oldPath": raw_old,
                "newPath": raw_new,
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
        Arc::new(MovePathTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )))
    }

    #[tokio::test]
    async fn renames_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "hi").unwrap();
        let out = tool()
            .execute(
                serde_json::json!({ "old_path": "a.txt", "new_path": "b.txt" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(parsed["isDirectory"], false);
        assert!(!tmp.path().join("a.txt").exists());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("b.txt")).unwrap(),
            "hi"
        );
    }

    #[tokio::test]
    async fn moves_a_folder() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("src/inner")).unwrap();
        std::fs::write(tmp.path().join("src/inner/f.txt"), "x").unwrap();
        let out = tool()
            .execute(
                serde_json::json!({ "old_path": "src", "new_path": "dst" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(parsed["isDirectory"], true);
        assert!(tmp.path().join("dst/inner/f.txt").is_file());
    }

    #[tokio::test]
    async fn fails_when_source_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tool()
            .execute(
                serde_json::json!({ "old_path": "nope", "new_path": "dst" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("does not exist"));
    }

    #[tokio::test]
    async fn fails_when_destination_exists() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "1").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "2").unwrap();
        let out = tool()
            .execute(
                serde_json::json!({ "old_path": "a.txt", "new_path": "b.txt" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("already exists"));
    }
}
