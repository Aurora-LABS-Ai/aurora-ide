//! `multi_search_replace` — atomic batch find-and-replace.
//!
//! Wraps `crate::commands::editor_ops::apply_multi_search_replace`
//! with `write: true`. All replacements share the original file
//! snapshot and either all apply or none do.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::commands::editor_ops::{
    apply_multi_search_replace, ApplyMultiSearchReplaceRequest, SearchReplaceItem,
    SearchReplaceResponse,
};
use crate::tools::shell_editor_todo::IdeEventSink;

use super::resolve_path;
use super::search_replace::{emit_post_write, render_response};

pub struct MultiSearchReplaceTool {
    sink: Arc<dyn IdeEventSink>,
}

impl MultiSearchReplaceTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for MultiSearchReplaceTool {
    fn name(&self) -> &str {
        "multi_search_replace"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "multi_search_replace".into(),
            description: "Apply MULTIPLE find-and-replace edits to a file in a single atomic call. \
                          All replacements are matched against the original snapshot. If any \
                          replacement fails, the entire operation rolls back."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The path of the file to modify." },
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
                        "description": "Array of replacements. Regions must not overlap."
                    }
                },
                "required": ["path", "replacements"],
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
        let raw_replacements = input
            .get("replacements")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ToolError::InvalidInput(
                    "`replacements` must be a non-empty array of {old_string, new_string} objects"
                        .into(),
                )
            })?;
        if raw_replacements.is_empty() {
            return Err(ToolError::InvalidInput(
                "`replacements` must be a non-empty array".into(),
            ));
        }

        let mut replacements = Vec::with_capacity(raw_replacements.len());
        for (idx, rep) in raw_replacements.iter().enumerate() {
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

        let resolved = resolve_path(path, ctx.workspace_root.as_deref())?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let raw_path = path.to_string();

        let response = apply_multi_search_replace(ApplyMultiSearchReplaceRequest {
            path: resolved_str.clone(),
            replacements,
            write: true,
        })
        .await
        .map_err(ToolError::Execution)?;

        if matches!(response, SearchReplaceResponse::Ok { .. }) {
            emit_post_write(
                &*self.sink,
                &resolved_str,
                "multi_search_replace",
                &ctx.tool_call_id,
            )
            .await;
        }

        Ok(render_response(&raw_path, &resolved_str, response, true))
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
    async fn applies_two_replacements_atomically() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("f.rs"), "let a = 1;\nlet b = 2;\n").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(MultiSearchReplaceTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let result = tool
            .execute(
                serde_json::json!({
                    "path": "f.rs",
                    "replacements": [
                        { "old_string": "let a = 1;", "new_string": "let a = 100;" },
                        { "old_string": "let b = 2;", "new_string": "let b = 200;" }
                    ]
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(parsed["totalReplacements"], 2);
        let on_disk = std::fs::read_to_string(tmp.path().join("f.rs")).unwrap();
        assert_eq!(on_disk, "let a = 100;\nlet b = 200;\n");
    }

    #[tokio::test]
    async fn rejects_empty_replacement_array() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(MultiSearchReplaceTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let err = tool
            .execute(
                serde_json::json!({ "path": "any.txt", "replacements": [] }),
                &ctx_for(None),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
