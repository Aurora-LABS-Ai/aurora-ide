//! Agent runtime — Shrinking tool output: per-tool caps for what the model sees, and a much
//! larger, separate cap for what the transcript renders.
//!
//! Split out of `conversation.rs` verbatim; see `mod.rs` for the map.

/// Hard cap on a single tool result before it enters the conversation
/// history, the API request body, and the streamed Tauri event payload.
/// Search-heavy tools (grep, multi_file_read, auroro_websearch fetch)
/// can otherwise return megabytes of text, which blows the model's
/// context window, bloats the JSONL log, and pressures the WebView2
/// IPC channel. Picked to match the legacy `context::manager` truncator
/// at four kilobytes, with extra slack for tools that return JSON
/// (whose formatting overhead burns characters without adding signal).
pub(super) const MAX_TOOL_RESULT_LENGTH: usize = 8_192;

/// Model-history cap for content-delivery reads (`file_read`,
/// `multi_file_read`). These tools hand the model file content it must
/// match against VERBATIM to perform exact-text edits, and they already
/// bound their own output (file_read windows files over ~1500 lines /
/// 500 KB; multi_file_read caps per-file and in total). The generic 8 KiB
/// clamp was a SECOND, far tighter cap that silently hid the middle of any
/// file over ~200 lines — so a later file_edit built its `old_string` from
/// the invisible region and failed to match. A read-sized cap lets a normal
/// read through in full while still backstopping a pathological blob.
pub(super) const MAX_READ_RESULT_LENGTH: usize = 512 * 1024;

/// Bytes held back from the clamp budget for the `[truncated …]` marker, so
/// the finished string still fits under its cap. The marker runs ~90 bytes
/// with realistic byte counts; 128 leaves headroom without being worth
/// computing exactly.
pub(super) const TRUNCATION_MARKER_RESERVE: usize = 128;

/// Model-history cap for the workspace map.
///
/// `workspace_tree` self-limits by node budget (default 500 nodes at ~60 bytes
/// each), so it does not need a byte clamp to stay sane — it needs one only as
/// a backstop for an explicit `max_nodes` request. The generic 8 KiB cap was
/// far below what any useful map costs, which meant EVERY call went through
/// [`compact_json_arrays`]; that pass halves the largest array repeatedly, and
/// on Aurora's own repo it left 47 of 3,066 nodes with `src/` and `src-tauri/`
/// deleted outright and nothing in the payload admitting it. A clamp that
/// silently destroys the result it is meant to bound is worse than a bigger
/// clamp.
pub(super) const MAX_TREE_RESULT_LENGTH: usize = 64 * 1024;

/// The model-history clamp for a given tool's result. Reads get the large
/// [`MAX_READ_RESULT_LENGTH`] (they self-limit and the model needs the
/// content); the workspace map gets [`MAX_TREE_RESULT_LENGTH`] for the same
/// reason; everything else keeps the tight [`MAX_TOOL_RESULT_LENGTH`] that
/// stops grep / websearch megabytes from flooding the context window.
/// Model-history cap for a fetched web page.
///
/// `auroro_websearch` is a content-delivery read like `file_read`: what it
/// returns is the page the model asked to read, and clipping it defeats the
/// call. It bounds its own output instead — a fetch returns a window plus the
/// offset of the next one — so this cap is a backstop, not the working limit.
/// It sits comfortably above the largest window the tool will hand over
/// (120,000 characters) plus the JSON around it, which is the point: the tool
/// must never reach [`compact_json_tool_content`], whose last resort throws the
/// page away.
pub(super) const MAX_WEB_RESULT_LENGTH: usize = 512 * 1024;

/// Model-history cap for the built-in surface doctrine.
///
/// `design_guidelines` returns a FIXED string compiled into the binary —
/// `doctrine::VISUAL`, `doctrine::WRITING`, or both — so it carries none of the
/// unbounded-growth risk the 8 KiB cap exists to contain. Under that cap the
/// default `both` (10,185 chars) lost its last 2,121: the model was handed the
/// doctrine with `**Errors**`, `**Warnings**`, the whole ethical-psychology
/// section, every hard-fail pattern and the tone rules cut off mid-sentence,
/// then spent a second round trip re-reading what it had just been sent. Half a
/// standing instruction is worse than none: the model cannot tell that the
/// rules it is about to break were the ones that did not arrive.
///
/// Sized well clear of the current payload so ordinary edits to the doctrine do
/// not need to touch this number; `the_doctrine_reaches_the_model_whole` fails
/// if it ever grows past it.
pub(super) const MAX_DOCTRINE_RESULT_LENGTH: usize = 32 * 1024;

