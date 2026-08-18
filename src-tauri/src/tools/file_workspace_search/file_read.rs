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

/// Most files one call may name. Matches the schema's `maxItems`.
const MAX_BATCH_PATHS: usize = 20;

/// What a `file_read` call names, and how it named it.
pub(super) struct ReadRequest {
    /// Every path to read: trimmed, de-duplicated, in the order given.
    pub targets: Vec<String>,
    /// The caller used the ARRAY form. Routing needs this: a one-element array
    /// without a line window still means "read this batch", and the batch
    /// reader answers an oversized file differently from the single reader.
    pub array_form: bool,
}

/// Describe what actually arrived, for an error the caller can act on.
fn describe_value(value: &Value) -> &'static str {
    match value {
        Value::Number(_) => "a number",
        Value::Bool(_) => "a boolean",
        Value::Object(_) => "an object",
        Value::Array(_) => "an array",
        Value::String(_) => "a string",
        Value::Null => "null",
    }
}

/// Append one path, trimmed, skipping blanks and duplicates.
///
/// A blank entry is DROPPED rather than rejected: it names no file, so nothing
/// is lost by ignoring it, and models emit `""` as a slot-filler. If every
/// entry is blank the call still fails on the empty-list check, which is the
/// honest error — "you named no file", not "entry 3 was empty".
fn push_path(raw: &str, targets: &mut Vec<String>) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    if !targets.iter().any(|existing| existing == trimmed) {
        targets.push(trimmed.to_string());
    }
}

/// Append every entry of an array, rejecting only values that name no file.
fn push_entries(entries: &[Value], targets: &mut Vec<String>, key: &str) -> Result<(), ToolError> {
    for entry in entries {
        match entry {
            Value::String(text) => push_path(text, targets),
            other => {
                return Err(ToolError::InvalidInput(format!(
                    "`{key}` contains {} where a file path string was expected. Send paths as \
                     strings — `\"path\": [\"src/a.ts\", \"src/b.ts\"]`.",
                    describe_value(other)
                )))
            }
        }
    }
    Ok(())
}

