//! `file_read` — bounded line-window read.
//!
//! Wraps `crate::commands::read_file_content` and applies the same
//! line-policy as the TS `fileReadExecutor` (large files return
//! truncated windows; small files return full content). Returns a
//! JSON object matching the TS executor's response shape so the
//! agent's downstream behaviour does not change.

use std::path::Path;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::resolve_path_for_read_with_spill;

/// Chosen to match the TS executor (`MAX_FILE_SIZE = 500 * 1024`).
const MAX_FILE_SIZE: usize = 500 * 1024;
/// Most lines any single call returns unless `force_full_content` is set.
/// A request for more is CAPPED to this and told to page — never silently
/// widened and never silently gutted.
pub(super) const MAX_SINGLE_READ_LINES: usize = 1_000;

/// Marker the runtime honours to leave a payload alone.
///
/// `file_read` bounds its own output by lines (see [`read_with_policy`]), so a
/// result that reaches here is already exactly what the model asked for. The
/// generic spill/clamp layers used to bound it a SECOND time — a 30 KB, 739-line
/// component came back with its middle 22 KB replaced by a "read this file"
/// pointer, and the model then spent five more calls paging the spill file back
/// in. Anything a read returns is verbatim, or an exact-match `file_edit` built
/// from it fails.
pub const EXACT_READ_MARKER: &str = "\"exactRead\":true";

pub struct FileReadTool;

#[async_trait]
impl ToolExecutor for FileReadTool {
    fn name(&self) -> &str {
        "file_read"
    }

