//! Spill oversized tool output to a file instead of destroying it.
//!
//! A build or test run that prints thousands of lines cannot fit in the
//! model's context. Clamping it to the first few kilobytes is worse than it
//! looks: compiler and test output puts the *summary* at the end, so a
//! head-only clamp reliably shows the model everything except the failure,
//! and the dropped bytes are gone — the process has exited, and nothing in
//! the transcript can get them back.
//!
//! Instead the full text is written to
//! `<thread_id>.tool-results/out-<hash>[-<field>].txt` and the result
//! keeps a **head and tail** preview plus that path. The model already has
//! `file_read` (which takes `start_line`/`end_line`) and `grep`, so it can
//! page through the file or jump straight to the error without any new tool.
//!
//! Two shapes are handled:
//!
//! - **JSON results** (shell, grep, reads): only the large payload *fields*
//!   spill — `stdout`, `stderr`, `output`, `content`. The envelope keeps its
//!   structure, gaining `stdoutFile` / `stdoutBytes` alongside the preview,
//!   so every existing frontend renderer keeps working untouched.
//! - **Plain text results**: the whole body spills.
//!
//! Spilling is best-effort. If the file cannot be written the payload is left
//! exactly as it was for the normal clamp to handle — a full disk must not
//! fail a tool call.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// Payload fields large enough to be worth spilling, in the order they are
/// reported. These are the same keys the history clamp shrinks.
const PAYLOAD_FIELDS: &[&str] = &["stdout", "stderr", "output", "content"];

/// Below this a payload stays inline: it costs little context and a file the
/// model has to open would be pure friction. Sized so ordinary command output
/// (a test summary, a short listing) is never spilled.
const SPILL_THRESHOLD: usize = 12 * 1024;

/// Head kept inline — enough to see what the command started doing.
const PREVIEW_HEAD: usize = 3 * 1024;

/// Tail kept inline — where exit summaries, error counts, and stack traces
/// live. This is the half a head-only clamp always lost.
const PREVIEW_TAIL: usize = 5 * 1024;

/// Rewrite `raw` so any oversized payload lives on disk.
///
/// Returns the (possibly unchanged) content to hand to the history clamp.
#[must_use]
pub fn spill_oversized(dir: &Path, tool_call_id: &str, raw: String) -> String {
    if raw.len() <= SPILL_THRESHOLD {
        return raw;
    }

    // A tool that already bounded its own output to exactly what was asked for
    // opts out. Spilling is right for command output — a build log's summary is
    // at the end, so head+tail beats a head-only clamp and the bytes are gone
    // once the process exits. It is WRONG for a file read: the middle of a file
    // is the part an exact-match edit needs, the bytes are still on disk, and
    // replacing them with a pointer only buys round trips. A 739-line component
    // came back with 22 KB of its middle removed and cost five extra calls to
    // page back in — one of which spilled again.
    if raw.contains(crate::tools::file_workspace_search::EXACT_READ_MARKER) {
        return raw;
    }

    // A result embedding a real `<aurora_image>` marker (browser_screenshot,
    // image file reads) is oversized BY DESIGN — the base64 body is the image.
    // Spilling it cuts the payload mid-base64 and drops the close tag, so the
    // downstream leanify branch (`truncate_tool_content`) and the vision
    // adapters can no longer recognise it: the model gets a wall of elided
    // base64 instead of seeing the page. Leanify already keeps history tiny
    // (body stripped, rehydrated from `src` at request build), so passing
    // through whole costs nothing.
    if crate::api::aurora_image::has_marker(&raw) {
        return raw;
    }

    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(map)) => spill_json_fields(dir, tool_call_id, map)
            .and_then(|map| serde_json::to_string(&Value::Object(map)).ok())
            .unwrap_or(raw),
        // A non-object result (plain text, or a bare array) spills whole.
        _ => match write_spill(dir, tool_call_id, None, &raw) {
            Some(path) => plain_text_envelope(&raw, &path),
            None => raw,
        },
    }
}

/// Spill each oversized payload field, annotating the envelope in place.
/// Returns `None` when nothing was large enough to move.
fn spill_json_fields(
    dir: &Path,
    tool_call_id: &str,
    mut map: Map<String, Value>,
) -> Option<Map<String, Value>> {
    let mut spilled_any = false;

    for field in PAYLOAD_FIELDS {
        let Some(Value::String(text)) = map.get(*field) else {
            continue;
        };
        if text.len() <= SPILL_THRESHOLD {
            continue;
        }
        // Same image-marker exemption as the top-level check — a marker inside
        // a JSON field is escaped in `raw`, so only the parsed value shows it.
        if crate::api::aurora_image::has_marker(text) {
            continue;
        }
        let text = text.clone();
        let Some(path) = write_spill(dir, tool_call_id, Some(field), &text) else {
            continue;
        };

        map.insert((*field).to_string(), Value::String(preview(&text, &path)));
        map.insert(
            format!("{field}File"),
            Value::String(path.to_string_lossy().to_string()),
        );
        map.insert(format!("{field}Bytes"), Value::from(text.len() as u64));
        spilled_any = true;
    }

    spilled_any.then_some(map)
}