pub(super) fn result_cap_for(tool: &str) -> usize {
    match tool {
        "file_read" | "multi_file_read" => MAX_READ_RESULT_LENGTH,
        "workspace_tree" => MAX_TREE_RESULT_LENGTH,
        // Discovery bounds its own output and pages oversized schemas. The
        // generic JSON shrinker must not delete required schema properties.
        "tool_search" => 96 * 1024,
        "auroro_websearch" => MAX_WEB_RESULT_LENGTH,
        // Every `*_guidelines` tool, not just design's. The reasoning above
        // is about doctrine, and doctrine is a family: `browser_guidelines`
        // and `canvas_guidelines` are the same kind of standing instruction
        // and were the same kind of wrong to cut. An agent reported
        // `browser_guidelines` arriving 1,080 bytes short of its 9,144 —
        // mandatory browser rules ending mid-sentence at "Check it " — while
        // `design_guidelines`, one arm away, was never touched.
        t if t.ends_with("_guidelines") => MAX_DOCTRINE_RESULT_LENGTH,
        _ => MAX_TOOL_RESULT_LENGTH,
    }
}

/// Tools whose clamped results earn a full-fidelity `.rich.jsonl` sidecar
/// entry: the modify family, whose `oldContent`/`newContent` drive the
/// reload-time diff view. Reads are excluded — their model cap already
/// matches the UI cap, and re-persisting file bodies twice buys nothing.
pub(super) fn rich_persisted_tool(name: &str) -> bool {
    matches!(
        name,
        "file_edit"
            | "file_write"
            | "file_create"
            | "file_patch"
            | "search_replace"
            | "multi_search_replace"
    )
}

/// Strip the `oldContent`/`newContent` echo out of a modify-family result
/// before it enters MODEL history. Both strings are content the model itself
/// just sent (or read moments ago); echoing them back burned most of the 8 KiB
/// cap per edit on pure duplication — the loudest silent context cost in the
/// toolset. The counts and message that remain are the actual signal. The UI is
/// unaffected: the live tool card gets its own untouched copy, and reload-time
/// diffs come from the `.rich.jsonl` sidecar.
///
/// ## The strip is SILENT, and that is deliberate
///
/// This used to leave a `contentEcho` note behind explaining the elision. It is
/// gone, because every justification for it was wrong:
///
/// - It explained an absence nobody could see. The model is given a schema for
///   tool INPUTS, never for tool RESULTS, so a missing `newContent` contradicts
///   no expectation it ever held.
/// - The confirmation it offered is already here in structured form.
///   `"Replaced 1 occurrence(s)"`, `replacements`, `linesAdded`, `linesRemoved`
///   say the edit landed, how often, and how large. Prose after that restates
///   data.
/// - The one genuinely new thing it carried — that re-reading to confirm the
///   write is wasted — is a rule that holds for a whole conversation, and it was
///   being repeated on every single result. At ~70 tokens a copy, resident in
///   history and re-uploaded each turn, a 40-edit thread paid 2,800 tokens per
///   turn to restate one sentence. Inside the function whose entire job is
///   deleting duplication from history.
///
/// If that rule is ever worth stating, it belongs in the system prompt's tool
/// guidelines, said once. It does not belong here, said N times.
///
/// Returns `None` when the result carries no echo (failures, non-JSON), in
/// which case the caller leaves the content as it was.
pub(super) fn strip_edit_content_echo(raw: &str) -> Option<String> {
    let mut value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let mut stripped_any = false;

    let mut strip = |obj: &mut serde_json::Map<String, serde_json::Value>| {
        for key in ["oldContent", "newContent"] {
            if obj.remove(key).is_some() {
                stripped_any = true;
            }
        }
    };

    if let serde_json::Value::Object(map) = &mut value {
        strip(map);
        if let Some(serde_json::Value::Array(files)) = map.get_mut("files") {
            for entry in files.iter_mut() {
                if let serde_json::Value::Object(file) = entry {
                    strip(file);
                }
            }
        }
    }

    stripped_any.then(|| serde_json::to_string(&value).ok())?
}