    /// Pure disk read — safe alongside other reads in the same batch.
    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "file_read".into(),
            description: "Read file content safely. For ONE file pass a non-empty `path`; for \
                          SEVERAL pass a non-empty `paths` array. Send one or the other, never both, \
                          and never `paths: []`. start_line/end_line/max_lines work with either form \
                          — with `paths` the SAME range is read from every file in the batch. A line \
                          range is returned EXACTLY as asked, up to 1000 lines per file per call — \
                          ask for more and you get the first 1000 plus the total, so continue with \
                          the next range. Without a range, files of 1000 lines or fewer come back \
                          whole. To read a longer file in one call anyway, set force_full_content: \
                          true. A missing path reports exists=false rather than failing."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "One non-empty file path. Omit `paths`."
                    },
                    "paths": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 20,
                        "items": { "type": "string", "minLength": 1 },
                        "description": "1-20 non-empty file paths to read in parallel. Omit `path`; never send an empty array. A line range, if given, is applied to every file."
                    },
                    "start_line": { "type": "number", "description": "1-based first line to return. The returned range is exactly what you ask for, capped at 1000 lines per file. With `paths`, applies to every file." },
                    "end_line": { "type": "number", "description": "1-based inclusive last line to return. Ranges wider than 1000 lines return the first 1000; continue from the next line. With `paths`, applies to every file." },
                    "max_lines": { "type": "number", "description": "Maximum lines to return from start_line (hard cap 1000 per file)." },
                    "force_full_content": { "type": "boolean", "description": "Return the whole file in one call with no line cap, however long it is. Use when you genuinely need the entire file; otherwise page with start_line/end_line." }
                },
                // NOTE: the "exactly one of `path` / `paths`" contract is
                // carried by the descriptions above and ENFORCED at runtime in
                // `execute` (both-present and empty-array cases are rejected).
                // We deliberately do NOT express it with a top-level `oneOf`:
                // strict tool-schema validators (xAI/grok in particular) reject
                // `oneOf`/`anyOf`/`allOf` in function parameters with HTTP 400,
                // which would break every agent turn on those providers.
                "additionalProperties": false,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let path = match input.get("path") {
            Some(Value::String(path)) if !path.trim().is_empty() => Some(path.as_str()),
            Some(Value::String(_)) | Some(Value::Null) | None => None,
            Some(_) => {
                return Err(ToolError::InvalidInput(
                    "`path` must be a non-empty string when provided".into(),
                ))
            }
        };
        // `paths` sent as a JSON-ENCODED STRING — `"[\"a.ts\", \"b.ts\"]"`
        // instead of `["a.ts", "b.ts"]`. The value it names is an unambiguous
        // array of file paths; it just arrived one encoding layer deep.
        //
        // This is a serialization artifact, not a model having a bad day:
        // measured across this machine's transcripts it was 8 of 542 batch
        // reads, spread over 5 different conversations and projects. Rejecting
        // it burned a whole iteration each time, and the agent's own reaction
        // was to abandon the batch form entirely ("the paths array approach
        // isn't working with the tool") and fall back to one read per file —
        // so a harness quirk was costing N-1 extra round trips per batch.
        //
        // Same rule as the one-element-plus-line-window coercion below: when
        // the input has exactly one sensible reading, resolve it and serve the
        // call. Only genuinely ambiguous or unusable input is an error.
        let unwrapped_paths: Option<Vec<Value>> = match input.get("paths") {
            Some(Value::String(raw)) => serde_json::from_str::<Vec<Value>>(raw)
                .ok()
                .filter(|arr| !arr.is_empty())
                .filter(|arr| {
                    arr.iter()
                        .all(|entry| entry.as_str().is_some_and(|s| !s.trim().is_empty()))
                }),
            _ => None,
        };
        let paths: Option<&[Value]> = if let Some(arr) = unwrapped_paths.as_deref() {
            Some(arr)
        } else {
            match input.get("paths") {
                Some(Value::Array(paths)) if !paths.is_empty() => Some(paths.as_slice()),
                Some(Value::Array(_)) | Some(Value::Null) | None => None,
                // Name what actually arrived and the exact form that works.
                // The old message restated the schema, which the model had
                // already read — it gave nothing to correct toward.
                Some(other) => {
                    let got = match other {
                        Value::String(_) => "a string that is not a JSON array of file paths",
                        Value::Number(_) => "a number",
                        Value::Bool(_) => "a boolean",
                        Value::Object(_) => "an object",
                        _ => "an unsupported value",
                    };
                    return Err(ToolError::InvalidInput(format!(
                        "`paths` received {got}. Send it as a real JSON array of non-empty file \
                         path strings — `\"paths\": [\"src/a.ts\", \"src/b.ts\"]` — or use \
                         `path` for a single file."
                    )));
                }
            }
        };

        if path.is_some() && paths.is_some() {
            return Err(ToolError::InvalidInput(
                "use exactly one file_read form: `path` for one file or `paths` for several files; do not send both"
                    .into(),
            ));
        }

        let wants_window = input.get("start_line").is_some()
            || input.get("end_line").is_some()
            || input.get("max_lines").is_some();

        // `paths: ["one/file.rs"], start_line: 1, end_line: 80` used to be a hard
        // error. It should not be: a one-element array names exactly one file, so
        // the line window has precisely one meaning and the request is not
        // ambiguous at all.
        //
        // It is also SCHEMA-VALID input. The `path` xor `paths` contract can't be
        // expressed in the schema (a top-level `oneOf` makes strict validators
        // return HTTP 400 — see `schema()`), so every one of these fields is
        // declared as an independent optional sibling. A model that emits this is
        // obeying the schema it was given; rejecting it made a correct-looking
        // call fail for a reason only the prose description hinted at, which is
        // exactly the kind of unforced error that derails a turn.
        //
        // So: normalise it to the single-file form and serve the read. Two or more
        // files with a window are served too, by the batch arm below — see the
        // note there.
        let coerced_single: Option<String> = match paths {
            Some(arr) if wants_window && arr.len() == 1 => arr[0]
                .as_str()
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string),
            _ => None,
        };
        let paths = if coerced_single.is_some() {
            None
        } else {
            paths
        };
        let path = path.or(coerced_single.as_deref());

        // An empty `paths` array is treated as an omitted optional placeholder
        // only when a valid single-file `path` is present. This keeps a model's
        // redundant default from overriding the unambiguous requested read.
        if let Some(arr) = paths {
            if arr.iter().any(|entry| {
                entry
                    .as_str()
                    .map(|value| value.trim().is_empty())
                    .unwrap_or(true)
            }) {
                return Err(ToolError::InvalidInput(
                    "every entry in `paths` must be a non-empty file path string".into(),
                ));
            }
            // A window across 2+ files used to be rejected as having "no single
            // referent". It has an obvious one: the same range, read from each
            // file. "Lines 210-520 of these four files" cannot mean anything
            // else, and it is what a model asks for whenever it compares the
            // same region across implementations — so the rejection cost a whole
            // iteration and N error strings to teach a rule that only existed
            // because nothing had implemented the batch case. `read_many` now
            // slices per file with `slice_window`, the same function and the
            // same 1000-line cap the single-file form uses.

            // Record each requested path as "seen" so a later file_edit knows
            // the agent looked at it, then delegate to the parallel reader.
            for entry in arr {
                if let Some(p) = entry.as_str() {
                    if let Ok(resolved) = resolve_path_for_read_with_spill(
                        p,
                        ctx.workspace_root.as_deref(),
                        ctx.allow_outside_workspace,
                        ctx.spill_dir.as_deref(),
                    ) {
                        super::read_tracker::record(&ctx.thread_id, &resolved.to_string_lossy());
                    }
                }
            }
            // Hand the parallel reader the NORMALIZED shape. It re-reads
            // `paths` off the input it is given, so passing the original would
            // put a coerced call straight back into the validation this arm
            // just resolved — the fix would look applied and change nothing.
            let delegated = match unwrapped_paths.as_ref() {
                Some(unwrapped) => {
                    let mut normalized = input.clone();
                    if let Some(object) = normalized.as_object_mut() {
                        object.insert("paths".into(), Value::Array(unwrapped.clone()));
                    }
                    normalized
                }
                None => input.clone(),
            };
            return super::multi_file_read::read_many(delegated, ctx).await;
        }

        let path = path.ok_or_else(|| {
            if input.get("paths").and_then(Value::as_array).is_some() {
                ToolError::InvalidInput(
                    "`paths` must contain at least one file; use `path` for a single file and omit `paths`"
                        .into(),
                )
            } else {
                ToolError::InvalidInput(
                    "provide exactly one file_read form: non-empty `path` or non-empty `paths`"
                        .into(),
                )
            }
        })?;

        let resolved = match resolve_path_for_read_with_spill(
            path,
            ctx.workspace_root.as_deref(),
            ctx.allow_outside_workspace,
            ctx.spill_dir.as_deref(),
        ) {
            Ok(resolved) => resolved,
            Err(ToolError::Execution(err)) => {
                return Ok(serde_json::to_string(&json!({
                    "success": false,
                    "path": path,
                    "error": format!("Invalid file path: {err}"),
                }))
                .unwrap());
            }
            Err(err) => return Err(err),
        };
        let start_line = input
            .get("start_line")
            .and_then(Value::as_u64)
            .map(|n| n as usize);
        let end_line = input
            .get("end_line")
            .and_then(Value::as_u64)
            .map(|n| n as usize);
        let max_lines = input
            .get("max_lines")
            .and_then(Value::as_u64)
            .map(|n| n as usize);
        // Accept the boolean, and also the string spelling some providers emit
        // for boolean-valued function args — refusing "true" would make the
        // opt-out silently do nothing.
        let force_full_content = match input.get("force_full_content") {
            Some(Value::Bool(flag)) => *flag,
            Some(Value::String(text)) => text.eq_ignore_ascii_case("true"),
            _ => false,
        };

        let path_owned = resolved.to_string_lossy().to_string();
        let resolved_for_record = path_owned.clone();
        let raw_path = path.to_string();

        let body = tokio::task::spawn_blocking(move || {
            read_with_policy(
                &path_owned,
                &raw_path,
                start_line,
                end_line,
                max_lines,
                force_full_content,
            )
        })
        .await
        .map_err(|err| ToolError::Execution(format!("file_read task panicked: {err}")))??;

        // Mark the file seen so a subsequent file_edit passes the
        // read-before-edit guard. Recording the attempt (even on a miss)
        // is harmless: file_edit independently fails on a missing file.
        super::read_tracker::record(&ctx.thread_id, &resolved_for_record);

        Ok(body)
    }
}

