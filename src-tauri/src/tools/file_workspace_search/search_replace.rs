//! `search_replace` — single find-and-replace edit on one file.
//!
//! Wraps `crate::commands::editor_ops::apply_search_replace` with
//! `write: true`, then renders the result into the same JSON shape
//! the TS `searchReplaceExecutor` produces (success + replacement
//! count, or one of the structured `not_found` / `not_unique` /
//! `overlap` failures).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::commands::editor_ops::{
    apply_search_replace, ApplySearchReplaceRequest, MatchDiagnosis, SearchReplaceItem,
    SearchReplaceResponse,
};
use crate::tools::shell_editor_todo::{FileChangedPayload, IdeEventSink};

use super::resolve_path_with_access;

pub struct SearchReplaceTool {
    sink: Arc<dyn IdeEventSink>,
}

impl SearchReplaceTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

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

        let resolved =
            resolve_path_with_access(path, ctx.workspace_root.as_deref(), ctx.workspace_access)?;
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

        // On success, emit `agent_file_changed` with the freshly-written
        // file contents so open Monaco buffers can update in place.
        // We do a single async read after the patch lands rather than
        // teaching `apply_search_replace` to return its post-write
        // content — keeps the editor_ops contract narrow and avoids
        // shipping the buffer twice (the response struct already
        // carries lines_added/lines_removed/total_replacements for the
        // UI summary).
        let impact = if matches!(response, SearchReplaceResponse::Ok { .. }) {
            emit_post_write(
                &*self.sink,
                &resolved_str,
                "search_replace",
                &ctx.tool_call_id,
            )
            .await;
            super::index_note_after_write(ctx, &resolved_str)
        } else {
            None
        };

        Ok(render_response(
            &raw_path,
            &resolved_str,
            response,
            false,
            impact.as_deref(),
            super::read_tracker::last_window(&ctx.thread_id, &resolved_str),
        ))
    }
}

/// Read the just-written file off disk and emit a `Modified`
/// `agent_file_changed`. Soft-fails on every step — the file is
/// already correctly on disk, so a missing UI refresh is preferable
/// to surfacing a tool failure.
pub(crate) async fn emit_post_write(
    sink: &dyn IdeEventSink,
    resolved_str: &str,
    source_tool: &str,
    tool_call_id: &str,
) {
    let path = resolved_str.to_string();
    let read = tokio::task::spawn_blocking(move || std::fs::read_to_string(&path)).await;
    let content = match read {
        Ok(Ok(s)) => s,
        Ok(Err(io_err)) => {
            eprintln!("[{source_tool}] post-write read failed for {resolved_str}: {io_err}");
            return;
        }
        Err(join_err) => {
            eprintln!(
                "[{source_tool}] post-write read task panicked for {resolved_str}: {join_err}"
            );
            return;
        }
    };
    let payload = FileChangedPayload::modified(resolved_str, content, source_tool)
        .with_tool_call_id(tool_call_id);
    if let Err(emit_err) = sink.emit_file_changed(&payload) {
        eprintln!("[{source_tool}] emit_file_changed failed for {resolved_str}: {emit_err}");
    }
}

/// Upper bound on per-side content embedded in a tool result for the
/// Review panel. Aligned with the UI layer's per-JSON-field cap
/// (`MAX_UI_JSON_FIELD_LENGTH` = 128 KiB in `conversation.rs`): at or
/// below this, both sides pass through to the UI pristine (and the
/// combined payload stays under the 512 KiB envelope cap, so nothing is
/// trimmed mid-content). Past it we emit `null` and the Review panel
/// cleanly falls back to the stats-only summary — better than a
/// truncation marker injected into the middle of a diff.
pub(crate) const MAX_DIFF_CONTENT: usize = 128 * 1024;

/// Embed a file side (before/after) into a result payload, or `null`
/// when it exceeds [`MAX_DIFF_CONTENT`].
pub(crate) fn diff_side(content: &str) -> Value {
    if content.len() > MAX_DIFF_CONTENT {
        Value::Null
    } else {
        Value::String(content.to_string())
    }
}

