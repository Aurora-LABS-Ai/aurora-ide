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

use super::resolve_path_with_access;
use super::search_replace::{
    describe_diagnosis, diff_side, emit_post_write, render_response, window_note,
};
use super::streaming_targets;

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

    /// ## What this description deliberately withholds
    ///
    /// A zero-match edit whose only fault is a straightened quote or dash is
    /// repaired and applied (see `editor_ops::recover_typographic`). This
    /// description does **not** say so, and that is the point.
    ///
    /// The contract stays "match exactly", because it is still true and it is
    /// still the instruction that produces correct calls. Advertising the net
    /// would teach carelessness across the board while the net covers exactly
    /// one class — indentation, trailing whitespace and over-escaping are all
    /// still hard failures. A model told "Aurora fixes my quotes" has no way to
    /// learn where the fixing stops.
    ///
    /// The caller is not kept in the dark either: a repaired edit says so in
    /// its result ("matched after correcting N spots"), at the moment that
    /// knowing is useful and cannot be mistaken for permission.
    ///
    /// What IS advertised is the failure shape, because it changes what the
    /// model should DO. The learned habit after a failed edit is to re-read the
    /// file and try again; the failure now carries the exact correction, so
    /// that habit spends a round trip on an answer already in hand.
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "file_edit".into(),
            description: format!(
                          "Edit files by exact-text find-and-replace. \
                          {rule} \
                          Single edit: pass path + old_string + new_string. \
                          Many edits to ONE file: pass `edits` (an array) plus the top-level `path`. \
                          Edits across MULTIPLE files in ONE call: give each item in `edits` its own \
                          `path` (the top-level `path` becomes the default for items that omit it). \
                          The whole batch is atomic — every edit applies against its file's original \
                          snapshot, and if any edit fails NO file is changed. old_string must match \
                          exactly and be unique unless replace_all=true. Copy old_string from text \
                          you have actually seen (file_read, or a search result that returned the \
                          line). replace_all=true additionally REQUIRES that the file was read this \
                          session, because it rewrites occurrences you have not seen. When no match \
                          is found the failure names the closest text in the file and the exact \
                          characters that differ — correct those and send old_string again, rather \
                          than re-reading the file and guessing a second time. A successful \
                          edit may return an `impact` field naming symbols this file exports that \
                          OTHER files use — if you changed one of their signatures or behavior, \
                          check those call sites before moving on.",
                          rule = streaming_targets::RULE,
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    // FIRST, always. See `streaming_targets` for why the name
                    // has to start with a letter this early in the alphabet.
                    streaming_targets::FIELD: streaming_targets::property(),
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
        //
        // Resolved rather than read: a model that named the file only in
        // `affected_paths` — which this tool's own description tells it to emit
        // first, for every call — meant that file. See `path_argument`.
        let resolved_arg = super::path_argument::resolve(&input, "edit").map_err(with_batch_hint);
        let top_path = resolved_arg.as_ref().ok().map(|arg| arg.path.as_str());

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

        // Single-edit form — requires a top-level `path`. The batch form above
        // is allowed to run without one, so the refusal lands here, carrying
        // whichever sentence names what actually arrived.
        let path_arg = resolved_arg?;
        let path = path_arg.path.as_str();
        let resolved =
            resolve_path_with_access(path, ctx.workspace_root.as_deref(), ctx.workspace_access)?;
        let resolved_str = resolved.to_string_lossy().to_string();
        let raw_path = path.to_string();

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

        // `replace_all` is the one form the exact-match engine cannot police:
        // it waives the uniqueness check, so a short pattern rewrites every
        // occurrence — including ones in parts of the file the agent has never
        // seen. That stays refused up front. See `blind_replace_all_json`.
        if replace_all && !super::read_tracker::was_seen(&ctx.thread_id, &resolved_str) {
            return Ok(blind_replace_all_json(&raw_path, &resolved_str));
        }

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

        let mut impact = None;
        if matches!(response, SearchReplaceResponse::Ok { .. }) {
            emit_post_write(&*self.sink, &resolved_str, "file_edit", &ctx.tool_call_id).await;
            super::read_tracker::record(&ctx.thread_id, &resolved_str);
            impact = super::index_note_after_write(ctx, &resolved_str);
        }

        // The text was not there AND the agent never read this file — now the
        // unread file is the actionable cause, so say that instead of "could
        // not find the specified text", which invites another blind guess.
        if matches!(response, SearchReplaceResponse::NotFound { .. })
            && !super::read_tracker::was_seen(&ctx.thread_id, &resolved_str)
        {
            return Ok(needs_read_json(&raw_path, &resolved_str));
        }

        let _ = Path::new("");
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
            let old_string = rep
                .get("old_string")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ToolError::InvalidInput(format!("Edit {n}: `old_string` is required"))
                })?;
            if old_string.is_empty() {
                return Err(ToolError::InvalidInput(format!(
                    "Edit {n}: `old_string` must not be empty"
                )));
            }
            let new_string = rep
                .get("new_string")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ToolError::InvalidInput(format!("Edit {n}: `new_string` is required"))
                })?;
            let replace_all = rep
                .get("replace_all")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            let resolved = resolve_path_with_access(
                raw_path,
                ctx.workspace_root.as_deref(),
                ctx.workspace_access,
            )?;
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

        // Read-before-edit, narrowed to the case where it protects something.
        //
        // It used to gate EVERY edit, and that produced false refusals on work
        // the agent had done correctly: it would locate the exact line with
        // `grep` or `code`, batch an edit across three files, and have the whole
        // batch declined because one of them was never opened with `file_read` —
        // even though the matched text came back in the search result it was
        // looking at. The tracker cannot see any of the other legitimate ways
        // the text reaches the agent (search hits, `code` output, an earlier
        // diff, the user pasting it), so as a precondition it will always refuse
        // some correct edits.
        //
        // What actually keeps a blind edit safe is the engine, not the tracker:
        // `old_string` must match exactly and be unique, and the batch is
        // atomic. A guessed edit therefore fails to match and writes nothing.
        // The one exception is `replace_all`, which waives uniqueness and so can
        // rewrite occurrences nobody has seen — that stays gated.
        //
        // For everything else the check moves to phase 1, where an unread file
        // becomes the DIAGNOSIS for a match that failed rather than a barrier in
        // front of one that would have succeeded.
        for g in &groups {
            if g.items.iter().any(|item| item.replace_all)
                && !super::read_tracker::was_seen(&ctx.thread_id, &g.resolved)
            {
                return Ok(if multi {
                    render_multi_blind_replace_all(&g.raw, &g.resolved)
                } else {
                    blind_replace_all_json(&g.raw, &g.resolved)
                });
            }
        }

        // Phase 1 — validate every file and retain its original/new snapshots.
        // One failure aborts before any disk write.
        let mut prepared: Vec<(String, String, SearchReplaceResponse)> =
            Vec::with_capacity(groups.len());
        for g in &groups {
            let resp = apply_multi_search_replace(ApplyMultiSearchReplaceRequest {
                path: g.resolved.clone(),
                replacements: g.items.clone(),
                write: false,
            })
            .await
            .map_err(ToolError::Execution)?;
            if !matches!(resp, SearchReplaceResponse::Ok { .. }) {
                // Text missing from a file the agent never read — that is the
                // cause worth reporting, and the recovery is one `file_read`
                // rather than another guess at the surrounding context.
                if matches!(resp, SearchReplaceResponse::NotFound { .. })
                    && !super::read_tracker::was_seen(&ctx.thread_id, &g.resolved)
                {
                    return Ok(if multi {
                        render_multi_needs_read(&g.raw, &g.resolved)
                    } else {
                        needs_read_json(&g.raw, &g.resolved)
                    });
                }
                let window = super::read_tracker::last_window(&ctx.thread_id, &g.resolved);
                return Ok(if multi {
                    render_multi_failure(&g.raw, &g.resolved, resp, window)
                } else {
                    render_response(&g.raw, &g.resolved, resp, true, None, window)
                });
            }
            prepared.push((g.raw.clone(), g.resolved.clone(), resp));
        }

        // Phase 2 — commit from the validated snapshots. The commit checks that
        // no file changed between planning and writing, and rolls back every
        // attempted write if a later write fails.
        let committed = tokio::task::spawn_blocking(move || commit_prepared_files(prepared))
            .await
            .map_err(|error| {
                ToolError::Execution(format!("file_edit commit task panicked: {error}"))
            })?
            .map_err(ToolError::Execution)?;

        let mut notes: Vec<Option<String>> = Vec::with_capacity(committed.len());
        for (_, resolved, _) in &committed {
            emit_post_write(&*self.sink, resolved, "file_edit", &ctx.tool_call_id).await;
            super::read_tracker::record(&ctx.thread_id, resolved);
            notes.push(super::index_note_after_write(ctx, resolved));
        }

        if committed.len() == 1 {
            let note = notes.into_iter().next().flatten();
            let (raw, resolved, resp) = committed.into_iter().next().unwrap();
            // Committed, so this renders a success: no window to explain.
            return Ok(render_response(
                &raw,
                &resolved,
                resp,
                true,
                note.as_deref(),
                None,
            ));
        }
        // Multi-file: each note names its file, or the model cannot tell whose
        // callers it is being warned about.
        let joined = committed
            .iter()
            .zip(&notes)
            .filter_map(|((raw, _, _), note)| note.as_ref().map(|n| format!("{raw} — {n}")))
            .collect::<Vec<_>>()
            .join(" ");
        let impact = (!joined.is_empty()).then_some(joined.as_str());
        Ok(render_multi_success(&committed, impact))
    }
}

