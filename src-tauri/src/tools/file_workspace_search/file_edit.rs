//! `file_edit` — the one surgical editor. Exact-text find-and-replace,
//! single or batch. In a batch a failed edit is skipped and reported; the
//! rest apply.
//!
//! This is the unified replacement for the old `search_replace` /
//! `multi_search_replace` / `file_patch` trio: one tool, two shapes.
//! "Search and replace" names the *mechanism*; "edit" names the
//! *intent* — they are the same operation, so we expose one door.
//! The backing engine is unchanged: it still calls
//! `crate::workspace::edit::apply_search_replace` /
//! `apply_multi_search_replace` and renders results via the shared
//! [`super::search_replace`] helpers, so matching, uniqueness,
//! `replace_all`, rollback of a failed disk write, and the Review-panel diff payload
//! all behave exactly as before.
//!
//! ## Read before you change
//!
//! `file_edit` refuses to touch an existing file this conversation has not
//! seen any of — a `file_read` window, a `grep` hit or a `code` passage all
//! count. See [`super::read_gate`]. The refusal is a graceful `success:false`
//! naming the file's size, so the model reads and retries rather than
//! hard-failing the turn.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::workspace::edit::{
    apply_multi_search_replace, apply_search_replace, ApplyMultiSearchReplaceRequest,
    ApplySearchReplaceRequest, SearchReplaceItem, SearchReplaceResponse,
};
use crate::tools::shell_editor_todo::IdeEventSink;

use super::resolve_path_with_access;
use super::search_replace::{
    describe_diagnosis, diff_side, emit_post_write, render_response, window_note,
    with_line_number_hint,
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
    /// repaired and applied (`editor_ops::recover_typographic`). So is one
    /// whose only fault is a level of string escaping the caller's serializer
    /// added (`editor_ops::recover_overescaped`). This description does **not**
    /// say so, and that is the point.
    ///
    /// The contract stays "match exactly", because it is still true and it is
    /// still the instruction that produces correct calls. Advertising the net
    /// would teach carelessness across the board while the net covers exactly
    /// two classes — indentation and trailing whitespace are still hard
    /// failures, and so is text the file simply does not contain. A model told
    /// "Aurora fixes my quotes" has no way to learn where the fixing stops.
    ///
    /// Both nets share one rule: they change how the caller's text is READ,
    /// never what the file says. The file is never folded, rewritten or
    /// re-escaped to meet a pattern halfway, and a recovered match must still
    /// be exact and unique or it is refused.
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
                          Every edit matches against its file's original snapshot. An edit that \
                          fails is not applied and the others are: the result lists each failed \
                          edit by number with the reason, so send only those again. old_string must match \
                          exactly and be unique unless replace_all=true. An existing file must have \
                          been seen in this conversation first: a file_read of any part, or a grep \
                          or code search that returned its lines. Copy old_string from that text. \
                          replace_all=true additionally REQUIRES a complete read of the current \
                          file, because it rewrites occurrences you have not seen. When no match \
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
                        // "across all targeted files" used to stand where the
                        // second sentence is. It was the only place the batch
                        // form said where its files come from, and "targeted"
                        // is the word `affected_paths` was named after until
                        // 2026-08-20 (`streaming_targets::LEGACY_FIELD`). A
                        // model reading the array description and skipping the
                        // nested `path` one was being told, in Aurora's own
                        // words, to take its files from the streaming field.
                        "description": "Batch form: array of edits, each matched against its file's original snapshot; a failed edit is skipped and reported, the rest apply. Each item's own `path` chooses the file that edit belongs to, falling back to the top-level `path`; the file is never taken from `affected_paths`. Matched regions in the same file must not overlap."
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

        // Batch form takes priority when present. `edits_argument` reads the
        // canonical key, its `replacements` alias, and the forms that can only
        // mean the batch — a misspelled key, the array written as a string, a
        // single edit sent unwrapped — reporting whatever it assumed.
        if let Some(batch) = super::edits_argument::resolve(&input) {
            let note = batch.note.clone();
            let mut result = self.run_batch(&batch.items, top_path, &input, ctx).await?;
            if let Some(note) = note {
                result = with_argument_note(&result, &note);
            }
            return Ok(result);
        }
        if let Some(arr) = input
            .get("edits")
            .and_then(Value::as_array)
            .or_else(|| input.get("replacements").and_then(Value::as_array))
        {
            // Only an EMPTY array reaches here — `edits_argument` claims every
            // batch that has something in it.
            debug_assert!(arr.is_empty());
            return Err(ToolError::InvalidInput(
                "`edits` must be a non-empty array".into(),
            ));
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
            .ok_or_else(|| ToolError::InvalidInput(no_edit_named(&input)))?;
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
        if new_string == old_string {
            return Err(ToolError::InvalidInput(
                "`new_string` is identical to `old_string`, so this edit changes nothing. \
                 Nothing was written."
                    .into(),
            ));
        }
        let replace_all = input
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // Read before you change — `read_gate`. This also covers `replace_all`,
        // which used to be the only form gated here.
        if let Some(refusal) = super::read_gate::refuse_unread(
            ctx,
            super::read_gate::Change::Edit,
            &raw_path,
            &resolved_str,
        )
        .await
        {
            return Ok(refusal.to_string());
        }

        let mut response = apply_search_replace(ApplySearchReplaceRequest {
            path: resolved_str.clone(),
            replacement: SearchReplaceItem {
                old_string: old_string.to_string(),
                new_string,
                replace_all,
            },
            write: false,
        })
        .await
        .map_err(ToolError::Execution)?;

        if let SearchReplaceResponse::Ok {
            original_content, ..
        } = &response
        {
            if replace_all
                && !super::read_tracker::matches_content(
                    &ctx.thread_id,
                    &resolved_str,
                    original_content,
                )
            {
                return Ok(fresh_read_required(&raw_path, &resolved_str, false, &ctx.thread_id));
            }
            let prepared = vec![(raw_path.clone(), resolved_str.clone(), response)];
            response = tokio::task::spawn_blocking(move || commit_prepared_files(prepared))
                .await
                .map_err(|error| {
                    ToolError::Execution(format!("file_edit commit task panicked: {error}"))
                })?
                .map_err(ToolError::Execution)?
                .remove(0)
                .2;
        }

        let mut impact = None;
        if matches!(response, SearchReplaceResponse::Ok { .. }) {
            emit_post_write(&*self.sink, &resolved_str, "file_edit", &ctx.tool_call_id).await;
            if let SearchReplaceResponse::Ok {
                original_content,
                new_content,
                ..
            } = &response
            {
                super::read_tracker::record_edit(
                    &ctx.thread_id,
                    &resolved_str,
                    original_content,
                    new_content,
                );
            }
            impact = super::index_note_after_write(ctx, &resolved_str);
        }

        let _ = Path::new("");
        Ok(with_line_number_hint(
            render_response(
                &raw_path,
                &resolved_str,
                response,
                false,
                impact.as_deref(),
                super::read_tracker::last_window(&ctx.thread_id, &resolved_str),
            ),
            &[old_string],
        ))
    }
}

