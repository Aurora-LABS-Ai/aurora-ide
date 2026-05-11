//! `file_patch` — search/replace alias accepting either a single
//! `{old_string, new_string}` pair or an array of them.
//!
//! The original TS tooling routes the agent's "patch this file"
//! intent into either `search_replace` or `multi_search_replace`
//! depending on the shape of the input. For Rust parity, this
//! tool dispatches to the same backing
//! `crate::commands::editor_ops::apply_search_replace` /
//! `apply_multi_search_replace` calls and reuses the response
//! renderer in [`super::search_replace::render_response`].

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::commands::editor_ops::{
    apply_multi_search_replace, apply_search_replace, ApplyMultiSearchReplaceRequest,
    ApplySearchReplaceRequest, SearchReplaceItem,
};

use super::resolve_path;
use super::search_replace::render_response;

pub struct FilePatchTool;

#[async_trait]
impl ToolExecutor for FilePatchTool {
    fn name(&self) -> &str {
        "file_patch"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "file_patch".into(),
            description: "Patch a file by exact-text replacement. Accepts either a single \
                          {old_string, new_string} pair OR a `replacements` array for atomic \
                          batch edits. Identical semantics to search_replace / \
                          multi_search_replace."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The path of the file to modify." },
                    "old_string": { "type": "string", "description": "Single-edit form: text to find." },
                    "new_string": { "type": "string", "description": "Single-edit form: replacement text." },
                    "replace_all": { "type": "boolean", "default": false, "description": "Single-edit form only." },
                    "replacements": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_string": { "type": "string" },
                                "new_string": { "type": "string" },
                                "replace_all": { "type": "boolean", "default": false },
                            },
                            "required": ["old_string", "new_string"],
                        },
                        "description": "Batch form: array of replacements."
                    }
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
        let resolved = resolve_path(path, ctx.workspace_root.as_deref())?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let raw_path = path.to_string();

        // Batch form takes priority when present.
        if let Some(arr) = input.get("replacements").and_then(Value::as_array) {
            if arr.is_empty() {
                return Err(ToolError::InvalidInput(
                    "`replacements` must be a non-empty array".into(),
                ));
            }
            let mut replacements = Vec::with_capacity(arr.len());
            for (idx, rep) in arr.iter().enumerate() {
                let old_string = rep
                    .get("old_string")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ToolError::InvalidInput(format!(
                            "Replacement {}: `old_string` is required",
                            idx + 1
                        ))
                    })?;
                if old_string.is_empty() {
                    return Err(ToolError::InvalidInput(format!(
                        "Replacement {}: `old_string` must not be empty",
                        idx + 1
                    )));
                }
                let new_string = rep
                    .get("new_string")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ToolError::InvalidInput(format!(
                            "Replacement {}: `new_string` is required",
                            idx + 1
                        ))
                    })?;
                let replace_all = rep
                    .get("replace_all")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                replacements.push(SearchReplaceItem {
                    old_string: old_string.to_string(),
                    new_string: new_string.to_string(),
                    replace_all,
                });
            }
            let response = apply_multi_search_replace(ApplyMultiSearchReplaceRequest {
                path: resolved_str.clone(),
                replacements,
                write: true,
            })
            .await
            .map_err(ToolError::Execution)?;
            return Ok(render_response(&raw_path, &resolved_str, response, true));
        }

        // Single-edit form.
        let old_string = input
            .get("old_string")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ToolError::InvalidInput(
                    "supply either `replacements` (array) or `old_string`+`new_string`".into(),
                )
            })?;
        if old_string.is_empty() {
            return Err(ToolError::InvalidInput(
                "`old_string` must not be empty".into(),
            ));
        }
        let new_string = input
            .get("new_string")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let replace_all = input
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let response = apply_search_replace(ApplySearchReplaceRequest {
            path: resolved_str.clone(),
            replacement: SearchReplaceItem {
                old_string: old_string.to_string(),
                new_string,
                replace_all,
            },
            write: true,
        })
        .await
        .map_err(ToolError::Execution)?;

        Ok(render_response(&raw_path, &resolved_str, response, false))
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
    async fn single_form_matches_search_replace() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "alpha\n").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FilePatchTool);
        let out = tool
            .execute(
                serde_json::json!({
                    "path": "a.txt",
                    "old_string": "alpha",
                    "new_string": "omega",
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(), "omega\n");
    }

    #[tokio::test]
    async fn batch_form_matches_multi_search_replace() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("b.txt"), "one\ntwo\n").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FilePatchTool);
        let out = tool
            .execute(
                serde_json::json!({
                    "path": "b.txt",
                    "replacements": [
                        { "old_string": "one", "new_string": "ONE" },
                        { "old_string": "two", "new_string": "TWO" }
                    ]
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(parsed["totalReplacements"], 2);
    }

    #[tokio::test]
    async fn rejects_empty_input() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(FilePatchTool);
        let err = tool
            .execute(serde_json::json!({ "path": "x" }), &ctx_for(None))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
