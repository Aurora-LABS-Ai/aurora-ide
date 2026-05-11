//! `search_replace` — single find-and-replace edit on one file.
//!
//! Wraps `crate::commands::editor_ops::apply_search_replace` with
//! `write: true`, then renders the result into the same JSON shape
//! the TS `searchReplaceExecutor` produces (success + replacement
//! count, or one of the structured `not_found` / `not_unique` /
//! `overlap` failures).

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::commands::editor_ops::{
    apply_search_replace, ApplySearchReplaceRequest, SearchReplaceItem, SearchReplaceResponse,
};

use super::resolve_path;

pub struct SearchReplaceTool;

#[async_trait]
impl ToolExecutor for SearchReplaceTool {
    fn name(&self) -> &str {
        "search_replace"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "search_replace".into(),
            description: "Find and replace exact text in a file. Line endings are normalised \
                          automatically. old_string must be unique unless replace_all=true."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The path of the file to modify." },
                    "old_string": { "type": "string", "description": "Exact text to find." },
                    "new_string": { "type": "string", "description": "Replacement text. May be empty to delete old_string." },
                    "replace_all": { "type": "boolean", "default": false, "description": "Replace every occurrence." }
                },
                "required": ["path", "old_string", "new_string"],
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
        let old_string = input
            .get("old_string")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`old_string` is required".into()))?;
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

        let resolved = resolve_path(path, ctx.workspace_root.as_deref())?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let raw_path = path.to_string();

        let request = ApplySearchReplaceRequest {
            path: resolved_str.clone(),
            replacement: SearchReplaceItem {
                old_string: old_string.to_string(),
                new_string,
                replace_all,
            },
            write: true,
        };

        let response = apply_search_replace(request)
            .await
            .map_err(ToolError::Execution)?;

        Ok(render_response(&raw_path, &resolved_str, response, false))
    }
}

/// Render a [`SearchReplaceResponse`] in the same JSON shape the TS
/// executor produces. `multi` selects between the single- and
/// batch-failure phrasings.
pub(crate) fn render_response(
    raw_path: &str,
    full_path: &str,
    response: SearchReplaceResponse,
    multi: bool,
) -> String {
    match response {
        SearchReplaceResponse::Ok {
            line_ending_normalized,
            lines_added,
            lines_removed,
            total_replacements,
            replacement_details,
            ..
        } => {
            let mut payload = json!({
                "success": true,
                "pending": false,
                "message": format!("Replaced {total_replacements} occurrence(s) in {raw_path}"),
                "path": raw_path,
                "fullPath": full_path,
                "replacements": total_replacements,
                "totalReplacements": total_replacements,
                "linesAdded": lines_added,
                "linesRemoved": lines_removed,
                "lineEndingNormalized": line_ending_normalized,
            });
            if multi {
                payload["replacementsRequested"] = json!(replacement_details.len());
                payload["results"] = json!(replacement_details
                    .iter()
                    .map(|d| json!({
                        "index": d.index,
                        "occurrences": d.occurrences,
                        "replaced": d.replaced,
                    }))
                    .collect::<Vec<_>>());
            }
            serde_json::to_string(&payload).unwrap()
        }
        SearchReplaceResponse::NotFound { failed_at } => {
            let error = if multi {
                format!(
                    "Replacement {failed_at}: Could not find the specified text in the original file snapshot."
                )
            } else {
                format!(
                    "Could not find the specified text in {raw_path}. Line endings are handled automatically; check indentation or surrounding context."
                )
            };
            serde_json::to_string(&json!({
                "success": false,
                "error": error,
                "path": raw_path,
                "fullPath": full_path,
                "failedAt": failed_at,
                "hint": if multi {
                    "The text still needs to match the current file content exactly."
                } else {
                    "Add more surrounding code to old_string to make it unique in the file."
                },
            }))
            .unwrap()
        }
        SearchReplaceResponse::NotUnique {
            failed_at,
            occurrences,
        } => {
            let error = if multi {
                format!("Replacement {failed_at}: Found {occurrences} occurrences. Either include more context or set replace_all=true.")
            } else {
                format!("Found {occurrences} occurrences of the text. The old_string must be unique. Either include more context or set replace_all=true.")
            };
            serde_json::to_string(&json!({
                "success": false,
                "error": error,
                "path": raw_path,
                "fullPath": full_path,
                "failedAt": failed_at,
                "occurrences": occurrences,
                "hint": "Disambiguate via more context or replace_all.",
            }))
            .unwrap()
        }
        SearchReplaceResponse::Overlap {
            failed_at,
            conflicting_replacement,
        } => serde_json::to_string(&json!({
            "success": false,
            "error": format!(
                "Replacement {failed_at} overlaps with replacement {conflicting_replacement}. Combine nearby edits."
            ),
            "path": raw_path,
            "fullPath": full_path,
            "failedAt": failed_at,
            "conflictingReplacement": conflicting_replacement,
            "hint": "Batch edits can target the same file, but their matched regions cannot overlap.",
        }))
        .unwrap(),
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
    async fn replaces_unique_match() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "hello world\n").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(SearchReplaceTool);
        let result = tool
            .execute(
                serde_json::json!({
                    "path": "a.txt",
                    "old_string": "world",
                    "new_string": "universe",
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], true);
        let on_disk = std::fs::read_to_string(tmp.path().join("a.txt")).unwrap();
        assert_eq!(on_disk, "hello universe\n");
    }

    #[tokio::test]
    async fn reports_not_found_as_structured_failure() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "hello\n").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(SearchReplaceTool);
        let result = tool
            .execute(
                serde_json::json!({
                    "path": "a.txt",
                    "old_string": "xyz",
                    "new_string": "qqq",
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("Could not find"));
    }
}