/// Resolve any accepted spelling of "what to read" into one list of paths.
///
/// This is the ONLY place a `file_read` call's targets are interpreted, so the
/// single-file and batch arms cannot drift apart about what was asked for.
///
/// The governing rule — already applied in this file to two narrower cases (an
/// array arriving JSON-ENCODED as a string, and a one-element array beside a
/// line window), and now the whole contract: **when the input has exactly one
/// sensible reading, resolve it and serve the call.** Only genuinely unusable
/// input is an error.
///
/// `paths` is still READ here although the schema no longer advertises it.
/// Models emit it from habit and from the history of older threads, and a call
/// naming files under a familiar name is not ambiguous — it is the same
/// request. Rejecting it would rebuild the precise failure this replaced: a
/// schema-obedient model told its correct call was malformed, with no way to
/// discover why. Accepting it costs one map lookup and can mislead no one,
/// because both spellings resolve into the same list.
pub(super) fn read_targets(input: &Value) -> Result<ReadRequest, ToolError> {
    let mut targets: Vec<String> = Vec::new();
    let mut array_form = false;

    for key in ["path", "paths"] {
        match input.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(raw)) => {
                // A JSON-ENCODED array — `"[\"a.ts\", \"b.ts\"]"` instead of
                // `["a.ts", "b.ts"]`. Measured at 8 of 542 batch reads on this
                // machine across 5 conversations: a serialization artifact, not
                // a model having a bad day. It names an unambiguous list of
                // files; it just arrived one encoding layer deep.
                match serde_json::from_str::<Vec<Value>>(raw) {
                    Ok(decoded) if !decoded.is_empty() => {
                        array_form = true;
                        push_entries(&decoded, &mut targets, key)?;
                    }
                    _ => push_path(raw, &mut targets),
                }
            }
            Some(Value::Array(entries)) => {
                // An EMPTY array is a slot-filler, not a batch. `path: "a.md"`
                // beside `paths: []` is a single read, and letting the empty
                // array set the batch flag would route it to the parallel
                // reader — a different result shape for a call that named one
                // file.
                if !entries.is_empty() {
                    array_form = true;
                }
                push_entries(entries, &mut targets, key)?;
            }
            Some(other) => {
                return Err(ToolError::InvalidInput(format!(
                    "`{key}` received {}. Send one path as a string — `\"path\": \"src/a.ts\"` — \
                     or several as an array of strings — \
                     `\"path\": [\"src/a.ts\", \"src/b.ts\"]`.",
                    describe_value(other)
                )))
            }
        }
    }

    if targets.is_empty() {
        return Err(ToolError::InvalidInput(
            "`path` is required: one file path as a string, or 1-20 paths as an array of strings"
                .into(),
        ));
    }
    if targets.len() > MAX_BATCH_PATHS {
        return Err(ToolError::InvalidInput(format!(
            "`path` names {} files; at most {MAX_BATCH_PATHS} can be read per call. Split the \
             rest into another call.",
            targets.len()
        )));
    }

    Ok(ReadRequest {
        targets,
        array_form,
    })
}

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
            description: "Read one or more files. `path` takes a single path (`\"path\": \"src/a.ts\"`) or an array to read several in parallel (`\"path\": [\"src/a.ts\", \"src/b.ts\"]`, max 20). START WITH NO RANGE — you never need to guess how long a file is: files small enough come back whole, and anything larger comes back with its exact total line count and where to continue from, so one call tells you what still needs paging. Then window only the large ones. start_line/end_line/max_lines return EXACTLY the range asked for, up to 1000 lines per file per call — ask for more and you get the first 1000 plus the total, so continue from the next line. With several paths the SAME range is read from every file; to take DIFFERENT ranges from different files, issue one call per file in the same message — they run in parallel. Set force_full_content: true to take a whole file in one call with no line cap. A missing path reports exists=false rather than failing."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": ["string", "array"],
                        "minLength": 1,
                        "maxItems": 20,
                        "items": { "type": "string", "minLength": 1 },
                        "description": "One file path as a string, or 1-20 file paths as an array of strings to read in parallel. A line range, if given, applies to every path."
                    },
                    "start_line": { "type": "number", "description": "1-based first line to return. The returned range is exactly what you ask for, capped at 1000 lines per file. With several paths, applies to every file." },
                    "end_line": { "type": "number", "description": "1-based inclusive last line to return. Ranges wider than 1000 lines return the first 1000; continue from the next line. With several paths, applies to every file." },
                    "max_lines": { "type": "number", "description": "Maximum lines to return from start_line (hard cap 1000 per file)." },
                    "force_full_content": { "type": "boolean", "description": "Return the whole file in one call with no line cap, however long it is. Use when you genuinely need the entire file; otherwise page with start_line/end_line." }
                },
                // ONE slot names what to read, so there is no second field
                // that can contradict it and no exclusivity rule to enforce.
                //
                // This replaced a `path` + `paths` pair whose "exactly one of"
                // contract could not be expressed in the schema at all — a
                // top-level `oneOf` makes strict validators (xAI/grok) reject
                // the request with HTTP 400 — so it lived in prose and was
                // enforced by REJECTION. A model decoding strictly fills every
                // declared property, sent both, and was told its schema-obedient
                // call was malformed. Measured: 6 of 60 `file_read` calls in one
                // thread, every one of them a batch read, every one dead.
                //
                // A union `"type": [...]` is safe where `oneOf` is not — the
                // same pattern `shell_kill`'s `pid` already ships on every
                // provider Aurora supports.
                "additionalProperties": false,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        // One slot, one reading. Every accepted spelling of "what to read"
        // resolves in `read_targets`, so the single and batch arms below can
        // never disagree about what was asked for.
        let request = read_targets(&input)?;
        let targets = request.targets;

        let wants_window = input.get("start_line").is_some()
            || input.get("end_line").is_some()
            || input.get("max_lines").is_some();

        // Routing is deliberately UNCHANGED by the merge of the two fields: a
        // bare string reads as one file, an array reads as a batch, and a
        // one-element array beside a line window reads as one file (one named
        // file with one range has exactly one meaning).
        //
        // The distinction is kept because the two readers answer an oversized
        // file DIFFERENTLY — the batch returns a per-file stub carrying that
        // file's length, the single reader returns its first page — so
        // collapsing them would quietly change what an existing call gets back.
        let single = targets.len() == 1 && (!request.array_form || wants_window);

        if !single {
            // Record each requested path as "seen" so a later file_edit knows
            // the agent looked at it, then delegate to the parallel reader.
            for entry in &targets {
                if let Ok(resolved) = resolve_path_for_read_with_spill(
                    entry,
                    ctx.workspace_root.as_deref(),
                    ctx.allow_outside_workspace,
                    ctx.spill_dir.as_deref(),
                ) {
                    super::read_tracker::record(&ctx.thread_id, &resolved.to_string_lossy());
                }
            }
            // Hand the parallel reader the RESOLVED list under the key it
            // reads. Passing the caller's raw input instead would put an
            // already-resolved call back through interpretation a second time —
            // the fix would look applied and change nothing.
            let mut delegated = input.clone();
            if let Some(object) = delegated.as_object_mut() {
                object.remove("path");
                object.insert(
                    "paths".into(),
                    Value::Array(targets.iter().cloned().map(Value::String).collect()),
                );
            }
            return super::multi_file_read::read_many(delegated, ctx).await;
        }

        let path = targets[0].as_str();

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

    let slice = slice_window(&content, total_lines, start_line, end_line, max_lines);

    // The range starts after the last line. Nothing to return, and the useful
    // answer is the file's real size so the next call can be right.
    if slice.past_end {
        let payload = json!({
            "success": false,
            "path": rel_path,
            "fullPath": full_path,
            "totalLines": total_lines,
            "error": format!(
                "start_line {} is past the end of this file, which has {total_lines} lines. \
                 Nothing was read. Re-read with a range inside 1-{total_lines}.",
                slice.start
            ),
        });
        return Ok(serde_json::to_string(&payload).unwrap());
    }

    let (sliced, range_start, range_end, omit_before, omit_after, truncated, capped) = (
        slice.text,
        slice.start,
        slice.end,
        slice.omitted_before,
        slice.omitted_after,
        slice.outside,
        slice.capped,
    );

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
    // A trailing separator TERMINATES the last line; it does not begin another.
    // Counting it reported one line too many for every file that ends in a
    // newline — which is most of them — and made the file's last "line" the
    // empty string after it. A window clamped to that line returned nothing.
    if content.ends_with('\n') || content.ends_with('\r') {
        return separators;
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
/// One window of a file, and whether the request could be served at all.
pub(super) struct Slice {
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub omitted_before: usize,
    pub omitted_after: usize,
    /// Lines exist outside what was returned. A property of the WINDOW — not a
    /// cut made because the content was too big, which is a different claim and
    /// gets a different sentence.
    pub outside: bool,
    pub capped: bool,
    /// The requested range begins past the last line, so there is nothing to
    /// return. Reported rather than clamped: clamping handed back an empty
    /// string under `success: true`, which the caller cannot tell apart from an
    /// empty file, and which taught it nothing about the range it got wrong.
    pub past_end: bool,
}

pub(super) fn slice_window(
    content: &str,
    total_lines: usize,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_lines: Option<usize>,
) -> Slice {
    let mut lines: Vec<&str> = if content.is_empty() {
        Vec::new()
    } else {
        content.split('\n').map(trim_trailing_cr).collect()
    };
    // A file that ends in a newline splits into a trailing empty element, and
    // that element is not a line. Left in, the last "line" of every such file is
    // the empty string — which is exactly what a window clamped to the end of
    // the file returned.
    if lines.len() > 1 && lines.last() == Some(&"") {
        lines.pop();
    }
    let total = lines.len();
    let requested_start = start_line.unwrap_or(1).max(1);

    if total == 0 || requested_start > total {
        return Slice {
            text: String::new(),
            start: requested_start,
            end: requested_start,
            omitted_before: total,
            omitted_after: 0,
            outside: false,
            capped: false,
            past_end: total > 0,
        };
    }

    let start = requested_start;
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

    let omitted_before = start.saturating_sub(1);
    let omitted_after = total_lines.saturating_sub(end);
    Slice {
        text: lines[start - 1..end].join("\n"),
        start,
        end,
        omitted_before,
        omitted_after,
        outside: omitted_before > 0 || omitted_after > 0,
        capped,
        past_end: false,
    }
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

    /// ONE slot names what to read, and it accepts either spelling.
    ///
    /// The pair this replaced could not state its own "exactly one of" rule in
    /// the schema — a top-level `oneOf` makes strict validators (xAI/grok)
    /// answer HTTP 400 — so the rule lived in prose and was enforced by
    /// rejection, and a strictly-decoding model that filled both fields was
    /// told its schema-obedient call was malformed.
    ///
    /// A second declared field cannot come back without failing this.
    #[test]
    fn schema_offers_exactly_one_way_to_name_what_to_read() {
        let schema = FileReadTool.schema();
        assert!(schema.input_schema.get("oneOf").is_none());

        let properties = schema.input_schema["properties"].as_object().unwrap();
        assert!(
            properties.get("paths").is_none(),
            "a second path field is what made the two contradict each other"
        );

        let path = &properties["path"];
        assert_eq!(
            path["type"],
            serde_json::json!(["string", "array"]),
            "one slot takes a single path or a list of them"
        );
        assert_eq!(path["items"]["type"], "string");
        assert_eq!(path["maxItems"], MAX_BATCH_PATHS);
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

    /// A bare string that is NOT an encoded array names exactly one file, so
    /// it is SERVED rather than rejected. This used to be an error, on the
    /// reasoning that the caller meant a batch and got the encoding wrong —
    /// but "read this one file" is the only thing the value can mean, and
    /// refusing it spends an iteration teaching a rule with no purpose.
    #[tokio::test]
    async fn a_bare_string_names_one_file_and_is_served() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("just-one-file.ts"), "let a = 1;").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "paths": "just-one-file.ts" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("one named file has exactly one reading");
        let body: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(body["success"], true);
        assert_eq!(body["content"], "let a = 1;");
    }

    /// A blank entry names no file, so dropping it loses nothing and the rest
    /// of the batch is served. Rejecting the whole call over a slot-filler
    /// meant the files the caller DID name went unread.
    #[tokio::test]
    async fn a_blank_entry_is_dropped_and_the_named_files_are_still_read() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.ts"), "let a = 1;\n").unwrap();
        std::fs::write(tmp.path().join("b.ts"), "let b = 2;\n").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": ["a.ts", "  ", "b.ts"] }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("the named files are still unambiguous");
        assert!(result.contains("let a = 1;"), "first file read: {result}");
        assert!(result.contains("let b = 2;"), "second file read: {result}");
    }

    /// Naming NOTHING is still an error — there is no sensible reading of a
    /// call that asks for no file, and inventing one would hide the mistake.
    #[tokio::test]
    async fn naming_no_file_at_all_is_an_error() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let err = tool
            .execute(serde_json::json!({ "path": ["  ", ""] }), &ctx_for(None))
            .await
            .expect_err("no file was named");
        let message = err.to_string();
        assert!(message.contains("`path` is required"), "{message}");
    }

    /// A value that names no file at all still fails, and the message shows
    /// the working forms rather than restating the schema.
    #[tokio::test]
    async fn an_unreadable_path_value_fails_with_an_actionable_message() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let err = tool
            .execute(serde_json::json!({ "path": 42 }), &ctx_for(None))
            .await
            .expect_err("a number names no file");
        let message = err.to_string();
        assert!(
            message.contains("a number"),
            "names what arrived: {message}"
        );
        assert!(message.contains("\"path\""), "shows the form: {message}");
    }

    /// More files than one call serves is refused with the real limit and the
    /// next move, not a silent truncation that would report files as read
    /// when they never were.
    #[tokio::test]
    async fn more_paths_than_the_batch_cap_is_refused_with_the_limit() {
        let many: Vec<String> = (0..MAX_BATCH_PATHS + 1)
            .map(|n| format!("file{n}.ts"))
            .collect();
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let err = tool
            .execute(serde_json::json!({ "path": many }), &ctx_for(None))
            .await
            .expect_err("over the cap");
        let message = err.to_string();
        assert!(message.contains(&MAX_BATCH_PATHS.to_string()), "{message}");
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

    /// THE regression. This is the verbatim payload GPT-5.6 Sol sent in thread
    /// `9db4f0f0` on 2026-08-18, and Aurora answered "use exactly one
    /// file_read form … do not send both". Six of sixty `file_read` calls in
    /// that thread had this shape; every one of them was a batch read and
    /// every one died. The model retried three times, shedding a file each
    /// time, because the error named nothing it could act on.
    ///
    /// Note `path` IS `paths[0]` — not a contradiction, a redundant
    /// restatement. Note too that every optional property is filled
    /// (`max_lines` duplicating `end_line`, `force_full_content` stated rather
    /// than omitted): the signature of a model decoding the schema strictly,
    /// which is to say obeying it.
    #[tokio::test]
    async fn the_payload_that_broke_a_live_thread_now_reads_every_file() {
        let tmp = tempfile::tempdir().unwrap();
        let names = [
            "proxy-check.js",
            "proxies.js",
            "engine.js",
            "main.js",
            "preload.js",
            "package.json",
        ];
        for (n, name) in names.iter().enumerate() {
            std::fs::write(tmp.path().join(name), format!("// file {n}\nbody\n")).unwrap();
        }

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({
                    "end_line": 380,
                    "force_full_content": false,
                    "max_lines": 380,
                    "path": "proxy-check.js",
                    "paths": names,
                    "start_line": 1
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("a redundant restatement is not a contradiction");

        let body: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(body["filesError"], 0, "no file failed: {body}");
        assert_eq!(
            body["filesRead"], 6,
            "every named file was read exactly once: {body}"
        );
        // Content, not just a success flag — a card that says "6 files" over an
        // empty body is the failure this replaced wearing a check mark.
        for n in 0..names.len() {
            assert!(
                result.contains(&format!("// file {n}")),
                "file {n} came back with its content: {result}"
            );
        }
    }

    /// A `path` that is NOT already in the list is one more file to read. Still
    /// exactly one reading, so still served — the union, in the order given.
    #[tokio::test]
    async fn a_path_outside_the_list_is_read_alongside_it() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("one.md"), "first").unwrap();
        std::fs::write(tmp.path().join("two.md"), "second").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": "one.md", "paths": ["two.md"] }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("two named files are two files to read");
        let body: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(body["filesRead"], 2, "{body}");
        assert!(result.contains("first"), "{result}");
        assert!(result.contains("second"), "{result}");
    }

    /// The array form, under the name the schema now advertises.
    #[tokio::test]
    async fn path_as_an_array_reads_the_batch() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.ts"), "alpha").unwrap();
        std::fs::write(tmp.path().join("b.ts"), "beta").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": ["a.ts", "b.ts"] }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("an array names a batch");
        let body: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(body["filesRead"], 2, "{body}");
        assert!(
            result.contains("alpha") && result.contains("beta"),
            "{result}"
        );
    }

    /// The same file named twice is read once. Without this a model that
    /// restates `path` inside `paths` would be billed for the file twice and
    /// the card would count it twice.
    #[tokio::test]
    async fn a_file_named_twice_is_read_once() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.ts"), "alpha").unwrap();
        std::fs::write(tmp.path().join("b.ts"), "beta").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": ["a.ts", "b.ts", "a.ts"] }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("a duplicate is not an error");
        let body: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(body["filesRead"], 2, "read once each: {body}");
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

    /// A call whose ONLY entry is blank named no file. The error says that,
    /// rather than blaming the line range, which was never the problem.
    #[tokio::test]
    async fn a_blank_only_call_with_a_window_says_no_file_was_named() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let err = tool
            .execute(
                serde_json::json!({ "path": ["  "], "start_line": 2 }),
                &ctx_for(None),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidInput(message) if message.contains("`path` is required"))
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
