//! Read before you change: the one rule `file_write` and `file_edit` share.
//!
//! An agent may not overwrite or edit a file that already has content until
//! this conversation has seen some of it. Any part counts — a `file_read` of
//! lines 1–30, a `grep` that returned one of its lines, a `code` search
//! passage. Every one of those tells the agent the file exists and how big it
//! is (`"Returned lines 1-14 of 1990"`), which is exactly what a blind writer
//! lacks.
//!
//! Why it exists: on 2026-10-25 an agent wanted to add a lesson to
//! `.knowledge/lesson.md`, assumed the file was new, and called `file_write`.
//! It replaced 2,005 lines with 12. The file was git-ignored, so nothing could
//! bring it back. The chat had never read the file — one read of any part
//! would have shown "of 1990" and sent it to `file_edit` instead.
//!
//! The 2026-08-11 version of this rule (gate every `file_edit` on a
//! `file_read`) was narrowed because it refused correct edits whose text came
//! from a `grep` hit. That gap is closed here instead of by dropping the rule:
//! search results that show a file's lines mark it as seen ([`record_shown`]).
//!
//! What stays allowed without a read: creating a file, and writing over an
//! empty one. Neither can lose anything.

use std::path::Path;

use serde_json::{json, Value};

use crate::agent_runtime::tool_executor::ToolContext;

use super::read_tracker;

/// Which tool is asking, so the refusal names the right next step.
#[derive(Clone, Copy)]
pub(crate) enum Change {
    Write,
    Edit,
}

/// The refusal for changing `resolved` when it holds content this chat has not
/// seen, or `None` when the change may go ahead.
///
/// Costs nothing when the file was seen. Otherwise it reads the file once off
/// the async runtime to count its lines, because the count is the fact the
/// agent was missing.
pub(crate) async fn refuse_unread(
    ctx: &ToolContext,
    change: Change,
    raw_path: &str,
    resolved: &str,
) -> Option<Value> {
    if read_tracker::was_seen(&ctx.thread_id, resolved) {
        return None;
    }
    let path = resolved.to_string();
    let lines = tokio::task::spawn_blocking(move || existing_line_count(Path::new(&path)))
        .await
        .ok()
        .flatten()?;
    Some(refusal(change, raw_path, resolved, lines))
}

/// Lines in an existing, non-empty file; `None` for a missing or empty one.
fn existing_line_count(path: &Path) -> Option<usize> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
    Some(if bytes.ends_with(b"\n") { newlines } else { newlines + 1 })
}

fn refusal(change: Change, raw_path: &str, resolved: &str, lines: usize) -> Value {
    let size = if lines == 1 { "1 line".to_string() } else { format!("{lines} lines") };
    let (error, hint) = match change {
        Change::Write => (
            format!(
                "{raw_path} already exists ({size}) and this chat has not read any of it. \
                 Nothing was written: file_write would have replaced all {size}."
            ),
            "To add to the file, use file_edit. To replace it on purpose, read it first \
             (any part is enough) so you know what you are replacing, then write again."
                .to_string(),
        ),
        Change::Edit => (
            format!(
                "{raw_path} ({size}) has not been read in this chat. Nothing was changed."
            ),
            "Read the part you mean to change with file_read (a grep or code search that \
             returned its lines also counts), then send the edit with text copied from it."
                .to_string(),
        ),
    };
    json!({
        "success": false,
        "error": error,
        "path": raw_path,
        "fullPath": resolved,
        "lines": lines,
        "hint": hint,
        "needsRead": true,
    })
}

/// Mark files whose lines a search result put in front of the agent as seen.
///
/// `paths` are as the search reported them — absolute, or relative to the
/// workspace. Each goes through the same resolver `file_edit` uses, so both
/// sides agree on the key however the path was spelled. A path that does not
/// resolve is skipped: it cannot be edited either.
pub(crate) fn record_shown<'a>(ctx: &ToolContext, paths: impl IntoIterator<Item = &'a str>) {
    let mut done = std::collections::HashSet::new();
    for raw in paths {
        if !done.insert(raw) {
            continue;
        }
        if let Ok(resolved) = super::resolve_path_with_access(
            raw,
            ctx.workspace_root.as_deref(),
            ctx.workspace_access,
        ) {
            read_tracker::record(&ctx.thread_id, &resolved.to_string_lossy());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_lines_with_and_without_a_final_newline() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.md");
        let b = tmp.path().join("b.md");
        let empty = tmp.path().join("empty.md");
        std::fs::write(&a, "one\ntwo\n").unwrap();
        std::fs::write(&b, "one\ntwo").unwrap();
        std::fs::write(&empty, "").unwrap();
        assert_eq!(existing_line_count(&a), Some(2));
        assert_eq!(existing_line_count(&b), Some(2));
        assert_eq!(existing_line_count(&empty), None);
        assert_eq!(existing_line_count(&tmp.path().join("missing.md")), None);
    }

    #[test]
    fn the_write_refusal_names_the_size_and_file_edit() {
        let v = refusal(Change::Write, ".knowledge/lesson.md", "/w/.knowledge/lesson.md", 1990);
        let error = v["error"].as_str().unwrap();
        assert!(error.contains("1990 lines"), "{error}");
        assert!(v["hint"].as_str().unwrap().contains("file_edit"));
        assert_eq!(v["success"], false);
        assert_eq!(v["needsRead"], true);
    }
}