/// Head + elision note + tail.
fn preview(text: &str, path: &Path) -> String {
    let head_end = floor_boundary(text, PREVIEW_HEAD);
    let tail_start = ceil_boundary(text, text.len().saturating_sub(PREVIEW_TAIL));

    // Overlapping halves mean the text barely exceeded the threshold; a single
    // slice reads better than a note claiming nothing was hidden.
    if tail_start <= head_end {
        return text.to_string();
    }

    let hidden = tail_start - head_end;
    format!(
        "{}\n\n[{} of {} bytes hidden — full output: {}\n \
         Read it with file_read (start_line/end_line) or search it with grep.]\n\n{}",
        &text[..head_end],
        hidden,
        text.len(),
        path.display(),
        &text[tail_start..],
    )
}

/// Envelope for a spilled non-JSON result.
fn plain_text_envelope(text: &str, path: &Path) -> String {
    preview(text, path)
}

/// Write `text` and return where it landed, or `None` on any I/O failure.
fn write_spill(dir: &Path, tool_call_id: &str, field: Option<&str>, text: &str) -> Option<PathBuf> {
    if fs::create_dir_all(dir).is_err() {
        return None;
    }
    let stem = sanitize(tool_call_id);
    let name = match field {
        Some(field) => format!("{stem}-{field}.txt"),
        None => format!("{stem}.txt"),
    };
    let path = dir.join(name);
    fs::write(&path, text).ok()?;
    // An absolute path is what makes this reachable: `file_read` and `grep`
    // resolve it directly, with no workspace-relative guessing.
    Some(dunce::canonicalize(&path).unwrap_or(path))
}

/// A short, stable file stem for a tool call.
///
/// Provider call ids are long and noisy (`call_00_GX2Uk9XV5vG1yZFYts544827`),
/// and the model has to read the resulting path back and pass it to
/// `file_read` — so the name is hashed to eight hex characters instead. The
/// directory is already thread-scoped, so this only has to be unique within a
/// thread, and hashing also means a hostile id can never escape the folder.
fn sanitize(id: &str) -> String {
    if id.is_empty() {
        return "out-000000000000".to_string();
    }
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("out-{:08x}", hash as u32)
}