impl FileEditTool {
    /// Run the batch (`edits[]`) form. Edits are grouped by their resolved
    /// file — one file, or many — and planned against their original
    /// snapshots first (no disk writes). An edit that fails is set aside with
    /// its reason and the rest are committed together; the result names every
    /// edit that was not applied. The commit itself stays all-or-nothing: if
    /// one file cannot be written, the files already written are rolled back.
    ///
    /// `input` is the whole call, carried in only so a missing per-item `path`
    /// can be explained against what the model actually sent — see
    /// [`super::path_argument::batch_item_without_path`].
    /// Run the batch, then say what had to be worked out to run it.
    ///
    /// The note is attached here rather than inside the body because the body
    /// returns through half a dozen paths, and a resolution the result does not
    /// mention is a silent one.
    async fn run_batch(
        &self,
        arr: &[Value],
        top_path: Option<&str>,
        input: &Value,
        ctx: &ToolContext,
    ) -> Result<String, ToolError> {
        let mut resolved_by_content: Vec<(usize, String)> = Vec::new();
        let result = self
            .run_batch_inner(arr, top_path, input, ctx, &mut resolved_by_content)
            .await?;
        Ok(match content_resolution_note(&resolved_by_content) {
            Some(note) => with_argument_note(&result, &note),
            None => result,
        })
    }