/// Spell a match failure out as text the caller can act on without reading the
/// file again.
///
/// The structured `diagnosis` object travels in the payload too, but the
/// message is what the model actually reads, and a message that names the
/// column and both characters turns a dead round trip into a one-line fix.
pub(crate) fn describe_diagnosis(diagnosis: &MatchDiagnosis) -> String {
    let mut out = String::new();
    let span = if diagnosis.start_line == diagnosis.end_line {
        format!("line {}", diagnosis.start_line)
    } else {
        format!("lines {}-{}", diagnosis.start_line, diagnosis.end_line)
    };
    let count = diagnosis.differences.len();
    out.push_str(&format!(
        "Closest text in the file is at {span}. {count} difference{}{}:",
        if count == 1 { "" } else { "s" },
        if diagnosis.more_differences {
            " (more follow)"
        } else {
            ""
        }
    ));

    for difference in &diagnosis.differences {
        out.push_str(&format!(
            "\n  line {}, column {} — you sent `{}`, the file has `{}`",
            difference.line, difference.column, difference.sent, difference.found
        ));
        // Codepoints earn their space only where the characters cannot be told
        // apart by looking at them, which is exactly the case that keeps
        // costing round trips.
        if let (Some(sent), Some(found)) = (&difference.sent_codes, &difference.found_codes) {
            if sent.len() <= 3 && found.len() <= 3 {
                out.push_str(&format!(" ({} vs {})", sent.join(" "), found.join(" ")));
            }
        }
        if let Some(note) = &difference.note {
            out.push_str(&format!("\n    {note}"));
        }
    }

    if diagnosis.typographic_matches > 1 {
        out.push_str(&format!(
            "\n  {} places would match if the quotes, dashes and spaces were copied from the file.",
            diagnosis.typographic_matches
        ));
    }
    out
}

/// Say what the caller has actually seen of a file, when it is less than all
/// of it.
///
/// 29 of the 53 recorded zero-match failures on an already-read file were
/// matching against a file that had come back as a range — "lines 235-250 of
/// 1588". The text they wanted was often in the 1,338 lines they never got,
/// and nothing in the failure said so.
pub(crate) fn window_note(window: Option<(usize, usize, usize)>) -> Option<String> {
    let (first, last, total) = window?;
    Some(if first == 0 || last == 0 {
        format!(
            "None of this file has been read yet — it has {total} lines and the last read was \
             refused as too large. Read the range you mean to edit first."
        )
    } else {
        format!(
            "Only lines {first}-{last} of this file's {total} have been read. If the text you are \
             matching lies outside that window, read the range holding it before editing."
        )
    })
}