/// Clamp a tool's stringified result to its per-tool cap and append a
/// `[truncated N bytes]` marker so the model knows the tail was dropped.
/// Operates on char boundaries (not byte boundaries) so a truncation point
/// inside a multi-byte UTF-8 sequence cannot produce invalid UTF-8.
pub(super) fn truncate_tool_content(tool: &str, s: String) -> String {
    // Results carrying an `<aurora_image>` block (browser_screenshot) get
    // LEANIFIED, not clamped: the base64 body is stripped from the persisted /
    // model-history copy (the PNG lives on disk, referenced by the `src` header
    // attr, and is rehydrated at request-build time by `split_aurora_images`).
    // This keeps the JSONL tiny, stops the base64 being re-uploaded to the model
    // every turn, and means a reloaded thread never shows a raw base64 blob. A
    // blind byte clamp here would instead cut through the base64 and drop the
    // closing tag → adapter can't split the image → model "sees" nothing.
    //
    // The check is a VALIDATED parse, not a substring test. Text that merely
    // quotes the marker syntax (this project's own docs and source do) used to
    // take this branch, so it skipped the cap below AND was handed to the
    // provider adapter as an image — prose shipped as base64, HTTP 400.
    if crate::api::aurora_image::has_marker(&s) {
        return leanify_aurora_images(&s);
    }
    // Reads that bounded themselves are handed to the model verbatim. They are
    // already exactly the window that was requested (or an explicitly forced
    // whole file), and a byte clamp here would cut the tail off that window —
    // which is precisely the content a following exact-match `file_edit` has to
    // reproduce character for character.
    if s.contains(crate::tools::file_workspace_search::EXACT_READ_MARKER) {
        return s;
    }
    // Modify-family results drop their before/after echo from the model copy
    // regardless of size — see `strip_edit_content_echo`. Done before the cap
    // so the budget is never spent shrinking content the model already has.
    let s = if rich_persisted_tool(tool) {
        strip_edit_content_echo(&s).unwrap_or(s)
    } else {
        s
    };
    let cap = result_cap_for(tool);
    if s.len() <= cap {
        return s;
    }
    if let Some(compacted) = compact_json_tool_content(&s, cap) {
        return compacted;
    }
    let original_len = s.len();
    // Walk char boundaries to find a safe slice point, leaving room for the
    // marker. Cutting at exactly `cap` and *then* appending the marker put
    // the result OVER the cap the function exists to enforce.
    let mut cut = cap.saturating_sub(TRUNCATION_MARKER_RESERVE);
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = String::with_capacity(cut + 64);
    out.push_str(&s[..cut]);
    out.push_str(&format!(
        "\n\n[truncated {} bytes — tool returned {} bytes total, kept first {}]",
        original_len.saturating_sub(cut),
        original_len,
        cut,
    ));
    out
}