fn read_with_policy(
    full_path: &str,
    rel_path: &str,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_lines: Option<usize>,
    force_full_content: bool,
) -> Result<String, ToolError> {
    let content = match std::fs::read_to_string(Path::new(full_path)) {
        Ok(c) => c,
        Err(err) => {
            // Mirror TS executor: returns success=false JSON, NOT a thrown error.
            // `exists: false` folds in the old `file_exists` tool — callers can
            // probe a path's presence with file_read and branch on this flag.
            return Ok(serde_json::to_string(&json!({
                "success": false,
                "exists": false,
                "path": rel_path,
                "fullPath": full_path,
                "error": format!("Failed to read file: {err}"),
            }))
            .unwrap());
        }
    };

    let total_lines = count_lines(&content);

    // Opt-out of every bound. The caller said it needs the whole file, so it
    // gets the whole file — `exactRead` then keeps the spill and history clamp
    // from quietly undoing that downstream.
    if force_full_content {
        let payload = json!({
            "success": true,
            "exactRead": true,
            "path": rel_path,
            "fullPath": full_path,
            "content": content,
            "totalLines": total_lines,
            "size": content.len(),
            "largeFile": false,
            "range": { "startLine": 1, "endLine": total_lines },
            "truncated": false,
            "forcedFullContent": true,
        });
        return Ok(serde_json::to_string(&payload).unwrap());
    }

    let explicit = start_line.is_some() || end_line.is_some() || max_lines.is_some();

    // A file that fits the per-call line cap comes back whole, with no window
    // bookkeeping to reason about.
    if !explicit && total_lines <= MAX_SINGLE_READ_LINES && content.len() <= MAX_FILE_SIZE {
        let payload = json!({
            "success": true,
            "exactRead": true,
            "path": rel_path,
            "fullPath": full_path,
            "content": content,
            "totalLines": total_lines,
            "size": content.len(),
            "largeFile": false,
        });
        return Ok(serde_json::to_string(&payload).unwrap());
    }

    // A single line can hold megabytes (minified / generated output), so the
    // line cap alone is not a real bound. Refuse rather than flood the context,
    // and name both ways forward.
    if !explicit && content.len() > MAX_FILE_SIZE {
        let payload = json!({
            "success": true,
            "exactRead": true,
            "path": rel_path,
            "fullPath": full_path,
            "totalLines": total_lines,
            "size": content.len(),
            "largeFile": true,
            "requiresLineRange": true,
            "content": "",
            "warning": format!(
                "This file is {} bytes over {} lines — too large to return unasked. Read it chunk by chunk with start_line/end_line (max {MAX_SINGLE_READ_LINES} lines per call), or set force_full_content: true to take all of it in one call.",
                content.len(), total_lines
            ),
            "suggestedRange": {
                "startLine": 1,
                "endLine": std::cmp::min(MAX_SINGLE_READ_LINES, total_lines),
            }
        });
        return Ok(serde_json::to_string(&payload).unwrap());
    }

    let (sliced, range_start, range_end, omit_before, omit_after, truncated, capped) =
        slice_window(&content, total_lines, start_line, end_line, max_lines);

    // Three different situations used to share one vague sentence. Say which
    // one happened, because the right next move differs for each.
    let warning = if capped {
        // The caller asked for a wider range than one call returns. It did NOT
        // get what it asked for, so say so first and give the exact resume point.
        Some(format!(
            "Capped at {MAX_SINGLE_READ_LINES} lines: returned {range_start}-{range_end} of \
             {total_lines}. This is a big file — read it chunk by chunk, continuing from \
             start_line: {}. To take the whole file in one call instead, set \
             force_full_content: true.",
            range_end.saturating_add(1)
        ))
    } else if truncated {
        Some(format!(
            "Returned lines {range_start}-{range_end} of {total_lines} exactly as requested. \
             Continue with start_line/end_line, or set force_full_content: true for the whole file."
        ))
    } else {
        None
    };

    let payload = json!({
        "success": true,
        "exactRead": true,
        "path": rel_path,
        "fullPath": full_path,
        "content": sliced,
        "totalLines": total_lines,
        "size": content.len(),
        "largeFile": total_lines > MAX_SINGLE_READ_LINES,
        "range": { "startLine": range_start, "endLine": range_end },
        "truncated": truncated,
        "cappedAtMaxLines": capped,
        "omittedLinesBefore": omit_before,
        "omittedLinesAfter": omit_after,
        "warning": warning,
    });
    Ok(serde_json::to_string(&payload).unwrap())
}

