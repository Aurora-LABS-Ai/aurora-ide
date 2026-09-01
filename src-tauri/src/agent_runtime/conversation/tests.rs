//! Agent runtime — conversation tests.
//!
//! Split out of `conversation.rs` verbatim. Declared by `mod.rs` as
//! `#[cfg(test)] mod tests;`, so `use super::*` below reaches the
//! conversation module exactly as it did inside the old single file.

use super::*;
// Compaction's helpers are used by these tests but not by `mod.rs`,
// so they are imported here rather than re-exported module-wide.
use super::compaction::*;
use crate::agent_runtime::api_client::{ApiError, TurnUsage};
use async_trait::async_trait;
use std::sync::Mutex;
use tokio::sync::mpsc;

/// An edit result's before/after echo is content the model itself sent —
/// it must never reach model history, whatever its size. Counts and the
/// message stay; the elision names itself and the recovery.
#[test]
fn edit_results_drop_their_content_echo_from_model_history() {
    let raw = serde_json::json!({
        "success": true,
        "message": "Edited 1 file (2 replacements)",
        "path": "src/app.ts",
        "linesAdded": 4,
        "linesRemoved": 1,
        "oldContent": "x".repeat(500),
        "newContent": "y".repeat(500),
    })
    .to_string();

    let out = truncate_tool_content("file_edit", raw);
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(parsed.get("oldContent").is_none(), "echo dropped");
    assert!(parsed.get("newContent").is_none(), "echo dropped");
    assert_eq!(parsed["linesAdded"], 4, "signal kept");
    assert_eq!(
        parsed["message"], "Edited 1 file (2 replacements)",
        "signal kept"
    );
    // The strip leaves NO note behind. A note would explain an absence the
    // model cannot perceive — it is given a schema for tool inputs, never for
    // tool results — while the counts above already prove the edit landed. The
    // one rule a note could usefully carry holds for the whole conversation,
    // so paying ~70 tokens per result to restate it is the exact duplication
    // this function exists to delete.
    assert!(
        parsed.get("contentEcho").is_none(),
        "the elision is silent, got: {parsed}"
    );
}