pub(super) fn compact_json_tool_content(raw: &str, cap: usize) -> Option<String> {
    let original = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let mut low = 0usize;
    let mut high = cap;
    let mut best: Option<String> = None;

    while low <= high {
        let limit = low + (high - low) / 2;
        let mut candidate = original.clone();
        // A `false` return means "no payload string was longer than
        // `limit`" — NOT failure. Bailing out on it was wrong twice over:
        //   * `workspace_tree` has no payload-string keys at all, so the
        //     very first probe returned false and this aborted before ever
        //     reaching `compact_json_arrays` — the function written for
        //     exactly that shape. The result fell through to the blind byte
        //     clamp and came back as invalid JSON.
        //   * A batch `file_read` whose per-file contents are each smaller
        //     than the first probe (but huge in aggregate) hit the same
        //     path, so the one case the binary search exists to solve was
        //     the one it refused.
        // The serialized size below is the real signal; an unchanged
        // candidate simply measures too big and the search moves lower.
        let _ = shrink_history_payload_strings(&mut candidate, limit);
        if let serde_json::Value::Object(map) = &mut candidate {
            map.insert("historyTruncated".into(), serde_json::Value::Bool(true));
            map.insert(
                "originalBytes".into(),
                serde_json::Value::from(raw.len() as u64),
            );
        }
        let serialized = serde_json::to_string(&candidate).ok()?;
        if serialized.len() <= cap {
            best = Some(serialized);
            low = limit.saturating_add(1);
        } else if limit == 0 {
            break;
        } else {
            high = limit - 1;
        }
    }

    if best.is_some() {
        return best;
    }

    if let Some(compacted) = compact_json_arrays(&original, cap, raw.len()) {
        return Some(compacted);
    }

    // Last resort: keep the envelope, drop the payload.
    //
    // This branch is lossy in a way the others are not — it does not shorten
    // the result, it removes it — so it SAYS SO. Without the note it emits
    // `{"success": true, "historyTruncated": true, "originalBytes": 9454}`,
    // and a reader has no way to tell that from a tool that genuinely found
    // nothing. That is not hypothetical: a web fetch landed here and was read
    // as an empty page, which is what prompted `websearch` to be built around
    // fitting under the cap rather than trusting this to shrink it.
    //
    // A tool reaching this branch has a bug worth fixing at the tool: it is
    // returning more than the runtime will keep, and no compaction strategy
    // can make that lossless.
    let mut fallback = serde_json::Map::new();
    let mut dropped: Vec<&str> = Vec::new();
    if let serde_json::Value::Object(map) = &original {
        for (key, value) in map {
            let keepable = matches!(key.as_str(), "success" | "message" | "error" | "path");
            if keepable && !value.is_array() && !value.is_object() {
                fallback.insert(key.clone(), value.clone());
            } else if !value.is_null() {
                dropped.push(key.as_str());
            }
        }
    }
    fallback.insert("historyTruncated".into(), serde_json::Value::Bool(true));
    fallback.insert(
        "originalBytes".into(),
        serde_json::Value::from(raw.len() as u64),
    );
    if !dropped.is_empty() {
        fallback.insert(
            "truncationNote".into(),
            serde_json::Value::from(format!(
                "This result was too large to keep ({} bytes, limit {cap}). \
                 These fields were dropped entirely and hold no data here: {}. \
                 Do not read their absence as an empty answer — ask for a smaller \
                 slice of the same call instead.",
                raw.len(),
                dropped.join(", "),
            )),
        );
    }
    let compacted = serde_json::to_string(&serde_json::Value::Object(fallback)).ok()?;
    (compacted.len() <= cap).then_some(compacted)
}

pub(super) fn compact_json_arrays(
    original: &serde_json::Value,
    cap: usize,
    original_len: usize,
) -> Option<String> {
    let mut candidate = original.clone();
    if let serde_json::Value::Object(map) = &mut candidate {
        map.insert("historyTruncated".into(), serde_json::Value::Bool(true));
        map.insert(
            "originalBytes".into(),
            serde_json::Value::from(original_len as u64),
        );
    }

    loop {
        let serialized = serde_json::to_string(&candidate).ok()?;
        if serialized.len() <= cap {
            return Some(serialized);
        }
        let largest = largest_json_array_len(&candidate);
        if largest == 0 || !shrink_json_arrays_of_len(&mut candidate, largest) {
            return None;
        }
    }
}

pub(super) fn largest_json_array_len(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(items) => items
            .iter()
            .map(largest_json_array_len)
            .fold(items.len(), usize::max),
        serde_json::Value::Object(map) => {
            map.values().map(largest_json_array_len).max().unwrap_or(0)
        }
        _ => 0,
    }
}

pub(super) fn shrink_json_arrays_of_len(value: &mut serde_json::Value, target_len: usize) -> bool {
    match value {
        serde_json::Value::Array(items) => {
            if items.len() == target_len {
                items.truncate(items.len() / 2);
                return true;
            }
            items.iter_mut().fold(false, |changed, item| {
                shrink_json_arrays_of_len(item, target_len) || changed
            })
        }
        serde_json::Value::Object(map) => map.values_mut().fold(false, |changed, child| {
            shrink_json_arrays_of_len(child, target_len) || changed
        }),
        _ => false,
    }
}