/// Match TypeScript's `splitLines` semantics: split on `\r\n`, `\n`,
/// or bare `\r`, then return the resulting segment count. Returns 0
/// for the empty string (matching TS `splitLines("")` → `[]`).
fn count_lines(content: &str) -> usize {
    if content.is_empty() {
        return 0;
    }
    // 1 + number of line separators. Walk bytes to coalesce CRLF.
    let bytes = content.as_bytes();
    let mut separators = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                separators += 1;
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    i += 2;
                } else {
                    i += 1;
                }
            }
            b'\n' => {
                separators += 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    separators + 1
}

/// Slice the requested window.
///
/// Returns `(text, start, end, omitted_before, omitted_after, truncated, capped)`.
/// `capped` means the caller asked for a WIDER range than [`MAX_SINGLE_READ_LINES`]
/// and got the first slice of it — the one case where the result is deliberately
/// not what was requested, so the caller has to be told explicitly.
///
/// Shared with [`super::multi_file_read`], which applies the same window to every
/// file of a batch read — so a windowed `paths` call and a windowed `path` call
/// slice by identical rules, including the per-file line cap.
pub(super) fn slice_window(
    content: &str,
    total_lines: usize,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_lines: Option<usize>,
) -> (String, usize, usize, usize, usize, bool, bool) {
    let lines: Vec<&str> = if content.is_empty() {
        Vec::new()
    } else {
        content.split('\n').map(trim_trailing_cr).collect()
    };
    let total = lines.len().max(1);

    let start = start_line.unwrap_or(1).max(1).min(total);
    // `max_lines` is a request like any other: honoured up to the hard cap.
    let window = max_lines.unwrap_or(MAX_SINGLE_READ_LINES).max(1);
    let allowed = window.min(MAX_SINGLE_READ_LINES);

    // What the caller actually asked to see, clamped only to the file's end.
    let requested_end = end_line
        .unwrap_or_else(|| start.saturating_add(allowed - 1))
        .max(start)
        .min(total);
    let cap_end = start.saturating_add(allowed - 1);
    let end = requested_end.min(cap_end);
    let capped = requested_end > cap_end;

    let selected = if lines.is_empty() {
        String::new()
    } else {
        lines[start - 1..end].join("\n")
    };
    let omit_before = start.saturating_sub(1);
    let omit_after = total_lines.saturating_sub(end);
    let truncated = omit_before > 0 || omit_after > 0;
    (
        selected,
        start,
        end,
        omit_before,
        omit_after,
        truncated,
        capped,
    )
}