/// The multi-file batch shape carries the echo per entry in `files[]`.
#[test]
fn multi_file_edit_results_drop_per_file_echo() {
    let raw = serde_json::json!({
        "success": true,
        "multiFile": true,
        "files": [
            { "path": "a.ts", "success": true, "oldContent": "a", "newContent": "b" },
            { "path": "b.ts", "success": true, "oldContent": "c", "newContent": "d" },
        ],
    })
    .to_string();

    let out = truncate_tool_content("file_edit", raw);
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    for file in parsed["files"].as_array().unwrap() {
        assert!(file.get("oldContent").is_none());
        assert!(file.get("newContent").is_none());
        assert!(file.get("path").is_some(), "identity kept");
    }
    // Silent for the batch shape too — neither at the top level nor per entry.
    assert!(parsed.get("contentEcho").is_none(), "got: {parsed}");
    assert!(
        parsed["files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|file| file.get("contentEcho").is_none()),
        "got: {parsed}"
    );
}

/// `file_write` goes through the same strip, and keeps the measured facts that
/// are the actual reason a result is worth sending back at all.
#[test]
fn writes_keep_their_measurements_and_lose_only_the_echo() {
    let raw = serde_json::json!({
        "success": true,
        "message": "File written: notes.md",
        "path": "notes.md",
        "bytes": 34,
        "linesAdded": 3,
        "linesRemoved": 0,
        "oldContent": "old",
        "newContent": "new",
    })
    .to_string();

    let out = truncate_tool_content("file_write", raw);
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(parsed.get("oldContent").is_none());
    assert!(parsed.get("newContent").is_none());
    assert!(parsed.get("contentEcho").is_none(), "got: {parsed}");
    assert_eq!(parsed["bytes"], 34, "measurement kept");
    assert_eq!(parsed["linesAdded"], 3, "measurement kept");
    assert_eq!(parsed["success"], true, "outcome kept");
}

/// A failure result has no echo to strip and must pass through untouched —
/// its corrective message is exactly what the model needs verbatim.
#[test]
fn edit_failures_are_left_alone() {
    let raw = serde_json::json!({
        "success": false,
        "error": "could not find the specified text",
        "hint": "Call file_read on this path, then retry.",
    })
    .to_string();
    assert_eq!(truncate_tool_content("file_edit", raw.clone()), raw);
}

#[test]
fn screenshot_ui_result_omits_base64_and_emits_path_json() {
    let raw = "<aurora_image media_type=\"image/png\" width=\"800\" height=\"600\" src=\"C:\\cache\\shot-1.png\">QUJDREVGRw==</aurora_image>\nScreenshot of http://localhost:3001 (800×600 px)";
    let ui = truncate_tool_content_for_ui("browser_screenshot", raw.to_string());

    // No base64 reaches the UI / thread store.
    assert!(!ui.contains("QUJDREVGRw=="));
    // A structured payload the tool card can parse: path + dims + url.
    let v: serde_json::Value = serde_json::from_str(&ui).expect("valid JSON payload");
    let shot = &v["screenshot"];
    assert_eq!(shot["path"], "C:\\cache\\shot-1.png");
    assert_eq!(shot["width"], 800);
    assert_eq!(shot["height"], 600);
    assert_eq!(shot["url"], "http://localhost:3001");
}

#[test]
fn screenshot_model_history_is_leaned_but_rehydratable() {
    // A screenshot WITH a `src` is leaned: base64 stripped, header (src/dims)
    // + caption + close tag kept, so the JSONL stays tiny and the adapter can
    // rehydrate the PNG from disk. It must NOT be byte-clamped (that would
    // chop the block and drop the close tag).
    let big_b64 = "A".repeat(20_000);
    let raw = format!(
            "<aurora_image media_type=\"image/png\" width=\"1400\" height=\"820\" src=\"C:\\cache\\shot.png\">{big_b64}</aurora_image>\nScreenshot of http://localhost:3001 (1400×820 px)"
        );
    let leaned = truncate_tool_content("browser_screenshot", raw);
    assert!(!leaned.contains(&big_b64), "base64 body must be stripped");
    assert!(
        leaned.contains("src=\"C:\\cache\\shot.png\""),
        "src pointer kept"
    );
    assert!(leaned.contains("</aurora_image>"), "close tag kept");
    assert!(
        leaned.contains("Screenshot of http://localhost:3001"),
        "caption kept"
    );
}

/// `file_read` on a picture returns the same marker shape a capture does, so
/// it must get the same treatment all the way down: leaned for history, kept
/// whole (never byte-clamped through the base64), and rendered from a path
/// rather than a blob. The bug this closes was the read failing outright with
/// "stream did not contain valid UTF-8"; the bug it must not introduce is the
/// image being re-uploaded on every later turn.
#[test]
fn a_file_read_image_is_leaned_and_named_like_a_capture() {
    let big_b64 = "C".repeat(20_000);
    let raw = format!(
        "<aurora_image media_type=\"image/jpeg\" width=\"1024\" height=\"594\" \
         src=\"C:\\cache\\agent-images\\img-9f2c.jpg\" name=\"hub-dashboard.png\">{big_b64}\
         </aurora_image>\ndocs/hub-dashboard.png — PNG image, 1400×812 px, 235 KB. \
         Shown to you downscaled to 1024×594."
    );

    let leaned = truncate_tool_content("file_read", raw.clone());
    assert!(!leaned.contains(&big_b64), "base64 stripped from history");
    assert!(leaned.contains("img-9f2c.jpg"), "src pointer kept");
    assert!(leaned.contains("</aurora_image>"), "close tag kept");
    assert!(
        leaned.contains("docs/hub-dashboard.png — PNG image"),
        "caption kept — it is the whole result for a model without vision"
    );

    let ui = truncate_tool_content_for_ui("file_read", raw);
    assert!(!ui.contains(&big_b64), "no base64 reaches the thread store");
    let v: serde_json::Value = serde_json::from_str(&ui).expect("valid JSON payload");
    let image = &v["screenshot"];
    assert_eq!(image["path"], "C:\\cache\\agent-images\\img-9f2c.jpg");
    assert_eq!(
        image["name"], "hub-dashboard.png",
        "the card labels itself with the file that was read, not the cache file"
    );
    assert!(image["url"].is_null(), "a file read captured no page");
}

/// A read naming several pictures cannot collapse into the single-image
/// envelope: it keeps its own shape and only sheds the base64, so the card can
/// find every marker and show as many images as the model was given.
#[test]
fn a_multi_image_read_keeps_every_marker_in_the_ui_copy() {
    let raw = format!(
        "{first}\n\n{second}",
        first = "<aurora_image media_type=\"image/jpeg\" width=\"800\" height=\"600\" \
                 src=\"C:\\cache\\a.jpg\" name=\"one.png\">QUJDREVGRw==</aurora_image>\none.png",
        second = "<aurora_image media_type=\"image/jpeg\" width=\"640\" height=\"480\" \
                  src=\"C:\\cache\\b.jpg\" name=\"two.png\">SElKS0xNTk8=</aurora_image>\ntwo.png",
    );

    let ui = truncate_tool_content_for_ui("file_read", raw);
    assert!(!ui.contains("QUJDREVGRw=="), "first body stripped");
    assert!(!ui.contains("SElKS0xNTk8="), "second body stripped");
    assert!(ui.contains("C:\\cache\\a.jpg") && ui.contains("C:\\cache\\b.jpg"));
    assert_eq!(ui.matches("</aurora_image>").count(), 2, "both kept");
}

/// An image is billed by the provider's tile formula, not by the length of its
/// base64. Counting the marker as text put a single screenshot at ~7,000 tokens
/// of context it does not occupy — enough to trip trimming on its own.
#[test]
fn an_image_result_costs_a_flat_estimate_not_its_base64_length() {
    let body = "D".repeat(28_000);
    let raw = format!(
        "<aurora_image media_type=\"image/jpeg\" width=\"1024\" height=\"594\" \
         name=\"mock.png\">{body}</aurora_image>\nmock.png — PNG image, 240 KB."
    );
    let counted = super::tokens::estimate_text_with_images(&raw);
    assert!(
        counted < super::tokens::IMAGE_TOKEN_ESTIMATE + 100,
        "an image plus a one-line caption, not 7k of base64: got {counted}"
    );
}

#[test]
fn screenshot_without_src_keeps_inline_base64() {
    // If the on-disk save failed there's no `src`, so the body is the only
    // copy — it must survive leaning or the model loses the image entirely.
    let b64 = "B".repeat(12_000);
    let raw = format!(
            "<aurora_image media_type=\"image/png\" width=\"800\" height=\"600\">{b64}</aurora_image>\nScreenshot of http://localhost:3001 (800×600 px)"
        );
    let out = truncate_tool_content("browser_screenshot", raw);
    assert!(out.contains(&b64), "inline base64 kept when there's no src");
}

/// Prose that documents the marker syntax — `.knowledge/knowledge.md` and
/// this project's own source both do — must not be mistaken for a
/// screenshot. Before the validated parse it took the leanify branch, so it
/// skipped the size cap AND was handed to the provider adapter as an image.
#[test]
fn text_quoting_the_marker_syntax_is_not_a_screenshot() {
    let prose = format!(
        "FIX: `truncate_tool_content` returns early when `s.contains(\"<aurora_image \")`.\n\
             {}\n\
             The MODEL copy keeps the full `<aurora_image>` block (vision), the UI copy is lean.\n",
        "context line\n".repeat(4_000),
    );

    // A tool whose results are clamped: the cap must still apply.
    let out = truncate_tool_content("grep", prose.clone());
    assert!(out.len() < prose.len(), "size cap must still apply");
    assert!(out.contains("[truncated"), "clamp marker present");

    // And the adapter must see text, not an image.
    assert!(!crate::api::aurora_image::has_marker(&prose));
}

#[test]
fn persisted_edit_result_stays_valid_json_when_large() {
    let raw = serde_json::json!({
        "success": true,
        "path": "src/App.tsx",
        "fullPath": "E:\\work\\src\\App.tsx",
        "linesAdded": 2,
        "linesRemoved": 2,
        "oldContent": "a".repeat(20_000),
        "newContent": "b".repeat(20_000),
    })
    .to_string();

    let compacted = truncate_tool_content("file_edit", raw);
    assert!(compacted.len() <= MAX_TOOL_RESULT_LENGTH);
    let parsed: serde_json::Value =
        serde_json::from_str(&compacted).expect("history result must stay valid JSON");
    assert_eq!(parsed["path"], "src/App.tsx");
    // The echo is stripped outright (see `strip_edit_content_echo`), so a
    // large edit result never even reaches the shrink-to-fit pass.
    assert!(parsed.get("oldContent").is_none());
    assert!(parsed.get("newContent").is_none());
    assert_eq!(parsed["linesAdded"], 2);
}

#[test]
fn persisted_multi_read_keeps_each_file_as_valid_json() {
    let raw = serde_json::json!({
        "success": true,
        "filesRead": 3,
        "files": [
            { "path": "a.ts", "success": true, "content": "a".repeat(240_000) },
            { "path": "b.ts", "success": true, "content": "b".repeat(240_000) },
            { "path": "c.ts", "success": true, "content": "c".repeat(240_000) },
        ]
    })
    .to_string();

    let compacted = truncate_tool_content("file_read", raw);
    assert!(compacted.len() <= MAX_READ_RESULT_LENGTH);
    let parsed: serde_json::Value =
        serde_json::from_str(&compacted).expect("batch read history must stay valid JSON");
    let files = parsed["files"].as_array().expect("files array");
    assert_eq!(files.len(), 3);
    assert!(files.iter().all(|file| file["content"]
        .as_str()
        .is_some_and(|content| !content.is_empty())));
}

/// The built-in doctrine is a standing instruction, not a search result: it
/// must arrive whole or the model follows rules it was never shown. Under the
/// generic 8 KiB cap the default `both` lost its last 2,121 characters —
/// errors, warnings, ethical psychology, every hard-fail pattern and the tone
/// rules — and the cut landed mid-sentence with nothing but a byte count to
/// say so. This fails the moment the payload outgrows its cap again.
#[test]
fn the_doctrine_reaches_the_model_whole() {
    use crate::tools::design::doctrine::{AUDIT, CORE, PATTERNS, WRITING};

    // The widest reading the tool will hand over (`topic: "all"`), composed the
    // way `DesignGuidelinesTool` composes it.
    let all = [CORE, PATTERNS, WRITING, AUDIT].join("\n\n---\n\n");

    for payload in [CORE, PATTERNS, WRITING, AUDIT, all.as_str()] {
        let kept = truncate_tool_content("design_guidelines", payload.to_string());
        assert_eq!(
            kept,
            payload,
            "the doctrine must reach the model verbatim: {} chars against a {} cap",
            payload.len(),
            result_cap_for("design_guidelines"),
        );
    }

    // Sections that sit at the TAIL of their document, so a cap that clips
    // again is caught by name rather than by a byte count.
    assert!(all.contains("## 8. Ethical psychology"));
    assert!(all.contains("## 10. Hard fails"));
    assert!(all.contains("## 13. Report format"));
    assert!(!all.contains("[truncated"));
}

#[test]
fn persisted_structured_result_never_falls_back_to_broken_json() {
    // Well past even the tree's own cap, so the compactor is guaranteed to
    // engage — this test is about it producing VALID JSON, not about where
    // the threshold sits.
    let raw = serde_json::json!({
        "success": true,
        "tree": (0..40_000)
            .map(|index| serde_json::json!({
                "name": format!("file-{index}.ts"),
                "path": format!("src/generated/file-{index}.ts"),
                "type": "file",
            }))
            .collect::<Vec<_>>(),
    })
    .to_string();

    let compacted = truncate_tool_content("workspace_tree", raw);
    let parsed: serde_json::Value =
        serde_json::from_str(&compacted).expect("structured history must stay valid JSON");
    // The tree has its own, larger cap — `MAX_TOOL_RESULT_LENGTH` would be
    // the wrong bound to assert here. See `result_cap_for`.
    assert!(compacted.len() <= result_cap_for("workspace_tree"));
    assert_eq!(parsed["success"], true);
    assert_eq!(parsed["historyTruncated"], true);
    assert!(parsed["tree"]
        .as_array()
        .is_some_and(|tree| !tree.is_empty()));
}

/// A real-shaped `workspace_tree` result must reach the model INTACT. The
/// tool now fits its own budget, so the compactor should never engage —
/// that pass is what silently deleted `src/` from Aurora's own map.
#[test]
fn a_default_sized_tree_is_never_compacted() {
    // 500 nodes (the tool's default budget) at a realistic path length.
    let raw = serde_json::json!({
        "success": true,
        "rootPath": r"E:\VOID-EDITOR\Aurora-Agent-IDE",
        "tree": (0..500)
            .map(|index| serde_json::json!({
                "name": format!("some_module_{index}.rs"),
                "path": format!("src-tauri/src/tools/file_workspace_search/some_module_{index}.rs"),
                "type": "file",
                "lineCount": 420,
            }))
            .collect::<Vec<_>>(),
    })
    .to_string();

    let compacted = truncate_tool_content("workspace_tree", raw.clone());
    assert_eq!(
        compacted, raw,
        "a default-budget tree must pass through whole"
    );
    let parsed: serde_json::Value = serde_json::from_str(&compacted).unwrap();
    assert!(parsed.get("historyTruncated").is_none());
    assert_eq!(parsed["tree"].as_array().unwrap().len(), 500);
}

/// The bug that ate a whole web page.
///
/// `auroro_websearch` used to answer with `{"content": {"title": …, "content":
/// "<the page>"}}`. The shrinker matched the OUTER `content` key, found an
/// object rather than a string, and stopped — so the page body one level down
/// was never shortened, the search for a fitting size could never succeed, and
/// the result fell through to the envelope-only fallback. What reached the
/// model was `{"success": true, "historyTruncated": true}`: a success with no
/// page in it, which it reported as a page that returned no content.
#[test]
fn a_payload_nested_under_a_payload_key_is_still_shrunk() {
    let mut value = serde_json::json!({
        "success": true,
        "content": {
            "title": "A very long article",
            "content": "x".repeat(50_000),
        },
    });

    let changed = shrink_history_payload_strings(&mut value, 1_000);

    assert!(changed, "the nested body was not shrunk at all");
    let body = value["content"]["content"].as_str().unwrap();
    assert!(body.len() < 2_000, "still {} bytes", body.len());
    assert!(body.contains("truncated"));
    // The container itself survives — this shrinks payloads, it does not
    // delete structure.
    assert_eq!(value["content"]["title"], "A very long article");
}

/// The last-resort fallback removes the payload rather than shortening it, so
/// it has to say so. Without the note it is indistinguishable from a tool that
/// genuinely found nothing.
#[test]
fn the_envelope_only_fallback_admits_what_it_dropped() {
    // One enormous scalar the shrinker cannot touch (not a payload key) and no
    // arrays to halve, which is the only way to reach the fallback.
    let raw = serde_json::json!({
        "success": true,
        "blob": "y".repeat(60_000),
    })
    .to_string();

    let compacted = compact_json_tool_content(&raw, 512).expect("fallback");
    let parsed: serde_json::Value = serde_json::from_str(&compacted).unwrap();

    assert_eq!(parsed["historyTruncated"], true);
    let note = parsed["truncationNote"]
        .as_str()
        .expect("a dropped payload must be named");
    assert!(note.contains("blob"), "{note}");
    assert!(note.contains("empty answer"), "{note}");
}

/// The web tool now bounds its own output, so a normal page must reach the
/// model whole and never touch the compactor at all.
#[test]
fn a_normal_web_page_reaches_the_model_untouched() {
    let raw = serde_json::json!({
        "success": true,
        "action": "fetch",
        "document": {
            "url": "https://doc.rust-lang.org/book/ch10-02-traits.html",
            "kind": "article",
            "title": "Traits: Defining Shared Behavior",
            // A full window at the tool's default size.
            "content": "The trait defines shared behaviour. ".repeat(850),
            "totalChars": 30_000,
            "returnedChars": 30_000,
            "offset": 0,
            "hasMore": false,
        },
    })
    .to_string();

    let out = truncate_tool_content("auroro_websearch", raw.clone());
    assert_eq!(out, raw, "a normal page must pass through whole");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(parsed.get("historyTruncated").is_none());
    assert!(parsed["document"]["content"]
        .as_str()
        .is_some_and(|c| c.len() > 25_000));
}

/// The reported bug, reproduced end to end against the real page and the real
/// runtime clamp.
///
/// What was filed:
///
/// ```text
/// call:  {"action":"fetch","url":"https://aurorahelix.com/docs"}
/// reply: {"success":true,"error":null,"historyTruncated":true,"originalBytes":9454}
/// ```
///
/// A success with no page in it. This runs the same call through the real tool
/// and then through `truncate_tool_content` — the step the old result died at,
/// and the reason no amount of better extraction alone would have fixed it.
/// Both halves have to hold: real content out of the tool, and that content
/// still there after the clamp.
///
/// Ignored by default because it talks to the internet:
/// `cargo test --lib the_reported_fetch -- --ignored --nocapture`
#[tokio::test]
#[ignore = "hits the network"]
async fn the_reported_fetch_reaches_the_model_with_the_page_in_it() {
    use crate::agent_runtime::tool_executor::{ToolContext, ToolExecutor};
    use crate::tools::file_workspace_search::auroro_websearch::AuroroWebSearchTool;
    use std::sync::Arc;

    let ctx = ToolContext {
        workspace_access: Default::default(),
        turn_id: "t".into(),
        tool_call_id: "c".into(),
        thread_id: "s".into(),
        workspace_root: None,
        cancel_token: tokio_util::sync::CancellationToken::new(),
        spill_dir: None,
    };

    let tool: Arc<dyn ToolExecutor> = Arc::new(AuroroWebSearchTool);
    let raw = tool
        .execute(
            serde_json::json!({ "action": "fetch", "url": "https://aurorahelix.com/docs" }),
            &ctx,
        )
        .await
        .expect("the tool ran");

    let clamped = truncate_tool_content("auroro_websearch", raw.clone());
    println!("tool {} bytes -> model {} bytes", raw.len(), clamped.len());

    let parsed: serde_json::Value = serde_json::from_str(&clamped).expect("valid JSON");
    assert_eq!(parsed["success"], true);
    // The two markers of the old failure.
    assert!(
        parsed.get("historyTruncated").is_none(),
        "the compactor engaged: {clamped}"
    );
    assert!(
        parsed.get("truncationNote").is_none(),
        "the payload was dropped: {clamped}"
    );
    let content = parsed["document"]["content"]
        .as_str()
        .expect("a fetch must carry its page");
    assert!(content.len() > 500, "only {} bytes of page", content.len());
    assert!(content.contains("Aurora"), "{content}");
}

// ── Test doubles ────────────────────────────────────────────────

/// Mock API client that emits a scripted sequence of events and
/// then returns a canned `TurnUsage`. Each call advances through
/// the script; if the script runs out the test fails.
struct MockApi {
    script: Mutex<Vec<TurnScript>>,
}

struct TurnScript {
    events: Vec<AssistantEvent>,
    result: Result<TurnUsage, ApiError>,
}

impl MockApi {
    fn new(turns: Vec<TurnScript>) -> Self {
        Self {
            script: Mutex::new(turns),
        }
    }
}

#[async_trait]
impl StreamingApiClient for MockApi {
    async fn stream(
        &self,
        _request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        _cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        let turn = {
            let mut script = self.script.lock().expect("script mutex");
            if script.is_empty() {
                return Err(ApiError::Provider(
                    "MockApi script exhausted — test bug".into(),
                ));
            }
            script.remove(0)
        };
        for event in turn.events {
            if event_sink.send(event).await.is_err() {
                return Err(ApiError::Network("event sink closed".into()));
            }
        }
        turn.result
    }
}

/// Tool that records every input it sees and returns a canned
/// string. Used to verify the runtime's tool dispatch path.
struct RecordingTool {
    name: &'static str,
    seen: Arc<Mutex<Vec<serde_json::Value>>>,
    response: String,
}

#[async_trait]
impl super::super::tool_executor::ToolExecutor for RecordingTool {
    fn name(&self) -> &str {
        self.name
    }
    fn schema(&self) -> super::super::api_client::ToolSchema {
        super::super::api_client::ToolSchema {
            name: self.name.into(),
            description: "test recorder".into(),
            input_schema: serde_json::json!({"type":"object"}),
        }
    }
    async fn execute(
        &self,
        input: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<String, ToolError> {
        self.seen.lock().expect("seen mutex").push(input);
        Ok(self.response.clone())
    }
}

/// Streams an assistant message and then cancels the turn — the user
/// pressing Stop while the tool calls are still arriving, which is the
/// window that used to leave `tool_use` blocks unanswered forever.
struct CancelWhileStreamingApi {
    message: Mutex<Option<ConversationMessage>>,
}

#[async_trait]
impl StreamingApiClient for CancelWhileStreamingApi {
    async fn stream(
        &self,
        _request: ApiRequest<'_>,
        _event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        let message = self
            .message
            .lock()
            .expect("message mutex")
            .take()
            .expect("CancelWhileStreamingApi called twice — test bug");
        cancel_token.cancel();
        Ok(turn_usage(message, "tool_use"))
    }
}

/// Tool that reports the turn was cancelled while it was running.
struct CancellingTool {
    name: &'static str,
}

#[async_trait]
impl super::super::tool_executor::ToolExecutor for CancellingTool {
    fn name(&self) -> &str {
        self.name
    }
    fn schema(&self) -> super::super::api_client::ToolSchema {
        super::super::api_client::ToolSchema {
            name: self.name.into(),
            description: "test canceller".into(),
            input_schema: serde_json::json!({"type":"object"}),
        }
    }
    async fn execute(
        &self,
        _input: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<String, ToolError> {
        Err(ToolError::Cancelled)
    }
}

fn assistant_tool_uses(calls: &[(&str, &str)]) -> ConversationMessage {
    ConversationMessage::assistant(
        calls
            .iter()
            .map(|(id, name)| ContentBlock::ToolUse {
                id: (*id).into(),
                name: (*name).into(),
                input: serde_json::json!({}),
            })
            .collect(),
        1_700_000_000_000,
    )
}

/// Ids of every `tool_use` in the session that no `tool_result` answers.
/// Non-empty means the next request to any provider is a 400.
fn unanswered_tool_use_ids(session: &Session) -> Vec<String> {
    let mut requested: Vec<String> = Vec::new();
    let mut answered: Vec<String> = Vec::new();
    for message in session.messages() {
        for block in &message.blocks {
            match block {
                ContentBlock::ToolUse { id, .. } => requested.push(id.clone()),
                ContentBlock::ToolResult { tool_use_id, .. } => answered.push(tool_use_id.clone()),
                _ => {}
            }
        }
    }
    requested
        .into_iter()
        .filter(|id| !answered.contains(id))
        .collect()
}

fn assistant_text(text: &str) -> ConversationMessage {
    ConversationMessage::assistant(
        vec![ContentBlock::Text { text: text.into() }],
        1_700_000_000_000,
    )
}

fn assistant_tool_use(id: &str, name: &str, input: serde_json::Value) -> ConversationMessage {
    ConversationMessage::assistant(
        vec![ContentBlock::ToolUse {
            id: id.into(),
            name: name.into(),
            input,
        }],
        1_700_000_000_000,
    )
}

fn turn_usage(message: ConversationMessage, stop_reason: &str) -> TurnUsage {
    TurnUsage {
        usage: TokenUsage {
            input_tokens: 5,
            output_tokens: 7,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            estimated: None,
            cost_usd: None,
        },
        stop_reason: stop_reason.into(),
        assistant_message: message,
    }
}

fn user_msg(text: &str) -> ConversationMessage {
    ConversationMessage::user_text(text, 1_700_000_000_000)
}

// ── Tests ───────────────────────────────────────────────────────

#[tokio::test]
async fn run_turn_no_tools_returns_after_one_iteration() {
    let api = Arc::new(MockApi::new(vec![TurnScript {
        events: vec![
            AssistantEvent::TextDelta {
                delta: "hello".into(),
            },
            AssistantEvent::TextDelta {
                delta: " world".into(),
            },
        ],
        result: Ok(turn_usage(assistant_text("hello world"), "end_turn")),
    }]));
    let tools = Arc::new(ToolRegistry::new());
    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

    let mut session = Session::new("t");
    let (tx, mut rx) = mpsc::channel(32);
    let cancel = CancellationToken::new();

    let summary = runtime
        .run_turn(&mut session, user_msg("hi"), tx, cancel)
        .await
        .expect("ok");

    assert_eq!(summary.iterations, 1);
    assert_eq!(summary.stop_reason, "end_turn");
    assert_eq!(summary.assistant_messages.len(), 1);
    assert!(summary.tool_results.is_empty());
    assert_eq!(summary.usage.input_tokens, 5);
    assert_eq!(summary.usage.output_tokens, 7);

    // session has user + assistant
    assert_eq!(session.len(), 2);

    // Drain the event channel and confirm we got 3 events:
    // 2 deltas + 1 message_stop, with strictly increasing seq.
    let mut events = Vec::new();
    while let Ok(envelope) =
        tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await
    {
        match envelope {
            Some(e) => events.push(e),
            None => break,
        }
    }
    assert_eq!(events.len(), 3, "expected 3 events, got {events:?}");
    for window in events.windows(2) {
        assert!(
            window[1].seq > window[0].seq,
            "seq must be strictly monotonic"
        );
        assert_eq!(window[0].turn_id, window[1].turn_id);
    }
    match &events[2].event {
        AssistantEvent::MessageStop { stop_reason } => {
            assert_eq!(stop_reason, "end_turn")
        }
        other => panic!("expected MessageStop last, got {other:?}"),
    }
}

/// The reported bug, end to end: Stop pressed after the tool calls streamed
/// in but before any of them ran, then a new prompt. The assistant message
/// is already persisted; if its `tool_use` blocks go unanswered the thread
/// is malformed on disk and EVERY later turn dies with a provider 400.
#[tokio::test]
async fn stopping_before_the_tools_run_leaves_no_unanswered_call() {
    let api = Arc::new(CancelWhileStreamingApi {
        message: Mutex::new(Some(assistant_tool_uses(&[
            ("call-1", "echo"),
            ("call-2", "echo"),
        ]))),
    });

    let seen = Arc::new(Mutex::new(Vec::new()));
    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(RecordingTool {
        name: "echo",
        seen: seen.clone(),
        response: "hi".into(),
    }));

    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());
    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(64);

    let outcome = runtime
        .run_turn(
            &mut session,
            user_msg("read both"),
            tx,
            CancellationToken::new(),
        )
        .await;

    assert!(matches!(outcome, Err(RuntimeError::Cancelled)));
    assert!(
        seen.lock().expect("seen").is_empty(),
        "cancelling before dispatch must not run the tools"
    );
    assert!(
        unanswered_tool_use_ids(&session).is_empty(),
        "every tool_use must carry an answer or the thread is malformed: {:?}",
        unanswered_tool_use_ids(&session),
    );

    // And the answers say why, so the model doesn't read them as real output.
    let answers: Vec<&str> = session
        .messages()
        .iter()
        .flat_map(|m| &m.blocks)
        .filter_map(|b| match b {
            ContentBlock::ToolResult {
                content, is_error, ..
            } => Some((content.as_str(), *is_error)),
            _ => None,
        })
        .map(|(content, is_error)| {
            assert_eq!(is_error, Some(true), "a stopped call is not a success");
            content
        })
        .collect();
    assert_eq!(answers, [STOPPED_BEFORE_RUN, STOPPED_BEFORE_RUN]);
}

/// Stop pressed while a tool is mid-flight. Results that already landed are
/// kept, the interrupted call is marked, and calls that never got dispatched
/// are answered too — all three kinds must appear or the pairing breaks.
#[tokio::test]
async fn stopping_during_a_tool_keeps_finished_work_and_answers_the_rest() {
    let api = Arc::new(MockApi::new(vec![TurnScript {
        events: vec![],
        result: Ok(turn_usage(
            assistant_tool_uses(&[
                ("call-1", "echo"),
                ("call-2", "stopper"),
                ("call-3", "echo"),
            ]),
            "tool_use",
        )),
    }]));

    let seen = Arc::new(Mutex::new(Vec::new()));
    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(RecordingTool {
        name: "echo",
        seen: seen.clone(),
        response: "hi".into(),
    }));
    tools.register(Arc::new(CancellingTool { name: "stopper" }));

    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());
    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(64);

    let outcome = runtime
        .run_turn(&mut session, user_msg("go"), tx, CancellationToken::new())
        .await;

    assert!(matches!(outcome, Err(RuntimeError::Cancelled)));
    assert!(
        unanswered_tool_use_ids(&session).is_empty(),
        "unanswered after a mid-tool stop: {:?}",
        unanswered_tool_use_ids(&session),
    );

    let answers: Vec<(String, String)> = session
        .messages()
        .iter()
        .flat_map(|m| &m.blocks)
        .filter_map(|b| match b {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                ..
            } => Some((tool_use_id.clone(), content.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(answers.len(), 3, "one answer per call, in call order");
    assert_eq!(answers[0], ("call-1".to_string(), "hi".to_string()));
    assert_eq!(answers[1].1, STOPPED_MID_RUN);
    assert_eq!(answers[2].1, STOPPED_BEFORE_RUN);
    assert_eq!(
        seen.lock().expect("seen").len(),
        1,
        "the call after the cancelled one must never dispatch"
    );
}

/// A reply cut off by the output cap WHILE emitting tool calls. The
/// arguments that parsed may be silently incomplete and the calls after the
/// cut are missing entirely, so none of them are safe to run — and the user
/// has to be told, which on this path used to happen nowhere.
#[tokio::test]
async fn a_reply_cut_off_mid_tool_call_fails_the_batch_and_says_so() {
    let api = Arc::new(MockApi::new(vec![TurnScript {
        events: vec![],
        result: Ok(turn_usage(
            assistant_tool_uses(&[("call-1", "echo")]),
            "length",
        )),
    }]));

    let seen = Arc::new(Mutex::new(Vec::new()));
    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(RecordingTool {
        name: "echo",
        seen: seen.clone(),
        response: "hi".into(),
    }));

    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());
    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(64);

    let summary = runtime
        .run_turn(
            &mut session,
            user_msg("write it"),
            tx,
            CancellationToken::new(),
        )
        .await
        .expect("a truncated batch ends the turn, it does not fail it");

    assert_eq!(summary.stop_reason, "length");
    assert_eq!(
        summary.iterations, 1,
        "the turn stops; retrying re-truncates"
    );
    assert!(
        seen.lock().expect("seen").is_empty(),
        "a call whose arguments may be truncated must not execute"
    );
    assert!(unanswered_tool_use_ids(&session).is_empty());

    let answered_with: Vec<&str> = session
        .messages()
        .iter()
        .flat_map(|m| &m.blocks)
        .filter_map(|b| match b {
            ContentBlock::ToolResult { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(answered_with, [TRUNCATED_CALL]);

    // The user is told, and the notice survives a reload.
    assert!(
        session.messages().iter().flat_map(|m| &m.blocks).any(
            |b| matches!(b, ContentBlock::Notice { message, .. } if message.contains("cut off"))
        ),
        "the truncation notice must be persisted on this path too",
    );
}

#[tokio::test]
async fn run_turn_dispatches_tool_then_loops_for_final_text() {
    let api = Arc::new(MockApi::new(vec![
        TurnScript {
            events: vec![AssistantEvent::ToolUse {
                id: "call-1".into(),
                name: "echo".into(),
                input: serde_json::json!({"msg": "hi"}),
            }],
            result: Ok(turn_usage(
                assistant_tool_use("call-1", "echo", serde_json::json!({"msg": "hi"})),
                "tool_use",
            )),
        },
        TurnScript {
            events: vec![AssistantEvent::TextDelta {
                delta: "done".into(),
            }],
            result: Ok(turn_usage(assistant_text("done"), "end_turn")),
        },
    ]));

    let tools = Arc::new(ToolRegistry::new());
    let seen = Arc::new(Mutex::new(Vec::new()));
    tools.register(Arc::new(RecordingTool {
        name: "echo",
        seen: seen.clone(),
        response: "hi".into(),
    }));

    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());
    let mut session = Session::new("t");
    let (tx, mut rx) = mpsc::channel(32);
    let cancel = CancellationToken::new();

    let summary = runtime
        .run_turn(&mut session, user_msg("hi"), tx, cancel)
        .await
        .expect("ok");

    assert_eq!(summary.iterations, 2, "should loop once for the tool");
    assert_eq!(summary.tool_results.len(), 1);
    assert_eq!(summary.assistant_messages.len(), 2);
    assert_eq!(summary.stop_reason, "end_turn");

    // session = user + assistant(tool_use) + tool(result) + assistant(text)
    assert_eq!(session.len(), 4);

    let recorded = seen.lock().expect("seen mutex");
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0], serde_json::json!({"msg": "hi"}));

    // The tool_results message must contain a ToolResult block
    // referencing the call id.
    match &summary.tool_results[0].blocks[0] {
        ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => {
            assert_eq!(tool_use_id, "call-1");
            assert_eq!(content, "hi");
            assert!(is_error.is_none(), "successful tool result has no is_error");
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }

    let mut events = Vec::new();
    while let Ok(envelope) =
        tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await
    {
        match envelope {
            Some(e) => events.push(e),
            None => break,
        }
    }
    assert_eq!(
        events.len(),
        5,
        "expected full tool lifecycle, got {events:?}"
    );
    assert!(matches!(
        &events[0].event,
        AssistantEvent::ToolUse { id, name, .. }
            if id == "call-1" && name == "echo"
    ));
    match &events[1].event {
        AssistantEvent::ToolExecutionStart { id, name, input } => {
            assert_eq!(id, "call-1");
            assert_eq!(name, "echo");
            assert_eq!(input, &serde_json::json!({"msg":"hi"}));
        }
        other => panic!("expected ToolExecutionStart, got {other:?}"),
    }
    match &events[2].event {
        AssistantEvent::ToolExecutionResult {
            id,
            name,
            content,
            is_error,
            ..
        } => {
            assert_eq!(id, "call-1");
            assert_eq!(name, "echo");
            assert_eq!(content, "hi");
            assert!(!is_error);
        }
        other => panic!("expected ToolExecutionResult, got {other:?}"),
    }
    match &events[4].event {
        AssistantEvent::MessageStop { stop_reason } => assert_eq!(stop_reason, "end_turn"),
        other => panic!("expected MessageStop last, got {other:?}"),
    }
}

#[tokio::test]
async fn run_turn_returns_tool_result_with_is_error_when_tool_not_found() {
    let api = Arc::new(MockApi::new(vec![
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use("call-x", "nonexistent", serde_json::json!({})),
                "tool_use",
            )),
        },
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(assistant_text("ok"), "end_turn")),
        },
    ]));
    let tools = Arc::new(ToolRegistry::new());
    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);
    let cancel = CancellationToken::new();

    let summary = runtime
        .run_turn(&mut session, user_msg("?"), tx, cancel)
        .await
        .expect("ok");

    assert_eq!(summary.tool_results.len(), 1);
    match &summary.tool_results[0].blocks[0] {
        ContentBlock::ToolResult {
            content, is_error, ..
        } => {
            assert_eq!(*is_error, Some(true));
            assert!(content.contains("tool not found"));
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }
}