pub(super) fn shrink_history_payload_strings(value: &mut serde_json::Value, limit: usize) -> bool {
    let mut changed = false;
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                changed |= shrink_history_payload_strings(item, limit);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                // A payload KEY holding a STRING is the thing to shrink. A
                // payload key holding an object or an array is a container
                // whose own payload is one level further down, so it must be
                // recursed into like any other key.
                //
                // Treating the key match as reason enough to stop was a real
                // bug with a loud symptom. `auroro_websearch` returned
                // `{"content": {"title": …, "content": "<the whole page>"}}`;
                // the outer `content` matched, the `if let` failed because it
                // is an object, the `else` never ran, and the page body was
                // never shrunk. The binary search above could therefore never
                // get the result under its cap, so it fell through to the
                // envelope-only fallback and the model was handed a success
                // with no page in it.
                let is_payload_key = matches!(
                    key.as_str(),
                    "content" | "oldContent" | "newContent" | "stdout" | "stderr" | "output"
                );
                match child {
                    serde_json::Value::String(text) if is_payload_key => {
                        if text.len() > limit {
                            let original_len = text.len();
                            let mut cut = limit;
                            while cut > 0 && !text.is_char_boundary(cut) {
                                cut -= 1;
                            }
                            text.truncate(cut);
                            text.push_str(&format!(
                                "\n\n[truncated {} bytes in persisted history]",
                                original_len.saturating_sub(cut),
                            ));
                            changed = true;
                        }
                    }
                    other => changed |= shrink_history_payload_strings(other, limit),
                }
            }
        }
        _ => {}
    }
    changed
}

/// Backstop for the UI event payload. The model-history copy is hard
/// clamped at [`MAX_TOOL_RESULT_LENGTH`], but the UI deliberately gets
/// the *full* result so the rich renderers (workspace_tree, grep, shell
/// output) can parse complete JSON — a blind byte clamp chops the JSON
/// mid-string and the frontend falls back to dumping raw bytes.
///
/// Normal-sized results pass through untouched, preserving that
/// behavior. Only pathological payloads (multi-megabyte `cat`, verbose
/// build logs) are trimmed, and we do it JSON-aware: parse the value and
/// shrink its large *string* fields in place so the envelope stays valid
/// JSON the frontend can still parse. If it isn't JSON, fall back to a
/// plain char-boundary clamp (safe to chop — there's no structure to
/// break). This keeps megabyte blobs off the WebView2 IPC channel and
/// out of the thread store without reintroducing the raw-dump artifact.
pub(super) const MAX_UI_TOOL_RESULT_LENGTH: usize = 512 * 1024; // 512 KiB
pub(super) const MAX_UI_JSON_FIELD_LENGTH: usize = 128 * 1024; // 128 KiB per string field

pub(super) fn truncate_tool_content_for_ui(tool_name: &str, s: String) -> String {
    // Keyed on the CONTENT, not the tool: `file_read` returns an image marker
    // whenever the path was a picture, and the UI copy is the one that gets
    // persisted — letting base64 through it would put megabytes of encoded
    // pixels into the thread store for every image the agent opens.
    if tool_name == "browser_screenshot" || crate::api::aurora_image::has_marker(&s) {
        return screenshot_ui_payload(&s);
    }

    if s.len() <= MAX_UI_TOOL_RESULT_LENGTH {
        return s;
    }

    // Try to keep the payload valid JSON by trimming oversized string
    // fields rather than the serialized envelope.
    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&s) {
        shrink_json_strings(&mut value);
        if let Ok(compacted) = serde_json::to_string(&value) {
            return compacted;
        }
    }

    // Not JSON (or re-serialization failed): plain text is safe to chop.
    let original_len = s.len();
    let mut cut = MAX_UI_TOOL_RESULT_LENGTH;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = String::with_capacity(cut + 64);
    out.push_str(&s[..cut]);
    out.push_str(&format!(
        "\n\n[truncated {} bytes for display — tool returned {} bytes total]",
        original_len.saturating_sub(cut),
        original_len,
    ));
    out
}

