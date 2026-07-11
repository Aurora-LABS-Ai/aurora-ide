//! `file_edit` — the one surgical editor. Exact-text find-and-replace,
//! single or batch, atomic.
//!
//! This is the unified replacement for the old `search_replace` /
//! `multi_search_replace` / `file_patch` trio: one tool, two shapes.
//! "Search and replace" names the *mechanism*; "edit" names the
//! *intent* — they are the same operation, so we expose one door.
//! The backing engine is unchanged: it still calls
//! `crate::commands::editor_ops::apply_search_replace` /
//! `apply_multi_search_replace` and renders results via the shared
//! [`super::search_replace`] helpers, so matching, uniqueness,
//! `replace_all`, atomic rollback, and the Review-panel diff payload
//! all behave exactly as before.
//!
//! ## Read-before-edit guard
//!
//! A surgical edit matches an exact `old_string` the agent must have
//! seen. So `file_edit` refuses to touch a file the agent never read
//! (or wrote) this session — see [`super::read_tracker`]. The refusal
//! is a graceful `success:false` with a corrective hint, so the model
//! simply reads the file and retries rather than hard-failing the turn.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::commands::editor_ops::{
    apply_multi_search_replace, apply_search_replace, ApplyMultiSearchReplaceRequest,
    ApplySearchReplaceRequest, SearchReplaceItem, SearchReplaceResponse,
};
use crate::tools::shell_editor_todo::IdeEventSink;

use super::resolve_path;
use super::search_replace::{diff_side, emit_post_write, render_response};

pub struct FileEditTool {
    sink: Arc<dyn IdeEventSink>,
}

impl FileEditTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for FileEditTool {
    fn name(&self) -> &str {
        "file_edit"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "file_edit".into(),
            description: "Edit files by exact-text find-and-replace. \
                          Single edit: pass path + old_string + new_string. \
                          Many edits to ONE file: pass `edits` (an array) plus the top-level `path`. \
                          Edits across MULTIPLE files in ONE call: give each item in `edits` its own \
                          `path` (the top-level `path` becomes the default for items that omit it). \
                          The whole batch is atomic — every edit applies against its file's original \
                          snapshot, and if any edit fails NO file is changed. old_string must match \
                          exactly and be unique unless replace_all=true. Read each file with \
                          file_read first."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The file to edit. Required for the single-edit form; in the batch form it is the DEFAULT path for edits that don't set their own." },
                    "old_string": { "type": "string", "description": "Single-edit form: exact text to find." },
                    "new_string": { "type": "string", "description": "Single-edit form: replacement text (may be empty to delete)." },
                    "replace_all": { "type": "boolean", "default": false, "description": "Single-edit form: replace every occurrence." },
                    "edits": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string", "description": "Optional file for THIS edit. Defaults to the top-level `path`. Set it to edit several files in one call." },
                                "old_string": { "type": "string" },
                                "new_string": { "type": "string" },
                                "replace_all": { "type": "boolean", "default": false },
                            },
                            "required": ["old_string", "new_string"],
                        },
                        "description": "Batch form: array of edits, applied atomically across all targeted files. Matched regions in the same file must not overlap."
                    }
                },
                "required": [],
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

        // `path` is the DEFAULT file for every edit. It's optional now: a batch
        // whose items each carry their own `path` can omit it (multi-file form).
        let top_path = input.get("path").and_then(Value::as_str);

        // Batch form takes priority when present. Accept `edits` (the canonical
        // key) or `replacements` (back-compat alias). Each item may name its own
        // `path`; items without one fall back to the top-level `path`.
        let batch = input
            .get("edits")
            .and_then(Value::as_array)
            .or_else(|| input.get("replacements").and_then(Value::as_array));

        if let Some(arr) = batch {
            if arr.is_empty() {
                return Err(ToolError::InvalidInput(
                    "`edits` must be a non-empty array".into(),
                ));
            }
            return self.run_batch(arr, top_path, ctx).await;
        }

        // Single-edit form — requires a top-level `path`.
        let path =
            top_path.ok_or_else(|| ToolError::InvalidInput(missing_path_message(&input)))?;
        let resolved = resolve_path(path, ctx.workspace_root.as_deref())?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let raw_path = path.to_string();

        // Read-before-edit guard. `resolve_path` already proved the file
        // exists (it canonicalizes), so the only question is whether the
        // agent has seen it this session. If not, refuse gracefully with a
        // corrective hint instead of patching against content it guessed.
        if !super::read_tracker::was_seen(&ctx.session_id, &resolved_str) {
            return Ok(needs_read_json(&raw_path, &resolved_str));
        }

        let old_string = input
            .get("old_string")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ToolError::InvalidInput(
                    "supply either `edits` (array) or `old_string`+`new_string`".into(),
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

        if matches!(response, SearchReplaceResponse::Ok { .. }) {
            emit_post_write(&*self.sink, &resolved_str, "file_edit", &ctx.tool_call_id).await;
            super::read_tracker::record(&ctx.session_id, &resolved_str);
        }

        let _ = Path::new("");
        Ok(render_response(&raw_path, &resolved_str, response, false))
    }
}