#[test]
fn malformed_input_error_quotes_what_arrived_and_names_the_cause() {
    // Cut off mid-string — the shape an output cap produces.
    let cut = r#"{"path":"src/main.rs","content":"fn main() {"#;
    let message = malformed_input_error("file_write", cut).to_string();

    assert!(message.contains("`file_write` was NOT executed"));
    assert!(message.contains(cut), "must quote the raw payload");
    assert!(
        message.contains("output-token limit"),
        "an EOF parse failure is a truncation, not a syntax error: {message}"
    );

    // A syntax error gets the other diagnosis and the other advice.
    let broken = r#"{"path":"C:\Users\x"}"#;
    let message = malformed_input_error("file_read", broken).to_string();
    assert!(
        !message.contains("output-token limit"),
        "complete-but-invalid JSON is not a truncation: {message}"
    );
    assert!(message.contains("must be in double quotes"));
    assert!(
        message.contains("`\\\\`"),
        "must still name the escape: {message}"
    );
}

/// The caret is the part a model can act on without counting characters.
///
/// "column 10" is a number it has to tally against its own payload by hand,
/// and a miscount edits the wrong thing — which is how one missing pair of
/// quotes became five identical retries from GLM-5.2 on 2026-08-21.
#[test]
fn malformed_input_error_points_at_the_offending_character() {
    let broken = r#"{"path":"C:\Users\x"}"#;
    let message = malformed_input_error("file_read", broken).to_string();

    let caret = message
        .lines()
        .find(|line| line.trim_start().starts_with('^'))
        .expect("a caret line");
    let payload = message
        .lines()
        .find(|line| line.starts_with(r#"{"path""#))
        .expect("the quoted payload");

    // The caret's column must land on a real character of the payload.
    let column = caret.len() - caret.trim_start().len();
    assert!(column < payload.len(), "caret past the end: {message}");
    assert!(caret.contains("column"), "{message}");
}

/// A payload spanning several lines gets no caret rather than a misplaced one.
/// A caret under the wrong line is worse than none: it sends the reader to a
/// character that is fine.
#[test]
fn malformed_input_error_omits_the_caret_when_it_cannot_be_aligned() {
    let multiline = "{\n  \"path\": oops\n}";
    let message = malformed_input_error("file_read", multiline).to_string();

    assert!(message.contains("was NOT executed"));
    assert!(
        !message
            .lines()
            .any(|line| line.trim_start().starts_with('^')),
        "a caret cannot be aligned across lines: {message}"
    );
}

/// The diagnosis must describe what ARRIVED, never assume why we are here.
///
/// The old text said "the arguments parsed but were not a JSON object" for
/// anything that parsed — including a perfectly good object. A model read that,
/// concluded it had double-encoded its arguments, rewrote a shape that was
/// already correct, and filed a retraction of a bug report that was right.
#[test]
fn malformed_input_error_does_not_blame_the_model_for_a_valid_object() {
    let valid = r#"{"path":"out.md","content":"hello"}"#;
    let message = malformed_input_error("file_write", valid).to_string();
    assert!(
        message.contains("Aurora bug"),
        "a well-formed object reaching this path is our fault and must say so: {message}"
    );
    assert!(
        !message.contains("were not a JSON object"),
        "must not tell the model its object is not an object: {message}"
    );

    // A genuinely double-encoded payload still gets named for what it is.
    let double_encoded = r#""{\"path\":\"out.md\"}""#;
    let message = malformed_input_error("file_write", double_encoded).to_string();
    assert!(
        message.contains("double-encoded"),
        "a JSON string must be diagnosed as one: {message}"
    );
}

#[test]
fn malformed_input_error_elides_the_middle_of_a_huge_payload() {
    let raw = format!(r#"{{"content":"{}"#, "x".repeat(5_000));
    let message = malformed_input_error("file_write", &raw).to_string();

    assert!(message.contains("First 400 characters"));
    assert!(message.contains("Last 200 characters"));
    assert!(
        message.len() < 2_000,
        "the error must not itself flood the context: {} chars",
        message.len()
    );
}

#[tokio::test]
async fn run_turn_does_not_dispatch_a_tool_whose_arguments_never_parsed() {
    // `parse_tool_input` encodes an unparseable payload as a raw string.
    // The dispatcher must answer it with MalformedInput instead of
    // handing the executor an empty object and letting it report a
    // missing field to a model that sent one.
    let raw = r#"{"msg":"unterminated"#;
    let api = Arc::new(MockApi::new(vec![
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use("call-bad", "echo", serde_json::json!(raw)),
                "tool_use",
            )),
        },
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(assistant_text("ok"), "end_turn")),
        },
    ]));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(RecordingTool {
        name: "echo",
        seen: seen.clone(),
        response: "should never run".into(),
    }));
    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);

    let summary = runtime
        .run_turn(&mut session, user_msg("?"), tx, CancellationToken::new())
        .await
        .expect("ok");

    assert!(
        seen.lock().expect("seen mutex").is_empty(),
        "the executor must never be reached with fabricated arguments"
    );

    match &summary.tool_results[0].blocks[0] {
        ContentBlock::ToolResult {
            content, is_error, ..
        } => {
            assert_eq!(*is_error, Some(true));
            assert!(content.contains("was NOT executed"), "{content}");
            assert!(content.contains(raw), "must quote the payload: {content}");
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }
}

#[test]
fn failure_loop_guard_escalates_only_on_repeats() {
    let mut guard = FailureLoopGuard::default();
    let args = serde_json::json!({"path": "a.rs", "old_string": "x"});

    // First failure reads normally — a single miss is not a loop.
    assert!(guard.record_failure("file_edit", &args).is_none());

    let second = guard
        .record_failure("file_edit", &args)
        .expect("escalation");
    assert!(second.contains("SECOND time"));
    assert!(second.contains("re-read the file"));

    let third = guard
        .record_failure("file_edit", &args)
        .expect("escalation");
    assert!(third.contains("STOP"));
    assert!(third.contains("failed 3 times"));

    // Different arguments are a different attempt, not a repeat.
    let other = serde_json::json!({"path": "b.rs", "old_string": "x"});
    assert!(guard.record_failure("file_edit", &other).is_none());
    // …and so is the same arguments on a different tool.
    assert!(guard.record_failure("search_replace", &args).is_none());
}

#[test]
fn failure_loop_guard_resets_after_a_success() {
    let mut guard = FailureLoopGuard::default();
    let args = serde_json::json!({"command": "cargo test"});

    assert!(guard.record_failure("shell_execute", &args).is_none());
    guard.clear("shell_execute", &args);
    assert!(
        guard.record_failure("shell_execute", &args).is_none(),
        "a success means the situation changed — counting starts fresh"
    );
}

#[test]
fn length_stop_is_recognized_across_provider_spellings() {
    assert!(is_length_stop("length"));
    assert!(is_length_stop("max_tokens"));
    assert!(!is_length_stop("end_turn"));
    assert!(!is_length_stop("tool_use"));
    assert!(!is_length_stop("stop"));
}

/// Executor that blocks until released, so a test can prove two calls
/// were genuinely in flight at once rather than merely fast.
struct GateTool {
    name: &'static str,
    concurrent: bool,
    entered: Arc<tokio::sync::Semaphore>,
    release: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl super::super::tool_executor::ToolExecutor for GateTool {
    fn name(&self) -> &str {
        self.name
    }
    fn concurrency_safe(&self) -> bool {
        self.concurrent
    }
    fn schema(&self) -> super::super::api_client::ToolSchema {
        super::super::api_client::ToolSchema {
            name: self.name.into(),
            description: "gate".into(),
            input_schema: serde_json::json!({"type":"object"}),
        }
    }
    async fn execute(
        &self,
        _input: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<String, ToolError> {
        self.entered.add_permits(1);
        self.release.notified().await;
        Ok("done".into())
    }
}

#[tokio::test]
async fn concurrency_safe_calls_in_one_batch_run_at_the_same_time() {
    let entered = Arc::new(tokio::sync::Semaphore::new(0));
    let release = Arc::new(tokio::sync::Notify::new());

    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(GateTool {
        name: "reader",
        concurrent: true,
        entered: entered.clone(),
        release: release.clone(),
    }));

    let calls: Vec<PendingToolCall> = (0..3)
        .map(|i| PendingToolCall {
            id: format!("call-{i}"),
            name: "reader".into(),
            input: serde_json::json!({ "n": i }),
        })
        .collect();

    let runtime = ConversationRuntime::new(
        Arc::new(MockApi::new(vec![])),
        tools,
        RuntimeConfig::default(),
    );
    let session = Session::new("t");
    let (tx, _rx) = mpsc::channel(64);
    let cancel = CancellationToken::new();
    let mut seq = 0u64;

    // Release only once all three have entered. If dispatch were
    // sequential this would deadlock, so the timeout IS the assertion.
    let waiter = tokio::spawn({
        let entered = entered.clone();
        let release = release.clone();
        async move {
            let _ = entered.acquire_many(3).await.expect("all three entered");
            release.notify_waiters();
        }
    });

    let batch = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        runtime.execute_tool_calls(calls, &session, "turn-1", &cancel, &tx, &mut seq),
    )
    .await
    .expect("three concurrency-safe calls must overlap, not serialize")
    .expect("ok");

    waiter.await.expect("waiter");
    assert!(!batch.cancelled);
    assert_eq!(batch.message.blocks.len(), 3);
    // Order follows the model's call order, not completion order.
    for (i, block) in batch.message.blocks.iter().enumerate() {
        match block {
            ContentBlock::ToolResult { tool_use_id, .. } => {
                assert_eq!(*tool_use_id, format!("call-{i}"));
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }
}

/// Concurrency-safe and instant — the fast half of a mixed batch.
struct InstantTool {
    name: &'static str,
}

#[async_trait]
impl super::super::tool_executor::ToolExecutor for InstantTool {
    fn name(&self) -> &str {
        self.name
    }
    fn concurrency_safe(&self) -> bool {
        true
    }
    fn schema(&self) -> super::super::api_client::ToolSchema {
        super::super::api_client::ToolSchema {
            name: self.name.into(),
            description: "instant".into(),
            input_schema: serde_json::json!({"type":"object"}),
        }
    }
    async fn execute(
        &self,
        _input: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<String, ToolError> {
        Ok("instant".into())
    }
}

#[tokio::test]
async fn a_finished_call_resolves_its_own_card_without_waiting_for_the_batch() {
    let entered = Arc::new(tokio::sync::Semaphore::new(0));
    let release = Arc::new(tokio::sync::Notify::new());

    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(InstantTool { name: "fast" }));
    tools.register(Arc::new(GateTool {
        name: "slow",
        concurrent: true,
        entered: entered.clone(),
        release: release.clone(),
    }));

    let calls = vec![
        PendingToolCall {
            id: "call-fast".into(),
            name: "fast".into(),
            input: serde_json::json!({}),
        },
        PendingToolCall {
            id: "call-slow".into(),
            name: "slow".into(),
            input: serde_json::json!({}),
        },
    ];

    let runtime = ConversationRuntime::new(
        Arc::new(MockApi::new(vec![])),
        tools,
        RuntimeConfig::default(),
    );
    let session = Session::new("t");
    let (tx, mut rx) = mpsc::channel::<AgentEventEnvelope>(64);
    let cancel = CancellationToken::new();
    let mut seq = 0u64;

    // Release the slow tool ONLY once the fast one's result event has
    // arrived. Back when both cards resolved together, that event did not
    // exist until the slow tool had already returned — which cannot happen
    // until this task fires. The deadlock, caught by the timeout, IS the
    // assertion.
    let watcher = tokio::spawn(async move {
        let mut resolved = Vec::new();
        while let Some(envelope) = rx.recv().await {
            if let AssistantEvent::ToolExecutionResult { id, .. } = &envelope.event {
                resolved.push(id.clone());
                if id == "call-fast" {
                    // `notify_one` parks a permit, so this cannot be missed
                    // if the slow tool has not reached its gate yet.
                    release.notify_one();
                }
            }
        }
        resolved
    });

    let batch = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        runtime.execute_tool_calls(calls, &session, "turn-1", &cancel, &tx, &mut seq),
    )
    .await
    .expect("a finished call must resolve its card before its slow neighbour returns")
    .expect("ok");

    drop(tx);
    let resolved = watcher.await.expect("watcher");
    assert_eq!(
        resolved,
        vec!["call-fast".to_string(), "call-slow".to_string()],
        "cards resolve in COMPLETION order"
    );

    // The model's copy is untouched by any of that: still call order.
    let ids: Vec<&str> = batch
        .message
        .blocks
        .iter()
        .map(|block| match block {
            ContentBlock::ToolResult { tool_use_id, .. } => tool_use_id.as_str(),
            other => panic!("expected ToolResult, got {other:?}"),
        })
        .collect();
    assert_eq!(ids, vec!["call-fast", "call-slow"]);

    // Every event drew from one counter, and the caller resumes after it.
    assert_eq!(seq, 4, "two starts + two results");
}

#[tokio::test]
async fn a_non_concurrent_tool_splits_the_batch_and_keeps_order() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(RecordingTool {
        name: "reader",
        seen: seen.clone(),
        response: "r".into(),
    }));
    tools.register(Arc::new(RecordingTool {
        name: "writer",
        seen: seen.clone(),
        response: "w".into(),
    }));

    let runtime = ConversationRuntime::new(
        Arc::new(MockApi::new(vec![])),
        tools.clone(),
        RuntimeConfig::default(),
    );

    // RecordingTool leaves `concurrency_safe` at its default (false),
    // so every call must run alone.
    let calls: Vec<PendingToolCall> = ["reader", "writer", "reader"]
        .iter()
        .enumerate()
        .map(|(i, name)| PendingToolCall {
            id: format!("c{i}"),
            name: (*name).into(),
            input: serde_json::json!({ "i": i }),
        })
        .collect();

    assert_eq!(
        runtime.concurrent_batch_len(&calls),
        1,
        "an unsafe tool at the head must run alone"
    );

    let session = Session::new("t");
    let (tx, _rx) = mpsc::channel(64);
    let mut seq = 0u64;
    let batch = runtime
        .execute_tool_calls(
            calls,
            &session,
            "turn-1",
            &CancellationToken::new(),
            &tx,
            &mut seq,
        )
        .await
        .expect("ok");

    assert_eq!(batch.message.blocks.len(), 3);
    assert_eq!(seen.lock().expect("seen").len(), 3);
}

#[test]
fn batch_splits_at_the_first_unsafe_call() {
    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(GateTool {
        name: "reader",
        concurrent: true,
        entered: Arc::new(tokio::sync::Semaphore::new(0)),
        release: Arc::new(tokio::sync::Notify::new()),
    }));
    tools.register(Arc::new(GateTool {
        name: "writer",
        concurrent: false,
        entered: Arc::new(tokio::sync::Semaphore::new(0)),
        release: Arc::new(tokio::sync::Notify::new()),
    }));
    let runtime = ConversationRuntime::new(
        Arc::new(MockApi::new(vec![])),
        tools,
        RuntimeConfig::default(),
    );

    let call = |name: &str, i: usize| PendingToolCall {
        id: format!("c{i}"),
        name: name.into(),
        input: serde_json::json!({}),
    };

    // [read, read, write, read] → batch of 2, then 1, then 1.
    let calls = vec![
        call("reader", 0),
        call("reader", 1),
        call("writer", 2),
        call("reader", 3),
    ];
    assert_eq!(runtime.concurrent_batch_len(&calls), 2);
    assert_eq!(runtime.concurrent_batch_len(&calls[2..]), 1);
    assert_eq!(runtime.concurrent_batch_len(&calls[3..]), 1);

    // An unknown tool never executes, so it cannot conflict with anything.
    let unknown = vec![call("nope", 0), call("reader", 1)];
    assert_eq!(runtime.concurrent_batch_len(&unknown), 2);
}

#[tokio::test]
async fn run_turn_respects_max_iterations_cap() {
    // Script always asks for another tool — would loop forever
    // without the cap.
    let always_tool = TurnScript {
        events: vec![],
        result: Ok(turn_usage(
            assistant_tool_use("call-loop", "echo", serde_json::json!({"msg":"loop"})),
            "tool_use",
        )),
    };
    // Need at least 4 entries so the cap-of-3 hits the limit
    // before exhausting the script.
    let api = Arc::new(MockApi::new(vec![
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use("call-loop", "echo", serde_json::json!({"msg":"loop"})),
                "tool_use",
            )),
        },
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use("call-loop", "echo", serde_json::json!({"msg":"loop"})),
                "tool_use",
            )),
        },
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use("call-loop", "echo", serde_json::json!({"msg":"loop"})),
                "tool_use",
            )),
        },
        always_tool,
    ]));

    let tools = Arc::new(ToolRegistry::new());
    let seen = Arc::new(Mutex::new(Vec::new()));
    tools.register(Arc::new(RecordingTool {
        name: "echo",
        seen: seen.clone(),
        response: "loop".into(),
    }));

    let runtime = ConversationRuntime::new(
        api,
        tools,
        RuntimeConfig {
            max_iterations: Some(3),
            ..RuntimeConfig::default()
        },
    );

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);
    let cancel = CancellationToken::new();

    let err = runtime
        .run_turn(&mut session, user_msg("?"), tx, cancel)
        .await
        .expect_err("must hit cap");
    match err {
        RuntimeError::InvalidState(msg) => {
            assert!(
                msg.contains("max_iterations"),
                "must mention cap, got: {msg}"
            );
        }
        other => panic!("expected InvalidState, got {other:?}"),
    }
}

