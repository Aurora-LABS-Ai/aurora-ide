//! `file_read` — bounded line-window read.
//!
//! Wraps `crate::commands::read_file_content` and applies the same
//! line-policy as the TS `fileReadExecutor` (large files return
//! truncated windows; small files return full content). Returns a
//! JSON object matching the TS executor's response shape so the
//! agent's downstream behaviour does not change.
//!
//! One result is deliberately NOT that JSON: a path whose bytes are a PNG,
//! JPEG, GIF or WebP comes back as an `<aurora_image>` marker plus a caption,
//! the same shape `browser_screenshot` returns, so a vision model sees the
//! picture instead of a UTF-8 error. See [`super::image_read`].

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
                // The correction the model reads has to match the schema it was
                // given, or the next attempt repeats the mistake it was just
                // told about.
                return Err(ToolError::InvalidInput(format!(
                    "`{key}` received {}. Send an array of paths — \
                     `\"path\": [\"src/a.ts\"]` for one file, \
                     `\"path\": [\"src/a.ts\", \"src/b.ts\"]` for several.",
                    describe_value(other)
                )));
            }
        }
    }

    if targets.is_empty() {
        return Err(ToolError::InvalidInput(
            "`path` is required: an array of 1-20 file paths, e.g. `\"path\": [\"src/a.ts\"]`"
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
            description: "Read one or more files. `path` is ALWAYS an array — one entry for a single file (`\"path\": [\"src/a.ts\"]`), up to 20 to read them in parallel (`\"path\": [\"src/a.ts\", \"src/b.ts\"]`). START WITH NO RANGE — you never need to guess how long a file is: files small enough come back whole, and anything larger comes back with its exact total line count and where to continue from, so one call tells you what still needs paging. Then window only the large ones. start_line/end_line/max_lines return EXACTLY the range asked for, up to 1000 lines per file per call — ask for more and you get the first 1000 plus the total, so continue from the next line. With several paths the SAME range is read from every file; to take DIFFERENT ranges from different files, issue one call per file in the same message — they run in parallel. Set force_full_content: true to take a whole file in one call with no line cap. A missing path reports exists=false rather than failing. IMAGES ARE FILES TOO — name a PNG, JPEG, GIF or WebP and you SEE it, so read a mockup, a screenshot or a design straight off disk instead of describing it blind; it can share a call with source files."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 20,
                        "items": { "type": "string", "minLength": 1 },
                        "description": "The files to read, as an array of paths — one entry for a single file (`[\"src/a.ts\"]`), up to 20 to read in parallel. A line range, if given, applies to every path (and is simply unused on an image)."
                    },
                    "start_line": { "type": "number", "description": "1-based first line to return. The returned range is exactly what you ask for, capped at 1000 lines per file. With several paths, applies to every file." },
                    "end_line": { "type": "number", "description": "1-based inclusive last line to return. Ranges wider than 1000 lines return the first 1000; continue from the next line. With several paths, applies to every file." },
                    "max_lines": { "type": "number", "description": "Maximum lines to return from start_line (hard cap 1000 per file)." },
                    "force_full_content": { "type": "boolean", "description": "Return the whole file in one call with no line cap, however long it is. Use when you genuinely need the entire file; otherwise page with start_line/end_line." }
                },
                // ONE slot names what to read, and it declares ONE type.
                //
                // The slot itself replaced a `path` + `paths` pair whose
                // "exactly one of" contract could not be expressed in the
                // schema at all — a top-level `oneOf` makes strict validators
                // (xAI/grok) reject the request with HTTP 400 — so it lived in
                // prose and was enforced by REJECTION. A model decoding
                // strictly fills every declared property, sent both, and was
                // told its schema-obedient call was malformed. Measured: 6 of
                // 60 `file_read` calls in one thread, every one a batch read,
                // every one dead.
                //
                // The slot then declared `"type": ["string", "array"]`, on the
                // theory that a union is safe where `oneOf` is not. It is not.
                // Measured 2026-08-29 — one identical request, three gateways,
                // three different serialisations of the same call:
                //
                //   byteplus  {"path": ["a.ts", "b.ts"]}   correct
                //   kenari    {"path": "[\"a.ts\", \"b.ts\"]"}
                //             the array flattened into a STRING. Harmless only
                //             because `read_targets` already decodes that (see
                //             its `Value::String` arm) — a workaround this
                //             union is the reason for.
                //   vectide   {"path":     …and then the REST OF THE CALL
                //             emitted as message text:
                //             `<tool_call><function=file_read>…`. The tool
                //             call is truncated mid-argument and unrecoverable;
                //             every read in the turn failed.
                //
                // One shape serialises correctly on all three: a plain array.
                // So a single read is a one-element array, and no gateway has
                // to choose between two types. `read_targets` still accepts a
                // bare string and a JSON-encoded one, because older threads on
                // disk are full of both.
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
            // the agent looked at it, and split the pictures out of the batch:
            // the parallel reader decodes UTF-8, so an image handed to it comes
            // back as "stream did not contain valid UTF-8" and the caller has
            // to go find another way to look at its own file.
            let mut image_jobs = Vec::new();
            let mut text_targets: Vec<String> = Vec::new();
            for entry in &targets {
                let resolved = resolve_path_for_read_with_spill(
                    entry,
                    ctx.workspace_root.as_deref(),
                    ctx.workspace_access,
                    ctx.spill_dir.as_deref(),
                );
                if let Ok(resolved) = resolved {
                    super::read_tracker::record(&ctx.thread_id, &resolved.to_string_lossy());
                    if let Some(kind) = super::image_read::sniff_path(&resolved) {
                        image_jobs.push((entry.clone(), resolved, kind));
                        continue;
                    }
                }
                // Anything that did not resolve stays in the text list, so an
                // unreadable path still gets the per-file error it always got.
                text_targets.push(entry.clone());
            }

            // Decoding and re-encoding is CPU + disk work; the whole batch of
            // it goes to one blocking thread rather than stalling the runtime.
            let opened = if image_jobs.is_empty() {
                Vec::new()
            } else {
                tokio::task::spawn_blocking(move || {
                    image_jobs
                        .into_iter()
                        .map(|(display, full, kind)| {
                            super::image_read::read_image(&display, &full, kind)
                        })
                        .collect::<Vec<_>>()
                })
                .await
                .map_err(|err| {
                    ToolError::Execution(format!("file_read image task panicked: {err}"))
                })?
            };
            let images = opened
                .iter()
                .map(|image| image.block.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let image_rows: Vec<Value> = opened.into_iter().map(|image| image.row).collect();

            if text_targets.is_empty() {
                return Ok(images);
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
                    Value::Array(
                        text_targets
                            .into_iter()
                            .map(Value::String)
                            .collect::<Vec<_>>(),
                    ),
                );
            }
            let text = super::multi_file_read::read_many(delegated, ctx).await?;
            if images.is_empty() {
                return Ok(text);
            }
            // Images FIRST so the body does not open with `{`: a result that
            // looks like JSON but is not gets read as a broken envelope, and
            // this one is deliberately two shapes — pictures, then the files.
            return Ok(format!(
                "{images}\n\n{}",
                merge_image_rows(text, image_rows, &targets)
            ));
        }

        let path = targets[0].as_str();

        let resolution = resolve_path_for_read_with_spill(
            path,
            ctx.workspace_root.as_deref(),
            ctx.workspace_access,
            ctx.spill_dir.as_deref(),
        );
        // A hard rejection (outside the workspace with the opt-in off) is a
        // policy answer, not a typo, and recovery must not smuggle a file past
        // it. Only a resolvable-but-unreadable path is worth repairing.
        let resolved = match resolution {
            Ok(resolved) => Some(resolved),
            Err(ToolError::Execution(_)) => None,
            Err(err) => return Err(err),
        };

        // A path that opens goes straight through — the repair path costs a
        // `stat` at most, and on a hit it saves the model a whole round trip
        // spent working out what it meant.
        let mut path = path.to_string();
        let mut correction: Option<String> = None;
        let resolved = if resolved.as_deref().is_some_and(Path::is_file) {
            resolved.unwrap_or_default()
        } else {
            match super::path_recovery::recover(&path, resolved.as_deref(), &ctx).await {
                super::path_recovery::Recovery::Corrected {
                    full,
                    display,
                    note,
                } => {
                    path = display;
                    correction = Some(note);
                    full
                }
                super::path_recovery::Recovery::Ambiguous { note, candidates } => {
                    return Ok(serde_json::to_string(&json!({
                        "success": false,
                        "exists": false,
                        "path": path,
                        "error": note,
                        "candidates": candidates,
                    }))
                    .unwrap());
                }
                // Nothing to offer. Report exactly what we would have before:
                // the read error for a path that resolved, the resolution
                // error for one that did not.
                super::path_recovery::Recovery::None => match resolved {
                    Some(resolved) => resolved,
                    None => {
                        return Ok(serde_json::to_string(&json!({
                            "success": false,
                            "path": path,
                            "error": "Invalid file path: it does not resolve inside this \
                                      workspace, and no file of that name was found in it.",
                        }))
                        .unwrap());
                    }
                },
            }
        };
        let path = path.as_str();
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
        let thread_for_extent = ctx.thread_id.clone();

        let body = tokio::task::spawn_blocking(move || {
            read_with_policy(
                &path_owned,
                &raw_path,
                start_line,
                end_line,
                max_lines,
                force_full_content,
                &thread_for_extent,
            )
        })
        .await
        .map_err(|err| ToolError::Execution(format!("file_read task panicked: {err}")))??;

        // Mark the file seen so a subsequent file_edit passes the
        // read-before-edit guard. Recording the attempt (even on a miss)
        // is harmless: file_edit independently fails on a missing file.
        super::read_tracker::record(&ctx.thread_id, &resolved_for_record);

        Ok(match correction {
            Some(note) => annotate(body, note),
            None => body,
        })
    }
}