type PreparedEdit = (String, String, SearchReplaceResponse);

fn commit_prepared_files(mut files: Vec<PreparedEdit>) -> Result<Vec<PreparedEdit>, String> {
    commit_prepared_files_with(
        &files,
        |path| std::fs::read_to_string(path),
        |path, content| {
            std::fs::write(path, content)?;
            crate::file_cache::get_file_cache().invalidate(path);
            Ok(())
        },
    )?;

    for (_, _, response) in &mut files {
        if let SearchReplaceResponse::Ok { wrote_to_disk, .. } = response {
            *wrote_to_disk = true;
        }
    }
    Ok(files)
}

fn commit_prepared_files_with<Read, Write>(
    files: &[PreparedEdit],
    mut read: Read,
    mut write: Write,
) -> Result<(), String>
where
    Read: FnMut(&str) -> std::io::Result<String>,
    Write: FnMut(&str, &str) -> std::io::Result<()>,
{
    let mut committed = Vec::with_capacity(files.len());

    for (index, (_, path, response)) in files.iter().enumerate() {
        let SearchReplaceResponse::Ok {
            original_content,
            new_content,
            ..
        } = response
        else {
            return Err(format!("internal error: unplanned response for {path}"));
        };

        let current = read(path).map_err(|error| {
            rollback_error(
                format!("failed to re-read {path} before commit: {error}"),
                files,
                &committed,
                &mut write,
            )
        })?;
        if current != *original_content {
            return Err(rollback_error(
                format!("{path} changed after it was validated; no batch edits were kept"),
                files,
                &committed,
                &mut write,
            ));
        }

        if let Err(error) = write(path, new_content) {
            let mut attempted = committed.clone();
            attempted.push(index);
            return Err(rollback_error(
                format!("failed to write {path}: {error}"),
                files,
                &attempted,
                &mut write,
            ));
        }
        committed.push(index);
    }

    Ok(())
}