#[tokio::test]
async fn run_turn_returns_cancelled_when_pre_cancelled() {
    let api = Arc::new(MockApi::new(vec![]));
    let tools = Arc::new(ToolRegistry::new());
    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);
    let cancel = CancellationToken::new();
    cancel.cancel();

    let err = runtime
        .run_turn(&mut session, user_msg("?"), tx, cancel)
        .await
        .expect_err("must cancel");
    assert!(err.is_cancellation());
}

/// The id a tool receives must be the THREAD, not `Session::session_id`.
///
/// This was wrong in production and nothing caught it: `session_id` is a
/// fresh UUIDv4 on every load, so the todo tool wrote its sidecar to
/// `<uuid>.todos.json`, announced the list to the UI under a thread id that
/// did not exist (the header indicator stayed empty), and lost everything on
/// restart. Every tool-visible id is asserted here so the two can never be
/// confused again.
#[tokio::test]
async fn tools_receive_the_thread_id_never_the_ephemeral_session_id() {
    struct IdSpy {
        seen: Arc<Mutex<Vec<String>>>,
    }
    #[async_trait]
    impl super::super::tool_executor::ToolExecutor for IdSpy {
        fn name(&self) -> &str {
            "echo"
        }
        fn schema(&self) -> super::super::api_client::ToolSchema {
            super::super::api_client::ToolSchema {
                name: "echo".into(),
                description: "id spy".into(),
                input_schema: serde_json::json!({"type":"object"}),
            }
        }
        async fn execute(
            &self,
            _input: serde_json::Value,
            ctx: &ToolContext,
        ) -> Result<String, ToolError> {
            self.seen
                .lock()
                .expect("seen mutex")
                .push(ctx.thread_id.clone());
            Ok("ok".into())
        }
    }

    let api = Arc::new(MockApi::new(vec![
        TurnScript {
            events: vec![],
            result: Ok(TurnUsage {
                usage: TokenUsage {
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    estimated: None,
                    cost_usd: None,
                },
                stop_reason: "tool_use".into(),
                assistant_message: assistant_tool_use("c1", "echo", serde_json::json!({})),
            }),
        },
        TurnScript {
            events: vec![],
            result: Ok(TurnUsage {
                usage: TokenUsage {
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    estimated: None,
                    cost_usd: None,
                },
                stop_reason: "end_turn".into(),
                assistant_message: assistant_text("done"),
            }),
        },
    ]));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(IdSpy { seen: seen.clone() }));
    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

    let mut session = Session::new("thread-abc");
    let ephemeral = session.session_id.clone();
    let (tx, _rx) = mpsc::channel(32);
    runtime
        .run_turn(&mut session, user_msg("go"), tx, CancellationToken::new())
        .await
        .expect("turn");

    let ids = seen.lock().expect("seen mutex").clone();
    assert_eq!(ids, vec!["thread-abc".to_string()]);
    assert_ne!(
        ids[0], ephemeral,
        "a per-load UUID must never reach a tool as its conversation id"
    );
}

#[tokio::test]
async fn run_turn_aggregates_usage_across_iterations() {
    let api = Arc::new(MockApi::new(vec![
        TurnScript {
            events: vec![],
            result: Ok(TurnUsage {
                usage: TokenUsage {
                    input_tokens: 10,
                    output_tokens: 20,
                    cache_creation_input_tokens: Some(3),
                    cache_read_input_tokens: None,
                    estimated: None,
                    cost_usd: None,
                },
                stop_reason: "tool_use".into(),
                assistant_message: assistant_tool_use("c1", "echo", serde_json::json!({"msg":"x"})),
            }),
        },
        TurnScript {
            events: vec![],
            result: Ok(TurnUsage {
                usage: TokenUsage {
                    input_tokens: 5,
                    output_tokens: 8,
                    cache_creation_input_tokens: Some(1),
                    cache_read_input_tokens: Some(2),
                    estimated: None,
                    cost_usd: None,
                },
                stop_reason: "end_turn".into(),
                assistant_message: assistant_text("done"),
            }),
        },
    ]));
    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(RecordingTool {
        name: "echo",
        seen: Arc::new(Mutex::new(Vec::new())),
        response: "ok".into(),
    }));
    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);
    let cancel = CancellationToken::new();

    let summary = runtime
        .run_turn(&mut session, user_msg("hi"), tx, cancel)
        .await
        .expect("ok");

    assert_eq!(summary.usage.input_tokens, 15);
    assert_eq!(summary.usage.output_tokens, 28);
    assert_eq!(summary.usage.cache_creation_input_tokens, Some(4));
    assert_eq!(summary.usage.cache_read_input_tokens, Some(2));

    // Each persisted call carries ITS OWN usage, not the turn total — the
    // thread's cost is re-derived from these on reload, so they have to be
    // per-request and complete.
    let persisted: Vec<&TokenUsage> = session
        .messages
        .iter()
        .filter(|m| m.role == MessageRole::Assistant)
        .filter_map(|m| m.usage.as_ref())
        .collect();
    assert_eq!(persisted.len(), 2, "every API call persists its usage");
    assert_eq!(persisted[0].input_tokens, 10);
    assert_eq!(persisted[1].input_tokens, 5);
}

/// Cost is per-model and the model can change between turns, so a total
/// summed from the transcript can only be right if each call says which
/// model produced it.
#[tokio::test]
async fn persisted_assistant_messages_record_the_model_that_ran_them() {
    let api = Arc::new(MockApi::new(vec![TurnScript {
        events: vec![],
        result: Ok(TurnUsage {
            usage: TokenUsage {
                input_tokens: 10,
                output_tokens: 20,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                estimated: None,
                cost_usd: None,
            },
            stop_reason: "end_turn".into(),
            assistant_message: assistant_text("done"),
        }),
    }]));
    let runtime =
        ConversationRuntime::new(api, Arc::new(ToolRegistry::new()), RuntimeConfig::default());

    let mut session = Session::new("t");
    session.model = Some("openai:gpt-5.6".into());
    let (tx, _rx) = mpsc::channel(32);

    runtime
        .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
        .await
        .expect("ok");

    let assistant = session
        .messages
        .iter()
        .find(|m| m.role == MessageRole::Assistant)
        .expect("assistant message");
    assert_eq!(assistant.model.as_deref(), Some("openai:gpt-5.6"));
}

/// A provider that reports no usage used to persist ZEROS while the live UI
/// showed an estimate, so reopening the chat totalled an exact-looking
/// $0.00. The estimate must be persisted AND flagged, so the cost renders
/// as approximate rather than as free.
#[tokio::test]
async fn a_no_usage_provider_persists_a_flagged_estimate_not_zeros() {
    let api = Arc::new(MockApi::new(vec![TurnScript {
        events: vec![],
        result: Ok(TurnUsage {
            usage: TokenUsage::default(), // provider reported nothing
            stop_reason: "end_turn".into(),
            assistant_message: assistant_text("a reply with real content in it"),
        }),
    }]));
    let runtime =
        ConversationRuntime::new(api, Arc::new(ToolRegistry::new()), RuntimeConfig::default());

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);

    runtime
        .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
        .await
        .expect("ok");

    let usage = session
        .messages
        .iter()
        .find(|m| m.role == MessageRole::Assistant)
        .and_then(|m| m.usage.clone())
        .expect("usage persisted");
    assert_eq!(usage.estimated, Some(true), "flagged as an estimate");
    assert!(
        usage.output_tokens > 0,
        "the estimate is persisted, not zeros"
    );
}

/// Mock that captures the `ApiRequest` it was called with so a
/// test can assert the runtime forwarded the right per-turn
/// overrides into the wire-level request.
struct CapturingApi {
    captured: Arc<Mutex<Option<CapturedRequest>>>,
}

/// `ApiRequest<'a>` is borrowed; copy the fields we want to
/// inspect into an owned snapshot so we can read it after the
/// future returns.
#[derive(Debug, Clone)]
struct CapturedRequest {
    system_prompt: Option<String>,
    temperature: Option<f32>,
    max_output_tokens: u32,
    thinking_enabled: bool,
    model: String,
}

#[async_trait]
impl StreamingApiClient for CapturingApi {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        _event_sink: mpsc::Sender<AssistantEvent>,
        _cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        *self.captured.lock().expect("captured mutex") = Some(CapturedRequest {
            system_prompt: request.system_prompt.map(str::to_string),
            temperature: request.temperature,
            max_output_tokens: request.max_output_tokens,
            thinking_enabled: request.reasoning.enabled,
            model: request.model.to_string(),
        });
        Ok(turn_usage(assistant_text("ok"), "end_turn"))
    }
}

#[tokio::test]
async fn run_turn_forwards_runtime_config_temperature_into_api_request() {
    // Phase 2.3: per-turn overrides flow through `RuntimeConfig`
    // into `ApiRequest::temperature`.
    let captured = Arc::new(Mutex::new(None));
    let api = Arc::new(CapturingApi {
        captured: captured.clone(),
    });
    let runtime = ConversationRuntime::new(
        api,
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            default_temperature: Some(0.42),
            ..RuntimeConfig::default()
        },
    );

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);
    runtime
        .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
        .await
        .expect("ok");

    let captured = captured.lock().expect("captured mutex");
    let captured = captured.as_ref().expect("api was called");
    assert_eq!(captured.temperature, Some(0.42));
}

#[tokio::test]
async fn run_turn_forwards_system_prompt_max_tokens_thinking_into_api_request() {
    let captured = Arc::new(Mutex::new(None));
    let api = Arc::new(CapturingApi {
        captured: captured.clone(),
    });
    let runtime = ConversationRuntime::new(
        api,
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            system_prompt: Some("YOU ARE THE AURORA SYSTEM PROMPT".into()),
            default_max_output_tokens: 1234,
            reasoning: crate::agent_runtime::api_client::ReasoningConfig::legacy(true, None),
            default_temperature: Some(0.0),
            ..RuntimeConfig::default()
        },
    );

    let mut session = Session::new("t");
    session.model = Some("claude-3-7-sonnet".into());
    let (tx, _rx) = mpsc::channel(32);
    runtime
        .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
        .await
        .expect("ok");

    let captured = captured.lock().expect("captured mutex");
    let captured = captured.as_ref().expect("api was called");
    assert_eq!(
        captured.system_prompt.as_deref(),
        Some("YOU ARE THE AURORA SYSTEM PROMPT")
    );
    assert_eq!(captured.max_output_tokens, 1234);
    assert!(captured.thinking_enabled);
    assert_eq!(captured.temperature, Some(0.0));
    assert_eq!(captured.model, "claude-3-7-sonnet");
}

/// Mock that captures the messages slice the runtime hands to
/// the API client. Used to verify ide_context wrapping.
struct CapturingMessagesApi {
    captured: Arc<Mutex<Option<Vec<ConversationMessage>>>>,
}

#[async_trait]
impl StreamingApiClient for CapturingMessagesApi {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        _event_sink: mpsc::Sender<AssistantEvent>,
        _cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        *self.captured.lock().expect("captured mutex") = Some(request.messages.to_vec());
        Ok(turn_usage(assistant_text("ok"), "end_turn"))
    }
}

#[test]
fn volatile_context_rides_as_its_own_message_at_the_tail() {
    // The opposite placement from the repo map, for the opposite reason:
    // the checklist and the IDE context change mid-turn, and spliced into
    // any EXISTING message they rewrite bytes inside the provider's cached
    // prefix — measured as the whole conversation re-billing as fresh
    // input on every checklist update. As their own message at the end,
    // a change touches nothing that was already cached.
    let tail = trailing_context_message(
        Some("OPEN_FILE: src/main.rs"),
        Some("<aurora_task_reminder>\n- [ ] t1 Do it (pending)\n</aurora_task_reminder>"),
    )
    .expect("both blocks present produces a message");

    assert_eq!(tail.role, MessageRole::User);
    let text = match &tail.blocks[0] {
        ContentBlock::Text { text } => text.clone(),
        other => panic!("expected text, got {other:?}"),
    };
    assert!(text.starts_with("<aurora_runtime_state>"), "{text}");
    assert!(text.contains("<ide_context>"), "{text}");
    assert!(text.contains("OPEN_FILE: src/main.rs"), "{text}");
    assert!(text.contains("<aurora_task_reminder>"), "{text}");

    // The tail is the most recent USER message the model sees, and a user
    // message carrying no request reads as the user having asked for nothing.
    // Thread `d394396f` at 01:34:26 answered this block instead of the
    // question above it ("No new task or question was included"), so the
    // envelope has to disown itself in as many words.
    assert!(text.contains("NOT from the user"), "{text}");
    assert!(text.contains("NOT a new request"), "{text}");
    assert!(text.contains("Do not reply to it"), "{text}");
    assert!(
        text.contains("user's most recent message above"),
        "the block must point back at the real turn: {text}"
    );

    // Either block alone still produces a message; neither produces none.
    assert!(trailing_context_message(Some("ctx"), None).is_some());
    assert!(trailing_context_message(None, Some("reminder")).is_some());
    assert!(trailing_context_message(None, None).is_none());
    // Empty strings count as absent — an empty tail message is pure cost.
    assert!(trailing_context_message(Some(""), Some("")).is_none());
}

#[test]
fn the_task_reminder_states_every_status_and_where_the_agent_is() {
    use crate::tools::shell_editor_todo::todo_store::{self, TodoItem, TodoList, TodoStatus};

    let thread = format!("reminder-test-{}", std::process::id());
    assert!(
        task_reminder_block(&thread).is_none(),
        "no list means no block — an empty reminder is pure cost"
    );

    let mut list = TodoList::default();
    for (id, content, status) in [
        ("t1", "Read the code", TodoStatus::Completed),
        ("t2", "Fix the bug", TodoStatus::InProgress),
        ("t3", "Run the tests", TodoStatus::Pending),
        ("t4", "Update the docs", TodoStatus::Cancelled),
    ] {
        list.items.push(TodoItem {
            id: id.into(),
            content: content.into(),
            active_form: content.into(),
            status,
        });
    }
    todo_store::write(&thread, &list).expect("write");

    let block = task_reminder_block(&thread).expect("a tracked list produces a block");
    assert!(block.starts_with("<aurora_task_reminder>"));
    assert!(block.ends_with("</aurora_task_reminder>"));
    // Every task, with its status readable both as a mark and as a word.
    assert!(
        block.contains("- [x] t1 Read the code (completed)"),
        "{block}"
    );
    assert!(
        block.contains("- [>] t2 Fix the bug (in_progress)"),
        "{block}"
    );
    assert!(
        block.contains("- [ ] t3 Run the tests (pending)"),
        "{block}"
    );
    assert!(
        block.contains("- [-] t4 Update the docs (cancelled)"),
        "{block}"
    );
    // Cancelled counts as closed, exactly like the user's checklist counts.
    assert!(block.contains("2 closed of 4"), "{block}");
    assert!(block.contains("Now working on t2."), "{block}");

    todo_store::clear(&thread).ok();
}

#[test]
fn repo_map_rides_on_the_first_user_message_not_the_latest() {
    // Placement is the whole cost model. At the head it sits inside the
    // provider's cached prefix and is billed once; on the newest message it
    // would be re-sent in full every turn, costing more than the file reads
    // it exists to avoid.
    let msgs = vec![
        ConversationMessage::user_text("first question", 0),
        ConversationMessage::user_text("second question", 1),
    ];
    let out = inject_repo_map(
        &msgs,
        "<repo_map>
src/
</repo_map>",
    );

    let head = match &out[0].blocks[0] {
        ContentBlock::Text { text } => text.clone(),
        other => panic!("expected text, got {other:?}"),
    };
    assert!(head.starts_with("<repo_map>"), "{head}");
    assert!(
        head.contains("first question"),
        "original text must survive"
    );

    let last = match &out[1].blocks[0] {
        ContentBlock::Text { text } => text.clone(),
        other => panic!("expected text, got {other:?}"),
    };
    assert!(
        !last.contains("<repo_map>"),
        "the latest message must stay untouched: {last}"
    );
}

#[test]
fn repo_map_injection_leaves_the_persisted_messages_verbatim() {
    // Same contract as inject_ide_context: the JSONL on disk holds the
    // user's words, and only the request body carries Aurora's additions.
    let msgs = vec![ConversationMessage::user_text("original", 0)];
    let out = inject_repo_map(&msgs, "<repo_map>x</repo_map>");

    match &msgs[0].blocks[0] {
        ContentBlock::Text { text } => assert_eq!(text, "original"),
        other => panic!("expected text, got {other:?}"),
    }
    match &out[0].blocks[0] {
        ContentBlock::Text { text } => assert!(text.contains("<repo_map>")),
        other => panic!("expected text, got {other:?}"),
    }
}

#[tokio::test]
async fn run_turn_wraps_user_message_with_ide_context_for_api_only() {
    let captured = Arc::new(Mutex::new(None));
    let api = Arc::new(CapturingMessagesApi {
        captured: captured.clone(),
    });
    let runtime = ConversationRuntime::new(
        api,
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            ide_context: Some("OPEN_FILE: src/main.rs".into()),
            ..RuntimeConfig::default()
        },
    );

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);
    runtime
        .run_turn(
            &mut session,
            user_msg("hello, agent"),
            tx,
            CancellationToken::new(),
        )
        .await
        .expect("ok");

    // API saw the ide_context as its own trailing user message — at the
    // absolute end, past everything the provider may have cached — and the
    // user's own message stayed byte-identical.
    let captured = captured.lock().expect("captured mutex");
    let captured = captured.as_ref().expect("api was called");
    let api_user = captured
        .iter()
        .find(|m| m.role == MessageRole::User)
        .expect("api saw a user message");
    match &api_user.blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(
                text, "hello, agent",
                "the user's message must not be rewritten — that is the cached prefix"
            );
        }
        other => panic!("expected Text, got {other:?}"),
    }
    let tail = captured.last().expect("api saw messages");
    assert_eq!(
        tail.role,
        MessageRole::User,
        "context tail is a user message"
    );
    match &tail.blocks[0] {
        ContentBlock::Text { text } => {
            assert!(
                text.contains("<ide_context>"),
                "tail must carry the ide_context wrapper, got: {text}"
            );
            assert!(
                text.contains("OPEN_FILE: src/main.rs"),
                "tail must carry the ide_context body, got: {text}"
            );
        }
        other => panic!("expected Text, got {other:?}"),
    }

    // Persisted session keeps the user message clean.
    let session_user = session
        .messages()
        .iter()
        .find(|m| m.role == MessageRole::User)
        .expect("session has user");
    match &session_user.blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(
                text, "hello, agent",
                "session JSONL must remain verbatim — got: {text}"
            );
            assert!(
                !text.contains("ide_context"),
                "session must NOT contain the ide_context wrapper, got: {text}"
            );
        }
        other => panic!("expected Text, got {other:?}"),
    }
}