    async fn run_batch_inner(
        &self,
        arr: &[Value],
        top_path: Option<&str>,
        input: &Value,
        ctx: &ToolContext,
        resolved_by_content: &mut Vec<(usize, String)>,
    ) -> Result<String, ToolError> {
        // Build per-file groups, preserving first-seen order so the result
        // lists files in the order the agent wrote them.
        let mut groups: Vec<FileGroup> = Vec::new();
        let mut index_by_resolved: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();

        // Files the call named but did not assign to any edit, and their
        // contents once read. Only touched when an item arrives without a
        // `path`, so an ordinary well-formed batch reads nothing extra.
        let candidates = super::path_argument::candidate_paths(input);
        let mut candidate_contents: std::collections::HashMap<String, Option<String>> =
            std::collections::HashMap::new();
        let mut skipped: Vec<FailedEdit> = Vec::new();

        for (idx, rep) in arr.iter().enumerate() {
            let n = idx + 1;
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
            // `path` on the item, then the shared top-level `path`, then the
            // file whose text this edit actually matches. The last step is a
            // resolution, not a guess — see `resolve_by_content`.
            let resolved_from_content;
            let raw_path = match rep.get("path").and_then(Value::as_str).or(top_path) {
                Some(path) => path,
                None => {
                    let outcome =
                        resolve_by_content(&candidates, old_string, ctx, &mut candidate_contents);
                    match outcome {
                        ContentResolution::Resolved(path) => {
                            resolved_by_content.push((n, path.clone()));
                            resolved_from_content = path;
                            &resolved_from_content
                        }
                        other => {
                            return Err(ToolError::InvalidInput(
                                super::path_argument::batch_item_without_path(
                                    input,
                                    n,
                                    match other {
                                        ContentResolution::NoneMatched => {
                                            super::path_argument::ContentLookup::NoneMatched
                                        }
                                        ContentResolution::Ambiguous(count) => {
                                            super::path_argument::ContentLookup::Ambiguous(count)
                                        }
                                        _ => super::path_argument::ContentLookup::NotAttempted,
                                    },
                                ),
                            ))
                        }
                    }
                }
            };
            let new_string = rep
                .get("new_string")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ToolError::InvalidInput(format!("Edit {n}: `new_string` is required"))
                })?;
            // A no-op is the most harmless failure there is, so it costs this
            // edit only, like every other per-edit problem (dogfood F31).
            if new_string == old_string {
                skipped.push(FailedEdit {
                    number: n,
                    rendered: json!({
                        "success": false,
                        "failedPath": raw_path,
                        "error": format!(
                            "Edit {n}: `new_string` is identical to `old_string`, so it changes \
                             nothing. It was not applied."
                        ),
                    })
                    .to_string(),
                });
                continue;
            }
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
                Some(&i) => {
                    groups[i].items.push(item);
                    groups[i].numbers.push(n);
                }
                None => {
                    index_by_resolved.insert(resolved_str.clone(), groups.len());
                    groups.push(FileGroup {
                        raw: raw_path.to_string(),
                        resolved: resolved_str,
                        items: vec![item],
                        numbers: vec![n],
                    });
                }
            }
        }

        let multi = groups.len() > 1;

        // Read before you change — `read_gate`. A file this chat has not seen
        // costs its own edits only; the other files in the call still apply.
        // `grep` and `code` search hits count as seen, which is what the
        // 2026-08-11 narrowing of the old gate was really asking for.
        //
        // Phase 1 — plan every file against its original snapshot. An edit that
        // fails is set aside with its own diagnosis and the file is planned
        // again without it, so one bad `old_string` costs that edit only. It
        // used to abort the whole call: three files, two correct edits, one
        // typo, and nothing written. The model then resent all three.
        let mut prepared: Vec<(String, String, SearchReplaceResponse)> =
            Vec::with_capacity(groups.len());
        let mut failed: Vec<FailedEdit> = skipped;
        let mut unchanged: Vec<String> = Vec::new();
        for g in &groups {
            let mut items = g.items.clone();
            let mut numbers = g.numbers.clone();
            if let Some(mut refusal) = super::read_gate::refuse_unread(
                ctx,
                super::read_gate::Change::Edit,
                &g.raw,
                &g.resolved,
            )
            .await
            {
                if multi {
                    refusal["multiFile"] = json!(true);
                }
                let rendered = refusal.to_string();
                for number in numbers.drain(..) {
                    failed.push(FailedEdit {
                        number,
                        rendered: rendered.clone(),
                    });
                }
                items.clear();
            }
            while !items.is_empty() {
                let resp = apply_multi_search_replace(ApplyMultiSearchReplaceRequest {
                    path: g.resolved.clone(),
                    replacements: items.clone(),
                    write: false,
                })
                .await
                .map_err(ToolError::Execution)?;
                if let SearchReplaceResponse::Ok {
                    original_content, ..
                } = &resp
                {
                    if items.iter().any(|item| item.replace_all)
                        && !super::read_tracker::matches_content(
                            &ctx.thread_id,
                            &g.resolved,
                            original_content,
                        )
                    {
                        let rendered =
                            fresh_read_required(&g.raw, &g.resolved, multi, &ctx.thread_id);
                        take_where(&mut items, &mut numbers, |item| item.replace_all)
                            .into_iter()
                            .for_each(|number| {
                                failed.push(FailedEdit {
                                    number,
                                    rendered: rendered.clone(),
                                })
                            });
                        continue;
                    }
                    prepared.push((g.raw.clone(), g.resolved.clone(), resp));
                    break;
                }
                let at = failed_position(&resp).clamp(1, items.len()) - 1;
                // The planner counts within this file's remaining list; the
                // model counts its `edits` array. Speak the model's numbers
                // everywhere in the message (dogfood F32).
                let resp = renumbered(resp, &numbers);
                let window = super::read_tracker::last_window(&ctx.thread_id, &g.resolved);
                let sent: Vec<&str> = items.iter().map(|item| item.old_string.as_str()).collect();
                let rendered = with_line_number_hint(
                    if multi {
                        render_multi_failure(&g.raw, &g.resolved, resp, window)
                    } else {
                        render_response(&g.raw, &g.resolved, resp, true, None, window)
                    },
                    &sent,
                );
                failed.push(FailedEdit {
                    number: numbers[at],
                    rendered,
                });
                items.remove(at);
                numbers.remove(at);
            }
            if items.is_empty() {
                unchanged.push(g.raw.clone());
            }
        }
        failed.sort_by_key(|failure| failure.number);

        // Nothing applied and one cause: answer exactly as a single failure
        // always has.
        if prepared.is_empty() && failed.len() == 1 {
            return Ok(failed.remove(0).rendered);
        }
        if prepared.is_empty() {
            return Ok(render_batch_failures(arr.len(), &failed));
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
        for (_, resolved, response) in &committed {
            emit_post_write(&*self.sink, resolved, "file_edit", &ctx.tool_call_id).await;
            if let SearchReplaceResponse::Ok {
                original_content,
                new_content,
                ..
            } = response
            {
                super::read_tracker::record_edit(
                    &ctx.thread_id,
                    resolved,
                    original_content,
                    new_content,
                );
            }
            notes.push(super::index_note_after_write(ctx, resolved));
        }

        if !failed.is_empty() {
            let joined = committed
                .iter()
                .zip(&notes)
                .filter_map(|((raw, _, _), note)| note.as_ref().map(|n| format!("{raw} — {n}")))
                .collect::<Vec<_>>()
                .join(" ");
            let impact = (!joined.is_empty()).then_some(joined.as_str());
            return Ok(render_partial_success(
                &committed,
                impact,
                arr.len(),
                &failed,
                &unchanged,
            ));
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

fn fresh_read_required(path: &str, full_path: &str, multi: bool, thread_id: &str) -> String {
    // A file Aurora edited but nothing ever read whole has no snapshot at all.
    // "The file changed or was only partly read" was wrong there (F32).
    let error = if super::read_tracker::has_complete_read(thread_id, full_path) {
        "replace_all requires a complete read of the current file. The file changed or was only partly read. That edit was not applied; read the file again before retrying it."
    } else {
        "replace_all requires a complete file_read of this file's current version, and this conversation has none: the file was only edited or partly read. That edit was not applied; read the file, then retry it."
    };
    json!({
        "success": false, "needsRead": true, "multiFile": multi,
        "path": path, "fullPath": full_path,
        "error": error,
    }).to_string()
}

type PreparedEdit = (String, String, SearchReplaceResponse);

fn commit_prepared_files(mut files: Vec<PreparedEdit>) -> Result<Vec<PreparedEdit>, String> {
    commit_prepared_files_with(
        &files,
        |path| std::fs::read_to_string(path),
        |path, content| {
            super::write_retry::write_retrying_lock(path, content)?;
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
            // A write can fail partway (truncated, then out of space), so the
            // failed file is restored too — unless it still reads as it did.
            // A write refused before it touched the file (another program
            // holding it) leaves nothing to restore, and "restoring" it hits
            // the same hold and reports a failed rollback for a file that was
            // never changed. That false alarm cost a model a call to check.
            let untouched = read(path).is_ok_and(|now| now == *original_content);
            if !untouched {
                attempted.push(index);
            }
            let note = if untouched {
                " (that file was not changed)"
            } else {
                ""
            };
            return Err(rollback_error(
                format!("failed to write {path}: {error}{note}"),
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

/// Which of a call's candidate files a pathless batch item belongs to.
enum ContentResolution {
    /// Exactly one candidate holds this `old_string`. Not a guess — the text
    /// is in that file and in no other file the call named.
    Resolved(String),
    /// The text is in none of them. Usually a stale `old_string`; the edit
    /// would have failed to match even with the right path.
    NoneMatched,
    /// Several hold it. This is the one case that is genuinely the model's to
    /// decide, and the refusal says so.
    Ambiguous(usize),
    /// Fewer than two candidates, so there was never a choice to resolve.
    NotApplicable,
}

/// Decide a pathless batch item's file from the text it matches.
///
/// ## Why this exists
///
/// `affected_paths` is ordered FIRST in the schema so the interface can label a
/// row while arguments stream ([`super::streaming_targets`] has the measurement
/// behind that). Models read the field that leads, fill it, and leave the
/// per-item `path` out — measured four times in one session on 2026-09-19, and
/// once more in thread `c4669acf`. The old answer was to refuse and explain the
/// batch form.
///
/// That refusal was right while the tool had only argument SHAPE to reason
/// from. It stops being right the moment the tool reads the files, because
/// `old_string` is exact text: the edit belongs to the candidate that contains
/// it. `path_argument` already resolves every other single-sensible-reading
/// case (a one-element list, a JSON-encoded array, one file in
/// `affected_paths`); this is that same rule reaching the case it never covered.
///
/// ## Why it cannot pick wrong
///
/// The text must be present in exactly one candidate. Two candidates holding it
/// is [`ContentResolution::Ambiguous`] and still refuses, because a write to the
/// wrong file is not something a later turn can discover. And resolution only
/// decides WHICH file to run against — the ordinary uniqueness and exact-match
/// rules still apply inside it, so a resolved path cannot turn a bad edit good.
fn resolve_by_content(
    candidates: &[String],
    old_string: &str,
    ctx: &ToolContext,
    cache: &mut std::collections::HashMap<String, Option<String>>,
) -> ContentResolution {
    if candidates.len() < 2 {
        return ContentResolution::NotApplicable;
    }

    let normalized = crate::workspace::edit::normalize_line_endings(old_string);
    // The same text with one escape level off, so a call that is BOTH
    // over-escaped and pathless resolves instead of failing twice. The engine
    // applies the same recovery once the file is chosen.
    let unescaped = crate::workspace::edit::unescape_once(&normalized)
        .map(|text| crate::workspace::edit::normalize_line_endings(&text));

    let mut hits: Vec<&String> = Vec::new();
    let mut readable = 0usize;
    for candidate in candidates {
        let Ok(resolved) =
            resolve_path_with_access(candidate, ctx.workspace_root.as_deref(), ctx.workspace_access)
        else {
            continue;
        };
        let key = resolved.to_string_lossy().to_string();
        let content = cache
            .entry(key)
            .or_insert_with_key(|path| crate::file_cache::read_file_cached(path).ok())
            .as_deref()
            .map(crate::workspace::edit::normalize_line_endings);
        let Some(content) = content else {
            continue;
        };
        readable += 1;
        let found = content.contains(&normalized)
            || unescaped.as_deref().is_some_and(|text| content.contains(text));
        if found {
            hits.push(candidate);
        }
    }

    // Nothing could be read, so nothing was tested. "The text is in none of
    // them" would be a claim about files this never opened — the same shape of
    // untrue answer the whole module exists to stop.
    if readable == 0 {
        return ContentResolution::NotApplicable;
    }

    match hits.len() {
        1 => ContentResolution::Resolved(hits[0].clone()),
        0 => ContentResolution::NoneMatched,
        n => ContentResolution::Ambiguous(n),
    }
}

/// One target file plus the ordered edits destined for it.
struct FileGroup {
    /// The path exactly as the agent wrote it (for messages / UI).
    raw: String,
    /// The canonical on-disk path (grouping key + write target).
    resolved: String,
    items: Vec<SearchReplaceItem>,
    /// Each item's 1-based position in the call's `edits` array, parallel to
    /// `items`, so a failure names the edit the model wrote.
    numbers: Vec<usize>,
}

/// One edit of a batch that was not applied, already rendered the way a
/// single failure renders, plus the batch position it held.
struct FailedEdit {
    number: usize,
    rendered: String,
}

/// Say what a repaired argument was read as, inside the result the tool
/// already returns.
///
/// A repair is never silent ([`super::path_argument`] holds the same rule): the
/// model sees the name it should have used, and the transcript shows the user
/// what was assumed. Attached rather than prepended so nothing about the
/// successful edit moves.
fn with_argument_note(result: &str, note: &str) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(result) else {
        return result.to_string();
    };
    let Some(object) = parsed.as_object_mut() else {
        return result.to_string();
    };
    // Two repairs can happen to one call — the batch array read out of a
    // string, and a pathless item resolved by its text. Replacing the note
    // would hide whichever landed first, which is exactly the silence this
    // field exists to prevent.
    let merged = match object.get("argumentNote").and_then(Value::as_str) {
        Some(existing) if !existing.is_empty() => format!("{existing} {note}"),
        _ => note.to_string(),
    };
    object.insert("argumentNote".into(), json!(merged));
    serde_json::to_string(&parsed).unwrap_or_else(|_| result.to_string())
}

/// Say which file each pathless edit was matched to, and on what evidence.
///
/// The model has to be able to check this. It names the file and the reason
/// ("its text is in that file and no other one you named") rather than
/// announcing a repair, because the next thing the model does is either accept
/// it or send the edit again with an explicit `path`.
fn content_resolution_note(resolved: &[(usize, String)]) -> Option<String> {
    if resolved.is_empty() {
        return None;
    }
    let field = streaming_targets::FIELD;
    let list = resolved
        .iter()
        .map(|(n, path)| format!("edit {n} → {path}"))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "No `path` on {} — each was matched to the one file in `{field}` that holds its \
         `old_string` ({list}). Set `path` per edit to say so directly.",
        if resolved.len() == 1 {
            "1 edit".to_string()
        } else {
            format!("{} edits", resolved.len())
        }
    ))
}

/// The refusal for a call that named no edit at all.
///
/// It lists the fields that DID arrive, because the sentence it replaced —
/// "supply either `edits` (array) or `old_string`+`new_string`" — is a true
/// statement about the tool and says nothing about the call. A model reading it
/// after sending `edites` looks at its own payload, sees the edits it wrote,
/// and starts theorising. Naming what arrived is what turns the retry into a
/// correction. Same rule as [`crate::agent_runtime::tool_executor::ToolError`]'s
/// malformed-input doc: never tell a model a field is missing without saying
/// what you received instead.
fn no_edit_named(input: &Value) -> String {
    let Some(object) = input.as_object().filter(|o| !o.is_empty()) else {
        return "supply either `edits` (an array of {old_string, new_string}) or a single \
                `old_string` + `new_string`. This call carried no arguments at all."
            .into();
    };

    // The batch key IS here and still did not produce edits, so its VALUE is
    // the fault and naming the key alone explains nothing. Found by the harness
    // rig, 2026-09-06: a double-escaped `edits` string was correctly refused
    // with "This call carried: `affected_paths`, `edits`" — a sentence that
    // sends the reader to look for a missing field that is right there.
    for key in ["edits", "replacements"] {
        let Some(value) = object.get(key) else {
            continue;
        };
        return match value {
            Value::String(text) => match serde_json::from_str::<Value>(text.trim()) {
                Err(error) => format!(
                    "`{key}` arrived as a string, and that string is not valid JSON ({error}). \
                     Send `{key}` as a real JSON array — `[{{\"old_string\": …}}]` — not as text. \
                     A string that parses is read for you; this one could not be parsed, most \
                     often because the quotes inside it were escaped twice."
                ),
                Ok(parsed) => format!(
                    "`{key}` arrived as a string holding {}, which is not an edit or a list of \
                     them. Send `{key}` as a JSON array of {{old_string, new_string}} objects.",
                    describe_shape(&parsed)
                ),
            },
            Value::Array(items) if items.is_empty() => {
                format!("`{key}` is an empty array. Send at least one {{old_string, new_string}}.")
            }
            other => format!(
                "`{key}` is {}, which is not a list of edits. Send `{key}` as an array of \
                 {{old_string, new_string}} objects, or use a single `old_string` + `new_string`.",
                describe_shape(other)
            ),
        };
    }

    format!(
        "supply either `edits` (an array of {{old_string, new_string}}) or a single \
         `old_string` + `new_string`. This call carried: {}.",
        object
            .iter()
            .map(|(key, value)| format!("`{key}` ({})", describe_shape(value)))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// What a value IS, in the words a person would use about a JSON payload.
fn describe_shape(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(_) => "a boolean".into(),
        Value::Number(_) => "a number".into(),
        Value::String(_) => "a string".into(),
        Value::Array(items) => format!("an array of {}", items.len()),
        Value::Object(fields) => format!("an object with {} field(s)", fields.len()),
    }
}

/// Render one failed edit of a multi-file batch. That edit was not applied;
/// the message names the file and the 1-based edit that failed within it.
fn render_multi_failure(
    raw_path: &str,
    full_path: &str,
    response: SearchReplaceResponse,
    window: Option<(usize, usize, usize)>,
) -> String {
    let mut diagnosis_payload = None;
    let (error, failed_at, occurrences) = match response {
        // `failed_at` is the edit's position in the call's `edits` array:
        // `run_batch_inner` renumbers the planner's per-file positions before
        // rendering. It used to be the per-file position, printed as "this
        // file's edit 1" beside `failedEdits[].edit: 2`, two numbers for one
        // edit (dogfood F32). The scope stays in the string so it cannot be
        // read as zero-based.
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
                        "{raw_path} (edit {failed_at} of this call): no match for old_string.\n\
                         {detail}"
                    ),
                    None => format!(
                        "{raw_path} (edit {failed_at} of this call): no match for old_string, and \
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
                "{raw_path} (edit {failed_at} of this call): found {occurrences} occurrences. Add \
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
                "{raw_path} (edit {failed_at} of this call): overlaps edit \
                 {conflicting_replacement}, which matches in the same file. Combine the nearby edits."
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
        "hint": "This edit was not applied. Fix it and send it again.",
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
            line_ending_normalized,
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
                "matchedAcrossCrlf": line_ending_normalized,
                "lineEndingsPreserved": true,
                "lineEndingNote": super::search_replace::crlf_match_note(*line_ending_normalized),
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

/// Remove the items `pick` selects, returning their batch numbers.
fn take_where(
    items: &mut Vec<SearchReplaceItem>,
    numbers: &mut Vec<usize>,
    pick: impl Fn(&SearchReplaceItem) -> bool,
) -> Vec<usize> {
    let mut taken = Vec::new();
    let mut index = 0;
    while index < items.len() {
        if pick(&items[index]) {
            items.remove(index);
            taken.push(numbers.remove(index));
        } else {
            index += 1;
        }
    }
    taken
}

/// The failure with its edit numbers mapped from positions in the planned
/// list to positions in the call's `edits` array.
fn renumbered(mut response: SearchReplaceResponse, numbers: &[usize]) -> SearchReplaceResponse {
    let map = |position: usize| numbers.get(position.wrapping_sub(1)).copied().unwrap_or(position);
    match &mut response {
        SearchReplaceResponse::NotFound { failed_at, .. }
        | SearchReplaceResponse::NotUnique { failed_at, .. } => *failed_at = map(*failed_at),
        SearchReplaceResponse::Overlap {
            failed_at,
            conflicting_replacement,
        } => {
            *failed_at = map(*failed_at);
            *conflicting_replacement = map(*conflicting_replacement);
        }
        SearchReplaceResponse::Ok { .. } => {}
    }
    response
}

/// The 1-based position, within the planned list, of the edit that failed.
fn failed_position(response: &SearchReplaceResponse) -> usize {
    match response {
        SearchReplaceResponse::NotFound { failed_at, .. }
        | SearchReplaceResponse::NotUnique { failed_at, .. }
        | SearchReplaceResponse::Overlap { failed_at, .. } => *failed_at,
        SearchReplaceResponse::Ok { .. } => 1,
    }
}

/// A failed edit as one entry of `failedEdits`: its batch number plus what its
/// own failure said (error, closest text, hint).
fn failed_edit_entry(failure: &FailedEdit) -> Value {
    let mut entry = serde_json::from_str::<Value>(&failure.rendered)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "error": failure.rendered }));
    entry["edit"] = json!(failure.number);
    if let Some(object) = entry.as_object_mut() {
        for noise in ["success", "multiFile", "pending", "oldContent", "newContent"] {
            object.remove(noise);
        }
    }
    entry
}

fn edit_list(failed: &[FailedEdit]) -> String {
    let numbers: Vec<String> = failed.iter().map(|f| f.number.to_string()).collect();
    match numbers.as_slice() {
        [one] => format!("edit {one}"),
        [rest @ .., last] => format!("edits {} and {last}", rest.join(", ")),
        [] => "no edit".into(),
    }
}

/// Several edits failed and none applied.
fn render_batch_failures(total: usize, failed: &[FailedEdit]) -> String {
    json!({
        "success": false,
        "multiFile": true,
        "error": format!(
            "None of the {total} edits were applied: {} failed. No file was changed.",
            edit_list(failed)
        ),
        "failedEdits": failed.iter().map(failed_edit_entry).collect::<Vec<_>>(),
        "hint": "Each entry says why its edit failed. Fix those edits and send them again.",
    })
    .to_string()
}

/// Some edits applied, some did not. The applied ones are on disk; the result
/// says which were not, why, and which files kept no change at all.
fn render_partial_success(
    committed: &[(String, String, SearchReplaceResponse)],
    impact: Option<&str>,
    total: usize,
    failed: &[FailedEdit],
    unchanged: &[String],
) -> String {
    let mut payload: Value =
        serde_json::from_str(&render_multi_success(committed, impact)).unwrap_or_default();
    let applied = total - failed.len();
    payload["partial"] = json!(true);
    payload["editsApplied"] = json!(applied);
    payload["editsFailed"] = json!(failed.len());
    payload["message"] = json!(format!(
        "Applied {applied} of {total} edits. {} NOT applied — see failedEdits.{}",
        edit_list(failed),
        if unchanged.is_empty() {
            String::new()
        } else {
            format!(" Not changed at all: {}.", unchanged.join(", "))
        }
    ));
    payload["failedEdits"] = json!(failed.iter().map(failed_edit_entry).collect::<Vec<_>>());
    payload["unchangedFiles"] = json!(unchanged);
    payload["hint"] = json!(
        "Send only the failed edits again, fixed. The applied edits are already on disk, so \
         copy old_string from the file as it is now if a failed edit sits near one of them."
    );
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
        super::super::read_tracker::record_whole_content(
            &ctx.thread_id,
            &canonical.to_string_lossy(),
            &std::fs::read_to_string(&canonical).unwrap(),
        );
    }

    /// A batch failure names what its number counts. Aurora's own harness run
    /// read a bare "(edit 1)" and concluded the index was zero-based; the
    /// string gave it no way to tell. Since dogfood F32 the number is the
    /// position in the call's `edits` array, and the string says so.
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
                error.contains("edit 1 of this call"),
                "every batch failure names what the ordinal counts, got: {error}"
            );
            assert!(error.contains(expected), "got: {error}");
            assert_eq!(parsed["failedAt"], 1, "the number itself was always right");
            assert_eq!(parsed["multiFile"], true);
        }
    }

    /// The `edits` array description is the only sentence at the array level
    /// that says where a batch gets its files, and a model that reads it and
    /// skips the nested `path` description acts on it alone. It used to say
    /// "applied atomically across all targeted files" — pointing, by the only
    /// word in it that names a source, at the field formerly called
    /// `target_paths`. That is the call every model in the measurement made.
    #[test]
    fn the_batch_description_says_where_its_files_come_from() {
        let tool = FileEditTool::new(Arc::new(crate::tools::shell_editor_todo::NoopIdeEventSink));
        let description = tool.schema().input_schema["properties"]["edits"]["description"]
            .as_str()
            .expect("the batch form describes itself")
            .to_string();
        assert!(
            description.contains("`path`"),
            "the array description must name the field that chooses the file: {description}"
        );
        assert!(
            description.contains(streaming_targets::FIELD),
            "it must name the field models reach for instead: {description}"
        );
        assert!(
            !description.contains("targeted"),
            "\"targeted\" points at the streaming field, which chooses nothing: {description}"
        );
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

    /// The same trap, one form along: a BATCH across two files, each edit
    /// leaning on `affected_paths` for its file.
    ///
    /// Reproduced verbatim from thread `c4669acf` (2026-09-05), where it cost
    /// three requests. The refusal it used to give — "Edit 1: no `path`. Set
    /// `path` on this edit item, or provide a top-level `path` that all edits
    /// share." — is true about the tool and says nothing about the call: it
    /// never mentions `affected_paths`, which is the field the model filled
    /// and the field this tool's own description tells it to send first.
    #[tokio::test]
    async fn a_batch_leaning_on_affected_paths_is_told_what_it_actually_sent() {
        let ctx = ctx_for(None);
        let err = FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        ))
        .execute(
            serde_json::json!({
                "affected_paths": ["a.ts", "b.ts"],
                "edits": [
                    { "old_string": "sky", "new_string": "blue" },
                    { "old_string": "teal", "new_string": "indigo" },
                ],
            }),
            &ctx,
        )
        .await
        .expect_err("two files and no per-item path cannot be mapped");
        let msg = err.to_string();
        assert!(msg.contains("affected_paths"), "must name the field it filled: {msg}");
        assert!(msg.contains("names 2 files"), "must say what arrived: {msg}");
        assert!(
            msg.contains("own `path`"),
            "must say the one thing that fixes it: {msg}"
        );
        // The sentence it replaced pointed at a top-level `path`, which is the
        // WRONG advice for a batch spanning two files — following it would
        // send both edits to one of them.
        assert!(
            !msg.contains("all edits share"),
            "must not steer a two-file batch onto a single shared path: {msg}"
        );
    }

    /// From the harness rig, 2026-09-06. A double-escaped `edits` string was
    /// correctly refused — and the refusal said "This call carried:
    /// `affected_paths`, `edits`", which sends the reader hunting for a missing
    /// field that is sitting right there. The rig's own words: it "names the
    /// field but not what was actually sent for it".
    #[tokio::test]
    async fn a_batch_string_that_is_not_json_says_so() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("lib.rs"), "x