impl FileEditTool {
    /// Run the batch (`edits[]`) form. Edits are grouped by their resolved
    /// file — one file, or many — and applied **atomically across every
    /// file**: all edits are validated against their original snapshots
    /// first (no disk writes), and only if every file plans cleanly do we
    /// commit. A single failure leaves the whole workspace untouched, so the
    /// contract is identical whether the agent edits one file or ten.
    async fn run_batch(
        &self,
        arr: &[Value],
        top_path: Option<&str>,
        ctx: &ToolContext,
    ) -> Result<String, ToolError> {
        // Build per-file groups, preserving first-seen order so the result
        // lists files in the order the agent wrote them.
        let mut groups: Vec<FileGroup> = Vec::new();
        let mut index_by_resolved: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();

        for (idx, rep) in arr.iter().enumerate() {
            let n = idx + 1;
            let raw_path = rep
                .get("path")
                .and_then(Value::as_str)
                .or(top_path)
                .ok_or_else(|| {
                    ToolError::InvalidInput(format!(
                        "Edit {n}: no `path`. Set `path` on this edit item, or provide a \
                         top-level `path` that all edits share."
                    ))
                })?;
            let old_string = rep.get("old_string").and_then(Value::as_str).ok_or_else(|| {
                ToolError::InvalidInput(format!("Edit {n}: `old_string` is required"))
            })?;
            if old_string.is_empty() {
                return Err(ToolError::InvalidInput(format!(
                    "Edit {n}: `old_string` must not be empty"
                )));
            }
            let new_string = rep.get("new_string").and_then(Value::as_str).ok_or_else(|| {
                ToolError::InvalidInput(format!("Edit {n}: `new_string` is required"))
            })?;
            let replace_all = rep
                .get("replace_all")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            let resolved = resolve_path(raw_path, ctx.workspace_root.as_deref())?;
            let resolved_str = resolved.to_string_lossy().to_string();
            let item = SearchReplaceItem {
                old_string: old_string.to_string(),
                new_string: new_string.to_string(),
                replace_all,
            };

            match index_by_resolved.get(&resolved_str) {
                Some(&i) => groups[i].items.push(item),
                None => {
                    index_by_resolved.insert(resolved_str.clone(), groups.len());
                    groups.push(FileGroup {
                        raw: raw_path.to_string(),
                        resolved: resolved_str,
                        items: vec![item],
                    });
                }
            }
        }

        let multi = groups.len() > 1;

        // Read-before-edit guard, per file. Abort the whole batch (write
        // nothing) if any target hasn't been read this session.
        for g in &groups {
            if !super::read_tracker::was_seen(&ctx.session_id, &g.resolved) {
                return Ok(if multi {
                    render_multi_needs_read(&g.raw, &g.resolved)
                } else {
                    needs_read_json(&g.raw, &g.resolved)
                });
            }
        }

        // Phase 1 — validate every file with write:false. One failure aborts
        // the batch before any disk write.
        for g in &groups {
            let resp = apply_multi_search_replace(ApplyMultiSearchReplaceRequest {
                path: g.resolved.clone(),
                replacements: g.items.clone(),
                write: false,
            })
            .await
            .map_err(ToolError::Execution)?;
            if !matches!(resp, SearchReplaceResponse::Ok { .. }) {
                return Ok(if multi {
                    render_multi_failure(&g.raw, &g.resolved, resp)
                } else {
                    render_response(&g.raw, &g.resolved, resp, true)
                });
            }
        }

        // Phase 2 — commit. Every file planned cleanly, so each write re-runs
        // the (cached) plan and persists it.
        let mut committed: Vec<(String, String, SearchReplaceResponse)> =
            Vec::with_capacity(groups.len());
        for g in groups {
            let resp = apply_multi_search_replace(ApplyMultiSearchReplaceRequest {
                path: g.resolved.clone(),
                replacements: g.items.clone(),
                write: true,
            })
            .await
            .map_err(ToolError::Execution)?;
            if matches!(resp, SearchReplaceResponse::Ok { .. }) {
                emit_post_write(&*self.sink, &g.resolved, "file_edit", &ctx.tool_call_id).await;
                super::read_tracker::record(&ctx.session_id, &g.resolved);
            }
            committed.push((g.raw, g.resolved, resp));
        }

        if committed.len() == 1 {
            let (raw, resolved, resp) = committed.into_iter().next().unwrap();
            return Ok(render_response(&raw, &resolved, resp, true));
        }
        Ok(render_multi_success(&committed))
    }
}