#[tokio::test]
async fn run_turn_skips_ide_context_when_empty() {
    let captured = Arc::new(Mutex::new(None));
    let api = Arc::new(CapturingMessagesApi {
        captured: captured.clone(),
    });
    let runtime = ConversationRuntime::new(
        api,
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            ide_context: Some(String::new()),
            ..RuntimeConfig::default()
        },
    );

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);
    runtime
        .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
        .await
        .expect("ok");

    let captured = captured.lock().expect("captured mutex");
    let captured = captured.as_ref().expect("api was called");
    match &captured[0].blocks[0] {
        ContentBlock::Text { text } => {
            assert!(
                !text.contains("ide_context"),
                "empty ide_context must NOT wrap, got: {text}"
            );
        }
        other => panic!("expected Text, got {other:?}"),
    }
}

#[tokio::test]
async fn run_turn_default_config_yields_none_temperature_and_no_thinking() {
    // Sanity-check the default — `None` temperature and
    // `thinking_enabled: false` make the runtime defer to the
    // provider preset.
    let captured = Arc::new(Mutex::new(None));
    let api = Arc::new(CapturingApi {
        captured: captured.clone(),
    });
    let runtime =
        ConversationRuntime::new(api, Arc::new(ToolRegistry::new()), RuntimeConfig::default());

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);
    runtime
        .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
        .await
        .expect("ok");

    let captured = captured.lock().expect("captured mutex");
    let captured = captured.as_ref().expect("api was called");
    assert_eq!(captured.temperature, None);
    assert!(!captured.thinking_enabled);
    // Reasoning bills against this cap on most providers, so the default
    // has to leave room for a long think AND a full reply (was 8192, which
    // a high reasoning effort could consume entirely).
    assert_eq!(captured.max_output_tokens, 16_384);
    assert!(captured.system_prompt.is_none());
}

/// Hook recorder that captures every pre/post callback in order.
/// Used by the integration tests below to verify the runtime fires
/// hooks around tool dispatch in the contract-mandated order.
#[derive(Default)]
struct RecordingHook {
    events: Mutex<Vec<String>>,
}

#[async_trait]
impl super::super::hooks::Hook for RecordingHook {
    async fn pre_tool_use(&self, name: &str, _input: &serde_json::Value) {
        self.events
            .lock()
            .expect("events")
            .push(format!("pre:{name}"));
    }

    async fn post_tool_use(&self, name: &str, result: super::super::hooks::ToolHookResult<'_>) {
        let tag = match result {
            super::super::hooks::ToolHookResult::Success(s) => format!("ok:{s}"),
            super::super::hooks::ToolHookResult::Error(e) => format!("err:{e}"),
        };
        self.events
            .lock()
            .expect("events")
            .push(format!("post:{name}:{tag}"));
    }
}

#[tokio::test]
async fn run_turn_fires_pre_then_post_hook_around_tool_dispatch() {
    let api = Arc::new(MockApi::new(vec![
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use("c1", "echo", serde_json::json!({"msg":"hi"})),
                "tool_use",
            )),
        },
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(assistant_text("done"), "end_turn")),
        },
    ]));
    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(RecordingTool {
        name: "echo",
        seen: Arc::new(Mutex::new(Vec::new())),
        response: "hi".into(),
    }));

    let hook = Arc::new(RecordingHook::default());
    let runtime =
        ConversationRuntime::new(api, tools, RuntimeConfig::default()).with_hook(hook.clone());

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);
    runtime
        .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
        .await
        .expect("ok");

    let events = hook.events.lock().expect("events").clone();
    assert_eq!(events.len(), 2, "expected 1 pre + 1 post, got {events:?}");
    assert_eq!(events[0], "pre:echo");
    assert_eq!(events[1], "post:echo:ok:hi");
}

#[tokio::test]
async fn run_turn_post_hook_fires_with_error_when_tool_not_found() {
    let api = Arc::new(MockApi::new(vec![
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use("cx", "missing_tool", serde_json::json!({})),
                "tool_use",
            )),
        },
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(assistant_text("ok"), "end_turn")),
        },
    ]));
    let tools = Arc::new(ToolRegistry::new());
    let hook = Arc::new(RecordingHook::default());
    let runtime =
        ConversationRuntime::new(api, tools, RuntimeConfig::default()).with_hook(hook.clone());

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);
    runtime
        .run_turn(&mut session, user_msg("?"), tx, CancellationToken::new())
        .await
        .expect("ok");

    let events = hook.events.lock().expect("events").clone();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0], "pre:missing_tool");
    assert!(
        events[1].starts_with("post:missing_tool:err:tool not found"),
        "got: {}",
        events[1]
    );
}

#[tokio::test]
async fn run_turn_default_no_hook_still_compiles_and_runs() {
    // Sanity: the additive wiring keeps existing behaviour for
    // any caller that doesn't invoke `.with_hook(...)`.
    let api = Arc::new(MockApi::new(vec![TurnScript {
        events: vec![],
        result: Ok(turn_usage(assistant_text("ok"), "end_turn")),
    }]));
    let runtime =
        ConversationRuntime::new(api, Arc::new(ToolRegistry::new()), RuntimeConfig::default());
    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(32);
    runtime
        .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
        .await
        .expect("ok");
}

/// Traced from session `58e4f8a9` on 2026-08-23. The provider dropped a
/// request mid-stream — kenari's own dashboard billed that call **zero
/// tokens** — and Aurora received one thinking block whose text stops
/// mid-sentence. The retry that exists for a dropped response was keyed on
/// `blocks.is_empty()`, and the message had a block, so it never fired: 29
/// successful tool calls were thrown away and the user got "the model reasoned
/// but never produced an answer" with a Retry button.
#[tokio::test(start_paused = true)]
async fn reasoning_that_stops_without_answering_is_retried_not_kept() {
    let stalled = ConversationMessage::assistant(
        vec![ContentBlock::Thinking {
            text: "Now I have a complete picture. Let me confirm the data layer is".into(),
            signature: None,
            duration_ms: Some(11_711),
        }],
        1_700_000_000_000,
    );
    let api = Arc::new(MockApi::new(vec![
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(stalled, "end_turn")),
        },
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(assistant_text("the real answer"), "end_turn")),
        },
    ]));
    let runtime =
        ConversationRuntime::new(api, Arc::new(ToolRegistry::new()), RuntimeConfig::default());

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(64);
    runtime
        .run_turn(
            &mut session,
            user_msg("explain this"),
            tx,
            CancellationToken::new(),
        )
        .await
        .expect("the retry rescues the turn");

    let assistant_blocks: Vec<&ContentBlock> = session
        .messages
        .iter()
        .filter(|m| m.role == MessageRole::Assistant)
        .flat_map(|m| m.blocks.iter())
        .collect();

    assert!(
        assistant_blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Text { text } if text == "the real answer")),
        "the retry's answer must reach the session"
    );
    // The dead thought must not be persisted. History is replayed to the
    // provider on every later request in the thread, so keeping it means
    // paying for a truncated reasoning segment again and again.
    assert!(
        !assistant_blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Thinking { .. })),
        "the cut-off reasoning was persisted: {assistant_blocks:?}"
    );
}

/// The other half: a reply carrying only tool calls is a perfectly good step
/// and must never be mistaken for a dropped one. `has_visible_answer` counts
/// text only, so reusing it here would have stalled every tool-using turn.
#[tokio::test(start_paused = true)]
async fn a_reply_that_is_only_tool_calls_is_not_treated_as_dropped() {
    let api = Arc::new(MockApi::new(vec![
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_uses(&[("call-1", "echo")]),
                "tool_use",
            )),
        },
        // The tool result comes back, so the loop needs a second model call to
        // finish. A spurious retry would consume a third.
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(assistant_text("done"), "end_turn")),
        },
    ]));
    let tools = Arc::new(ToolRegistry::new());
    tools.register(Arc::new(RecordingTool {
        name: "echo",
        seen: Arc::new(Mutex::new(Vec::new())),
        response: "hi".into(),
    }));
    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

    let mut session = Session::new("t");
    let (tx, _rx) = mpsc::channel(64);
    let outcome = runtime
        .run_turn(&mut session, user_msg("go"), tx, CancellationToken::new())
        .await
        .expect("tool-only replies advance the turn");

    // Two model calls: the tool call and the answer after it. A third would
    // mean the retry fired on a reply that was advancing the turn perfectly
    // well.
    assert_eq!(outcome.iterations, 2);
    assert!(session.messages.iter().any(|m| m.role == MessageRole::Tool));
}

#[test]
fn the_backoff_ladder_is_capped_and_jittered() {
    // Capped: without a ceiling, attempt 6 of an 8-attempt ladder would be
    // half a minute and attempt 10 would be eight. A retry that long is a
    // hang wearing a progress message.
    for attempt in 1..40 {
        let delay = stream_retry_delay_ms(attempt, None);
        assert!(
            delay
                <= STREAM_RETRY_MAX_DELAY_MS
                    + (STREAM_RETRY_MAX_DELAY_MS as f64 * STREAM_RETRY_JITTER_FRACTION) as u64,
            "attempt {attempt} waited {delay}ms"
        );
    }

    // The first step is the base delay plus at most a quarter of it.
    let first = stream_retry_delay_ms(1, None);
    assert!(first >= STREAM_RETRY_BASE_DELAY_MS);
    assert!(first <= STREAM_RETRY_BASE_DELAY_MS + STREAM_RETRY_BASE_DELAY_MS / 4);

    // Jittered: every Aurora window that lost the same gateway must not come
    // back on the same schedule. Twenty draws landing on one value would mean
    // the jitter is not wired up.
    let draws: std::collections::HashSet<u64> =
        (0..20).map(|_| stream_retry_delay_ms(4, None)).collect();
    assert!(draws.len() > 1, "backoff is not jittered: {draws:?}");
}

#[test]
fn a_provider_that_names_its_own_wait_is_obeyed_over_the_ladder() {
    // Attempt 1's ladder guess is ~1s. When a 429 says 60, the guess is simply
    // wrong, and retrying early is what extends a rate limit rather than
    // clearing it.
    assert_eq!(stream_retry_delay_ms(1, Some(60)), 60_000);
    // It wins at every attempt, not just the first — the ladder never
    // out-bids a measured answer.
    assert_eq!(stream_retry_delay_ms(5, Some(3)), 3_000);
    // Zero is a legitimate "go ahead now".
    assert_eq!(stream_retry_delay_ms(2, Some(0)), 0);
}

#[tokio::test(start_paused = true)]
async fn run_turn_propagates_recoverable_api_error_with_event() {
    // A rate limit is retried before it is reported, so the script has to
    // fail every attempt for the error to reach the user at all. That IS
    // the contract: the Error event is what the user sees once retrying
    // has been tried and failed, not the first thing that goes wrong.
    let script = (0..MAX_STREAM_ATTEMPTS)
        .map(|_| TurnScript {
            events: vec![],
            result: Err(ApiError::RateLimit {
                retry_after_secs: None,
            }),
        })
        .collect();
    let api = Arc::new(MockApi::new(script));
    let tools = Arc::new(ToolRegistry::new());
    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

    let mut session = Session::new("t");
    let (tx, mut rx) = mpsc::channel(32);
    let cancel = CancellationToken::new();

    let err = runtime
        .run_turn(&mut session, user_msg("?"), tx, cancel)
        .await
        .expect_err("must surface api err");
    match err {
        RuntimeError::Api(ApiError::RateLimit { .. }) => {}
        other => panic!("expected Api(RateLimit), got {other:?}"),
    }

    // Drain to the Error event: the retries announce themselves first.
    let mut error_event = None;
    let mut discards = 0_u32;
    while let Ok(Some(envelope)) =
        tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await
    {
        match envelope.event {
            AssistantEvent::PartialReplyDiscarded { .. } => discards += 1,
            AssistantEvent::Error {
                message,
                recoverable,
            } => {
                error_event = Some((message, recoverable));
                break;
            }
            other => panic!("unexpected event before the error: {other:?}"),
        }
    }

    assert_eq!(
        discards,
        MAX_STREAM_ATTEMPTS - 1,
        "one discard per retry, and no discard for the attempt that gave up",
    );
    let (message, recoverable) = error_event.expect("the error must still reach the user");
    assert!(recoverable, "rate-limit must be recoverable");
    assert!(message.contains("rate"), "got message: {message}");
}

// ── Budget-aware trim tests ────────────────────────────────────────
//
// Pure unit tests for `trim_to_budget` / `build_trim_notice` plus an
// integration test that asserts the runtime forwards a trimmed
// message slice + an augmented system prompt to the API once a
// session blows past the configured window.

fn user_with_text(text: &str, ts: i64) -> ConversationMessage {
    ConversationMessage::user_text(text, ts)
}

fn assistant_with_text(text: &str, ts: i64) -> ConversationMessage {
    ConversationMessage::assistant(vec![ContentBlock::Text { text: text.into() }], ts)
}

/// Building block for trim tests: 60 char text yields ~15 tokens
/// under cl100k. Used to construct sessions whose total token count
/// is predictable enough to compare against a budget.
const FILLER_60: &str = "0123456789012345678901234567890123456789012345678901234567";

#[test]
fn trim_is_noop_when_context_window_is_none() {
    let messages = vec![user_with_text("hi", 0), assistant_with_text("ok", 1)];
    let outcome = trim_to_budget(messages.clone(), None, 4096, "", ReasoningReplay::Text);
    assert_eq!(outcome.dropped, 0);
    assert_eq!(outcome.messages, messages);
}

#[test]
fn trim_is_noop_when_under_threshold() {
    // 200k window minus 4096 reserved → ~195k budget; threshold is
    // ~146k. Two short messages don't come close.
    let messages = vec![user_with_text("hi", 0), assistant_with_text("ok", 1)];
    let outcome = trim_to_budget(
        messages.clone(),
        Some(200_000),
        4096,
        "system",
        ReasoningReplay::Text,
    );
    assert_eq!(outcome.dropped, 0);
    assert_eq!(outcome.messages.len(), 2);
}

#[test]
fn trim_drops_oldest_user_turn_when_over_threshold() {
    // Tiny window (1000 tokens) with a 100-token reserve → budget
    // 890, threshold ~667. Each big_text is ~250 tokens; three
    // user-anchored turns will exceed the threshold.
    let big = FILLER_60.repeat(60); // ~900 chars → ~225 tokens cl100k
    let messages = vec![
        user_with_text(&big, 0), // turn 1
        assistant_with_text(&big, 1),
        user_with_text(&big, 2), // turn 2
        assistant_with_text(&big, 3),
        user_with_text("latest", 4), // turn 3 (latest)
        assistant_with_text("reply", 5),
    ];

    let outcome = trim_to_budget(messages, Some(1000), 100, "", ReasoningReplay::Text);

    // Should drop the first turn (user + assistant = 2 messages),
    // keep the last 2 user-anchored turns intact.
    assert_eq!(outcome.dropped, 2, "must drop the oldest turn");
    assert_eq!(outcome.messages.len(), 4);
    // First kept message must be a User (we cut at a user boundary).
    assert_eq!(outcome.messages[0].role, MessageRole::User);
    // The latest turn is intact.
    assert!(matches!(
        &outcome.messages[2].blocks[0],
        ContentBlock::Text { text } if text == "latest"
    ));
}

#[test]
fn trim_refuses_to_drop_below_preserve_floor() {
    // Only two user-rooted turns total; PRESERVE_LAST_USER_TURNS = 2,
    // so there's nothing safe to drop even if we're over budget.
    let big = FILLER_60.repeat(200); // ~750 tokens
    let messages = vec![
        user_with_text(&big, 0),
        assistant_with_text(&big, 1),
        user_with_text(&big, 2),
        assistant_with_text(&big, 3),
    ];

    let outcome = trim_to_budget(messages.clone(), Some(1000), 100, "", ReasoningReplay::Text);

    assert_eq!(outcome.dropped, 0, "no safe cut → no-op");
    assert_eq!(outcome.messages.len(), 4);
}

#[test]
fn trim_keeps_tool_use_and_tool_result_paired() {
    // Cut at a User boundary so a Tool message never lands at index
    // 0 of the kept slice (which would orphan its tool_use_id).
    let big = FILLER_60.repeat(60);
    let tool_use = ConversationMessage::assistant(
        vec![ContentBlock::ToolUse {
            id: "call-1".into(),
            name: "echo".into(),
            input: serde_json::json!({"x": 1}),
        }],
        10,
    );
    let tool_result = ConversationMessage {
        role: MessageRole::Tool,
        blocks: vec![ContentBlock::ToolResult {
            tool_use_id: "call-1".into(),
            content: big.clone(),
            is_error: None,
        }],
        usage: None,
        timestamp: 11,
        attached_selected_elements: None,
        attached_prompt_chips: None,
        model: None,
    };
    let messages = vec![
        user_with_text(&big, 0),
        tool_use,
        tool_result,
        user_with_text(&big, 12),
        assistant_with_text(&big, 13),
        user_with_text("now", 14),
        assistant_with_text("done", 15),
    ];

    let outcome = trim_to_budget(messages, Some(1000), 100, "", ReasoningReplay::Text);

    // Whatever gets dropped, the first kept message MUST be a User.
    assert!(outcome.dropped > 0, "expected at least one drop");
    assert_eq!(
        outcome.messages[0].role,
        MessageRole::User,
        "trim must cut on a user boundary so tool pairs stay intact"
    );
    // No orphaned Tool message at index 0.
    for msg in &outcome.messages {
        if msg.role == MessageRole::Tool {
            // Every Tool message must follow an Assistant in the kept
            // slice — find the preceding tool_use by id.
            let rid = match &msg.blocks[0] {
                ContentBlock::ToolResult { tool_use_id, .. } => tool_use_id.clone(),
                _ => panic!("tool message must carry a ToolResult block"),
            };
            let has_matching_use = outcome.messages.iter().any(|m| {
                m.blocks.iter().any(|b| {
                    matches!(b,
                        ContentBlock::ToolUse { id, .. } if id == &rid)
                })
            });
            assert!(
                has_matching_use,
                "tool_result {rid} must have its tool_use in the kept slice"
            );
        }
    }
}

#[test]
fn trim_handles_pathological_max_output_greater_than_window() {
    // Window 1000, max_output 5000 → reserve = 5500 > window.
    // budget saturates to 0; we should bail out without touching
    // the message list (let the provider surface the real error).
    let messages = vec![user_with_text("hi", 0), assistant_with_text("ok", 1)];
    let outcome = trim_to_budget(
        messages.clone(),
        Some(1000),
        5000,
        "",
        ReasoningReplay::Text,
    );
    assert_eq!(outcome.dropped, 0);
    assert_eq!(outcome.messages, messages);
}

#[test]
fn build_trim_notice_appends_to_existing_prompt() {
    let out = build_trim_notice("you are aurora", 7);
    assert!(out.starts_with("you are aurora"));
    assert!(out.contains("<context_trim_notice>"));
    assert!(out.contains("7 earlier message(s)"));
    assert!(out.ends_with("</context_trim_notice>"));
}

#[test]
fn build_trim_notice_handles_empty_base_prompt() {
    let out = build_trim_notice("", 3);
    assert!(out.starts_with("<context_trim_notice>"));
    assert!(out.contains("3 earlier message(s)"));
}