fn trim_trailing_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::tool_executor::ToolContext;
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

    #[test]
    fn schema_requires_one_non_empty_read_form() {
        let schema = FileReadTool.schema();
        // The single-vs-batch contract is enforced in `execute`, not with a
        // top-level `oneOf` — strict providers (xAI/grok) 400 on `oneOf`.
        assert!(schema.input_schema.get("oneOf").is_none());
        assert_eq!(schema.input_schema["properties"]["paths"]["minItems"], 1);
        assert_eq!(schema.input_schema["properties"]["path"]["minLength"], 1);
    }

    /// Measured on real transcripts: 8 of 542 batch reads arrived with `paths`
    /// as a JSON-encoded string, across 5 conversations and projects. The
    /// value is an unambiguous array of file paths one encoding layer deep, so
    /// it is resolved rather than rejected — rejecting it made the agent
    /// abandon the batch form and fall back to one read per file.
    #[tokio::test]
    async fn a_json_encoded_paths_string_is_unwrapped() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.ts"), "let a = 1;\n").unwrap();
        std::fs::write(tmp.path().join("b.ts"), "let b = 2;\n").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "paths": "[\"a.ts\", \"b.ts\"]" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("a stringified array is served, not rejected");
        assert!(result.contains("a.ts"), "first file read: {result}");
        assert!(result.contains("b.ts"), "second file read: {result}");
    }

    /// A string that is NOT an encoded array still fails — but the message
    /// names what arrived and the form that works, instead of restating the
    /// schema the model had already read.
    #[tokio::test]
    async fn a_non_array_paths_string_fails_with_an_actionable_message() {
        let tmp = tempfile::tempdir().unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let err = tool
            .execute(
                serde_json::json!({ "paths": "just-one-file.ts" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect_err("a bare string is not a batch");
        let message = err.to_string();
        assert!(
            message.contains("not a JSON array"),
            "names what arrived: {message}"
        );
        assert!(
            message.contains("\"paths\""),
            "shows the working form: {message}"
        );
    }

    /// An encoded array with a blank entry is not unambiguous, so it is NOT
    /// half-accepted — it falls through to the normal validation.
    #[tokio::test]
    async fn an_encoded_paths_array_with_a_blank_entry_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "paths": "[\"a.ts\", \"  \"]" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await;
        assert!(
            result.is_err(),
            "a blank entry must not be silently dropped"
        );
    }

    #[tokio::test]
    async fn reads_small_file_in_full() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "hello\nworld\n").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": "a.txt" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let body: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(body["success"], true);
        assert_eq!(body["content"], "hello\nworld\n");
        assert_eq!(body["largeFile"], false);
    }

    #[tokio::test]
    async fn empty_paths_placeholder_does_not_override_single_path() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("knowledge.md"), "project memory").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({
                    "path": "knowledge.md",
                    "paths": [],
                    "start_line": 1,
                    "end_line": 220,
                    "max_lines": 220
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("an empty batch placeholder should not hide a valid single path");
        let body: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(body["success"], true);
        assert_eq!(body["content"], "project memory");
    }

    #[tokio::test]
    async fn rejects_ambiguous_non_empty_path_forms() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let err = tool
            .execute(
                serde_json::json!({ "path": "one.md", "paths": ["two.md"] }),
                &ctx_for(None),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidInput(message) if message.contains("do not send both"))
        );
    }

    /// A line window over TWO OR MORE files used to be rejected as having no
    /// single referent. It has an obvious one — the same range, read from each
    /// file — and a model asks for it whenever it compares the same region
    /// across implementations. Observed live: ten batch reads in one assistant
    /// message, all ten rejected, a full iteration spent to learn a rule that
    /// existed only because the batch case was unimplemented.
    #[tokio::test]
    async fn a_line_range_over_several_files_reads_each_of_them() {
        let tmp = tempfile::tempdir().unwrap();
        let body: String = (1..=10).map(|n| format!("line{n}\n")).collect();
        std::fs::write(tmp.path().join("one.md"), &body).unwrap();
        std::fs::write(tmp.path().join("two.md"), &body).unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let out = tool
            .execute(
                serde_json::json!({
                    "paths": ["one.md", "two.md"],
                    "start_line": 4,
                    "end_line": 6,
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("a windowed batch read is served, not rejected");

        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["filesRead"], 2);
        for name in ["one.md", "two.md"] {
            let file = parsed["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["path"] == name)
                .unwrap_or_else(|| panic!("{name} missing from {parsed}"));
            assert_eq!(file["content"], "line4\nline5\nline6");
            assert_eq!(file["range"]["startLine"], 4);
            assert_eq!(file["range"]["endLine"], 6);
        }
    }

    /// The regression this fix exists for. `paths: ["x"]` + a line range is
    /// schema-valid and unambiguous, so it must READ, not fail. Frontier models
    /// emit this shape occasionally because the schema cannot forbid it.
    #[tokio::test]
    async fn single_element_paths_with_a_line_window_is_honoured() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("lines.txt");
        let body: String = (1..=40).map(|n| format!("line {n}\n")).collect();
        std::fs::write(&file, body).unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let out = tool
            .execute(
                serde_json::json!({
                    "paths": [file.to_string_lossy()],
                    "start_line": 3,
                    "end_line": 5,
                }),
                &ctx_for(None),
            )
            .await
            .expect("a one-file batch with a line window must be served, not rejected");

        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], serde_json::json!(true), "{parsed}");
        let content = parsed["content"].as_str().unwrap_or_default();
        assert!(content.contains("line 3"), "{content}");
        assert!(content.contains("line 5"), "{content}");
        // Honoured as a WINDOW, not silently widened to the whole file.
        assert!(!content.contains("line 1\n"), "{content}");
        assert!(!content.contains("line 40"), "{content}");
    }

    /// Without a line window the one-element batch form keeps its existing
    /// multi-file response shape — the coercion must not change what already works.
    #[tokio::test]
    async fn single_element_paths_without_a_window_still_uses_the_batch_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("solo.txt");
        std::fs::write(&file, "hello").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let out = tool
            .execute(
                serde_json::json!({ "paths": [file.to_string_lossy()] }),
                &ctx_for(None),
            )
            .await
            .expect("batch read of one file");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert!(
            parsed.get("files").is_some(),
            "expected the batch response shape, got {parsed}"
        );
    }

    /// An empty entry reports the entry problem, not the line-range rule.
    #[tokio::test]
    async fn blank_single_entry_with_a_window_reports_the_entry_problem() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let err = tool
            .execute(
                serde_json::json!({ "paths": ["  "], "start_line": 2 }),
                &ctx_for(None),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidInput(message) if message.contains("non-empty file path string"))
        );
    }

    /// Helper: a file of exactly `n` numbered lines.
    ///
    /// Deliberately written WITHOUT a trailing newline. `count_lines` mirrors
    /// TypeScript's `splitLines`, which counts the empty segment after a final
    /// `\n` — so a trailing newline here would make every `totalLines`
    /// assertion off by one and read like a bug in the policy.
    fn numbered_file(dir: &Path, name: &str, n: usize) -> std::path::PathBuf {
        let path = dir.join(name);
        let body = (1..=n)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, body).unwrap();
        path
    }

    async fn read(input: serde_json::Value) -> Value {
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let out = tool.execute(input, &ctx_for(None)).await.expect("read ok");
        serde_json::from_str(&out).unwrap()
    }

    /// An explicit range is the contract: exactly those lines, nothing widened,
    /// nothing trimmed off the end.
    #[tokio::test]
    async fn explicit_range_is_returned_exactly() {
        let tmp = tempfile::tempdir().unwrap();
        let file = numbered_file(tmp.path(), "a.txt", 500);
        let got = read(serde_json::json!({
            "path": file.to_string_lossy(), "start_line": 120, "end_line": 300,
        }))
        .await;

        assert_eq!(got["range"]["startLine"], 120);
        assert_eq!(got["range"]["endLine"], 300);
        assert_eq!(got["cappedAtMaxLines"], serde_json::json!(false));
        let content = got["content"].as_str().unwrap();
        let lines: Vec<&str> = content.split('\n').collect();
        assert_eq!(lines.len(), 181, "300-120+1 lines");
        assert_eq!(lines[0], "line 120");
        assert_eq!(lines[180], "line 300");
    }

    /// The user's scenario: an over-wide range (1..12000 on a small file) must
    /// cap, say it capped, and name where to resume — not silently return less.
    #[tokio::test]
    async fn over_wide_range_caps_and_says_how_to_continue() {
        let tmp = tempfile::tempdir().unwrap();
        let file = numbered_file(tmp.path(), "big.txt", 1_200);
        let got = read(serde_json::json!({
            "path": file.to_string_lossy(), "start_line": 1, "end_line": 12_000,
        }))
        .await;

        assert_eq!(
            got["range"]["endLine"], 1_000,
            "capped at the per-call limit"
        );
        assert_eq!(got["cappedAtMaxLines"], serde_json::json!(true));
        assert_eq!(got["totalLines"], 1_200);
        let warning = got["warning"].as_str().unwrap();
        assert!(warning.contains("Capped at 1000 lines"), "{warning}");
        assert!(warning.contains("chunk by chunk"), "{warning}");
        assert!(warning.contains("start_line: 1001"), "{warning}");
        assert!(warning.contains("force_full_content"), "{warning}");
    }

    /// `force_full_content` overrides every bound, however long the file is.
    #[tokio::test]
    async fn force_full_content_returns_everything() {
        let tmp = tempfile::tempdir().unwrap();
        let file = numbered_file(tmp.path(), "huge.txt", 5_000);
        let got = read(serde_json::json!({
            "path": file.to_string_lossy(), "force_full_content": true,
        }))
        .await;

        assert_eq!(got["forcedFullContent"], serde_json::json!(true));
        assert_eq!(got["truncated"], serde_json::json!(false));
        let content = got["content"].as_str().unwrap();
        assert!(content.contains("line 1\n"), "starts at the top");
        assert!(content.contains("line 5000"), "reaches the very last line");
    }

    /// A file within the per-call limit comes back whole, with no window noise.
    #[tokio::test]
    async fn file_within_the_line_cap_comes_back_whole() {
        let tmp = tempfile::tempdir().unwrap();
        // 739 lines — the size that used to be gutted by the spill layer.
        let file = numbered_file(tmp.path(), "component.tsx", 739);
        let got = read(serde_json::json!({ "path": file.to_string_lossy() })).await;

        assert_eq!(got["totalLines"], 739);
        assert_eq!(got["largeFile"], serde_json::json!(false));
        assert!(got.get("range").is_none(), "no window bookkeeping: {got}");
        let content = got["content"].as_str().unwrap();
        assert!(content.contains("line 1\n"));
        assert!(content.contains("line 739"), "the tail must survive");
    }

    /// Over the cap with no range asked for: first window plus the honest count.
    #[tokio::test]
    async fn oversized_default_read_returns_the_first_window() {
        let tmp = tempfile::tempdir().unwrap();
        let file = numbered_file(tmp.path(), "long.txt", 2_400);
        let got = read(serde_json::json!({ "path": file.to_string_lossy() })).await;

        assert_eq!(got["range"]["startLine"], 1);
        assert_eq!(got["range"]["endLine"], 1_000);
        assert_eq!(got["totalLines"], 2_400);
        assert_eq!(got["truncated"], serde_json::json!(true));
        assert!(got["warning"]
            .as_str()
            .unwrap()
            .contains("force_full_content"));
    }

    /// Every read payload carries the marker the runtime keys off, or the spill
    /// and clamp layers will bound the result a second time.
    #[tokio::test]
    async fn every_read_payload_is_marked_exact() {
        let tmp = tempfile::tempdir().unwrap();
        let file = numbered_file(tmp.path(), "m.txt", 1_500);
        for input in [
            serde_json::json!({ "path": file.to_string_lossy() }),
            serde_json::json!({ "path": file.to_string_lossy(), "start_line": 5, "end_line": 9 }),
            serde_json::json!({ "path": file.to_string_lossy(), "force_full_content": true }),
        ] {
            let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
            let out = tool.execute(input.clone(), &ctx_for(None)).await.unwrap();
            assert!(
                out.contains(EXACT_READ_MARKER),
                "missing marker for {input}: {}",
                &out[..out.len().min(160)]
            );
        }
    }

    #[tokio::test]
    async fn rejects_path_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(tmp.path().join("outside.txt"), "secret").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let err = tool
            .execute(
                serde_json::json!({ "path": "../outside.txt" }),
                &ctx_for(Some(workspace.clone())),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PolicyViolation(_)));
    }

    #[tokio::test]
    async fn missing_file_returns_json_error() {
        let tmp = tempfile::tempdir().unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": "missing.txt" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("missing file should not fail the whole tool call");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"]
            .as_str()
            .unwrap()
            .contains("Failed to read file"));
    }

    #[tokio::test]
    async fn returns_window_for_explicit_range() {
        let tmp = tempfile::tempdir().unwrap();
        let body: String = (1..=200).map(|i| format!("line {i}\n")).collect();
        std::fs::write(tmp.path().join("big.txt"), &body).unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": "big.txt", "start_line": 5, "end_line": 7 }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["range"]["startLine"], 5);
        assert_eq!(parsed["range"]["endLine"], 7);
        assert_eq!(parsed["truncated"], true);
    }
}
