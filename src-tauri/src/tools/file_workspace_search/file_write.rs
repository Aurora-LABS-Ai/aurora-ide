//! `file_write` — overwrite (or create) a file with full contents.
//!
//! Wraps `crate::commands::write_file_content` (without going through
//! the Tauri IPC layer; we call the underlying `std::fs::write` plus
//! the file_cache invalidation directly so this tool is callable
//! from the Rust agent runtime). Mirrors the TS
//! `fileWriteExecutor` JSON response shape, omitting the
//! pending-changes UI plumbing (Sub-D's permission prompter is the
//! Rust-native equivalent).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::tools::shell_editor_todo::{FileChangedPayload, IdeEventSink};

use super::search_replace::diff_side;
use super::streaming_targets;
use super::{apply_write_conventions, detect_write_conventions, resolve_path_for_create};

pub struct FileWriteTool {
    sink: Arc<dyn IdeEventSink>,
}

impl FileWriteTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for FileWriteTool {
    fn name(&self) -> &str {
        "file_write"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "file_write".into(),
            description: format!(
                          "Create a new file or completely overwrite an existing one with the full \
                          content you supply. {rule} Creates parent \
                          directories automatically. `content` is REQUIRED — provide the entire \
                          file body. Use file_edit for targeted changes; set must_not_exist=true to \
                          fail instead of overwriting if the file already exists.",
                          rule = streaming_targets::RULE,
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    // FIRST, always — and it matters more here than anywhere
                    // else, because `content` is a whole file. Without this the
                    // row is unlabelled for the entire write.
                    streaming_targets::FIELD: streaming_targets::property(),
                    "path": { "type": "string", "description": "The full path of the file to write." },
                    "content": { "type": "string", "description": "The COMPLETE new content for the file (required)." },
                    "must_not_exist": { "type": "boolean", "default": false, "description": "When true, fail if the file already exists (create-only)." }
                },
                "required": ["path", "content"],
                "additionalProperties": false,
            }),
        }
    }

    /// Mutates the user's workspace — must consult the permission gate
    /// so the Settings → Tools `auto`/`always_ask`/`deny` mode is
    /// honoured (matches the legacy TS risk classification, where
    /// `file_write` was Medium-risk and required approval unless the
    /// user pre-approved it in Settings).
    fn requires_permission(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let path = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`path` must be a string".into()))?;
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`content` must be a string".into()))?
            .to_string();
        let must_not_exist = input
            .get("must_not_exist")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let resolved = resolve_path_for_create(path, ctx.workspace_root.as_deref())?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let raw_path = path.to_string();
        let bytes = content.len();

        // Detect Created vs Modified BEFORE writing. We need this for the
        // emit_file_changed payload; checking after the write is too late
        // (the file always exists by then). A racey `exists()` check is
        // fine — concurrent creators are not something the agent can
        // collide with here.
        let existed_before = Path::new(&resolved_str).exists();

        // Create-only guard (folds the old `file_create` tool's
        // "FAILS if the file already exists" contract into a flag).
        if must_not_exist && existed_before {
            return Ok(serde_json::to_string(&json!({
                "success": false,
                "error": format!("File already exists: {raw_path}. Omit must_not_exist to overwrite."),
                "path": raw_path,
                "fullPath": resolved_str,
            }))
            .unwrap());
        }

        let content_for_event = content.clone();
        let content_for_result = content.clone();
        // Returns the pre-write content (for the Review panel's diff). Empty when
        // the file is new. Read inside the same blocking task so there's no extra
        // hop and no TOCTOU window before the overwrite.
        let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
            let file_path = Path::new(&resolved_str);
            let old_content = if existed_before {
                std::fs::read_to_string(file_path).unwrap_or_default()
            } else {
                String::new()
            };
            if let Some(parent) = file_path.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create directories: {e}"))?;
                }
            }
            // Detect what convention the existing file uses (CRLF/LF
            // + UTF-8 BOM) and re-apply it to `content` BEFORE writing.
            // The LLM always emits LF + no BOM, so without this step
            // every overwrite on a Windows source file flips its
            // entire line-ending convention and shows up as a
            // file-wide diff in git.
            let (line_ending, bom) = detect_write_conventions(file_path);
            let bytes_to_write = apply_write_conventions(&content, line_ending, bom);
            std::fs::write(file_path, &bytes_to_write)
                .map_err(|e| format!("Failed to write file: {e}"))?;
            crate::file_cache::get_file_cache().invalidate(&resolved_str);
            Ok(old_content)
        })
        .await
        .map_err(|err| ToolError::Execution(format!("file_write task panicked: {err}")))?;

        match result {
            Ok(old_content) => {
                let old_normalized = old_content.replace("\r\n", "\n");
                let new_normalized = content_for_result.replace("\r\n", "\n");
                let (lines_added, lines_removed) =
                    line_change_counts(&old_normalized, &new_normalized);
                // Fire the IDE event so the open Monaco buffer + explorer +
                // pending-changes UI refresh. A `Created` kind is emitted
                // when the file did not exist before the write — this lets
                // the explorer add a tree node instead of just flagging a
                // modification, and lets the pending-changes panel show
                // "New file" instead of a diff against nothing.
                let payload = if existed_before {
                    FileChangedPayload::modified(
                        resolved.to_string_lossy().to_string(),
                        content_for_event,
                        "file_write",
                    )
                } else {
                    FileChangedPayload::created(
                        resolved.to_string_lossy().to_string(),
                        content_for_event,
                        "file_write",
                    )
                }
                .with_tool_call_id(ctx.tool_call_id.clone());

                // Soft-fail on emit error — the file is already safely on
                // disk, dropping the UI refresh is preferable to making the
                // tool look like it failed.
                if let Err(emit_err) = self.sink.emit_file_changed(&payload) {
                    eprintln!("[file_write] emit_file_changed failed for {raw_path}: {emit_err}");
                }

                // The agent now knows this file's exact content (it just
                // wrote it), so a follow-up file_edit should pass the
                // read-before-edit guard without a redundant read.
                super::read_tracker::record(&ctx.thread_id, &resolved.to_string_lossy());

                Ok(serde_json::to_string(&json!({
                    "success": true,
                    "pending": false,
                    "message": format!("File written: {raw_path}"),
                    "path": raw_path,
                    "fullPath": resolved.to_string_lossy(),
                    "bytes": bytes,
                    // Same names file_edit reports, so every modify tool's card
                    // gets its −removed/+added header counts. A brand-new file
                    // is all additions (green +N, no red side).
                    "linesAdded": lines_added,
                    "linesRemoved": lines_removed,
                    // Full before/after for the Review panel. Line endings are
                    // normalised to LF on both sides so a CRLF file doesn't render
                    // as an all-lines-changed diff.
                    "oldContent": diff_side(&old_normalized),
                    "newContent": diff_side(&new_normalized),
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

/// Line-change counts for a whole-file overwrite, matching what
/// `file_edit` reports so every modify tool's card header can show the
/// same −removed/+added pair.
///
/// The empty→content fast path matters twice over: it is the common case
/// (most `file_write` calls create new files), and it skips running a
/// diff whose answer is known — every line is an addition.
fn line_change_counts(old_content: &str, new_content: &str) -> (usize, usize) {
    // Same line split the agent window's `computeDiff` uses (a single trailing
    // newline is not its own line), so both ends state the same numbers. Diffing
    // raw text with `TextDiff::from_lines` would count a final line that merely
    // gained a trailing newline as one removal plus one addition.
    fn to_lines(text: &str) -> Vec<&str> {
        if text.is_empty() {
            return Vec::new();
        }
        let mut lines: Vec<&str> = text.split('\n').collect();
        if lines.last() == Some(&"") {
            lines.pop();
        }
        lines
    }

    let old_lines = to_lines(old_content);
    let new_lines = to_lines(new_content);
    if old_lines.is_empty() {
        return (new_lines.len(), 0);
    }
    if new_lines.is_empty() {
        return (0, old_lines.len());
    }
    let diff = similar::TextDiff::from_slices(&old_lines, &new_lines);
    let mut added = 0usize;
    let mut removed = 0usize;
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => added += 1,
            similar::ChangeTag::Delete => removed += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    (added, removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::tool_executor::ToolContext;
    use crate::tools::shell_editor_todo::{
        FileChangeKind, NoopIdeEventSink, RecordedEvent, RecordingIdeEventSink,
    };
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn ctx_for(workspace: Option<std::path::PathBuf>) -> ToolContext {
        ToolContext {
            allow_outside_workspace: false,
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: workspace,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    fn noop_tool() -> FileWriteTool {
        FileWriteTool::new(Arc::new(NoopIdeEventSink))
    }

    /// `file_write` is the tool this matters most for: `content` is an entire
    /// file, so a late filename leaves the row unlabelled for the whole write.
    /// It carried no announce field at all until 2026-08-20 — only prose.
    #[test]
    fn announces_its_target_before_the_body() {
        let schema = noop_tool().schema();
        let properties = schema.input_schema["properties"]
            .as_object()
            .expect("properties object");
        assert_eq!(
            properties.keys().next().map(String::as_str),
            Some(streaming_targets::FIELD),
        );
        // Both tools state the ordering rule in the same words, from the same
        // constant. Two tools wording it differently is what this replaced.
        assert!(schema.description.contains(streaming_targets::RULE));
    }

    #[test]
    fn schema_serializes_path_before_content() {
        let schema = noop_tool().schema();
        let keys = schema.input_schema["properties"]
            .as_object()
            .expect("properties object")
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        // Two things name the file, and both precede the body: the announce
        // field (which survives a model sorting its keys) and `path` itself.
        assert_eq!(keys.first(), Some(&streaming_targets::FIELD));
        assert_eq!(keys.get(1), Some(&"path"));
        assert_eq!(keys.get(2), Some(&"content"));
    }

    #[tokio::test]
    async fn writes_new_file_inside_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(noop_tool());
        let result = tool
            .execute(
                serde_json::json!({ "path": "out.txt", "content": "hi" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("out.txt")).unwrap(),
            "hi"
        );
    }

    #[tokio::test]
    async fn a_new_file_reports_every_line_as_added() {
        let tmp = tempfile::tempdir().unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(noop_tool());
        let result = tool
            .execute(
                serde_json::json!({ "path": "fresh.txt", "content": "one\ntwo\nthree" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["linesAdded"], 3);
        assert_eq!(parsed["linesRemoved"], 0);
    }

    #[tokio::test]
    async fn an_overwrite_reports_real_line_change_counts() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("pre.txt"), "one\ntwo\nthree").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(noop_tool());
        let result = tool
            .execute(
                serde_json::json!({ "path": "pre.txt", "content": "one\nTWO\nthree\nfour" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        // "two" → "TWO" is one removal + one addition; "four" is a pure addition.
        assert_eq!(parsed["linesAdded"], 2);
        assert_eq!(parsed["linesRemoved"], 1);
    }

    #[tokio::test]
    async fn rejects_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(noop_tool());
        let err = tool
            .execute(
                serde_json::json!({ "path": "../escape.txt", "content": "hi" }),
                &ctx_for(Some(workspace)),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PolicyViolation(_)));
    }

    #[tokio::test]
    async fn emits_created_for_new_file() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = RecordingIdeEventSink::new();
        let tool = FileWriteTool::new(sink.clone());
        tool.execute(
            serde_json::json!({ "path": "fresh.txt", "content": "hello" }),
            &ctx_for(Some(tmp.path().to_path_buf())),
        )
        .await
        .expect("ok");

        let events = sink.events();
        let file_event = events
            .iter()
            .find(|e| matches!(e, RecordedEvent::FileChanged(_)))
            .expect("emitted file_changed");
        match file_event {
            RecordedEvent::FileChanged(p) => {
                assert_eq!(p.kind, FileChangeKind::Created);
                assert_eq!(p.content.as_deref(), Some("hello"));
                assert!(!p.is_directory);
                assert_eq!(p.source_tool.as_deref(), Some("file_write"));
                assert_eq!(p.tool_call_id.as_deref(), Some("c"));
            }
            _ => unreachable!(),
        }
    }

    #[tokio::test]
    async fn emits_modified_for_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("pre.txt"), "before").unwrap();
        let sink = RecordingIdeEventSink::new();
        let tool = FileWriteTool::new(sink.clone());
        tool.execute(
            serde_json::json!({ "path": "pre.txt", "content": "after" }),
            &ctx_for(Some(tmp.path().to_path_buf())),
        )
        .await
        .expect("ok");

        let events = sink.events();
        let file_event = events
            .iter()
            .find(|e| matches!(e, RecordedEvent::FileChanged(_)))
            .expect("emitted file_changed");
        match file_event {
            RecordedEvent::FileChanged(p) => {
                assert_eq!(p.kind, FileChangeKind::Modified);
                assert_eq!(p.content.as_deref(), Some("after"));
            }
            _ => unreachable!(),
        }
    }
}