/// Fold a path-repair note into a result the reader already produced.
///
/// `pathCorrected` is the flag a UI can key on; `note` is the sentence the
/// model reads. Both ride alongside the content rather than replacing it —
/// the file WAS read, and burying that under a warning would trade one
/// wasted round trip for another.
///
/// A body that will not parse is returned untouched. Losing the note is a
/// smaller failure than losing the file.
fn annotate(body: String, note: String) -> String {
    let Ok(Value::Object(mut map)) = serde_json::from_str::<Value>(&body) else {
        return body;
    };
    map.insert("pathCorrected".into(), Value::Bool(true));
    map.insert("note".into(), Value::String(note));
    serde_json::to_string(&Value::Object(map)).unwrap_or(body)
}

/// Fold the pictures back into the batch reader's inventory so it describes the
/// WHOLE call.
///
/// A mixed read is split in two — pictures handled here, text handed to the
/// batch reader — and the batch reader can only count what it was given. Left
/// alone, a nine-path call came back saying `totalFiles: 3`. That is not a
/// smaller truth but a wrong one: the model cannot use the result as an
/// inventory of what it asked for, and a file it never sees a row for looks
/// like a file that was never read.
///
/// Found by the agent itself and filed through `report_aurora_issue`
/// (2026-08-31) within an hour of the image reader shipping — the code that
/// split the call is the code that has to put it back together.
///
/// Rows are returned in the order the CALLER named their paths, not in the
/// order the two readers happened to finish. A body that will not parse is
/// returned untouched: losing the counts is smaller than losing the files.
fn merge_image_rows(envelope: String, images: Vec<Value>, order: &[String]) -> String {
    if images.is_empty() {
        return envelope;
    }
    let Ok(Value::Object(mut map)) = serde_json::from_str::<Value>(&envelope) else {
        return envelope;
    };
    let Some(Value::Array(mut files)) = map.remove("files") else {
        return envelope;
    };

    files.extend(images);
    let position = |row: &Value| {
        row.get("path")
            .and_then(Value::as_str)
            .and_then(|path| order.iter().position(|named| named == path))
            .unwrap_or(usize::MAX)
    };
    files.sort_by_key(position);

    let read = files
        .iter()
        .filter(|row| row.get("success") == Some(&Value::Bool(true)))
        .count();
    map.insert("filesRead".into(), json!(read));
    map.insert("filesError".into(), json!(files.len() - read));
    map.insert("totalFiles".into(), json!(files.len()));
    map.insert("files".into(), Value::Array(files));

    serde_json::to_string(&Value::Object(map)).unwrap_or(envelope)
}