").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        let tool =
            FileEditTool::new(Arc::new(crate::tools::shell_editor_todo::NoopIdeEventSink));

        // Quotes escaped twice — what a model actually sends when it decides to
        // hand-write JSON into a string field.
        let message = tool
            .execute(
                serde_json::json!({
                    "affected_paths": ["lib.rs"],
                    "edits": r#"[{\"old_string\": \"a\", \"new_string\": \"b\"}]"#,
                }),
                &ctx,
            )
            .await
            .expect_err("an unparseable string is not a batch")
            .to_string();

        assert!(message.contains("arrived as a string"), "{message}");
        assert!(message.contains("not valid JSON"), "{message}");
        assert!(message.contains("escaped twice"), "names the usual cause: {message}");
    }

    /// A string that parses, but not into edits.
    #[tokio::test]
    async fn a_batch_string_holding_the_wrong_thing_names_the_shape() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "x
").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        let message =
            FileEditTool::new(Arc::new(crate::tools::shell_editor_todo::NoopIdeEventSink))
                .execute(
                    serde_json::json!({ "path": "a.txt", "edits": "[1, 2, 3]" }),
                    &ctx,
                )
                .await
                .expect_err("numbers are not edits")
                .to_string();
        assert!(message.contains("an array of 3"), "{message}");
    }

    /// The fallback still lists what arrived — now with each field's shape,
    /// because a name alone was what made the original message useless.
    #[tokio::test]
    async fn the_fallback_names_the_shape_of_every_field_that_arrived() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "x