/// One target file plus the ordered edits destined for it.
struct FileGroup {
    /// The path exactly as the agent wrote it (for messages / UI).
    raw: String,
    /// The canonical on-disk path (grouping key + write target).
    resolved: String,
    items: Vec<SearchReplaceItem>,
}

/// The graceful "read this file first" refusal used by the single-file paths.
fn needs_read_json(raw_path: &str, resolved_str: &str) -> String {
    serde_json::to_string(&json!({
        "success": false,
        "error": format!(
            "Read {raw_path} with file_read before editing it. file_edit matches exact text, \
             so the file must be read in this session first."
        ),
        "path": raw_path,
        "fullPath": resolved_str,
        "hint": "Call file_read on this path, then retry the edit.",
        "needsRead": true,
    }))
    .unwrap()
}

/// Multi-file variant of the read-before-edit refusal — names the offending
/// file and makes clear nothing was written.
fn render_multi_needs_read(raw_path: &str, resolved_str: &str) -> String {
    serde_json::to_string(&json!({
        "success": false,
        "multiFile": true,
        "error": format!(
            "Read {raw_path} with file_read before editing it. All files in a batch must be \
             read this session first — no files were changed."
        ),
        "path": raw_path,
        "fullPath": resolved_str,
        "hint": "Call file_read on this path, then retry the batch.",
        "needsRead": true,
    }))
    .unwrap()
}