/// What a file that opened but holds no text is told — an archive, a font, an
/// image format Aurora cannot decode.
///
/// Shared with the batch reader so one file gets one answer whichever route
/// read it. The batch path only ever sees the error as a STRING, which is why
/// [`is_non_text_error`] exists beside this: `read_to_string`'s own wording,
/// "stream did not contain valid UTF-8", names the decoder's problem rather
/// than the caller's and leaves the reader with nothing to do next.
pub(super) fn non_text_error(rel_path: &str) -> String {
    format!(
        "{rel_path} is not a text file — it holds bytes that are not UTF-8. file_read returns \
         text, and PNG/JPEG/GIF/WebP images. For anything else, inspect it with a shell command \
         that understands the format."
    )
}

/// True when a batch reader's error string is `read_to_string` refusing a
/// non-UTF-8 file. Matched on the message because that is all the batch path is
/// handed — the `io::Error` is consumed several layers below it.
pub(super) fn is_non_text_error(error: &str) -> bool {
    error.contains("stream did not contain valid UTF-8")
}

fn read_with_policy(
    full_path: &str,
    rel_path: &str,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_lines: Option<usize>,
    force_full_content: bool,
    // Recorded here rather than at the call site because this is the only place
    // that knows whether the caller ended up holding the file or a window onto
    // it. `file_edit` reads it back when a match fails.
    thread_id: &str,
) -> Result<String, ToolError> {
    // A picture is not text and never was. Checked here rather than at the call
    // site so it also covers a path that only became readable after recovery
    // repaired it — and by the file's own bytes, so a `.png` holding source
    // code still reads as source code below.
    //
    // Line arguments are not an error on this branch, they are simply spent: a
    // range names lines, an image has none, and the caller gets the picture it
    // asked for rather than a lecture about the argument it sent with it.
    if let Some(kind) = super::image_read::sniff_path(Path::new(full_path)) {
        // The inventory row is dropped on purpose: a single read answers about
        // one file, so the caption already IS the inventory. Only a batch, which
        // has to account for paths whose results took the other route, needs it.
        return Ok(super::image_read::read_image(rel_path, Path::new(full_path), kind).block);
    }

    let content = match std::fs::read_to_string(Path::new(full_path)) {
        Ok(c) => c,
        Err(err) => {
            // A file that opened but does not hold text: an archive, a binary,
            // a font, an image format Aurora cannot decode. `read_to_string`
            // reports that as "stream did not contain valid UTF-8", which names
            // the decoder's problem rather than the caller's, and leaves the
            // reader with nothing to do next.
            let error = if err.kind() == std::io::ErrorKind::InvalidData {
                non_text_error(rel_path)
            } else {
                format!("Failed to read file: {err}")
            };
            // Mirror TS executor: returns success=false JSON, NOT a thrown error.
            // `exists: false` folds in the old `file_exists` tool — callers can
            // probe a path's presence with file_read and branch on this flag.
            //
            // `exists` is what the byte-level failure above turns on: the file
            // is right there, so claiming it is absent would send the caller
            // looking for a path it already has.
            return Ok(serde_json::to_string(&json!({
                "success": false,
                "exists": err.kind() == std::io::ErrorKind::InvalidData,
                "path": rel_path,
                "fullPath": full_path,
                "error": error,
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
        super::read_tracker::record_whole(thread_id, full_path);
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
        super::read_tracker::record_whole(thread_id, full_path);
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
        // Refused, so no line of it was seen. Recorded as an empty window: an
        // edit after this one is matching against text the caller never got.
        super::read_tracker::record_window(thread_id, full_path, 0, 0, total_lines);
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
    if range_start <= 1 && range_end >= total_lines {
        super::read_tracker::record_whole(thread_id, full_path);
    } else {
        super::read_tracker::record_window(
            thread_id,
            full_path,
            range_start,
            range_end,
            total_lines,
        );
    }
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
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: workspace,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    /// A real 8×8 PNG, so the reader's own decoder decides what this is.
    fn png_fixture() -> Vec<u8> {
        let img = image::RgbImage::from_fn(8, 8, |x, _| image::Rgb([(x * 30) as u8, 90, 200]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .expect("encode png");
        out
    }

    /// A mixed call's inventory must account for every path the caller named,
    /// in the order they named them.
    ///
    /// This is the bug the agent filed against Aurora on 2026-08-31, an hour
    /// after the image reader shipped: a nine-path read answered `totalFiles: 3`
    /// because only the text half reached the reader that counts. A count that
    /// disagrees with the call is worse than no count — it reads as "six of your
    /// files do not exist".
    #[tokio::test]
    async fn a_mixed_read_accounts_for_every_path_it_was_given() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("shot.png"), png_fixture()).unwrap();
        std::fs::write(tmp.path().join("notes.md"), "hello\n").unwrap();
        std::fs::write(tmp.path().join("second.png"), png_fixture()).unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({
                    "path": ["shot.png", "notes.md", "second.png", "missing.txt"]
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("a mixed read succeeds");

        // The pictures come first, so the body never opens with `{`.
        assert!(result.starts_with("<aurora_image "), "images lead the body");

        let envelope = &result[result.find("\n\n{").expect("json envelope") + 2..];
        let parsed: Value = serde_json::from_str(envelope).expect("valid JSON envelope");

        assert_eq!(parsed["totalFiles"], 4, "every named path is accounted for");
        assert_eq!(parsed["filesRead"], 3);
        assert_eq!(parsed["filesError"], 1);

        let rows = parsed["files"].as_array().expect("files array");
        let paths: Vec<&str> = rows
            .iter()
            .map(|row| row["path"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            paths,
            vec!["shot.png", "notes.md", "second.png", "missing.txt"],
            "rows keep the caller's order, not the two readers' finishing order"
        );
        assert_eq!(rows[0]["kind"], "image");
        assert_eq!(rows[0]["width"], 8);
        assert_eq!(rows[1]["content"], "hello\n");
        assert_eq!(rows[3]["success"], false);
    }

    /// A binary reached through the batch used to report the decoder's own
    /// words. Both routes now say the same thing about the same file.
    #[tokio::test]
    async fn a_binary_in_a_batch_gets_the_same_sentence_as_a_single_read() {
        let tmp = tempfile::tempdir().unwrap();
        // An ICO header, then bytes no decoder can read as UTF-8 (`0xFF` never
        // appears in a valid sequence). Not text, and not one of the four
        // formats Aurora shows — the exact case `app-icon.ico` hit in testing.
        std::fs::write(
            tmp.path().join("app.ico"),
            [0u8, 0, 1, 0, 1, 0, 32, 32, 0xFF, 0xFE, 0xC0, 0x80],
        )
        .unwrap();
        std::fs::write(tmp.path().join("notes.md"), "hello\n").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": ["app.ico", "notes.md"] }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("batch read");
        let parsed: Value = serde_json::from_str(&result).expect("valid JSON");
        let error = parsed["files"][0]["error"].as_str().unwrap_or_default();

        assert!(
            error.contains("is not a text file"),
            "the caller's problem, not the decoder's: {error}"
        );
        assert!(
            !error.contains("stream did not contain valid UTF-8"),
            "the raw decoder wording must not reach the model: {error}"
        );
    }

    /// ONE slot names what to read, and it declares ONE type.
    ///
    /// The pair this replaced could not state its own "exactly one of" rule in
    /// the schema — a top-level `oneOf` makes strict validators (xAI/grok)
    /// answer HTTP 400 — so the rule lived in prose and was enforced by
    /// rejection, and a strictly-decoding model that filled both fields was
    /// told its schema-obedient call was malformed.
    ///
    /// The union `["string", "array"]` that followed had a quieter failure and
    /// a worse one: gateways serialise a two-typed parameter differently from
    /// each other. Measured across three on 2026-08-29 — byteplus correct,
    /// kenari flattening the array into a string, vectide truncating the call
    /// at `{"path": ` and emitting the remainder as message text, which killed
    /// every read in the turn. An array serialises correctly on all three.
    ///
    /// Neither a second field nor a second type can come back without failing
    /// this.
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
            path["type"], "array",
            "one slot, one type — a union is serialised wrongly by real gateways"
        );
        assert!(
            !path["type"].is_array(),
            "a union `type` is what truncated the call on vectide"
        );
        assert_eq!(path["items"]["type"], "string");
        assert_eq!(path["minItems"], 1);
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

    // ── Path repair ─────────────────────────────────────────────
    //
    // A failed read costs a full round trip. These cover the two failures
    // Aurora can already see the answer to, and the one it must refuse to
    // guess at.

    /// Read `path` in a workspace holding `files`, as the tool really runs it.
    async fn read_in_workspace(
        files: &[(&str, &str)],
        path: &str,
    ) -> (tempfile::TempDir, serde_json::Value) {
        let tmp = tempfile::tempdir().unwrap();
        for (rel, body) in files {
            let full = tmp.path().join(rel);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(&full, body).unwrap();
        }
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let raw = tool
            .execute(
                serde_json::json!({ "path": path }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("a bad path must not fail the whole tool call");
        let parsed = serde_json::from_str(&raw).unwrap();
        (tmp, parsed)
    }

    /// Observed live on Kimi K3: the model wrote the path as a string literal
    /// and let the closing quote into it. Windows rejects the whole filename
    /// (`os error 123`) and the read failed on a file sitting right there.
    #[tokio::test]
    async fn a_stray_quote_in_the_path_is_removed_and_the_file_is_read() {
        let (_tmp, parsed) =
            read_in_workspace(&[("app/Shop.tsx", "export default Shop")], "app/Shop.tsx\"").await;

        assert_eq!(parsed["success"], true, "got {parsed}");
        assert_eq!(parsed["pathCorrected"], true);
        assert_eq!(
            parsed["path"], "app/Shop.tsx",
            "the card must name the file \
                   that was actually read, not the broken path"
        );
        assert!(parsed["content"]
            .as_str()
            .unwrap()
            .contains("export default Shop"));
        let note = parsed["note"].as_str().unwrap();
        assert!(
            note.contains("quote"),
            "the note must say what changed: {note}"
        );
    }

    /// Right name, wrong folder. One file carries the name, so reading it is
    /// unambiguous and saves the round trip.
    #[tokio::test]
    async fn a_uniquely_named_file_is_found_in_the_folder_it_actually_lives_in() {
        let (_tmp, parsed) = read_in_workspace(
            &[("app/shop/Shop.tsx", "the real one")],
            "components/Shop.tsx",
        )
        .await;

        // ripgrep is a bundled sidecar; without it there is nothing to search
        // with and the tool correctly reports the miss instead.
        if parsed["success"] == false {
            return;
        }
        assert_eq!(parsed["pathCorrected"], true);
        assert_eq!(parsed["path"], "app/shop/Shop.tsx");
        assert!(parsed["content"].as_str().unwrap().contains("the real one"));
    }

    /// Two files, one name. Reading either would be a coin flip, and a wrong
    /// file delivered with a confident note is worse than the original error —
    /// the model would build on it and never know. It gets the list instead.
    #[tokio::test]
    async fn a_name_shared_by_several_files_reads_nothing_and_lists_them() {
        let (_tmp, parsed) = read_in_workspace(
            &[
                ("app/shop/Shop.tsx", "one"),
                ("app/admin/Shop.tsx", "two"),
                ("app/page.tsx", "unrelated"),
            ],
            "Shop.tsx",
        )
        .await;

        assert_eq!(parsed["success"], false, "nothing may be read: {parsed}");
        assert!(parsed["content"].is_null(), "no content may be returned");
        let candidates: Vec<&str> = match parsed["candidates"].as_array() {
            Some(list) => list.iter().filter_map(|c| c.as_str()).collect(),
            // No ripgrep available — the miss is reported the old way.
            None => return,
        };
        assert_eq!(candidates.len(), 2, "got {candidates:?}");
        assert!(candidates.contains(&"app/shop/Shop.tsx"));
        assert!(candidates.contains(&"app/admin/Shop.tsx"));

        // The paths belong in `candidates` and nowhere else. Spelling them out
        // in the message as well sent one list twice in a single tool result —
        // observed live on a Next.js app where 80 files are named `page.tsx`,
        // which is the last place a failed read should be spending context.
        let error = parsed["error"].as_str().unwrap();
        for path in &candidates {
            assert!(
                !error.contains(path),
                "`{path}` is in `candidates` already; the message must not repeat it: {error}"
            );
        }
    }

    /// A name that matches nothing must read exactly as it always did. The
    /// repair path is additive; it cannot turn a plain miss into a new shape
    /// the model has to learn.
    #[tokio::test]
    async fn a_path_matching_nothing_still_reports_the_plain_miss() {
        let (_tmp, parsed) = read_in_workspace(&[("a.txt", "x")], "nowhere/absent.txt").await;

        assert_eq!(parsed["success"], false);
        assert_eq!(parsed["exists"], false);
        assert!(parsed["pathCorrected"].is_null());
        assert!(parsed["candidates"].is_null());
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