fn rollback_error<Write>(
    cause: String,
    files: &[PreparedEdit],
    attempted: &[usize],
    write: &mut Write,
) -> String
where
    Write: FnMut(&str, &str) -> std::io::Result<()>,
{
    let failures: Vec<String> = attempted
        .iter()
        .rev()
        .filter_map(|&index| {
            let (_, path, response) = &files[index];
            let SearchReplaceResponse::Ok {
                original_content, ..
            } = response
            else {
                return Some(format!("{path}: original snapshot unavailable"));
            };
            write(path, original_content)
                .err()
                .map(|error| format!("{path}: {error}"))
        })
        .collect();

    if failures.is_empty() {
        format!("{cause}; all attempted writes were rolled back")
    } else {
        format!("{cause}; rollback also failed for: {}", failures.join(", "))
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

/// Diagnosis for a match that failed on a file the agent never read.
///
/// Not a precondition any more — by the time this renders, the edit was
/// attempted and the text genuinely was not there. Never having read the file
/// is the most likely reason, and it is the one with a concrete next step, so
/// it leads. Saying only "could not find the specified text" sends the agent
/// back to guess at indentation it has never seen.
fn needs_read_json(raw_path: &str, resolved_str: &str) -> String {
    serde_json::to_string(&json!({
        "success": false,
        "error": format!(
            "Could not find that text in {raw_path}, which has not been read this session — \
             so the text being matched was never seen. Nothing was changed."
        ),
        "path": raw_path,
        "fullPath": resolved_str,
        "hint": "Call file_read on this path, then retry the edit with text copied from it.",
        "needsRead": true,
    }))
    .unwrap()
}

/// Multi-file variant of the same diagnosis — names the offending file and
/// makes clear the whole batch was rolled back.
fn render_multi_needs_read(raw_path: &str, resolved_str: &str) -> String {
    serde_json::to_string(&json!({
        "success": false,
        "multiFile": true,
        "error": format!(
            "Could not find that text in {raw_path}, which has not been read this session — \
             so the text being matched was never seen. The batch is atomic: no files were changed."
        ),
        "path": raw_path,
        "fullPath": resolved_str,
        "hint": "Call file_read on this path, then retry the batch with text copied from it.",
        "needsRead": true,
    }))
    .unwrap()
}

/// The one read-before-edit refusal that remains a PRECONDITION.
///
/// `replace_all` waives the uniqueness requirement, so it is the only form that
/// can rewrite occurrences the agent has never laid eyes on. Refusing it on an
/// unread file is not about trusting the match — the match may well be right —
/// it is that neither the agent nor the user can know how many places it hits.
fn blind_replace_all_json(raw_path: &str, resolved_str: &str) -> String {
    serde_json::to_string(&json!({
        "success": false,
        "error": format!(
            "replace_all on {raw_path} needs the file read first: it rewrites EVERY occurrence, \
             including ones outside the part you have seen. Nothing was changed."
        ),
        "path": raw_path,
        "fullPath": resolved_str,
        "hint": "Either call file_read on this path and retry, or drop replace_all and match a \
                 unique string instead.",
        "needsRead": true,
    }))
    .unwrap()
}

/// Multi-file variant of the `replace_all` precondition.
fn render_multi_blind_replace_all(raw_path: &str, resolved_str: &str) -> String {
    serde_json::to_string(&json!({
        "success": false,
        "multiFile": true,
        "error": format!(
            "replace_all on {raw_path} needs the file read first: it rewrites EVERY occurrence, \
             including ones outside the part you have seen. The batch is atomic: no files were \
             changed."
        ),
        "path": raw_path,
        "fullPath": resolved_str,
        "hint": "Either call file_read on this path and retry, or drop replace_all and match a \
                 unique string instead.",
        "needsRead": true,
    }))
    .unwrap()
}

/// Render a validation failure for a multi-file batch. Nothing was written;
/// the message names the file and the 1-based edit that failed within it.
fn render_multi_failure(
    raw_path: &str,
    full_path: &str,
    response: SearchReplaceResponse,
    window: Option<(usize, usize, usize)>,
) -> String {
    let mut diagnosis_payload = None;
    let (error, failed_at, occurrences) = match response {
        // `failed_at` counts within THIS FILE's edits, not across the batch —
        // it is `index + 1` over the replacements planned for one path. Read as
        // a batch position it points at the wrong edit entirely, and a bare
        // "(edit 1)" beside a multi-file failure invites exactly that. Naming
        // the scope in the string is cheaper than being misread on a failure
        // path, which is the one place the reader is already off balance.
        SearchReplaceResponse::NotFound {
            failed_at,
            diagnosis,
        } => {
            // Same reasoning as the single-file branch: name the characters
            // that differ instead of sending the caller off to re-check line
            // endings and indentation, which are almost never the cause.
            let detail = diagnosis.as_ref().map(describe_diagnosis);
            diagnosis_payload = diagnosis;
            (
                match detail {
                    Some(detail) => format!(
                        "{raw_path} (this file's edit {failed_at}): no match for old_string.\n\
                         {detail}"
                    ),
                    None => format!(
                        "{raw_path} (this file's edit {failed_at}): no match for old_string, and \
                         nothing in the file resembles it."
                    ),
                },
                failed_at,
                None,
            )
        }
        SearchReplaceResponse::NotUnique {
            failed_at,
            occurrences,
        } => (
            format!(
                "{raw_path} (this file's edit {failed_at}): found {occurrences} occurrences. Add \
                 more context or set replace_all=true."
            ),
            failed_at,
            Some(occurrences),
        ),
        SearchReplaceResponse::Overlap {
            failed_at,
            conflicting_replacement,
        } => (
            format!(
                "{raw_path} (this file's edit {failed_at}): overlaps its edit \
                 {conflicting_replacement} in the same file. Combine the nearby edits."
            ),
            failed_at,
            None,
        ),
        // Unreachable: only non-Ok responses reach here.
        SearchReplaceResponse::Ok { .. } => ("unexpected success".to_string(), 0, None),
    };
    let mut payload = json!({
        "success": false,
        "multiFile": true,
        "error": error,
        "failedPath": raw_path,
        "fullPath": full_path,
        "failedAt": failed_at,
        "occurrences": occurrences,
        "hint": "No files were changed — a batch applies to every file or none. Fix this edit and retry.",
    });
    if let Some(note) = window_note(window) {
        let hint = payload["hint"].as_str().unwrap_or_default();
        payload["hint"] = json!(format!("{note} {hint}"));
    }
    if let Some(detail) = diagnosis_payload {
        payload["diagnosis"] = json!(detail);
    }
    serde_json::to_string(&payload).unwrap()
}

/// Render a successful multi-file batch. Each entry carries its own before/after
/// (capped per side via [`diff_side`]) so the Review panel can draw a real diff
/// for every file the call touched.
fn render_multi_success(
    committed: &[(String, String, SearchReplaceResponse)],
    impact: Option<&str>,
) -> String {
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
    let mut payload = json!({
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
    });
    // Only when there is something to say — see `render_response`.
    if let Some(note) = impact {
        payload["impact"] = json!(note);
    }
    serde_json::to_string(&payload).unwrap()
}

/// Build a corrective message for a missing `path` in the single-edit form.
///
/// The batch form is handled in [`FileEditTool::run_batch`] (which accepts a
/// per-item `path`), so this is only reached when the caller passed
/// `old_string`/`new_string` at the top level without naming a file.
/// `file_edit` is the one write tool that CAN touch several files in a single
/// call — through `edits`, never through a list in `path`. "I meant to change
/// three files" is the most common thing sitting behind a refused `path`, so
/// every one of its refusals points at the form that does it.
fn with_batch_hint(err: ToolError) -> ToolError {
    match err {
        ToolError::InvalidInput(message) => ToolError::InvalidInput(format!(
            "{message} To change several files in one call, pass `edits` — an array whose items \
             each carry their own `path`."
        )),
        other => other,
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
            thread_id: "s".into(),
            workspace_root: workspace,
            workspace_access: Default::default(),
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    /// Seed the read-tracker as if the agent had read the file, so the
    /// guard lets the edit through. Mirrors what file_read does in prod.
    fn mark_read(ctx: &ToolContext, abs: &std::path::Path) {
        let canonical = dunce::canonicalize(abs).unwrap();
        super::super::read_tracker::record(&ctx.thread_id, &canonical.to_string_lossy());
    }

    /// A batch failure numbers the edit WITHIN its file (`index + 1` over that
    /// one path's replacements), never across the whole batch. Aurora's own
    /// harness run read a bare "(edit 1)" as a batch position and concluded the
    /// index was zero-based; it was not, but the string gave it no way to tell.
    /// The number was always right, so this pins the scope, not the arithmetic.
    #[test]
    fn a_batch_failure_says_which_edit_list_it_is_counting() {
        for (response, expected) in [
            (
                SearchReplaceResponse::NotFound {
                    failed_at: 1,
                    diagnosis: None,
                },
                "no match for old_string",
            ),
            (
                SearchReplaceResponse::NotUnique {
                    failed_at: 1,
                    occurrences: 2,
                },
                "found 2 occurrences",
            ),
            (
                SearchReplaceResponse::Overlap {
                    failed_at: 1,
                    conflicting_replacement: 2,
                },
                "overlaps",
            ),
        ] {
            let rendered = render_multi_failure("src/math.ts", "E:/ws/src/math.ts", response, None);
            let parsed: Value = serde_json::from_str(&rendered).unwrap();
            let error = parsed["error"].as_str().unwrap();
            assert!(
                error.contains("this file's edit 1"),
                "every batch failure names what the ordinal counts, got: {error}"
            );
            assert!(error.contains(expected), "got: {error}");
            assert_eq!(parsed["failedAt"], 1, "the number itself was always right");
            assert_eq!(parsed["multiFile"], true);
        }
    }

    #[test]
    fn schema_exposes_early_multi_file_targets() {
        let tool = FileEditTool::new(Arc::new(crate::tools::shell_editor_todo::NoopIdeEventSink));
        let schema = tool.schema();
        assert_eq!(
            schema.input_schema["properties"][streaming_targets::FIELD]["items"]["type"],
            "string"
        );
        let first_property = schema.input_schema["properties"]
            .as_object()
            .and_then(|properties| properties.keys().next())
            .map(String::as_str);
        assert_eq!(first_property, Some(streaming_targets::FIELD));
        assert!(schema.description.contains(streaming_targets::RULE));
    }

    /// The property order Aurora authors is only worth anything if it is still
    /// the order on the wire. `provider_kernel_adapter` copies `input_schema`
    /// into the request body verbatim, so this reads the order back OUT OF THE
    /// SERIALIZED STRING rather than out of the in-memory map — which is what
    /// would break first if `serde_json`'s `preserve_order` feature were ever
    /// dropped, silently and everywhere at once.
    #[test]
    fn authored_property_order_survives_serialization() {
        let tool = FileEditTool::new(Arc::new(crate::tools::shell_editor_todo::NoopIdeEventSink));
        let body = serde_json::to_string(&serde_json::json!({
            "input_schema": tool.schema().input_schema,
        }))
        .expect("serialize");
        let announce = body
            .find(&format!("\"{}\"", streaming_targets::FIELD))
            .expect("announce field present");
        for later in ["\"path\"", "\"old_string\"", "\"new_string\"", "\"edits\""] {
            let at = body.find(later).expect("property present");
            assert!(
                announce < at,
                "{} must reach the wire before {later}",
                streaming_targets::FIELD,
            );
        }
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

    /// The single-edit form still refuses a call with no file in it, and the
    /// refusal names both ways out: `path`, or the batch form.
    #[tokio::test]
    async fn missing_path_single_form_is_helpful() {
        let ctx = ctx_for(None);
        let err = FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        ))
        .execute(
            serde_json::json!({ "old_string": "x", "new_string": "y" }),
            &ctx,
        )
        .await
        .expect_err("a call naming no file must be refused");
        let msg = err.to_string();
        assert!(msg.contains("the file to edit"), "got: {msg}");
        assert!(msg.contains("`edits`"), "got: {msg}");
    }

    /// The trap this tool sets for itself: its own description orders
    /// `affected_paths` emitted FIRST for every call, so a model that names the
    /// file there and stops has followed the schema as written. One file named
    /// once is not ambiguous, so the edit runs.
    #[tokio::test]
    async fn the_one_file_in_affected_paths_is_the_file_to_edit() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a.txt");
        std::fs::write(&file, "alpha\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &file);

        let out = FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        ))
        .execute(
            serde_json::json!({
                "affected_paths": ["a.txt"],
                "old_string": "alpha",
                "new_string": "omega",
            }),
            &ctx,
        )
        .await
        .expect("one file named once is not ambiguous");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true, "got: {out}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "omega\n");
    }

    /// Two files named and no `path` is a choice, and this tool does not make
    /// it — it points at the form that expresses the intent properly.
    #[tokio::test]
    async fn two_files_in_affected_paths_is_refused_with_the_batch_form() {
        let ctx = ctx_for(None);
        let err = FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        ))
        .execute(
            serde_json::json!({
                "affected_paths": ["a.txt", "b.txt"],
                "old_string": "x",
                "new_string": "y",
            }),
            &ctx,
        )
        .await
        .expect_err("two candidates must never be chosen between");
        let msg = err.to_string();
        assert!(msg.contains("names 2 files"), "got: {msg}");
        assert!(msg.contains("`edits`"), "got: {msg}");
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

    fn edit_tool() -> Arc<dyn ToolExecutor> {
        Arc::new(FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )))
    }

    /// The false refusal this guard used to produce. The agent can obtain exact
    /// text from a search hit or `code` output, neither of which the read
    /// tracker can observe — so an exact, unique match on an unread file is a
    /// legitimate edit and must apply.
    #[tokio::test]
    async fn edits_an_unread_file_when_the_text_matches_exactly() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("unseen.txt");
        std::fs::write(&file, "data\n").unwrap();
        // Deliberately NO mark_read.
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        let out = edit_tool()
            .execute(
                serde_json::json!({ "path": "unseen.txt", "old_string": "data", "new_string": "x" }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "x\n");
    }

    /// When the match genuinely fails, never having read the file is the
    /// actionable cause and must be what the result says.
    #[tokio::test]
    async fn an_unread_file_is_named_as_the_cause_when_the_text_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("unseen-miss.txt");
        std::fs::write(&file, "data\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        let out = edit_tool()
            .execute(
                serde_json::json!({
                    "path": "unseen-miss.txt",
                    "old_string": "text that is not there",
                    "new_string": "x"
                }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert_eq!(parsed["needsRead"], true);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "data\n");
    }

    /// A miss on a file the agent DID read is an ordinary not-found — telling
    /// it to read a file it already read would send it in a circle.
    #[tokio::test]
    async fn a_miss_on_a_read_file_is_an_ordinary_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("seen-miss.txt");
        std::fs::write(&file, "data\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &file);
        let out = edit_tool()
            .execute(
                serde_json::json!({
                    "path": "seen-miss.txt",
                    "old_string": "text that is not there",
                    "new_string": "x"
                }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed.get("needsRead").is_none());
    }

    /// The one precondition that survives: `replace_all` waives uniqueness, so
    /// on an unread file it can rewrite occurrences nobody has seen.
    #[tokio::test]
    async fn replace_all_still_requires_a_prior_read() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("many.txt");
        std::fs::write(&file, "a a a\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        let out = edit_tool()
            .execute(
                serde_json::json!({
                    "path": "many.txt",
                    "old_string": "a",
                    "new_string": "b",
                    "replace_all": true
                }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert_eq!(parsed["needsRead"], true);
        assert!(parsed["error"].as_str().unwrap().contains("replace_all"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "a a a\n");
    }

    /// The exact shape that was reported: three files edited in one batch, one
    /// of them located by search rather than opened. The batch must apply.
    #[tokio::test]
    async fn a_batch_applies_when_only_some_targets_were_read() {
        let tmp = tempfile::tempdir().unwrap();
        let read_file = tmp.path().join("read.ts");
        let searched_file = tmp.path().join("searched.css");
        std::fs::write(&read_file, "alpha\n").unwrap();
        std::fs::write(&searched_file, ".rule { color: red }\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &read_file); // only this one was opened

        let out = edit_tool()
            .execute(
                serde_json::json!({
                    "edits": [
                        { "path": "read.ts", "old_string": "alpha", "new_string": "ALPHA" },
                        { "path": "searched.css", "old_string": "color: red", "new_string": "color: blue" }
                    ]
                }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true, "batch result was {out}");
        assert_eq!(parsed["filesEdited"], 2);
        assert_eq!(std::fs::read_to_string(&read_file).unwrap(), "ALPHA\n");
        assert_eq!(
            std::fs::read_to_string(&searched_file).unwrap(),
            ".rule { color: blue }\n"
        );
    }

    fn prepared(path: &str, original: &str, new_content: &str) -> PreparedEdit {
        (
            path.to_string(),
            path.to_string(),
            SearchReplaceResponse::Ok {
                original_content: original.to_string(),
                new_content: new_content.to_string(),
                line_ending_normalized: false,
                lines_added: 0,
                lines_removed: 0,
                total_replacements: 1,
                replacement_details: Vec::new(),
                wrote_to_disk: false,
                typography_repairs: Vec::new(),
            },
        )
    }

    #[test]
    fn commit_rolls_back_every_attempted_file_when_a_later_write_fails() {
        use std::cell::{Cell, RefCell};
        use std::collections::HashMap;

        let files = vec![
            prepared("a", "old-a", "new-a"),
            prepared("b", "old-b", "new-b"),
        ];
        let disk = RefCell::new(HashMap::from([
            ("a".to_string(), "old-a".to_string()),
            ("b".to_string(), "old-b".to_string()),
        ]));
        let failed = Cell::new(false);

        let error = commit_prepared_files_with(
            &files,
            |path| {
                disk.borrow().get(path).cloned().ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "missing test file")
                })
            },
            |path, content| {
                if path == "b" && content == "new-b" && !failed.replace(true) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "injected failure",
                    ));
                }
                disk.borrow_mut()
                    .insert(path.to_string(), content.to_string());
                Ok(())
            },
        )
        .expect_err("second write must fail");

        assert!(error.contains("all attempted writes were rolled back"));
        assert_eq!(disk.borrow().get("a").unwrap(), "old-a");
        assert_eq!(disk.borrow().get("b").unwrap(), "old-b");
    }

    #[test]
    fn commit_rejects_stale_snapshot_and_rolls_back_earlier_files() {
        use std::cell::RefCell;
        use std::collections::HashMap;

        let files = vec![
            prepared("a", "old-a", "new-a"),
            prepared("b", "old-b", "new-b"),
        ];
        let disk = RefCell::new(HashMap::from([
            ("a".to_string(), "old-a".to_string()),
            ("b".to_string(), "changed-elsewhere".to_string()),
        ]));

        let error = commit_prepared_files_with(
            &files,
            |path| {
                disk.borrow().get(path).cloned().ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "missing test file")
                })
            },
            |path, content| {
                disk.borrow_mut()
                    .insert(path.to_string(), content.to_string());
                Ok(())
            },
        )
        .expect_err("stale second file must abort the batch");

        assert!(error.contains("changed after it was validated"));
        assert_eq!(disk.borrow().get("a").unwrap(), "old-a");
        assert_eq!(disk.borrow().get("b").unwrap(), "changed-elsewhere");
    }
}