").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        let message =
            FileEditTool::new(Arc::new(crate::tools::shell_editor_todo::NoopIdeEventSink))
                .execute(serde_json::json!({ "path": "a.txt", "content": 12 }), &ctx)
                .await
                .expect_err("no edit named")
                .to_string();
        assert!(message.contains("`path` (a string)"), "{message}");
        assert!(message.contains("`content` (a number)"), "{message}");
    }

    // -----------------------------------------------------------------------
    // Resolving a pathless batch item from the text it matches
    // -----------------------------------------------------------------------

    /// Build a workspace holding the given files and a tool ready to edit them.
    fn workspace_with(files: &[(&str, &str)]) -> (tempfile::TempDir, ToolContext, Arc<dyn ToolExecutor>) {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        for (name, body) in files {
            let path = tmp.path().join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, body).unwrap();
            mark_read(&ctx, &path);
        }
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileEditTool::new(Arc::new(
            crate::tools::shell_editor_todo::NoopIdeEventSink,
        )));
        (tmp, ctx, tool)
    }

    /// The failure this resolution was built for, reproduced from session
    /// `402f0f7a` (2026-09-19): `affected_paths` naming two files, `edits`
    /// carrying no per-item `path`, and every edit's text living in exactly one
    /// of them. It was refused four times in that session alone.
    ///
    /// `old_string` is exact text. When it is in one candidate and no other,
    /// the file is not a choice anybody has to make — it is a fact the tool can
    /// read off the disk.
    #[tokio::test]
    async fn a_pathless_batch_item_is_matched_to_the_file_holding_its_text() {
        let (tmp, ctx, tool) = workspace_with(&[
            ("run-manager.ts", "const started = false\n"),
            ("run-panel.tsx", "export function RunPanel() {}\n"),
        ]);

        let out = tool
            .execute(
                serde_json::json!({
                    "affected_paths": ["run-manager.ts", "run-panel.tsx"],
                    "edits": [
                        { "old_string": "const started = false", "new_string": "const started = true" },
                    ],
                }),
                &ctx,
            )
            .await
            .expect("the text names its own file");

        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], json!(true), "got {out}");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("run-manager.ts")).unwrap(),
            "const started = true\n"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("run-panel.tsx")).unwrap(),
            "export function RunPanel() {}\n",
            "the file the text is NOT in must be untouched"
        );
        // A repair is never silent: the note names the file and the reason, so
        // the model can check the choice instead of trusting it.
        let note = parsed["argumentNote"].as_str().unwrap_or_default();
        assert!(note.contains("run-manager.ts"), "got {note}");
        assert!(note.contains("old_string"), "got {note}");
    }

    /// Resolution decides WHICH file, never WHETHER the edit is good. Text in
    /// two candidates is the one case that is genuinely the caller's to settle,
    /// and it still refuses — a write to the wrong file is not something a
    /// later turn can discover.
    #[tokio::test]
    async fn text_in_two_candidates_is_refused_rather_than_picked() {
        let (tmp, ctx, tool) = workspace_with(&[
            ("a.ts", "export const shared = 1\n"),
            ("b.ts", "export const shared = 1\n"),
        ]);

        let err = tool
            .execute(
                serde_json::json!({
                    "affected_paths": ["a.ts", "b.ts"],
                    "edits": [
                        { "old_string": "export const shared = 1", "new_string": "export const shared = 2" },
                    ],
                }),
                &ctx,
            )
            .await
            .expect_err("two files hold this text");

        let msg = err.to_string();
        assert!(msg.contains("names 2 files"), "got {msg}");
        assert!(msg.contains("is in 2 of them"), "must say what it tried: {msg}");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.ts")).unwrap(),
            "export const shared = 1\n",
            "nothing may be written while the file is undecided"
        );
    }

    /// When the text is in none of them, a `path` would not have rescued the
    /// edit either — it would have failed to match wherever it was sent. The
    /// refusal has to say that, or the model spends its retry adding a `path`
    /// to a stale `old_string`.
    #[tokio::test]
    async fn text_in_no_candidate_says_the_path_was_not_the_problem() {
        let (_tmp, ctx, tool) = workspace_with(&[
            ("a.ts", "export const shared = 1\n"),
            ("b.ts", "export const other = 2\n"),
        ]);

        let err = tool
            .execute(
                serde_json::json!({
                    "affected_paths": ["a.ts", "b.ts"],
                    "edits": [
                        { "old_string": "export const missing = 9", "new_string": "x" },
                    ],
                }),
                &ctx,
            )
            .await
            .expect_err("this text is nowhere");

        let msg = err.to_string();
        assert!(
            msg.contains("not in any file"),
            "must not blame the missing path: {msg}"
        );
        assert!(msg.contains("file_read"), "must name the recovery: {msg}");
    }

    /// The two repairs compose. A call that is BOTH over-escaped and pathless
    /// has to resolve, or fixing one failure just uncovers the other — which is
    /// what the 2026-09-19 sessions actually looked like.
    #[tokio::test]
    async fn an_over_escaped_pathless_item_still_finds_its_file() {
        let (tmp, ctx, tool) = workspace_with(&[
            ("card.tsx", "const label = \"Added by our team.\"\n"),
            ("other.tsx", "const nothing = 0\n"),
        ]);

        let out = tool
            .execute(
                serde_json::json!({
                    "affected_paths": ["card.tsx", "other.tsx"],
                    "edits": [
                        {
                            "old_string": "const label = \\\"Added by our team.\\\"",
                            "new_string": "const label = \\\"Added by the reseller.\\\"",
                        },
                    ],
                }),
                &ctx,
            )
            .await
            .expect("escaped text still names its own file");

        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], json!(true), "got {out}");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("card.tsx")).unwrap(),
            "const label = \"Added by the reseller.\"\n",
            "the replacement must land unescaped too"
        );
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
    async fn batch_edits_multiple_files_in_one_call() {
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

    /// A failed edit costs that edit only. It used to abort the whole call, so
    /// two correct edits were thrown away with one typo and resent.
    #[tokio::test]
    async fn a_failed_edit_is_skipped_and_the_rest_apply() {
        let tmp = tempfile::tempdir().unwrap();
        for (name, body) in [
            ("aurora-test.tsx", "export function AuroraTest() {}\nconst count = 0;\n"),
            ("AuroraButton.tsx", "onPress: () => void;\n"),
            ("aurora-theme.css", "--aurora-accent: #6e56cf;\n"),
        ] {
            std::fs::write(tmp.path().join(name), body).unwrap();
        }
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        for name in ["aurora-test.tsx", "AuroraButton.tsx", "aurora-theme.css"] {
            mark_read(&ctx, &tmp.path().join(name));
        }
        let out = edit_tool()
            .execute(
                serde_json::json!({
                    "edits": [
                        { "path": "aurora-test.tsx", "old_string": "AuroraTest()", "new_string": "AuroraTest(props)" },
                        { "path": "aurora-test.tsx", "old_string": "const cuont = 0;", "new_string": "const count = 1;" },
                        { "path": "AuroraButton.tsx", "old_string": "onPress: () => void;", "new_string": "onPress(): void;" },
                        { "path": "aurora-theme.css", "old_string": "--missing: red;", "new_string": "--x: 1;" }
                    ]
                }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true, "{out}");
        assert_eq!(parsed["partial"], true);
        assert_eq!(parsed["editsApplied"], 2);
        let failed: Vec<_> = parsed["failedEdits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["edit"].as_u64().unwrap())
            .collect();
        assert_eq!(failed, [2, 4], "{out}");
        assert!(parsed["failedEdits"][0]["diagnosis"].is_object(), "the typo keeps its hint: {out}");
        assert_eq!(parsed["unchangedFiles"], serde_json::json!(["aurora-theme.css"]));
        let read = |name: &str| std::fs::read_to_string(tmp.path().join(name)).unwrap();
        assert_eq!(read("aurora-test.tsx"), "export function AuroraTest(props) {}\nconst count = 0;\n");
        assert_eq!(read("AuroraButton.tsx"), "onPress(): void;\n");
        assert_eq!(read("aurora-theme.css"), "--aurora-accent: #6e56cf;\n");
    }

    #[tokio::test]
    async fn a_failed_file_does_not_hold_back_another_file() {
        // File a's edit is valid; file b's old_string is absent. a is edited,
        // b is reported and left as it was.
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
        assert_eq!(parsed["success"], true, "{out}");
        assert_eq!(parsed["partial"], true);
        assert_eq!(parsed["failedEdits"][0]["edit"], 2);
        assert_eq!(parsed["failedEdits"][0]["failedPath"], "b.txt");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "ALPHA\n");
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

    /// Read before you change (`read_gate`): an existing file nobody in this
    /// chat has seen is not edited, even when the text happens to match. The
    /// refusal states the file's size, which is what a blind caller lacks.
    #[tokio::test]
    async fn an_unread_file_is_refused_even_when_the_text_matches() {
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
        assert_eq!(parsed["success"], false, "{out}");
        assert_eq!(parsed["needsRead"], true);
        assert_eq!(parsed["lines"], 1);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "data\n");
    }

    /// Any part counts: one window of a long file is enough to edit it.
    #[tokio::test]
    async fn a_partial_read_is_enough_to_edit() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("long.md");
        let body: String = (1..=200).map(|n| format!("line {n}\n")).collect();
        std::fs::write(&file, &body).unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        let canonical = dunce::canonicalize(&file).unwrap();
        // What `file_read` records for lines 1–30: a window is not a read by
        // itself (`record_window` only remembers where to look next).
        super::super::read_tracker::record_window_content(
            &ctx.thread_id,
            &canonical.to_string_lossy(),
            &body,
            1,
            30,
            200,
        );
        let out = edit_tool()
            .execute(
                serde_json::json!({ "path": "long.md", "old_string": "line 150\n", "new_string": "LINE 150\n" }),
                &ctx,
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true, "{out}");
        assert!(std::fs::read_to_string(&file).unwrap().contains("LINE 150\n"));
    }

    /// The refusal arrives before any matching, so a missing string on an
    /// unread file is reported as unread, not as a failed match.
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

    /// `replace_all` on an unread file is refused like any other edit.
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
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "a a a\n");
    }

    /// The 2026-08-11 report that narrowed the old gate: a batch across files,
    /// one of them located with `grep` rather than opened. A grep hit is a
    /// read, so the batch applies — through the real grep tool, not a seeded
    /// tracker.
    #[tokio::test]
    async fn a_batch_applies_when_a_target_was_found_by_grep() {
        let tmp = tempfile::tempdir().unwrap();
        let read_file = tmp.path().join("read.ts");
        let searched_file = tmp.path().join("searched.css");
        std::fs::write(&read_file, "alpha\n").unwrap();
        std::fs::write(&searched_file, ".rule { color: red }\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &read_file); // only this one was opened
        let grep: Arc<dyn ToolExecutor> = Arc::new(super::super::grep::GrepTool);
        let hits = grep
            .execute(serde_json::json!({ "pattern": "color: red" }), &ctx)
            .await
            .expect("grep ran");
        assert!(hits.contains("searched.css"), "{hits}");

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

    /// An unread file in a batch costs its own edits only: the read file is
    /// still edited, the unread one is untouched and reported.
    #[tokio::test]
    async fn an_unread_file_in_a_batch_costs_only_its_own_edits() {
        let tmp = tempfile::tempdir().unwrap();
        let read_file = tmp.path().join("seen.ts");
        let unread_file = tmp.path().join("unseen.ts");
        std::fs::write(&read_file, "alpha\n").unwrap();
        std::fs::write(&unread_file, "beta\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &read_file);

        let out = edit_tool()
            .execute(
                serde_json::json!({
                    "edits": [
                        { "path": "seen.ts", "old_string": "alpha", "new_string": "ALPHA" },
                        { "path": "unseen.ts", "old_string": "beta", "new_string": "BETA" }
                    ]
                }),
                &ctx,
            )
            .await
            .expect("ok");
        assert_eq!(std::fs::read_to_string(&read_file).unwrap(), "ALPHA\n", "{out}");
        assert_eq!(std::fs::read_to_string(&unread_file).unwrap(), "beta\n", "{out}");
        assert!(out.contains("has not been read in this chat"), "{out}");
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
                escape_repairs: Vec::new(),
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
    fn a_file_held_by_another_program_is_not_reported_as_a_failed_rollback() {
        use std::cell::RefCell;
        use std::collections::HashMap;

        // `b` refuses every write — the edit and any restore alike — the way
        // a file memory-mapped by a watcher does (os error 1224).
        let files = vec![
            prepared("a", "old-a", "new-a"),
            prepared("b", "old-b", "new-b"),
        ];
        let disk = RefCell::new(HashMap::from([
            ("a".to_string(), "old-a".to_string()),
            ("b".to_string(), "old-b".to_string()),
        ]));

        let error = commit_prepared_files_with(
            &files,
            |path| {
                disk.borrow().get(path).cloned().ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "missing test file")
                })
            },
            |path, content| {
                if path == "b" {
                    return Err(std::io::Error::other("held by another program"));
                }
                disk.borrow_mut()
                    .insert(path.to_string(), content.to_string());
                Ok(())
            },
        )
        .expect_err("the held file must fail the batch");

        assert!(error.contains("that file was not changed"), "{error}");
        assert!(
            error.contains("all attempted writes were rolled back"),
            "{error}"
        );
        assert!(!error.contains("rollback also failed"), "{error}");
        assert_eq!(disk.borrow().get("a").unwrap(), "old-a");
        assert_eq!(disk.borrow().get("b").unwrap(), "old-b");
    }

    #[test]
    fn a_write_that_damaged_the_file_before_failing_is_restored() {
        use std::cell::{Cell, RefCell};
        use std::collections::HashMap;

        let files = vec![prepared("a", "old-a", "new-a")];
        let disk = RefCell::new(HashMap::from([("a".to_string(), "old-a".to_string())]));
        let failed = Cell::new(false);

        let error = commit_prepared_files_with(
            &files,
            |path| {
                disk.borrow().get(path).cloned().ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "missing test file")
                })
            },
            |path, content| {
                if !failed.replace(true) {
                    // Truncated, then out of space.
                    disk.borrow_mut().insert(path.to_string(), "ne".to_string());
                    return Err(std::io::Error::other("disk full"));
                }
                disk.borrow_mut()
                    .insert(path.to_string(), content.to_string());
                Ok(())
            },
        )
        .expect_err("the write must fail");

        assert!(!error.contains("that file was not changed"), "{error}");
        assert_eq!(disk.borrow().get("a").unwrap(), "old-a");
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

    #[tokio::test]
    async fn replace_all_refuses_an_external_change_and_accepts_a_fresh_read() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("stale.txt");
        std::fs::write(&path, "zeta zeta").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &path);
        std::fs::write(&path, "zeta zeta zeta").unwrap();
        let args = serde_json::json!({"path":"stale.txt", "old_string":"zeta", "new_string":"eta", "replace_all":true});
        let out = edit_tool().execute(args.clone(), &ctx).await.unwrap();
        let result: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(result["needsRead"], true, "{out}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "zeta zeta zeta");
        use crate::tools::file_workspace_search::file_read::FileReadTool;
        FileReadTool
            .execute(serde_json::json!({"path":["stale.txt"]}), &ctx)
            .await
            .unwrap();
        let out = edit_tool().execute(args, &ctx).await.unwrap();
        let result: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(result["success"], true, "{out}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "eta eta eta");
    }

    /// Dogfood F20: old == new answered "Replaced 1 occurrence" and rewrote
    /// the file, touching its mtime.
    #[tokio::test]
    async fn an_edit_that_changes_nothing_is_refused_without_writing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("same.txt");
        std::fs::write(&path, "alpha beta").unwrap();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        let err = edit_tool()
            .execute(
                serde_json::json!({"path":"same.txt", "old_string":"beta", "new_string":"beta"}),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidInput(ref m) if m.contains("identical")),
            "{err:?}"
        );
        // In a batch it is one failed edit, reported like any other (F31).
        let out = edit_tool()
            .execute(
                serde_json::json!({"edits":[{"path":"same.txt", "old_string":"beta", "new_string":"beta"}]}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(out.contains("identical") && out.contains("\"success\":false"), "{out}");
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before
        );
    }

    /// Dogfood F31: one no-op edit used to reject the whole batch; F32: the
    /// failure's numbers are the call's numbers.
    #[tokio::test]
    async fn a_no_op_in_a_batch_costs_that_edit_and_numbers_match_the_call() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "padding: 4px\n").unwrap();
        let ctx = ctx_for(Some(tmp.path().to_path_buf()));
        mark_read(&ctx, &tmp.path().join("a.txt"));
        mark_read(&ctx, &tmp.path().join("b.txt"));
        let out = edit_tool()
            .execute(
                serde_json::json!({"edits":[
                    {"path":"a.txt", "old_string":"one", "new_string":"one"},
                    {"path":"b.txt", "old_string":"padding: 4px", "new_string":"padding: 8px"},
                    {"path":"a.txt", "old_string":"tow", "new_string":"TWO"}
                ]}),
                &ctx,
            )
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["partial"], true, "{out}");
        assert_eq!(std::fs::read_to_string(tmp.path().join("b.txt")).unwrap(), "padding: 8px\n");
        let typo = &parsed["failedEdits"][1];
        assert_eq!(typo["edit"], 3, "{out}");
        assert_eq!(typo["failedAt"], 3, "one number per edit: {out}");
        assert!(typo["error"].as_str().unwrap().contains("edit 3 of this call"), "{out}");
    }
}