/// Render a [`SearchReplaceResponse`] in the same JSON shape the TS
/// executor produces. `multi` selects between the single- and
/// batch-failure phrasings. `impact` is the code index's edit-impact note
/// ("other files use what this file defines…"), attached to successful
/// writes only — a failed edit changed nothing, so it has no impact.
pub(crate) fn render_response(
    raw_path: &str,
    full_path: &str,
    response: SearchReplaceResponse,
    multi: bool,
    impact: Option<&str>,
    // `window` is the range this file was last read through, when it was not
    // read whole. Consulted only on a failure — a successful edit has nothing
    // to explain.
    window: Option<(usize, usize, usize)>,
) -> String {
    match response {
        SearchReplaceResponse::Ok {
            original_content,
            new_content,
            line_ending_normalized,
            lines_added,
            lines_removed,
            total_replacements,
            replacement_details,
            typography_repairs,
            escape_repairs,
            ..
        } => {
            // An edit that only landed after folding the file's typography is
            // still an edit the caller did not quite ask for, so it says so.
            // Silence here would teach the model that its version of the text
            // was right, and the next edit to the same lines would miss again.
            let repair_note = typography_repairs.first().map(|repair| {
                let count = repair.differences.len();
                format!(
                    " (matched after correcting {count} spot{} where the file uses different \
                     characters — see typographyRepaired)",
                    if count == 1 { "" } else { "s" }
                )
            });
            // Louder than the typography note, because the assumption is
            // bigger. That repair changes which bytes matched; this one also
            // changes which bytes were written, and the caller is the only one
            // who can confirm that was the intent.
            let escape_note = (!escape_repairs.is_empty()).then(|| {
                let wrote_unescaped = escape_repairs.iter().any(|r| r.new_string_unescaped);
                format!(
                    " (your text arrived escaped one level too many — it matched after removing \
                     that level{}. Send this file's text without the extra backslashes next time; \
                     see escapeRepaired)",
                    if wrote_unescaped {
                        ", and new_string was unescaped the same way before writing"
                    } else {
                        ""
                    }
                )
            });
            // Said as a SENTENCE, not only as a flag, and it says what was
            // preserved rather than what was normalized.
            //
            // This used to be `"lineEndingNormalized": true` and nothing else.
            // It means "both sides were folded to LF so the match could
            // succeed" — a statement about the MATCH — and the file's own
            // endings are restored before the write (`restore_line_endings`,
            // `commands/editor_ops.rs`). But the name reads as "your file was
            // rewritten", and on 2026-09-04 an agent read it exactly that way:
            // it concluded a two-region edit had flipped a 402-line CRLF file
            // to LF, filed a bug, and wrote the finding up. The file was
            // CRLF the whole time. A field that reads as damage will keep
            // producing reports of damage that did not happen.
            let crlf_note = line_ending_normalized.then_some(
                " (this file uses CRLF: the text was matched with line endings \
                 folded to LF, and the file's own CRLF endings were preserved on write)",
            );
            let mut payload = json!({
                "success": true,
                "pending": false,
                "message": format!(
                    "Replaced {total_replacements} occurrence(s) in {raw_path}{}{}{}",
                    repair_note.as_deref().unwrap_or(""),
                    escape_note.as_deref().unwrap_or(""),
                    crlf_note.unwrap_or("")
                ),
                "path": raw_path,
                "fullPath": full_path,
                "replacements": total_replacements,
                "totalReplacements": total_replacements,
                "linesAdded": lines_added,
                "linesRemoved": lines_removed,
                // Named for what it describes — the match — so it cannot be
                // read as a claim about the file on disk.
                "matchedAcrossCrlf": line_ending_normalized,
                // Full before/after for the Review panel's diff. Capped per side;
                // `null` past the cap (Review falls back to the stats summary).
                "oldContent": diff_side(&original_content),
                "newContent": diff_side(&new_content),
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
            if !typography_repairs.is_empty() {
                payload["typographyRepaired"] = json!(typography_repairs);
            }
            if !escape_repairs.is_empty() {
                payload["escapeRepaired"] = json!(escape_repairs);
            }
            // Present only when there is something to say — a permanent
            // `"impact": null` on every edit would teach the model to stop
            // reading the field.
            if let Some(note) = impact {
                payload["impact"] = json!(note);
            }
            serde_json::to_string(&payload).unwrap()
        }
        SearchReplaceResponse::NotFound {
            failed_at,
            diagnosis,
        } => {
            let error = if multi {
                // Two things used to go wrong here. The message named an
                // "original file snapshot" while its hint named "current file
                // content", so a reader could not tell whether the file had
                // moved under them (re-read) or their old_string was simply
                // wrong (rewrite it) — and the good recovery text added for the
                // single-replacement case was never given to this branch.
                //
                // The snapshot is real and worth saying plainly: every
                // replacement in one call is matched against the file as it was
                // BEFORE any of them were applied, so replacement 2 must not
                // assume replacement 1 already landed.
                format!(
                    "Replacement {failed_at}: nothing in {raw_path} matched. Every replacement in \
                     one call is matched against the file as it was BEFORE any of them were \
                     applied."
                )
            } else {
                // The old wording here named the two things that are almost
                // never the cause ("line endings are handled automatically;
                // check indentation or surrounding context") and never named
                // the ones that are. Worse, mentioning line endings at all
                // planted them as a suspect: a session on 2026-08-25 read that
                // sentence, went and checked the file's line endings, concluded
                // "Windows line endings" and abandoned the tool for a shell
                // heredoc — while the real difference was two curly quotes.
                // Say what differs, or say nothing extra.
                format!("No match for old_string in {raw_path}.")
            };
            let mut payload = json!({
                "success": false,
                "error": match diagnosis.as_ref().map(describe_diagnosis) {
                    Some(detail) => format!("{error}\n{detail}"),
                    None => error,
                },
                "path": raw_path,
                "fullPath": full_path,
                "failedAt": failed_at,
                // ZERO matches. The recovery is to get the real text, not to
                // send more of the text that was already wrong — "make it
                // unique" is the answer to the OPPOSITE failure (too many
                // matches, `NotUnique` below) and points squarely away from the
                // problem. Padding an old_string that is absent with more
                // context that is also absent just fails again, longer.
                "hint": match diagnosis.as_ref() {
                    // With a diagnosis in hand, "go read the file again" is the
                    // wrong instruction: the caller usually HAS read it (53 of
                    // 83 recorded failures had), and the exact correction is
                    // already printed above. Re-reading costs a round trip and
                    // lands in the same place.
                    Some(d) if d.typographic_matches > 1 => {
                        "Those characters appear in more than one place. Extend old_string with \
                         nearby lines to pin down which one, copying every character from the \
                         file."
                    }
                    Some(_) => {
                        "Correct the differences listed above and send old_string again. The rest \
                         of it matched, so only those spots need changing."
                    }
                    None if multi => {
                        "Copy old_string verbatim from a file_read of this path — whitespace and \
                         indentation included — rather than adding more context around a guess. \
                         If this replacement was meant to edit text an earlier replacement in the \
                         same call produces, split it into a second call instead."
                    }
                    None => {
                        "Nothing in the file resembles this text. Copy old_string verbatim from a \
                         file_read of this path — whitespace and indentation included — rather \
                         than adding more context around a guess."
                    }
                },
            });
            // Appended rather than replacing the hint: the window explains why
            // the text might be absent, the hint still says what to do next.
            if let Some(note) = window_note(window) {
                let hint = payload["hint"].as_str().unwrap_or_default();
                payload["hint"] = json!(format!("{note} {hint}"));
                payload["readWindow"] = json!({
                    "firstLine": window.map(|w| w.0),
                    "lastLine": window.map(|w| w.1),
                    "totalLines": window.map(|w| w.2),
                });
            }
            if let Some(detail) = diagnosis {
                payload["diagnosis"] = json!(detail);
            }
            serde_json::to_string(&payload).unwrap()
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
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: workspace,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    #[tokio::test]
    async fn replaces_unique_match() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "hello world\n").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(SearchReplaceTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
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

    /// A CRLF file stays CRLF, and the result says so in words.
    ///
    /// The bug this pins is not in the writing — `restore_line_endings` has
    /// always put the file's own endings back. It is in the REPORTING: the
    /// result used to carry a bare `lineEndingNormalized: true`, which reads
    /// as "your file was rewritten". On 2026-09-04 an agent read it that way,
    /// concluded a two-region edit had flipped a 402-line CRLF file to LF, and
    /// filed a bug about damage that never happened. So this asserts both
    /// halves: the bytes on disk, and that the sentence tells the truth about
    /// them.
    #[tokio::test]
    async fn a_crlf_file_keeps_its_crlf_and_the_result_says_so() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "alpha\r\nbeta\r\ngamma\r\n").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(SearchReplaceTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let result = tool
            .execute(
                serde_json::json!({
                    // Written with LF, as a model writes it, against a CRLF file.
                    "path": "a.txt",
                    "old_string": "alpha\nbeta",
                    "new_string": "alpha\nBETA",
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], true);

        // The file is untouched apart from the edit itself.
        let on_disk = std::fs::read_to_string(tmp.path().join("a.txt")).unwrap();
        assert_eq!(on_disk, "alpha\r\nBETA\r\ngamma\r\n");

        // And the report names the match, not the file — and says the file's
        // own endings survived, which is the sentence that stops the wrong
        // reading before it starts.
        assert_eq!(parsed["matchedAcrossCrlf"], true);
        assert!(
            parsed["lineEndingNormalized"].is_null(),
            "the old name reads as damage and must not come back"
        );
        let message = parsed["message"].as_str().unwrap_or_default();
        assert!(message.contains("preserved"), "{message}");
        assert!(message.contains("CRLF"), "{message}");
    }

    /// The note is absent on an LF file — there is nothing to explain.
    #[tokio::test]
    async fn an_lf_file_gets_no_line_ending_note() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "alpha\nbeta\n").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(SearchReplaceTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let result = tool
            .execute(
                serde_json::json!({
                    "path": "a.txt",
                    "old_string": "beta",
                    "new_string": "BETA",
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["matchedAcrossCrlf"], false);
        assert!(!parsed["message"].as_str().unwrap_or_default().contains("CRLF"));
    }

    #[tokio::test]
    async fn reports_not_found_as_structured_failure() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "hello\n").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(SearchReplaceTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
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
        assert!(parsed["error"]
            .as_str()
            .unwrap()
            .contains("No match for old_string"));
        // "xyz" resembles nothing in "hello", so there is honestly nothing to
        // point at and the payload says so by omission.
        assert!(parsed["diagnosis"].is_null());

        // A ZERO-match failure must not be handed the answer to the too-many-
        // matches failure. Aurora's own harness run caught this: the error body
        // correctly said "check indentation or surrounding context" while the
        // hint beside it said to make old_string unique, which is advice for
        // the opposite problem and points away from the fix.
        let hint = parsed["hint"].as_str().unwrap();
        assert!(
            !hint.contains("unique"),
            "zero matches is not an ambiguity problem, got: {hint}"
        );
        assert!(
            hint.contains("file_read"),
            "recovery is to fetch the real text, got: {hint}"
        );
        assert!(parsed["occurrences"].is_null(), "nothing matched");
    }

    /// The sentence this replaces cost a real session three round trips. It
    /// said "line endings are handled automatically; check indentation or
    /// surrounding context" on a failure whose cause was two curly quotes —
    /// naming line endings at all was enough for the reader to go and check
    /// them, believe them, and abandon the tool for a shell heredoc.
    #[tokio::test]
    async fn a_failed_match_names_the_characters_instead_of_line_endings() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("notes.md"),
            "- make \u{201C}Request a quote\u{201D} lead somewhere real\n",
        )
        .unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(SearchReplaceTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        // Two candidates, so the repair is refused and the message has to do
        // the work on its own.
        std::fs::write(
            tmp.path().join("notes.md"),
            "- make \u{201C}Request a quote\u{201D} real\n- make \u{201C}Request a quote\u{201D} \
             real\n",
        )
        .unwrap();

        let result = tool
            .execute(
                serde_json::json!({
                    "path": "notes.md",
                    "old_string": "- make \"Request a quote\" real",
                    "new_string": "- done",
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        let error = parsed["error"].as_str().unwrap();

        assert_eq!(parsed["success"], false);
        assert!(
            !error.to_lowercase().contains("line ending"),
            "the one thing that is never the cause must not be named: {error}"
        );
        assert!(
            error.contains("Closest text in the file is at line 1"),
            "the caller is shown where to look: {error}"
        );
        assert!(
            error.contains('\u{201C}'),
            "and the character the file actually holds: {error}"
        );
        assert!(
            error.contains("2 places would match"),
            "and why fixing the quotes alone is not enough: {error}"
        );
        assert!(
            parsed["diagnosis"]["differences"][0]["line"] == 1,
            "the structured form travels alongside the message"
        );
    }

    /// The other half of the read-first failures: the file WAS read, but only
    /// through a window, and the text being matched was never in it. The old
    /// message could not tell that story; the caller was left guessing at
    /// indentation on lines it had never been shown.
    #[tokio::test]
    async fn a_failure_on_a_partly_read_file_says_how_much_was_seen() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("big.md");
        std::fs::write(&path, "alpha\nbeta\ngamma\n").unwrap();
        let resolved = path.to_string_lossy().to_string();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        super::super::read_tracker::record_window(&ctx.thread_id, &resolved, 235, 250, 1588);

        let tool: Arc<dyn ToolExecutor> = Arc::new(SearchReplaceTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let result = tool
            .execute(
                serde_json::json!({
                    "path": "big.md",
                    "old_string": "text from a line nobody ever returned",
                    "new_string": "x",
                }),
                &ctx,
            )
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();

        assert_eq!(parsed["success"], false);
        let hint = parsed["hint"].as_str().unwrap();
        assert!(
            hint.contains("Only lines 235-250 of this file's 1588"),
            "the window is named with real numbers: {hint}"
        );
        assert_eq!(parsed["readWindow"]["firstLine"], 235);
        assert_eq!(parsed["readWindow"]["totalLines"], 1588);

        super::super::read_tracker::clear_session(&ctx.thread_id);
    }

    /// The repaired case: the edit lands, and the result still says the
    /// caller's text was not what the file holds.
    #[tokio::test]
    async fn a_repaired_edit_reports_what_it_corrected() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("notes.md"),
            "- make \u{201C}Request a quote\u{201D} real\n",
        )
        .unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(SearchReplaceTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        let result = tool
            .execute(
                serde_json::json!({
                    "path": "notes.md",
                    "old_string": "- make \"Request a quote\" real",
                    "new_string": "- done",
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();

        assert_eq!(parsed["success"], true);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("notes.md")).unwrap(),
            "- done\n"
        );
        assert!(
            parsed["message"]
                .as_str()
                .unwrap()
                .contains("matched after correcting"),
            "a silent repair would teach the model its text was right: {}",
            parsed["message"]
        );
        assert!(parsed["typographyRepaired"][0]["differences"][0]["found"]
            .as_str()
            .unwrap()
            .contains('\u{201C}'));
    }
}