fn floor_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A read that already bounded itself must reach the model byte for byte.
    /// Spilling it replaced the middle of a 739-line component with a pointer
    /// and cost five extra calls to page back in.
    #[test]
    fn an_exact_read_is_never_spilled() {
        let dir = tempfile::tempdir().unwrap();
        let content = "z".repeat(60 * 1024);
        let raw = serde_json::json!({
            "success": true,
            "exactRead": true,
            "path": "components/ProfileForm.tsx",
            "content": content,
        })
        .to_string();

        let out = spill_oversized(dir.path(), "call-1", raw.clone());
        assert_eq!(out, raw, "an exactRead payload must pass through untouched");
        assert!(!out.contains("bytes hidden"), "no elision note");
        assert!(!out.contains("contentFile"), "nothing written to disk");
    }

    /// The regression the agent-window model reported: a ~260 KB screenshot
    /// result was spilled as plain text ("253577 of 261769 bytes hidden"),
    /// cutting the `<aurora_image>` marker mid-base64 — so the leanify branch
    /// and the vision adapters never saw an image, only elided base64. A result
    /// embedding a valid marker must reach `truncate_tool_content` whole.
    #[test]
    fn a_screenshot_marker_is_never_spilled() {
        let dir = tempfile::tempdir().unwrap();
        // Valid base64 well past the 12 KB threshold, exactly the tool's shape.
        let b64 = "QUJD".repeat(60_000);
        let raw = format!(
            "<aurora_image media_type=\"image/png\" width=\"1400\" height=\"1210\" \
             src=\"C:\\shots\\a.png\">{b64}</aurora_image>\n\
             Screenshot of http://localhost:5173 (1400×1210 px)"
        );

        let out = spill_oversized(dir.path(), "call-shot", raw.clone());
        assert_eq!(out, raw, "the marker must pass through untouched");
        assert!(
            std::fs::read_dir(dir.path()).unwrap().next().is_none(),
            "nothing written to disk"
        );
    }

    /// A marker embedded in a JSON payload field is escaped in the envelope, so
    /// the top-level check cannot see it — the per-field guard must.
    #[test]
    fn a_marker_inside_a_json_field_is_never_spilled() {
        let dir = tempfile::tempdir().unwrap();
        let b64 = "QUJD".repeat(60_000);
        let marker =
            format!("<aurora_image media_type=\"image/png\">{b64}</aurora_image>");
        let raw = serde_json::json!({ "success": true, "content": marker }).to_string();

        let out = spill_oversized(dir.path(), "call-json-shot", raw.clone());
        assert_eq!(out, raw, "the field must pass through untouched");
    }

    /// The exemption is narrow: shell/build output still spills, because its
    /// summary lives at the tail and the bytes are gone once the process exits.
    #[test]
    fn ordinary_oversized_output_still_spills() {
        let dir = tempfile::tempdir().unwrap();
        let raw = serde_json::json!({
            "success": false,
            "stdout": "q".repeat(60 * 1024),
        })
        .to_string();

        let out = spill_oversized(dir.path(), "call-2", raw);
        assert!(
            out.contains("stdoutFile"),
            "spill path recorded: {out:.200}"
        );
        assert!(out.contains("bytes hidden"), "elision note present");
    }

    fn big(marker_start: &str, marker_end: &str) -> String {
        let filler = "y".repeat(40);
        let mut text = String::from(marker_start);
        text.push('\n');
        for i in 0..2_000 {
            text.push_str(&format!("line {i:04} {filler}\n"));
        }
        text.push_str(marker_end);
        text
    }

    #[test]
    fn small_results_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let raw = r#"{"success":true,"stdout":"ok"}"#.to_string();
        assert_eq!(spill_oversized(dir.path(), "call_1", raw.clone()), raw);
        assert!(
            std::fs::read_dir(dir.path()).unwrap().next().is_none(),
            "no file for a small result"
        );
    }

    #[test]
    fn oversized_stdout_moves_to_a_file_and_keeps_both_ends() {
        let dir = tempfile::tempdir().unwrap();
        let output = big("FIRST_LINE", "LAST_LINE_MARKER");
        let raw = serde_json::json!({ "success": false, "stdout": output }).to_string();

        let result = spill_oversized(dir.path(), "call_abc", raw);
        let parsed: Value = serde_json::from_str(&result).expect("still valid JSON");

        let stdout = parsed["stdout"].as_str().unwrap();
        assert!(stdout.contains("FIRST_LINE"), "head is kept");
        assert!(
            stdout.contains("LAST_LINE_MARKER"),
            "tail is kept — this is where build errors live"
        );
        assert!(stdout.contains("bytes hidden"), "the gap is declared");
        assert!(stdout.contains("file_read"), "recovery path is stated");

        // The envelope keeps its shape for existing renderers.
        assert_eq!(parsed["success"], serde_json::json!(false));
        assert!(parsed["stdoutBytes"].as_u64().unwrap() > 12 * 1024);

        let spilled = parsed["stdoutFile"].as_str().unwrap();
        let contents = std::fs::read_to_string(spilled).expect("file exists");
        assert!(contents.contains("FIRST_LINE") && contents.contains("LAST_LINE_MARKER"));
        assert!(
            contents.contains("line 1000"),
            "the middle survives on disk"
        );
    }

    #[test]
    fn stdout_and_stderr_spill_to_separate_files() {
        let dir = tempfile::tempdir().unwrap();
        let raw = serde_json::json!({
            "stdout": big("OUT_HEAD", "OUT_TAIL"),
            "stderr": big("ERR_HEAD", "ERR_TAIL"),
        })
        .to_string();

        let parsed: Value =
            serde_json::from_str(&spill_oversized(dir.path(), "call_x", raw)).unwrap();
        let out = parsed["stdoutFile"].as_str().unwrap();
        let err = parsed["stderrFile"].as_str().unwrap();
        assert_ne!(out, err);
        assert!(std::fs::read_to_string(out).unwrap().contains("OUT_TAIL"));
        assert!(std::fs::read_to_string(err).unwrap().contains("ERR_TAIL"));
    }

    #[test]
    fn plain_text_results_spill_whole() {
        let dir = tempfile::tempdir().unwrap();
        let text = big("TEXT_HEAD", "TEXT_TAIL");
        let result = spill_oversized(dir.path(), "call_plain", text);
        assert!(result.contains("TEXT_HEAD") && result.contains("TEXT_TAIL"));
        assert!(result.len() < 12 * 1024 + 1024, "preview is bounded");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "the whole body lands in one file"
        );
    }

    #[test]
    fn spill_names_are_short_and_stable() {
        // The model reads this path back and passes it to file_read, so the
        // long provider id must not end up in the filename.
        let first = sanitize("call_00_GX2Uk9XV5vG1yZFYts544827");
        assert_eq!(first, sanitize("call_00_GX2Uk9XV5vG1yZFYts544827"));
        assert!(first.len() <= 12, "got: {first}");
        assert_ne!(first, sanitize("call_01_different"));
    }

    #[test]
    fn ids_cannot_escape_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let raw = serde_json::json!({ "stdout": big("H", "T") }).to_string();
        let parsed: Value =
            serde_json::from_str(&spill_oversized(dir.path(), "../../evil", raw)).unwrap();
        let path = PathBuf::from(parsed["stdoutFile"].as_str().unwrap());
        assert_eq!(
            path.parent().map(dunce::simplified),
            Some(dunce::simplified(&dunce::canonicalize(dir.path()).unwrap())),
            "spill stays inside the thread's directory"
        );
    }

    #[test]
    fn a_failed_write_leaves_the_result_untouched() {
        // A path that cannot be a directory: create_dir_all fails, so the
        // payload must survive for the normal clamp to handle.
        let file = tempfile::NamedTempFile::new().unwrap();
        let raw = serde_json::json!({ "stdout": big("H", "T") }).to_string();
        assert_eq!(
            spill_oversized(&file.path().join("nested"), "call_1", raw.clone()),
            raw
        );
    }
}