#[test]
fn estimate_message_tokens_includes_per_message_overhead() {
    let m = user_with_text("", 0);
    // Empty text + 4 per-message overhead.
    assert_eq!(estimate_message_tokens(&m, ReasoningReplay::Text), 4);
}

#[test]
fn estimate_message_tokens_accounts_for_tool_use_arguments() {
    let m = ConversationMessage::assistant(
        vec![ContentBlock::ToolUse {
            id: "x".into(),
            name: "shell".into(),
            input: serde_json::json!({"cmd": "ls -la /tmp"}),
        }],
        0,
    );
    // 4 (msg) + ≥1 (name) + ≥4 (json) + 3 (tool overhead)
    assert!(estimate_message_tokens(&m, ReasoningReplay::Text) >= 12);
}

/// One assistant message carrying a Responses-API reasoning item: a short
/// summary plus the fat encrypted blob Aurora stores in `signature`.
fn assistant_with_reasoning(text: &str, signature: &str) -> ConversationMessage {
    ConversationMessage::assistant(
        vec![ContentBlock::Thinking {
            text: text.into(),
            signature: Some(signature.into()),
            duration_ms: None,
        }],
        0,
    )
}

/// The bug this whole policy exists for.
///
/// A chat that ran a Responses-API model banks megabytes of encrypted
/// reasoning in its transcript. Switch to a provider that strips reasoning
/// and NONE of it is ever sent again — but the estimator used to run
/// tiktoken over the base64 anyway. On a real 180k-token session that
/// invented ~92k tokens of context, so `/compact` reported a "before" of
/// 431k and an "after" of 272k for a request the provider measured at 180k.
#[test]
fn dropped_reasoning_costs_nothing() {
    let blob = "gAAAAABqdpHR1SNl885r9cogd1rJiInPBBO4WmifWtviQ2nLyXqJ".repeat(40);
    let m = assistant_with_reasoning("brief summary", &blob);

    // Per-message overhead only: neither the summary nor the blob is sent.
    assert_eq!(estimate_message_tokens(&m, ReasoningReplay::Dropped), 4);
}

#[test]
fn text_replay_counts_the_summary_but_never_the_signature() {
    let blob = "gAAAAABqdpHR1SNl885r9cogd1rJiInPBBO4WmifWtviQ2nLyXqJ".repeat(40);
    let with_blob = assistant_with_reasoning("brief summary", &blob);
    let without_blob = assistant_with_reasoning("brief summary", "");

    // The signature is transport metadata — an id or an HMAC the provider
    // verifies. It is never prompt text, so it must not move the number.
    assert_eq!(
        estimate_message_tokens(&with_blob, ReasoningReplay::Text),
        estimate_message_tokens(&without_blob, ReasoningReplay::Text),
    );
    assert!(estimate_message_tokens(&with_blob, ReasoningReplay::Text) > 4);
}

#[test]
fn opaque_replay_prices_the_plaintext_not_the_ciphertext() {
    let blob = "gAAAAABqdpHR1SNl885r9cogd1rJiInPBBO4WmifWtviQ2nLyXqJ".repeat(40);
    let m = assistant_with_reasoning("brief summary", &blob);

    let opaque = estimate_message_tokens(&m, ReasoningReplay::Opaque);
    // It DOES cost something — the item is genuinely replayed.
    assert!(opaque > 4);
    // …but far less than tokenizing the base64, which is what made the
    // old estimate ~2.6x high even on the provider that replays it.
    let as_raw_text = estimate_text_tokens(&blob);
    assert!(
        opaque < as_raw_text / 2,
        "opaque={opaque} should be well under raw-text {as_raw_text}",
    );
}

#[test]
fn opaque_replay_of_a_missing_signature_costs_nothing() {
    let m = ConversationMessage::assistant(
        vec![ContentBlock::Thinking {
            text: "summary".into(),
            signature: None,
            duration_ms: None,
        }],
        0,
    );
    // No item to replay → nothing on the wire.
    assert_eq!(estimate_message_tokens(&m, ReasoningReplay::Opaque), 4);
}

/// Records the full request shape, so a test can assert on the things the
/// provider's cache key is actually made of.
#[derive(Default)]
struct CacheKeyRecordingApi {
    reply: String,
    seen: Mutex<Vec<(Option<String>, usize, bool, usize)>>,
}

#[async_trait]
impl StreamingApiClient for CacheKeyRecordingApi {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        _event_sink: mpsc::Sender<AssistantEvent>,
        _cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        self.seen.lock().expect("seen").push((
            request.system_prompt.map(str::to_string),
            request.tools.len(),
            request.reasoning.enabled,
            request.messages.len(),
        ));
        Ok(turn_usage(assistant_text(&self.reply), "end_turn"))
    }
}

fn cache_key_api(reply: &str) -> Arc<CacheKeyRecordingApi> {
    Arc::new(CacheKeyRecordingApi {
        reply: reply.to_string(),
        seen: Mutex::new(Vec::new()),
    })
}

fn one_tool_registry() -> Arc<ToolRegistry> {
    let registry = ToolRegistry::new();
    registry.register(Arc::new(RecordingTool {
        name: "file_read",
        seen: Arc::new(Mutex::new(Vec::new())),
        response: "ok".into(),
    }));
    Arc::new(registry)
}

#[tokio::test]
async fn summarizing_on_the_chat_model_reuses_its_prompt_prefix() {
    // The head is ALREADY in the provider's cache from the turns that
    // built it — but only if this request keeps the same prefix. System
    // prompt, tools and thinking config are all part of the cache key;
    // changing any of them re-bills the entire history at fresh rates.
    let chat = cache_key_api("<summary>note</summary>");
    let runtime = ConversationRuntime::new(
        chat.clone(),
        one_tool_registry(),
        RuntimeConfig {
            system_prompt: Some("you are aurora".into()),
            context_window: Some(4000),
            reasoning: crate::agent_runtime::api_client::ReasoningConfig::legacy(true, None),
            ..RuntimeConfig::default()
        },
    );

    let mut session = compactable_session();
    let (tx, _rx) = mpsc::channel(64);
    let mut seq = 0;
    assert!(runtime
        .compact_now(
            &mut session,
            "turn",
            &mut seq,
            &tx,
            &CancellationToken::new()
        )
        .await
        .is_some());

    let seen = chat.seen.lock().expect("seen");
    let (system, tools, thinking, _) = seen.first().expect("summarizer ran");
    assert_eq!(
        system.as_deref(),
        Some("you are aurora"),
        "a different system prompt diverges the prefix at token zero",
    );
    assert_eq!(*tools, 1, "dropping the tools invalidates the cache key");
    assert!(*thinking, "thinking config is part of the cache key");
}

#[tokio::test]
async fn a_pinned_model_sends_the_lean_request_instead() {
    // A pinned model has no cache to share, so there is nothing to protect
    // and every token saved is real: dedicated prompt, no tools, no
    // reasoning, thinking off.
    let summarizer = cache_key_api("<summary>note</summary>");
    let runtime = ConversationRuntime::new(
        recording_api("chat"),
        one_tool_registry(),
        RuntimeConfig {
            system_prompt: Some("you are aurora".into()),
            context_window: Some(4000),
            reasoning: crate::agent_runtime::api_client::ReasoningConfig::legacy(true, None),
            ..RuntimeConfig::default()
        },
    )
    .with_compaction_client(summarizer.clone(), "cheap:model");

    let mut session = compactable_session();
    let (tx, _rx) = mpsc::channel(64);
    let mut seq = 0;
    assert!(runtime
        .compact_now(
            &mut session,
            "turn",
            &mut seq,
            &tx,
            &CancellationToken::new()
        )
        .await
        .is_some());

    let seen = summarizer.seen.lock().expect("seen");
    let (system, tools, thinking, _) = seen.first().expect("summarizer ran");
    assert_ne!(system.as_deref(), Some("you are aurora"));
    assert_eq!(*tools, 0);
    assert!(!*thinking);
}

#[tokio::test]
async fn a_tool_call_instead_of_a_note_falls_back_rather_than_failing() {
    // Advertising tools is the price of the cache, and the model will
    // occasionally reach for one instead of answering. That must not burn
    // a compaction attempt — it re-bills, it does not fail.
    let chat = cache_key_api(""); // empty text, as a tool call would leave
    let runtime = ConversationRuntime::new(
        chat.clone(),
        one_tool_registry(),
        RuntimeConfig {
            system_prompt: Some("you are aurora".into()),
            context_window: Some(4000),
            ..RuntimeConfig::default()
        },
    );

    let mut session = compactable_session();
    let (tx, _rx) = mpsc::channel(64);
    let mut seq = 0;
    let _ = runtime
        .compact_now(
            &mut session,
            "turn",
            &mut seq,
            &tx,
            &CancellationToken::new(),
        )
        .await;

    let seen = chat.seen.lock().expect("seen");
    assert_eq!(seen.len(), 2, "should retry once in the standalone shape");
    assert_eq!(
        seen[0].1, 1,
        "first attempt keeps the tools (for the cache)"
    );
    assert_eq!(
        seen[1].1, 0,
        "retry drops them so the note cannot be misread"
    );
}

#[tokio::test]
async fn the_summarizer_never_sees_the_chat_model_s_reasoning() {
    // A signature is issued by one provider and meaningless to another,
    // and this request runs with thinking OFF — yet the Anthropic
    // converter emits `thinking` blocks regardless. Left in, summarizing
    // on a different provider fails on every attempt.
    let summarizer = recording_api("a summary");
    let runtime = ConversationRuntime::new(
        recording_api("chat"),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            context_window: Some(4000),
            ..RuntimeConfig::default()
        },
    )
    .with_compaction_client(summarizer.clone(), "other-provider:other-model");

    let mut session = compactable_session();
    // Reasoning carried over from the chat model, signature and all.
    session.append_message(assistant_with_reasoning(
        "mulling it over",
        "sig-from-openai",
    ));
    session.append_message(user_with_text("carry on", 99));

    let head = strip_reasoning(session.messages().to_vec());
    assert!(
        !head
            .iter()
            .flat_map(|m| &m.blocks)
            .any(|b| matches!(b, ContentBlock::Thinking { .. })),
        "no reasoning block may reach the summarizer",
    );
    // The reasoning-only message is gone entirely — an empty content array
    // is rejected by providers.
    assert!(head.len() < session.messages().len());

    let (tx, _rx) = mpsc::channel(64);
    let mut seq = 0;
    let result = runtime
        .compact_now(
            &mut session,
            "turn",
            &mut seq,
            &tx,
            &CancellationToken::new(),
        )
        .await;
    assert!(
        result.is_some(),
        "cross-provider compaction must still succeed"
    );
}

#[test]
fn stripping_reasoning_leaves_tool_pairing_intact() {
    // Nothing carrying a tool call can be emptied by the strip, so the
    // call/result pairing the provider validates is untouched.
    let messages = vec![
        ConversationMessage::assistant(
            vec![
                ContentBlock::Thinking {
                    text: "hmm".into(),
                    signature: Some("sig".into()),
                    duration_ms: None,
                },
                ContentBlock::ToolUse {
                    id: "call-1".into(),
                    name: "file_read".into(),
                    input: serde_json::json!({"path": "a.rs"}),
                },
            ],
            0,
        ),
        ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![ContentBlock::ToolResult {
                tool_use_id: "call-1".into(),
                content: "fn main() {}".into(),
                is_error: Some(false),
            }],
            usage: None,
            timestamp: 1,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            model: None,
        },
    ];

    let stripped = strip_reasoning(messages);
    assert_eq!(stripped.len(), 2, "neither message may be dropped");
    assert!(matches!(
        stripped[0].blocks.as_slice(),
        [ContentBlock::ToolUse { .. }]
    ));
}

#[test]
fn the_drafting_scratchpad_never_reaches_context() {
    let raw = "<analysis>\nChronological pass, 4000 tokens of it.\n</analysis>\n\n\
                   <summary>\n1. Primary request: ship the parser.\n</summary>";
    let out = format_compact_summary(raw);
    assert_eq!(out, "1. Primary request: ship the parser.");
    assert!(!out.contains("Chronological"), "analysis must be dropped");
}

#[test]
fn a_summary_cut_off_mid_note_keeps_what_was_written() {
    // The output budget ran out. The early sections are the valuable ones
    // — discarding them would fail the compaction over a missing tag.
    let raw = "<analysis>draft</analysis>\n<summary>\n1. Primary request: ship it.\n2. Files";
    let out = format_compact_summary(raw);
    assert!(out.starts_with("1. Primary request: ship it."));
    assert!(!out.contains("draft"));
}

#[test]
fn an_unclosed_analysis_block_does_not_swallow_the_note() {
    // The model wrote the whole note but forgot `</analysis>`. Cutting at
    // the missing tag would discard a perfectly good summary and fail the
    // compaction over punctuation.
    let raw = "<analysis>\nthinking out loud\n<summary>\n1. Ship the parser.\n</summary>";
    let out = format_compact_summary(raw);
    assert_eq!(out, "1. Ship the parser.");
    assert!(!out.contains("thinking out loud"));
}

#[test]
fn a_summary_that_ignored_the_tags_is_still_used() {
    // Tags are a request, not a guarantee. A plain-prose summary is worth
    // far more than treating the compaction as failed.
    let out = format_compact_summary("  We were refactoring the parser.  ");
    assert_eq!(out, "We were refactoring the parser.");
}

#[test]
fn the_resume_note_tells_the_model_to_continue_seamlessly() {
    let view = compaction_preamble("1. Primary request: ship it.", None);
    assert!(view.contains("1. Primary request: ship it."));
    // The whole point of the user-facing behaviour: no seam.
    assert!(view.contains("do not mention the summary"));
    assert!(view.contains("preserved word for word"));
    // No path was offered, so none must be promised.
    assert!(!view.contains("file_read"));
}

#[test]
fn the_resume_note_offers_the_transcript_when_it_is_readable() {
    let view = compaction_preamble("note", Some("C:/sessions/t-1.jsonl"));
    assert!(view.contains("C:/sessions/t-1.jsonl"));
    assert!(view.contains("file_read"));
}

#[tokio::test]
async fn the_transcript_is_only_offered_when_the_model_could_open_it() {
    let session = Session::new("t-hint");
    let with_tools = |access: crate::agent_runtime::tool_executor::WorkspaceAccess| {
        ConversationRuntime::new(
            recording_api("ok"),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                workspace_access: access,
                ..RuntimeConfig::default()
            },
        )
        .with_store_dir("C:/sessions")
    };
    // The session store is outside the workspace: without the opt-in the
    // read is refused, and naming a path the model cannot open is worse
    // than saying nothing.
    use crate::agent_runtime::tool_executor::WorkspaceAccess;
    assert!(with_tools(WorkspaceAccess::Workspace)
        .transcript_hint(&session)
        .is_none());
    assert!(with_tools(WorkspaceAccess::Read)
        .transcript_hint(&session)
        .is_some());
    // Full reads outside too, so it must offer the transcript as well —
    // the hint follows the capability, not one named mode.
    assert!(with_tools(WorkspaceAccess::Full)
        .transcript_hint(&session)
        .is_some());
}

fn measured(input: u32, cache_write: u32, cache_read: u32, output: u32) -> TokenUsage {
    TokenUsage {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: Some(cache_write),
        cache_read_input_tokens: Some(cache_read),
        estimated: None,
        cost_usd: None,
    }
}

/// Returns a blockless assistant message on the first call and a normal
/// one afterwards — the shape a dropped `redacted_thinking` block left
/// behind, reproduced from two real sessions where the provider billed
/// output tokens and Aurora persisted nothing.
#[derive(Default)]
struct EmptyThenAnswerApi {
    calls: Mutex<u32>,
}

#[async_trait]
impl StreamingApiClient for EmptyThenAnswerApi {
    async fn stream(
        &self,
        _request: ApiRequest<'_>,
        _event_sink: mpsc::Sender<AssistantEvent>,
        _cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        let mut calls = self.calls.lock().expect("calls");
        *calls += 1;
        if *calls == 1 {
            return Ok(turn_usage(
                ConversationMessage::assistant(Vec::new(), 0),
                "end_turn",
            ));
        }
        Ok(turn_usage(assistant_text("here is the answer"), "end_turn"))
    }
}

#[tokio::test]
async fn a_response_with_no_blocks_is_retried_once_instead_of_surfacing() {
    let api = Arc::new(EmptyThenAnswerApi::default());
    let runtime = ConversationRuntime::new(
        api.clone(),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig::default(),
    );

    let mut session = Session::new("t-empty");
    let (tx, _rx) = mpsc::channel(64);
    runtime
        .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
        .await
        .expect("turn should succeed on the retry");

    assert_eq!(*api.calls.lock().expect("calls"), 2, "should re-issue once");

    // The blockless response must leave NO trace in history. Serialized to
    // Anthropic it becomes an assistant turn with empty content, which the
    // API rejects — one dropped response would break every later turn.
    assert!(
        session.messages().iter().all(|m| !m.blocks.is_empty()),
        "an empty assistant message must never enter history",
    );
    assert!(
        session.messages().iter().any(|m| matches!(
            m.blocks.first(),
            Some(ContentBlock::Text { text }) if text == "here is the answer"
        )),
        "the retry's answer must be kept",
    );
}

// ── Dropped-stream retry ────────────────────────────────────────

/// Streams a little text, then dies the way a real dropped connection
/// does, for the first `fail_times` calls. Mirrors the failure that
/// dominated `aurora.log`: partial output already on screen when the
/// socket goes away.
struct DropsThenAnswersApi {
    calls: Mutex<u32>,
    fail_times: u32,
    error: ApiError,
}

impl DropsThenAnswersApi {
    fn new(fail_times: u32, error: ApiError) -> Self {
        Self {
            calls: Mutex::new(0),
            fail_times,
            error,
        }
    }

    fn call_count(&self) -> u32 {
        *self.calls.lock().expect("calls")
    }
}

#[async_trait]
impl StreamingApiClient for DropsThenAnswersApi {
    async fn stream(
        &self,
        _request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        _cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        let call = {
            let mut calls = self.calls.lock().expect("calls");
            *calls += 1;
            *calls
        };
        if call <= self.fail_times {
            // Some of the reply reached the screen before the drop.
            let _ = event_sink
                .send(AssistantEvent::TextDelta {
                    delta: "The project is ".into(),
                })
                .await;
            return Err(self.error.clone());
        }
        Ok(turn_usage(assistant_text("here is the answer"), "end_turn"))
    }
}