/// Build the UI-facing payload for a result carrying an image — a
/// `browser_screenshot` capture, or a picture opened by `file_read`.
///
/// The model-history copy keeps the full `<aurora_image>…base64…</aurora_image>`
/// block (the vision path). The UI must NOT carry that base64 — it would bloat
/// every persisted thread. Instead we emit a small JSON envelope the tool card's
/// parser understands: the on-disk `path` (asset-protocol loadable), its pixel
/// `width`/`height`, the page `url` for a capture, and the file `name` for a
/// read. The card renders the image from `path`; no image bytes touch the
/// thread store.
///
/// Falls back gracefully: if there's no `<aurora_image>` block at all (e.g. an
/// error string), the original text passes through unchanged.
pub(super) fn screenshot_ui_payload(s: &str) -> String {
    let Some(marker) = crate::api::aurora_image::find_marker(s, 0) else {
        return s.to_string();
    };

    // A `file_read` may return several pictures, and their captions, and the
    // JSON for the text files read alongside them. That does not fit one
    // envelope, so it keeps its own shape and only sheds the base64 — the card
    // reads the markers back and renders every image from its `src`.
    if crate::api::aurora_image::find_marker(s, marker.end).is_some() {
        return leanify_aurora_images(s);
    }

    let path = marker.src().map(|v| unescape_xml_attr(v.to_string()));
    let width = marker.attr("width").and_then(|v| v.parse::<u64>().ok());
    let height = marker.attr("height").and_then(|v| v.parse::<u64>().ok());
    // A capture is named by the page it photographed; a file read is named by
    // the file. Only one of the two is ever present, and the card labels itself
    // from whichever it got — the cache filename (`img-9f2c….jpg`) names
    // nothing anybody asked for.
    let name = marker
        .attr("name")
        .map(|v| unescape_xml_attr(v.to_string()));

    // The caption after the block reads `Screenshot of <url> (WxH px)` — pull the
    // URL out of it for the card's summary line.
    let url = s
        .find("Screenshot of ")
        .map(|i| &s[i + "Screenshot of ".len()..])
        .and_then(|rest| rest.split(" (").next())
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());

    serde_json::json!({
        "screenshot": {
            "path": path,
            "width": width,
            "height": height,
            "url": url,
            "name": name,
        }
    })
    .to_string()
}

/// Strip the base64 BODY out of every `<aurora_image src="…">…</aurora_image>`
/// block, leaving the header (with `src`/`width`/`height`) and surrounding text
/// intact. Only blocks that carry a `src` are leaned (the PNG is on disk and
/// re-readable); a block WITHOUT `src` (on-disk save failed → the body is the
/// only copy) is left untouched so the model still gets the image.
///
/// This is what makes the persisted history + JSONL tiny: `split_aurora_images`
/// rehydrates the base64 from `src` at request-build time.
pub(super) fn leanify_aurora_images(s: &str) -> String {
    use crate::api::aurora_image::{find_marker, CLOSE};

    let mut out = String::with_capacity(s.len());
    let mut cursor = 0usize;
    while let Some(marker) = find_marker(s, cursor) {
        // Text before + the full header incl. '>'.
        out.push_str(&s[cursor..marker.header_end]);
        if marker.src().is_none() {
            // No disk copy → keep the body so the image survives.
            out.push_str(marker.body);
        }
        // else: drop the base64 body — rehydratable from disk.
        out.push_str(CLOSE);
        cursor = marker.end;
    }
    out.push_str(&s[cursor..]);
    out
}

/// Reverse the minimal XML-attribute escaping applied when the image path was
/// written into the `src` attribute (`&amp;` → `&`, `&quot;` → `"`).
pub(super) fn unescape_xml_attr(v: String) -> String {
    crate::api::aurora_image::unescape_attr(&v)
}

/// Recursively clamp every string in a JSON value to
/// [`MAX_UI_JSON_FIELD_LENGTH`], appending a marker so the UI can show
/// the field was trimmed. Truncates on char boundaries to keep the
/// string valid UTF-8.
pub(super) fn shrink_json_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => {
            if text.len() > MAX_UI_JSON_FIELD_LENGTH {
                let original_len = text.len();
                let mut cut = MAX_UI_JSON_FIELD_LENGTH;
                while cut > 0 && !text.is_char_boundary(cut) {
                    cut -= 1;
                }
                text.truncate(cut);
                text.push_str(&format!(
                    "\n\n[truncated {} bytes for display]",
                    original_len.saturating_sub(cut),
                ));
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                shrink_json_strings(item);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                shrink_json_strings(v);
            }
        }
        _ => {}
    }
}
