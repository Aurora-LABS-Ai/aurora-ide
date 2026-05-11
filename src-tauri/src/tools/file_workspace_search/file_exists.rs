//! `file_exists` — check whether a path exists, and what kind of
//! filesystem entry lives there. Pure `std::fs::metadata` lookup —
//! no underlying Tauri command needed.

use std::path::Path;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::agent_safety::{is_within_workspace, resolve_within_workspace, PathSafetyError};

pub struct FileExistsTool;

#[async_trait]
impl ToolExecutor for FileExistsTool {
    fn name(&self) -> &str {
        "file_exists"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "file_exists".into(),
            description: "Check whether a path exists. Returns { exists, isFile, isDirectory, \
                          isSymlink, size? } — never throws on a missing path."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The path to check." }
                },
                "required": ["path"],
                "additionalProperties": false,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let path = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`path` must be a string".into()))?;

        // Don't fail when the path is missing — that's the whole
        // point of `file_exists`. We still enforce the workspace
        // boundary by:
        //   1. trying `resolve_within_workspace` (succeeds iff the
        //      path exists AND is inside the workspace),
        //   2. falling back to a manual containment check that
        //      rejects `..`-style escape attempts on a missing leaf.
        let raw_path = path.to_string();
        let workspace_root = ctx.workspace_root.clone();

        let payload = tokio::task::spawn_blocking(move || -> Value {
            let p = Path::new(&raw_path);

            // Resolve once. The branches below feed both the
            // workspace-boundary verdict AND the absolute path we
            // hand to `symlink_metadata`. Using the raw `p` for the
            // metadata lookup is wrong: a relative path resolves
            // against the process CWD, not the workspace root, so a
            // file at `<workspace>/e.txt` would silently report
            // `exists=false` when CWD ≠ workspace.
            let lookup_path: std::path::PathBuf = match workspace_root.as_deref() {
                Some(root) => match resolve_within_workspace(p, root) {
                    Ok(resolved) => resolved,
                    Err(PathSafetyError::OutsideWorkspace(_))
                    | Err(PathSafetyError::EscapingSymlink(_, _)) => {
                        return json!({
                            "exists": false,
                            "isFile": false,
                            "isDirectory": false,
                            "isSymlink": false,
                            "policyViolation": true,
                            "error": "path escapes workspace",
                        });
                    }
                    Err(PathSafetyError::Io(_)) => {
                        // Path likely missing. Workspace-bounded
                        // missing leaves are allowed (we report
                        // `exists=false` honestly); leaves whose
                        // closest existing ancestor is *outside* the
                        // workspace are policy violations.
                        if !is_missing_leaf_inside_workspace(p, root) {
                            return json!({
                                "exists": false,
                                "isFile": false,
                                "isDirectory": false,
                                "isSymlink": false,
                                "policyViolation": true,
                                "error": "path escapes workspace",
                            });
                        }
                        if p.is_absolute() {
                            p.to_path_buf()
                        } else {
                            root.join(p)
                        }
                    }
                },
                None => p.to_path_buf(),
            };

            match std::fs::symlink_metadata(&lookup_path) {
                Ok(meta) => {
                    let is_symlink = meta.file_type().is_symlink();
                    let is_dir = meta.is_dir();
                    let is_file = meta.is_file();
                    json!({
                        "exists": true,
                        "isFile": is_file,
                        "isDirectory": is_dir,
                        "isSymlink": is_symlink,
                        "size": meta.len(),
                    })
                }
                Err(_) => json!({
                    "exists": false,
                    "isFile": false,
                    "isDirectory": false,
                    "isSymlink": false,
                }),
            }
        })
        .await
        .map_err(|err| ToolError::Execution(format!("file_exists task panicked: {err}")))?;

        // Stamp the user-supplied path so the agent can correlate
        // the response with its request.
        let mut payload = payload;
        if let Some(map) = payload.as_object_mut() {
            map.insert("path".into(), json!(path));
        }
        Ok(serde_json::to_string(&payload).unwrap())
    }
}

/// Returns true when `path` doesn't exist but its closest existing
/// ancestor IS inside the workspace. This lets `file_exists` honestly
/// report `exists=false` for legitimately-missing paths the agent
/// asks about, without leaking information about the filesystem
/// outside the workspace.
fn is_missing_leaf_inside_workspace(path: &Path, root: &Path) -> bool {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let mut cursor = absolute.as_path();
    loop {
        if cursor.exists() {
            return is_within_workspace(cursor, root);
        }
        match cursor.parent() {
            Some(parent) => cursor = parent,
            None => return false,
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
    async fn reports_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("e.txt"), "x").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileExistsTool);
        let out = tool
            .execute(
                serde_json::json!({ "path": "e.txt" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["exists"], true);
        assert_eq!(parsed["isFile"], true);
    }

    #[tokio::test]
    async fn reports_missing_path_inside_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileExistsTool);
        let out = tool
            .execute(
                serde_json::json!({ "path": "missing.txt" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["exists"], false);
    }

    #[tokio::test]
    async fn rejects_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(tmp.path().join("outside.txt"), "x").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileExistsTool);
        let out = tool
            .execute(
                serde_json::json!({ "path": "../outside.txt" }),
                &ctx_for(Some(workspace.clone())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["exists"], false);
        assert_eq!(parsed["policyViolation"], true);
    }
}