#[tokio::test(start_paused = true)]
async fn a_dropped_stream_is_retried_without_the_user_asking() {
    let api = Arc::new(DropsThenAnswersApi::new(
        1,
        ApiError::Network("stream error: error decoding response body".into()),
    ));
    let runtime = ConversationRuntime::new(
        api.clone(),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig::default(),
    );

    let mut session = Session::new("t-drop");
    let (tx, _rx) = mpsc::channel(64);
    runtime
        .run_turn(
            &mut session,
            user_msg("check project"),
            tx,
            CancellationToken::new(),
        )
        .await
        .expect("a dropped stream must not end the turn");

    assert_eq!(api.call_count(), 2, "should re-issue exactly once");
    assert!(
        session.messages().iter().any(|m| matches!(
            m.blocks.first(),
            Some(ContentBlock::Text { text }) if text == "here is the answer"
        )),
        "the retry's answer must be kept",
    );
    // The half-sentence from the failed attempt was never committed —
    // the runtime appends only after a clean stream, and the retry must
    // not have introduced a second copy of the reply.
    let replies = session
        .messages()
        .iter()
        .filter(|m| m.role == MessageRole::Assistant)
        .count();
    assert_eq!(replies, 1, "the discarded fragment must not enter history");
}

#[tokio::test(start_paused = true)]
async fn the_frontend_is_told_to_drop_the_partial_reply_before_a_retry() {
    let api = Arc::new(DropsThenAnswersApi::new(
        1,
        ApiError::Network("connection reset".into()),
    ));
    let runtime =
        ConversationRuntime::new(api, Arc::new(ToolRegistry::new()), RuntimeConfig::default());

    let mut session = Session::new("t-discard");
    let (tx, mut rx) = mpsc::channel(64);
    runtime
        .run_turn(
            &mut session,
            user_msg("check project"),
            tx,
            CancellationToken::new(),
        )
        .await
        .expect("turn should recover");

    let mut discards = Vec::new();
    let mut deltas_before_discard = 0_u32;
    while let Ok(Some(envelope)) =
        tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await
    {
        match envelope.event {
            AssistantEvent::TextDelta { .. } if discards.is_empty() => {
                deltas_before_discard += 1;
            }
            AssistantEvent::PartialReplyDiscarded {
                attempt,
                max_attempts,
                ref reason,
            } => discards.push((attempt, max_attempts, reason.clone())),
            _ => {}
        }
    }

    assert_eq!(
        deltas_before_discard, 1,
        "the failed attempt's text really did reach the frontend",
    );
    assert_eq!(discards.len(), 1, "exactly one discard, for the one retry");
    let (attempt, max_attempts, reason) = discards.remove(0);
    assert_eq!(attempt, 1, "the attempt that failed, 1-based");
    assert_eq!(max_attempts, MAX_STREAM_ATTEMPTS);
    assert!(
        reason.contains("connection reset"),
        "the discard must carry why, got {reason}",
    );
}

#[tokio::test(start_paused = true)]
async fn retrying_stops_at_the_attempt_ceiling() {
    let api = Arc::new(DropsThenAnswersApi::new(
        u32::MAX,
        ApiError::Network("connection reset".into()),
    ));
    let runtime = ConversationRuntime::new(
        api.clone(),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig::default(),
    );

    let mut session = Session::new("t-ceiling");
    let (tx, _rx) = mpsc::channel(64);
    let result = runtime
        .run_turn(
            &mut session,
            user_msg("check project"),
            tx,
            CancellationToken::new(),
        )
        .await;

    assert!(result.is_err(), "a failure that never clears must surface");
    assert_eq!(
        api.call_count(),
        MAX_STREAM_ATTEMPTS,
        "the ceiling is a ceiling — no spinning",
    );
}

#[tokio::test(start_paused = true)]
async fn a_request_the_provider_rejects_is_not_retried() {
    // The 404 from `aurora.log`: a model routed to a backend that will
    // not take tools. Identical on every attempt, so retrying it only
    // spends the user's time.
    let api = Arc::new(DropsThenAnswersApi::new(
        u32::MAX,
        ApiError::InvalidRequest("HTTP 404: capability not supported".into()),
    ));
    let runtime = ConversationRuntime::new(
        api.clone(),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig::default(),
    );

    let mut session = Session::new("t-invalid");
    let (tx, _rx) = mpsc::channel(64);
    let result = runtime
        .run_turn(
            &mut session,
            user_msg("check project"),
            tx,
            CancellationToken::new(),
        )
        .await;

    assert!(result.is_err());
    assert_eq!(api.call_count(), 1, "a rejected request shape fails once");
}

#[tokio::test(start_paused = true)]
async fn stop_during_the_backoff_ends_the_turn_immediately() {
    // Cancelling mid-wait must not make the user sit out the rest of it,
    // and must report as a cancellation rather than the network error
    // that started the backoff.
    let api = Arc::new(DropsThenAnswersApi::new(
        u32::MAX,
        ApiError::Network("connection reset".into()),
    ));
    let runtime = ConversationRuntime::new(
        api.clone(),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig::default(),
    );

    let cancel = CancellationToken::new();
    let cancel_for_task = cancel.clone();
    tokio::spawn(async move {
        // Long enough that the first attempt has failed and the runtime
        // is inside the backoff; shorter than the 1s wait itself.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        cancel_for_task.cancel();
    });

    let mut session = Session::new("t-stop");
    let (tx, _rx) = mpsc::channel(64);
    let result = runtime
        .run_turn(&mut session, user_msg("check project"), tx, cancel)
        .await;

    // Same shape a Stop *during* the stream produces — `is_cancellation`
    // is what the callers check, and both routes must satisfy it.
    match result {
        Err(ref e) if e.is_cancellation() => {}
        other => panic!("expected a cancellation, got {other:?}"),
    }
    assert_eq!(api.call_count(), 1, "the retry must never have been issued");
}

/// Always blockless — the condition really is persistent.
#[derive(Default)]
struct AlwaysEmptyApi {
    calls: Mutex<u32>,
}

#[async_trait]
impl StreamingApiClient for AlwaysEmptyApi {
    async fn stream(
        &self,
        _request: ApiRequest<'_>,
        _event_sink: mpsc::Sender<AssistantEvent>,
        _cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        *self.calls.lock().expect("calls") += 1;
        Ok(turn_usage(
            ConversationMessage::assistant(Vec::new(), 0),
            "end_turn",
        ))
    }
}

#[tokio::test]
async fn a_persistently_empty_provider_is_reported_not_looped_on() {
    let api = Arc::new(AlwaysEmptyApi::default());
    let runtime = ConversationRuntime::new(
        api.clone(),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig::default(),
    );

    let mut session = Session::new("t-empty-always");
    let (tx, _rx) = mpsc::channel(64);
    runtime
        .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
        .await
        .expect("turn ends cleanly");

    assert_eq!(
        *api.calls.lock().expect("calls"),
        2,
        "exactly one retry — a second empty reply is a condition, not a loop",
    );
    assert!(
        session
            .messages()
            .iter()
            .any(|m| matches!(m.blocks.first(), Some(ContentBlock::Notice { .. }))),
        "the user must be told once the retry has also failed",
    );
}

#[test]
fn a_measured_request_counts_cache_writes_and_output() {
    // Every slice of the prompt, plus the completion that becomes input on
    // the next request. Dropping cache-write here understated a
    // cache-writing turn by most of its prompt.
    assert_eq!(
        measured_context_tokens(&measured(10_000, 40_000, 5_000, 700)),
        55_700
    );
}

/// A runtime with no tools and no system prompt, so the from-scratch
/// fallback is purely the message estimate and the two paths are easy to
/// tell apart in an assertion.
fn bare_runtime() -> ConversationRuntime {
    ConversationRuntime::new(
        recording_api("ok"),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            context_window: Some(500_000),
            ..RuntimeConfig::default()
        },
    )
}

#[tokio::test]
async fn context_size_anchors_on_the_last_measured_request() {
    let runtime = bare_runtime();
    let mut session = Session::new("t-anchor");
    // A long history whose from-scratch estimate is nowhere near the
    // measured number — this is the situation that produced the 431k
    // report for a 180k context.
    let big = FILLER_60.repeat(50);
    session.append_message(user_with_text(&big, 0));
    let mut answered = assistant_with_text("done", 1);
    answered.usage = Some(measured(120_000, 0, 30_000, 500));
    session.append_message(answered);

    // Nothing added since the measurement → the anchor IS the answer.
    assert_eq!(runtime.projected_request_tokens(&session), 150_500);

    // One new message → anchor plus exactly that message's estimate.
    let follow_up = user_with_text("what about the other file?", 2);
    let delta = estimate_message_tokens(&follow_up, ReasoningReplay::Dropped);
    session.append_message(follow_up);
    assert_eq!(runtime.projected_request_tokens(&session), 150_500 + delta);
}

/// A provider that counts the same conversation two different ways.
///
/// Gateways that fan a model out across several upstream accounts return
/// different token counts for a byte-identical request depending on which
/// backend served it — measured on one live endpoint as a clean two-band
/// split, 12,802 vs 14,161 for the same bytes. Within a compaction epoch the
/// request only ever grows, so a reading that comes back SMALLER than the one
/// before it is measurement noise, not the context shrinking. Anchoring on
/// whichever arrived last made the reported size jump between the bands every
/// few requests and, on the low band, under-report how full the window is.
#[tokio::test]
async fn a_smaller_later_measurement_does_not_shrink_the_reported_context() {
    let runtime = bare_runtime();
    let mut session = Session::new("t-anchor-bands");
    session.append_message(user_with_text("start", 0));

    let mut high = assistant_with_text("served by the counting backend", 1);
    high.usage = Some(measured(120_000, 0, 30_000, 500));
    session.append_message(high);

    let between = user_with_text("carry on", 2);
    let delta = estimate_message_tokens(&between, ReasoningReplay::Dropped);
    session.append_message(between);

    // The next request is necessarily LARGER — it carries everything the
    // previous one did plus `between` — yet this backend reports 20k fewer.
    let mut low = assistant_with_text("served by the other backend", 3);
    low.usage = Some(measured(100_000, 0, 30_000, 500));
    let low_delta = estimate_message_tokens(&low, ReasoningReplay::Dropped);
    session.append_message(low);

    // The high reading, carried forward across everything appended since, is
    // the honest floor. The low reading is discarded, not averaged.
    assert_eq!(
        runtime.projected_request_tokens(&session),
        150_500 + delta + low_delta
    );
}

/// The measurement a compaction invalidates.
///
/// `apply_compaction` keeps the verbatim TAIL, and those tail messages
/// carry the usage of the requests that measured them — taken while the
/// whole dropped head was still on the wire. Anchoring on one reports the
/// size of the conversation compaction just removed, so the number barely
/// moves after a shrink and the trigger keeps firing on a context that is
/// already small.
#[tokio::test]
async fn a_measurement_taken_before_a_compaction_is_not_an_anchor() {
    let runtime = bare_runtime();
    let mut session = Session::new("t-anchor-stale");

    session.append_message(user_with_text(&FILLER_60.repeat(50), 0));
    let mut answered = assistant_with_text("done", 1);
    // 300k: what the request cost while the head was still being sent.
    answered.usage = Some(measured(300_000, 0, 0, 500));
    session.append_message(answered);
    assert_eq!(
        runtime.projected_request_tokens(&session),
        300_500,
        "before compacting, that measurement is exactly right"
    );

    // Compact at the head boundary: the marker lands ahead of the tail, so
    // the 300k measurement is still IN the view afterwards.
    session.messages.insert(
        1,
        ConversationMessage {
            role: MessageRole::System,
            blocks: vec![ContentBlock::Compaction {
                summary: "the earlier work, summarized".into(),
                before_tokens: 300_500,
                after_tokens: 900,
                created_at: 10,
            }],
            usage: None,
            timestamp: 10,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            model: None,
        },
    );

    let after = runtime.projected_request_tokens(&session);
    assert!(
        after < 300_500,
        "a shrink must lower the reported size, got {after}"
    );
    // Falls through to the from-scratch reading of the compacted view,
    // which is the only honest answer until the next real reply measures
    // the new shape.
    assert_eq!(
        after,
        runtime.estimate_view_tokens(&runtime.compacted_view(&session)),
    );
}

/// A measurement taken AFTER the marker describes the compacted shape and
/// must still anchor — otherwise every turn following a compaction would
/// fall back to guessing forever.
#[tokio::test]
async fn a_measurement_taken_after_a_compaction_still_anchors() {
    let runtime = bare_runtime();
    let mut session = Session::new("t-anchor-fresh");
    session.append_message(ConversationMessage {
        role: MessageRole::System,
        blocks: vec![ContentBlock::Compaction {
            summary: "earlier work".into(),
            before_tokens: 300_000,
            after_tokens: 900,
            created_at: 10,
        }],
        usage: None,
        timestamp: 10,
        attached_selected_elements: None,
        attached_prompt_chips: None,
        model: None,
    });
    session.append_message(user_with_text("carry on", 11));
    let mut answered = assistant_with_text("done", 12);
    answered.usage = Some(measured(18_000, 0, 0, 400));
    session.append_message(answered);

    assert_eq!(runtime.projected_request_tokens(&session), 18_400);
}

#[tokio::test]
async fn our_own_estimate_is_never_used_as_an_anchor() {
    let runtime = bare_runtime();
    let mut session = Session::new("t-anchor-est");
    session.append_message(user_with_text("hello", 0));
    let mut guessed = assistant_with_text("hi", 1);
    // A no-usage provider's synthetic figure. Anchoring on it would
    // launder a guess into "measured" and freeze it as ground truth.
    guessed.usage = Some(TokenUsage {
        input_tokens: 999_999,
        output_tokens: 0,
        cache_creation_input_tokens: None,
        cache_read_input_tokens: None,
        estimated: Some(true),
        cost_usd: None,
    });
    session.append_message(guessed);

    let projected = runtime.projected_request_tokens(&session);
    assert!(
        projected < 1_000,
        "should fall back to estimating the transcript, got {projected}",
    );
}

#[tokio::test]
async fn context_size_falls_back_to_estimation_with_no_measurement() {
    let runtime = bare_runtime();
    let mut session = Session::new("t-anchor-none");
    session.append_message(user_with_text("hello", 0));
    session.append_message(assistant_with_text("hi", 1));

    let expected: u32 = session
        .messages()
        .iter()
        .map(|m| estimate_message_tokens(m, ReasoningReplay::Dropped))
        .fold(0, u32::saturating_add);
    assert_eq!(runtime.projected_request_tokens(&session), expected);
}

/// Summarizer that always comes back empty — the "compaction can never
/// succeed for this conversation" case.
#[derive(Default)]
struct FailingSummarizer {
    calls: Mutex<u32>,
}

#[async_trait]
impl StreamingApiClient for FailingSummarizer {
    async fn stream(
        &self,
        _request: ApiRequest<'_>,
        _event_sink: mpsc::Sender<AssistantEvent>,
        _cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        *self.calls.lock().expect("calls") += 1;
        Ok(turn_usage(assistant_text(""), "end_turn"))
    }
}

#[tokio::test]
async fn auto_compaction_stops_retrying_a_failure_that_never_clears() {
    let summarizer = Arc::new(FailingSummarizer::default());
    let runtime = ConversationRuntime::new(
        recording_api("chat"),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            // A window small enough that the seeded transcript is always
            // over the threshold, so every attempt re-qualifies.
            context_window: Some(1_000),
            compaction_threshold: Some(0.5),
            ..RuntimeConfig::default()
        },
    )
    .with_compaction_client(summarizer.clone(), "summarizer:model");

    let mut session = compactable_session();
    let (tx, _rx) = mpsc::channel(64);
    let mut seq = 0;

    // Ten turns' worth of attempts. Each failed compaction re-sends the
    // whole head, so an unbounded loop bills full price every turn.
    for _ in 0..10 {
        runtime
            .maybe_compact(
                &mut session,
                "turn",
                &mut seq,
                &tx,
                &CancellationToken::new(),
            )
            .await;
    }

    let calls = *summarizer.calls.lock().expect("calls");
    assert_eq!(
        calls, MAX_CONSECUTIVE_COMPACTION_FAILURES,
        "breaker must stop after {MAX_CONSECUTIVE_COMPACTION_FAILURES} failures, made {calls}",
    );
    assert!(
        session.compaction_retry_after.is_some(),
        "cooldown must be armed"
    );
}

#[tokio::test]
async fn a_manual_compact_is_not_blocked_by_the_breaker() {
    let summarizer = Arc::new(FailingSummarizer::default());
    let runtime = ConversationRuntime::new(
        recording_api("chat"),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            context_window: Some(1_000),
            compaction_threshold: Some(0.5),
            ..RuntimeConfig::default()
        },
    )
    .with_compaction_client(summarizer.clone(), "summarizer:model");

    let mut session = compactable_session();
    // Already tripped and cooling down.
    session.compaction_failures = MAX_CONSECUTIVE_COMPACTION_FAILURES;
    session.compaction_retry_after = Some(Utc::now().timestamp_millis() + 60_000);

    let (tx, _rx) = mpsc::channel(64);
    let mut seq = 0;
    let _ = runtime
        .compact_now(
            &mut session,
            "turn",
            &mut seq,
            &tx,
            &CancellationToken::new(),
        )
        .await;

    // The user asked for this one and is watching it — it must run.
    assert_eq!(*summarizer.calls.lock().expect("calls"), 1);
}

/// API mock that answers with a fixed body and records the model it was
/// asked for. Two of these let a test tell the chat provider apart from
/// the summarizer.
#[derive(Default)]
struct ModelRecordingApi {
    reply: String,
    models: Mutex<Vec<String>>,
}

#[async_trait]
impl StreamingApiClient for ModelRecordingApi {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        _event_sink: mpsc::Sender<AssistantEvent>,
        _cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        self.models
            .lock()
            .expect("models")
            .push(request.model.to_string());
        Ok(turn_usage(assistant_text(&self.reply), "end_turn"))
    }
}

fn recording_api(reply: &str) -> Arc<ModelRecordingApi> {
    Arc::new(ModelRecordingApi {
        reply: reply.to_string(),
        models: Mutex::new(Vec::new()),
    })
}

/// A tool result answering `id`, successful unless `is_error` says otherwise.
fn tool_result_for(id: &str, is_error: Option<bool>) -> ConversationMessage {
    ConversationMessage {
        role: MessageRole::Tool,
        blocks: vec![ContentBlock::ToolResult {
            tool_use_id: id.into(),
            content: "ok".into(),
            is_error,
        }],
        usage: None,
        timestamp: 1_700_000_000_000,
        attached_selected_elements: None,
        attached_prompt_chips: None,
        model: None,
    }
}

/// A summary describes the WORK; nothing in it records how the tools were being
/// called. Measured across every compaction on this machine — 17 of them — the
/// word `file_read` appears in none, while the replaced head held up to 258 tool
/// calls. Thread `9db4f0f0` compacted at line 131 after 130 well-formed calls
/// and produced its first malformed `file_read` at line 135.
///
/// The recap carries the model's OWN last working call of each tool across the
/// cut, so the evidence it was already copying survives the summary.
mod tool_usage_recap_tests {
    use super::*;