/// Render a validation failure for a multi-file batch. Nothing was written;
/// the message names the file and the 1-based edit that failed within it.
fn render_multi_failure(raw_path: &str, full_path: &str, response: SearchReplaceResponse) -> String {
    let (error, failed_at, occurrences) = match response {
        SearchReplaceResponse::NotFound { failed_at } => (
            format!(
                "{raw_path} (edit {failed_at}): could not find the specified text. Line endings \
                 are handled automatically; check indentation or surrounding context."
            ),
            failed_at,
            None,
        ),
        SearchReplaceResponse::NotUnique {
            failed_at,
            occurrences,
        } => (
            format!(
                "{raw_path} (edit {failed_at}): found {occurrences} occurrences. Add more context \
                 or set replace_all=true."
            ),
            failed_at,
            Some(occurrences),
        ),
        SearchReplaceResponse::Overlap {
            failed_at,
            conflicting_replacement,
        } => (
            format!(
                "{raw_path} (edit {failed_at}): overlaps edit {conflicting_replacement} in the \
                 same file. Combine the nearby edits."
            ),
            failed_at,
            None,
        ),
        // Unreachable: only non-Ok responses reach here.
        SearchReplaceResponse::Ok { .. } => ("unexpected success".to_string(), 0, None),
    };
    serde_json::to_string(&json!({
        "success": false,
        "multiFile": true,
        "error": error,
        "failedPath": raw_path,
        "fullPath": full_path,
        "failedAt": failed_at,
        "occurrences": occurrences,
        "hint": "No files were changed — a batch applies to every file or none. Fix this edit and retry.",
    }))
    .unwrap()
}

/// Render a successful multi-file batch. Each entry carries its own before/after
/// (capped per side via [`diff_side`]) so the Review panel can draw a real diff
/// for every file the call touched.
fn render_multi_success(committed: &[(String, String, SearchReplaceResponse)]) -> String {
    let mut files = Vec::with_capacity(committed.len());
    let mut total_replacements = 0usize;
    let mut total_added = 0usize;
    let mut total_removed = 0usize;

    for (raw, full, resp) in committed {
        if let SearchReplaceResponse::Ok {
            original_content,
            new_content,
            lines_added,
            lines_removed,
            total_replacements: reps,
            ..
        } = resp
        {
            total_replacements += *reps;
            total_added += *lines_added;
            total_removed += *lines_removed;
            files.push(json!({
                "path": raw,
                "fullPath": full,
                "success": true,
                "totalReplacements": reps,
                "linesAdded": lines_added,
                "linesRemoved": lines_removed,
                "oldContent": diff_side(original_content),
                "newContent": diff_side(new_content),
            }));
        }
    }

    let file_count = files.len();
    serde_json::to_string(&json!({
        "success": true,
        "pending": false,
        "multiFile": true,
        "message": format!(
            "Edited {file_count} file{} ({total_replacements} replacement{})",
            if file_count == 1 { "" } else { "s" },
            if total_replacements == 1 { "" } else { "s" },
        ),
        "filesEdited": file_count,
        "totalReplacements": total_replacements,
        "linesAdded": total_added,
        "linesRemoved": total_removed,
        "files": files,
    }))
    .unwrap()
}