    #[test]
    fn keeps_the_most_recent_working_call_of_each_tool() {
        let messages = vec![
            assistant_tool_use("a1", "file_read", serde_json::json!({ "path": "old.rs" })),
            tool_result_for("a1", None),
            assistant_tool_use(
                "a2",
                "file_read",
                serde_json::json!({ "path": ["new.rs", "other.rs"], "start_line": 1 }),
            ),
            tool_result_for("a2", None),
            assistant_tool_use("a3", "grep", serde_json::json!({ "pattern": "todo" })),
            tool_result_for("a3", None),
        ];

        let recap = tool_usage_recap(&messages).expect("three successful calls");

        assert!(recap.contains("new.rs"), "keeps the LATEST shape: {recap}");
        assert!(
            !recap.contains("old.rs"),
            "one line per tool, not a history: {recap}"
        );
        assert!(recap.contains("grep("), "covers every tool used: {recap}");
        assert!(
            recap.contains("<tool_usage_recap>"),
            "wrapped for the model: {recap}"
        );
    }

    #[test]
    fn a_call_that_failed_is_never_replayed() {
        // Replaying a rejected call teaches exactly the shape that did not work
        // — which is the failure this whole mechanism exists to prevent.
        let messages = vec![
            assistant_tool_use(
                "b1",
                "file_read",
                serde_json::json!({ "path": "a.rs", "paths": ["a.rs"] }),
            ),
            tool_result_for("b1", Some(true)),
        ];
        assert!(
            tool_usage_recap(&messages).is_none(),
            "the only call failed, so there is nothing worth carrying"
        );
    }

    #[test]
    fn an_earlier_success_survives_a_later_failure_of_the_same_tool() {
        let messages = vec![
            assistant_tool_use("c1", "file_read", serde_json::json!({ "path": "good.rs" })),
            tool_result_for("c1", None),
            assistant_tool_use("c2", "file_read", serde_json::json!({ "path": 42 })),
            tool_result_for("c2", Some(true)),
        ];
        let recap = tool_usage_recap(&messages).expect("one call worked");
        assert!(recap.contains("good.rs"), "{recap}");
        assert!(
            !recap.contains("42"),
            "the failed shape is excluded: {recap}"
        );
    }

    #[test]
    fn a_transcript_with_no_tool_calls_adds_nothing() {
        let messages = vec![user_msg("hello"), assistant_text("hi")];
        assert!(tool_usage_recap(&messages).is_none());
    }

    #[test]
    fn long_arguments_are_clipped_so_the_recap_stays_cheap() {
        let huge = "x".repeat(5_000);
        let messages = vec![
            assistant_tool_use("d1", "file_write", serde_json::json!({ "content": huge })),
            tool_result_for("d1", None),
        ];
        let recap = tool_usage_recap(&messages).expect("one working call");
        assert!(
            recap.len() < 1_000,
            "a recap must never become the thing it is protecting against: {} chars",
            recap.len()
        );
        assert!(
            recap.contains('…'),
            "clipping is stated, not silent: {recap}"
        );
    }
}

/// A transcript long enough for `compaction_cut` to find a safe boundary:
/// it needs at least two user messages with a non-empty head.
fn compactable_session() -> Session {
    let big = FILLER_60.repeat(20);
    let mut session = Session::new("t-compact").with_model("chat-provider:chat-model");
    for turn in 0..4 {
        session.append_message(user_with_text(&big, turn * 2));
        session.append_message(assistant_with_text(&big, turn * 2 + 1));
    }
    session
}

/// The shape Aurora actually produces: ONE instruction, then a long autonomous
/// run of tool rounds. Threads like this have a single user boundary, which is
/// precisely why cutting only at user messages could not help them.
fn autonomous_turn(rounds: usize) -> Vec<ConversationMessage> {
    let big = FILLER_60.repeat(40);
    let mut messages = vec![user_with_text(&big, 0)];
    for round in 0..rounds {
        let id = format!("call-{round}");
        messages.push(assistant_tool_use(
            &id,
            "file_read",
            serde_json::json!({ "path": format!("src/file{round}.rs"), "note": big }),
        ));
        messages.push(tool_result_for(&id, None));
    }
    messages
}

/// Every `tool_result` in the tail must be answered by a call that is ALSO in
/// the tail. A cut that breaks this hands the provider a result for a call it
/// cannot see.
fn tail_is_self_contained(messages: &[ConversationMessage], cut: usize) -> bool {
    let calls: std::collections::HashSet<&str> = messages[cut..]
        .iter()
        .flat_map(|m| m.blocks.iter())
        .filter_map(|b| match b {
            ContentBlock::ToolUse { id, .. } => Some(id.as_str()),
            _ => None,
        })
        .collect();
    messages[cut..]
        .iter()
        .flat_map(|m| m.blocks.iter())
        .filter_map(|b| match b {
            ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.as_str()),
            _ => None,
        })
        .all(|id| calls.contains(id))
}

/// THE regression. A thread with one user message and sixty tool rounds was
/// uncuttable, because the only boundary the old rule accepted was a user
/// message and there was exactly one — at index 0, which is not a cut.
///
/// Measured consequence on this machine before the change: `b3f19c05` went
/// 501,776 → 195,974 against a 40,000-token tail budget, and two other
/// compactions reclaimed nothing whatsoever.
#[test]
fn a_single_instruction_turn_can_still_be_compacted() {
    let messages = autonomous_turn(60);
    assert_eq!(
        messages
            .iter()
            .filter(|m| matches!(m.role, MessageRole::User))
            .count(),
        1,
        "the fixture is the one-user-message shape",
    );

    let cut = compaction_cut(&messages, 400_000, ReasoningReplay::Dropped)
        .expect("a 60-round turn must be cuttable");

    assert!(cut > 0, "the head has to hold something to summarize");
    assert!(
        !matches!(messages[cut].role, MessageRole::User),
        "the point of the change: the cut lands INSIDE the turn, at index {cut}",
    );
    assert!(
        tail_is_self_contained(&messages, cut),
        "the tail must not open with a result whose call was summarized away",
    );

    let tail: u32 = messages[cut..]
        .iter()
        .map(|m| estimate_message_tokens(m, ReasoningReplay::Dropped))
        .fold(0, u32::saturating_add);
    assert!(
        tail <= compact_tail_budget(400_000),
        "the budget is now reachable: {tail} tokens kept",
    );
}

/// The cut is taken as early as the budget allows, because the whole value of
/// compaction is how much it reclaims.
#[test]
fn the_cut_is_the_oldest_one_that_fits() {
    let messages = autonomous_turn(60);
    let cut = compaction_cut(&messages, 400_000, ReasoningReplay::Dropped).unwrap();
    let budget = compact_tail_budget(400_000);

    // Not "cut - 1 must overflow" — that index may simply be ILLEGAL, landing
    // between a call and its answer, in which case skipping it was correct.
    // The real claim is that no LEGAL earlier cut also fits.
    for earlier in 1..cut {
        if !tail_is_self_contained(&messages, earlier) {
            continue;
        }
        let tail: u32 = messages[earlier..]
            .iter()
            .map(|m| estimate_message_tokens(m, ReasoningReplay::Dropped))
            .fold(0, u32::saturating_add);
        assert!(
            tail > budget,
            "index {earlier} was a legal cut that also fit ({tail} <= {budget}), so {cut} was not the oldest",
        );
    }
}

/// Never split a call from its answer. With the result one message later than
/// the call, index `cut` may not land between them.
#[test]
fn a_cut_never_separates_a_call_from_its_result() {
    let messages = autonomous_turn(40);
    for window in [50_000_u32, 120_000, 400_000, 1_100_000] {
        let Some(cut) = compaction_cut(&messages, window, ReasoningReplay::Dropped) else {
            continue;
        };
        assert!(
            tail_is_self_contained(&messages, cut),
            "window {window} produced an orphaning cut at {cut}",
        );
    }
}

/// A conversation already inside the tail budget has nothing to reclaim, and
/// compacting it would spend a full-history request to make it BIGGER — which
/// is exactly what one measured compaction did (88,979 → 114,228 tokens).
#[test]
fn a_conversation_already_inside_the_budget_is_left_alone() {
    let messages = autonomous_turn(2);
    let total: u32 = messages
        .iter()
        .map(|m| estimate_message_tokens(m, ReasoningReplay::Dropped))
        .fold(0, u32::saturating_add);
    assert!(
        total <= compact_tail_budget(1_100_000),
        "fixture must fit the budget for this to test anything (got {total})",
    );
    assert!(
        compaction_cut(&messages, 1_100_000, ReasoningReplay::Dropped).is_none(),
        "nothing to reclaim, so no summarization request should be spent",
    );
}

/// The verbatim tail is bounded by an absolute token budget, never by a
/// share of the window.
///
/// This is the regression. The budget used to be 30% of the window, so a
/// 1.1M-context chat was authorised to keep a 330k tail — compaction took
/// a 382k request down to 204k, called it done, and the user paid to send
/// 204k on every request afterwards. The arithmetic was never wrong; the
/// number it was given was.
#[test]
fn the_preserved_tail_is_capped_in_tokens_not_in_window_share() {
    let big = FILLER_60.repeat(40);
    let mut messages = Vec::new();
    for turn in 0..60 {
        messages.push(user_with_text(&big, turn * 2));
        messages.push(assistant_with_text(&big, turn * 2 + 1));
    }
    let total: u32 = messages
        .iter()
        .map(|m| estimate_message_tokens(m, ReasoningReplay::Dropped))
        .fold(0, u32::saturating_add);
    assert!(
        total > 2 * COMPACT_TAIL_MAX_TOKENS,
        "the fixture has to be big enough for the cap to bite (got {total})",
    );

    let tail_for = |window: u32| -> u32 {
        let cut = compaction_cut(&messages, window, ReasoningReplay::Dropped)
            .expect("a transcript this long always has a safe cut");
        messages[cut..]
            .iter()
            .map(|m| estimate_message_tokens(m, ReasoningReplay::Dropped))
            .fold(0, u32::saturating_add)
    };

    // The window that produced the bug. 30% of it was 330,000 tokens.
    assert!(
        tail_for(1_100_000) <= COMPACT_TAIL_MAX_TOKENS,
        "a huge window must not authorise a huge tail",
    );
    // Every window large enough for the flat cap cuts in the SAME place —
    // the window no longer has a vote in how much history survives.
    assert_eq!(tail_for(1_100_000), tail_for(200_000));
    // A window too small for the flat cap scales down, and only down.
    assert!(tail_for(32_000) <= 32_000 / COMPACT_TAIL_WINDOW_DIVISOR);
}

#[tokio::test]
async fn compaction_summarizes_on_the_chat_model_by_default() {
    let chat = recording_api("a summary");
    let runtime = ConversationRuntime::new(
        chat.clone(),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            context_window: Some(4000),
            ..RuntimeConfig::default()
        },
    );

    let mut session = compactable_session();
    let (tx, _rx) = mpsc::channel(32);
    let mut seq = 0;
    let result = runtime
        .compact_now(
            &mut session,
            "turn-1",
            &mut seq,
            &tx,
            &CancellationToken::new(),
        )
        .await;

    assert!(result.is_some(), "compaction should have produced a marker");
    assert_eq!(
        chat.models.lock().expect("models").as_slice(),
        &["chat-provider:chat-model".to_string()],
        "with nothing pinned the summary rides the conversation's own model",
    );
}

#[tokio::test]
async fn a_pinned_compaction_model_runs_and_is_billed_for_the_summary() {
    let chat = recording_api("chat reply");
    let summarizer = recording_api("a summary");
    let runtime = ConversationRuntime::new(
        chat.clone(),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            context_window: Some(4000),
            ..RuntimeConfig::default()
        },
    )
    .with_compaction_client(summarizer.clone(), "cheap-provider:cheap-model");

    let mut session = compactable_session();
    let (tx, _rx) = mpsc::channel(32);
    let mut seq = 0;
    let result = runtime
        .compact_now(
            &mut session,
            "turn-1",
            &mut seq,
            &tx,
            &CancellationToken::new(),
        )
        .await;

    assert!(result.is_some(), "compaction should have produced a marker");
    // The summary ran on the pinned provider…
    assert_eq!(
        summarizer.models.lock().expect("models").as_slice(),
        &["cheap-provider:cheap-model".to_string()],
    );
    // …and the chat provider was never asked to do it.
    assert!(
        chat.models.lock().expect("models").is_empty(),
        "the chat model must not run the summary once one is pinned",
    );

    // The marker carries the SUMMARIZER's model, so the cost card prices
    // this request at the cheap model's rates rather than the chat one's.
    let marker = session
        .messages()
        .iter()
        .find(|m| {
            m.blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::Compaction { .. }))
        })
        .expect("marker was inserted");
    assert_eq!(marker.model.as_deref(), Some("cheap-provider:cheap-model"));
}

/// API mock that records every messages slice it sees so we can
/// assert what was actually trimmed.
#[derive(Default)]
struct CapturingTrimApi {
    captured: Mutex<Vec<(Option<String>, Vec<ConversationMessage>)>>,
}

#[async_trait]
impl StreamingApiClient for CapturingTrimApi {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        _event_sink: mpsc::Sender<AssistantEvent>,
        _cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        self.captured.lock().expect("captured").push((
            request.system_prompt.map(str::to_string),
            request.messages.to_vec(),
        ));
        Ok(turn_usage(assistant_text("ok"), "end_turn"))
    }
}

#[tokio::test]
async fn run_turn_trims_session_and_appends_trim_notice_when_over_budget() {
    // Pre-seed a session with three user-rooted turns where the
    // first two are large enough to exceed a tight budget.
    let big = FILLER_60.repeat(60); // ~225 tokens cl100k
    let mut session = Session::new("t");
    session.append_message(user_with_text(&big, 0));
    session.append_message(assistant_with_text(&big, 1));
    session.append_message(user_with_text(&big, 2));
    session.append_message(assistant_with_text(&big, 3));
    // Third user message comes from `run_turn` itself.

    let api = Arc::new(CapturingTrimApi::default());
    let runtime = ConversationRuntime::new(
        api.clone(),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            system_prompt: Some("you are aurora".into()),
            default_max_output_tokens: 100,
            context_window: Some(1000),
            ..RuntimeConfig::default()
        },
    );

    let (tx, _rx) = mpsc::channel(32);
    runtime
        .run_turn(&mut session, user_msg("now"), tx, CancellationToken::new())
        .await
        .expect("ok");

    let captured = api.captured.lock().expect("captured");
    let (sys, msgs) = captured.first().expect("api was called");

    // Trim notice was appended to the system prompt.
    let sys = sys.as_deref().expect("system prompt was set");
    assert!(
        sys.contains("<context_trim_notice>"),
        "system prompt should carry trim notice, got: {sys}"
    );
    assert!(
        sys.contains("you are aurora"),
        "original prompt must be preserved, got: {sys}"
    );

    // The first kept message must be a User (cut at user boundary).
    assert_eq!(msgs[0].role, MessageRole::User);
    // The latest user message ("now") must still be present.
    assert!(
        msgs.iter().any(|m| matches!(
            &m.blocks[0],
            ContentBlock::Text { text } if text == "now"
        )),
        "latest user message must survive trim"
    );

    // Persisted session is untouched — still 5 messages (4 seeded + 1
    // appended user + 1 appended assistant from MockApi return).
    assert_eq!(session.len(), 6);
}

#[tokio::test]
async fn run_turn_does_not_trim_when_context_window_is_none() {
    // No window set → legacy behaviour: send everything every turn.
    let big = FILLER_60.repeat(60);
    let mut session = Session::new("t");
    session.append_message(user_with_text(&big, 0));
    session.append_message(assistant_with_text(&big, 1));
    session.append_message(user_with_text(&big, 2));
    session.append_message(assistant_with_text(&big, 3));

    let api = Arc::new(CapturingTrimApi::default());
    let runtime = ConversationRuntime::new(
        api.clone(),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            system_prompt: Some("you are aurora".into()),
            default_max_output_tokens: 100,
            context_window: None,
            ..RuntimeConfig::default()
        },
    );

    let (tx, _rx) = mpsc::channel(32);
    runtime
        .run_turn(&mut session, user_msg("now"), tx, CancellationToken::new())
        .await
        .expect("ok");

    let captured = api.captured.lock().expect("captured");
    let (sys, msgs) = captured.first().expect("api was called");

    // System prompt unmodified.
    assert_eq!(sys.as_deref(), Some("you are aurora"));
    // All 5 messages (4 seeded + the new user) reach the API.
    assert_eq!(msgs.len(), 5, "no trim → full session sent");
}

/// The call site for `Session::resync_journal`.
///
/// `session.rs` proves the mechanism — desync, rewrite, appends resume. This
/// proves `compact_inner` actually invokes it, which is the half that decides
/// whether a real turn is recoverable. Delete the `resync_journal` call in
/// `compaction.rs` and this fails on the line count below.
///
/// The bug it guards: measured 2026-08-27, a compaction inserted its marker at
/// line 122 of a 137-line file and the journal went silent for the remaining
/// six minutes of the turn — forty messages, six of them file writes and
/// edits, held in nothing but RAM.
#[tokio::test]
async fn compaction_rewrites_the_journal_so_the_rest_of_the_turn_is_recoverable() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("t.jsonl");

    // One scripted turn: the summarizer's reply.
    let api = Arc::new(MockApi::new(vec![TurnScript {
        events: vec![],
        result: Ok(turn_usage(
            assistant_text("A note about everything above."),
            "end_turn",
        )),
    }]));

    let runtime = ConversationRuntime::new(
        api,
        Arc::new(ToolRegistry::new()),
        RuntimeConfig {
            // Small window and a low bar, so the seeded history is over the
            // line and compaction is guaranteed to run.
            context_window: Some(1_000),
            compaction_threshold: Some(0.01),
            ..RuntimeConfig::default()
        },
    );

    let mut session = Session::new("t");
    session.model = Some("test-model".into());
    session.attach_journal(&path, 0);
    // Enough history for the cut to have something on both sides of it.
    for i in 0..12 {
        session.append_message(user_msg(&format!("question {i} {}", "padding ".repeat(40))));
        session.append_message(assistant_text(&format!("answer {i}")));
    }
    let before_lines = std::fs::read_to_string(&path)
        .expect("journal")
        .lines()
        .count();
    assert_eq!(before_lines, 24, "the journal kept up until compaction");

    let (tx, _rx) = mpsc::channel(64);
    let mut seq = 0u64;
    runtime
        .maybe_compact(
            &mut session,
            "turn-1",
            &mut seq,
            &tx,
            &CancellationToken::new(),
        )
        .await;

    // The marker went in mid-history, so without the rewrite the file would
    // still hold 24 lines while memory holds 25.
    assert_eq!(session.len(), 25, "a marker was inserted");
    let on_disk = std::fs::read_to_string(&path).expect("journal");
    assert_eq!(
        on_disk.lines().count(),
        25,
        "compaction must rewrite the file, not leave it a message behind"
    );

    // And the journal is live again for the rest of the turn — the actual point.
    session.append_message(assistant_text("post-compaction work"));
    let recovered = Session::load_from_path("t", &path).expect("load");
    assert_eq!(recovered.len(), 26);
    assert!(
        std::fs::read_to_string(&path)
            .expect("journal")
            .contains("post-compaction work"),
        "appends must resume immediately, not wait for the end-of-turn save"
    );
}