/// Build a corrective message for a missing `path` in the single-edit form.
///
/// The batch form is handled in [`FileEditTool::run_batch`] (which accepts a
/// per-item `path`), so this is only reached when the caller passed
/// `old_string`/`new_string` at the top level without naming a file.
fn missing_path_message(_input: &Value) -> String {
    "Missing required `path` (string): the file to edit. For the single-edit form pass \
     path + old_string + new_string; for a batch pass `edits` (each item may carry its own \
     `path` to edit multiple files in one call)."
        .into()
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
            allow_outside_workspace: false,
            cancel_token: CancellationToken::new(),
        }
    }

    /// Seed the read-tracker as if the agent had read the file, so the
    /// guard lets the edit through. Mirrors what file_read does in prod.
    fn mark_read(ctx: &ToolContext, abs: &std::path::Path) {
        let canonical = dunce::canonicalize(abs).unwrap();
        super::super::read_tracker::record(&ctx.session_id, &canonical.to_string_lossy());
    }

    #[tokio::test]
    async fn single_form_replaces_text() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a.txt");
        std::fs::write(&file, "alpha\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &file);
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let out = tool
            .execute(
                serde_json::json!({ "path": "a.txt", "old_string": "alpha", "new_string": "omega" }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "omega\n");
    }

    #[tokio::test]
    async fn batch_form_applies_all_edits() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("b.txt");
        std::fs::write(&file, "one\ntwo\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &file);
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let out = tool
            .execute(
                serde_json::json!({
                    "path": "b.txt",
                    "edits": [
                        { "old_string": "one", "new_string": "ONE" },
                        { "old_string": "two", "new_string": "TWO" }
                    ]
                }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(parsed["totalReplacements"], 2);
    }

    #[tokio::test]
    async fn replacements_alias_still_works() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("c.txt");
        std::fs::write(&file, "x\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &file);
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let out = tool
            .execute(
                serde_json::json!({
                    "path": "c.txt",
                    "replacements": [ { "old_string": "x", "new_string": "y" } ]
                }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
    }

    #[test]
    fn missing_path_single_form_is_helpful() {
        let input = serde_json::json!({ "old_string": "x", "new_string": "y" });
        let msg = missing_path_message(&input);
        assert!(msg.contains("the file to edit"), "got: {msg}");
        assert!(msg.contains("edit multiple files"), "got: {msg}");
    }

    #[tokio::test]
    async fn batch_edits_multiple_files_atomically() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.txt");
        let b = tmp.path().join("b.txt");
        std::fs::write(&a, "alpha\n").unwrap();
        std::fs::write(&b, "beta\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &a);
        mark_read(&ctx, &b);
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let out = tool
            .execute(
                serde_json::json!({
                    "edits": [
                        { "path": "a.txt", "old_string": "alpha", "new_string": "ALPHA" },
                        { "path": "b.txt", "old_string": "beta", "new_string": "BETA" }
                    ]
                }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(parsed["multiFile"], true);
        assert_eq!(parsed["filesEdited"], 2);
        assert_eq!(parsed["totalReplacements"], 2);
        let files = parsed["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "ALPHA\n");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "BETA\n");
    }

    #[tokio::test]
    async fn batch_multi_file_is_atomic_on_failure() {
        // File a's edit is valid; file b's old_string is absent. The whole
        // batch must roll back — a stays untouched.
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.txt");
        let b = tmp.path().join("b.txt");
        std::fs::write(&a, "alpha\n").unwrap();
        std::fs::write(&b, "beta\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &a);
        mark_read(&ctx, &b);
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let out = tool
            .execute(
                serde_json::json!({
                    "edits": [
                        { "path": "a.txt", "old_string": "alpha", "new_string": "ALPHA" },
                        { "path": "b.txt", "old_string": "NOPE", "new_string": "x" }
                    ]
                }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert_eq!(parsed["multiFile"], true);
        assert_eq!(parsed["failedPath"], "b.txt");
        // Neither file changed.
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "alpha\n");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "beta\n");
    }

    #[tokio::test]
    async fn batch_edits_default_to_top_level_path() {
        // No per-item path → all edits fall back to the top-level `path`, so a
        // single-file result (not the multiFile shape) comes back.
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("s.txt");
        std::fs::write(&file, "one two\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &file);
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let out = tool
            .execute(
                serde_json::json!({
                    "path": "s.txt",
                    "edits": [
                        { "old_string": "one", "new_string": "1" },
                        { "old_string": "two", "new_string": "2" }
                    ]
                }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert!(parsed.get("multiFile").is_none());
        assert_eq!(parsed["totalReplacements"], 2);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "1 2\n");
    }

    #[tokio::test]
    async fn blocks_edit_without_prior_read() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("unseen.txt");
        std::fs::write(&file, "data\n").unwrap();
        // Note: NO mark_read — the guard must refuse.
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let out = tool
            .execute(
                serde_json::json!({ "path": "unseen.txt", "old_string": "data", "new_string": "x" }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert_eq!(parsed["needsRead"], true);
        // File must be untouched.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "data\n");
    }
}
