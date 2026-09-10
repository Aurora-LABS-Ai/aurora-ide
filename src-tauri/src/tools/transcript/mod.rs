//! `chapter` — the agent naming the part of the work it is starting.
//!
//! A long turn is one wall of prose and tool cards, and the reader has no way to
//! see its shape without reading all of it. This tool lets the model say "I am
//! starting X now", and the transcript renders that as a heading exactly where
//! the call landed.
//!
//! ## Why a tool, and not something inferred
//!
//! Chapters could have been guessed from the reply's own markdown headings, or
//! from runs of tool calls. Both are guesses about intent, and both are wrong
//! the moment the model formats a reply differently. A tool call is the model
//! stating the boundary itself: it is unambiguous, it already carries an id, and
//! it already lands at the exact point in the timeline where it was emitted — so
//! it survives a reload with no extra persistence of its own.
//!
//! ## Availability
//!
//! Off unless the user turns on Settings → Preferences → Transcript → Chapters.
//! The gate lives in `commands::agent_v2::is_tool_available_this_turn`, next to
//! the mode and plan gates, so the roster the model is advertised and the
//! instruction it is given are switched by the same preference.
//!
//! The tool deliberately does nothing but validate and echo. It stores no state:
//! the transcript IS the record, and a chapter that had to be written down
//! somewhere else could disagree with the turn it was describing.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};

/// Names this bucket registers, in roster order.
pub const TOOL_NAMES: &[&str] = &["chapter"];

/// Longest title shown. A chapter is a heading, not a paragraph — past this it
/// stops being scannable, which is the only thing it is for.
///
/// PAIRED with `CHAPTER_TITLE_MAX` in
/// `src/apps/agent/components/conversation/timeline.ts`. The transcript draws
/// the heading from the STREAMED arguments so it appears as the model types it,
/// which is before any result exists — so the frontend shortens it too, and the
/// two must agree or the model is told it got a title the user never saw.
const MAX_TITLE_LEN: usize = 60;

/// Shorten an over-long title to fit, or `None` when it already does.
///
/// Cuts at the last word boundary inside the budget and marks the cut with an
/// ellipsis, which is counted against the budget rather than added past it. A
/// heading sliced mid-word reads as a rendering bug; one ending in `…` reads as
/// what it is.
///
/// A single word longer than the whole budget is hard-cut, because there is no
/// boundary to prefer and the alternative is showing nothing.
fn shorten_title(title: &str) -> Option<String> {
    if title.chars().count() <= MAX_TITLE_LEN {
        return None;
    }
    // One short of the budget: the ellipsis has to live inside it.
    let head: String = title.chars().take(MAX_TITLE_LEN - 1).collect();
    let hard = head.trim_end();
    let cut = match head.rfind(char::is_whitespace) {
        // `rfind` returns a byte index at a char boundary, so slicing is safe.
        Some(at) => {
            let word = head[..at].trim_end();
            // Prefer the word boundary only when it keeps most of the budget.
            // Otherwise a title like "a <70-character-word>", whose only space
            // sits at position 1, would shorten to "a…" — a heading that says
            // less than no heading at all.
            if word.chars().count() >= MAX_TITLE_LEN / 2 {
                word
            } else {
                hard
            }
        }
        None => hard,
    };
    Some(format!("{cut}…"))
}

pub struct ChapterTool;

#[async_trait]
impl ToolExecutor for ChapterTool {
    fn name(&self) -> &str {
        "chapter"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "chapter".into(),
            description: "Announce the part of the work you are starting. The user's transcript \
shows it as a heading at this exact point, so they can see the shape of a long reply without \
reading all of it.

Call this the moment you begin a distinct part of the work, BEFORE the tool calls that do it — not \
afterwards as a summary, and not all at once up front.

Title it by what you are about to do, in a few plain words, and keep it under 60 characters — it is \
a heading, not a sentence: \"Read the reload path\", \"Fix the tool join\", \"Run the tests\". Not \
\"Step 2\", not \"Investigation phase\". A longer title is shortened to fit, not rejected.

Skip it entirely for short work. Two or three chapters across a long turn is right; a chapter per \
tool call is noise, and one chapter for everything says nothing."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        // The limit is stated in BOTH descriptions on purpose.
                        // Some providers show the model only the parameter
                        // descriptions when a schema gets long, and a limit the
                        // model cannot see is one it can only discover by
                        // tripping over it.
                        "description": "What you are about to do, in a few plain words. \
Under 60 characters.",
                        "maxLength": MAX_TITLE_LEN
                    }
                },
                "required": ["title"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let title = input
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidInput(
                    "`title` is required: name the part of the work you are starting.".into(),
                )
            })?;

        // Shortened, not rejected.
        //
        // This used to fail the call outright. The objection to truncating was
        // that it would show a heading the model did not write and teach the
        // model nothing — both true, and both fixed here without throwing the
        // call away: the ellipsis tells the READER the title was cut, and the
        // note tells the MODEL, in the same breath as saying not to retry.
        //
        // Failing was the wrong trade. A title is the cosmetic part of this
        // tool; the chapter boundary is the load-bearing part, and it was
        // being discarded over the cosmetic half. Worse, the user saw a red
        // failed tool card in the middle of a turn where nothing had actually
        // gone wrong, and the model, having been told only "rejected", would
        // reasonably spend another whole request calling it again.
        //
        // A MISSING title still fails, above: there is no heading to salvage.
        let (title, note) = match shorten_title(title) {
            None => (title.to_string(), None),
            Some(short) => (
                short,
                Some(format!(
                    "Your title was {} characters, so Aurora shortened it to fit the \
{MAX_TITLE_LEN}-character heading. The chapter is on screen — do not call `chapter` again for \
this one. Keep the next title under {MAX_TITLE_LEN}.",
                    title.chars().count()
                )),
            ),
        };

        let mut result = json!({ "success": true, "chapter": title });
        if let Some(note) = note {
            result["note"] = json!(note);
        }
        Ok(result.to_string())
    }
}

pub fn register(reg: &mut ToolRegistry) {
    reg.register(Arc::new(ChapterTool));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn ctx() -> ToolContext {
        ToolContext {
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    #[tokio::test]
    async fn echoes_the_title_it_was_given() {
        let out = ChapterTool
            .execute(json!({ "title": "  Read the reload path  " }), &ctx())
            .await
            .expect("accepted");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(parsed["chapter"], "Read the reload path");
        assert_eq!(parsed["success"], true);
    }

    #[tokio::test]
    async fn a_missing_or_blank_title_is_rejected() {
        for input in [json!({}), json!({ "title": "   " }), json!({ "title": 7 })] {
            let err = ChapterTool
                .execute(input.clone(), &ctx())
                .await
                .expect_err("a chapter with no name is not a chapter");
            assert!(matches!(err, ToolError::InvalidInput(_)), "{input}");
        }
    }

    /// The behaviour this tool used to get wrong: an over-long title failed the
    /// call, so the chapter boundary was thrown away over its cosmetic half and
    /// the user got a red tool card in a turn where nothing had gone wrong.
    #[tokio::test]
    async fn an_overlong_title_is_shortened_and_still_succeeds() {
        let long = "Read the reload path and then fix the tool join before running every test";
        assert!(long.chars().count() > MAX_TITLE_LEN);
        let out = ChapterTool
            .execute(json!({ "title": long }), &ctx())
            .await
            .expect("a long title is a cosmetic problem, not a failed call");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(parsed["success"], true);

        let shown = parsed["chapter"].as_str().expect("a chapter");
        assert!(shown.chars().count() <= MAX_TITLE_LEN, "{shown}");
        // Cut at a word boundary, and the cut is visible to the reader.
        assert!(shown.ends_with('…'), "{shown}");
        assert!(!shown.contains("  "), "{shown}");
        assert!(long.starts_with(shown.trim_end_matches('…')), "{shown}");
    }

    /// The model has to be told, or it learns nothing — and told NOT to retry,
    /// or it spends another whole request calling `chapter` again.
    #[tokio::test]
    async fn the_note_says_it_was_adjusted_and_not_to_retry() {
        let out = ChapterTool
            .execute(json!({ "title": "x".repeat(MAX_TITLE_LEN + 14) }), &ctx())
            .await
            .expect("accepted");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        let note = parsed["note"].as_str().expect("a note");
        assert!(note.contains(&(MAX_TITLE_LEN + 14).to_string()), "{note}");
        assert!(note.contains(&MAX_TITLE_LEN.to_string()), "{note}");
        assert!(note.contains("do not call"), "{note}");
    }

    /// No note on a title that fitted. A tool that comments on every ordinary
    /// call is one whose comments stop being read.
    #[tokio::test]
    async fn a_title_at_the_limit_is_accepted_untouched_and_unremarked() {
        let exact = "x".repeat(MAX_TITLE_LEN);
        let out = ChapterTool
            .execute(json!({ "title": exact.clone() }), &ctx())
            .await
            .expect("the boundary itself is fine");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(parsed["chapter"], exact);
        assert!(parsed.get("note").is_none(), "{parsed}");
    }

    /// One word longer than the whole budget has no boundary to prefer, and
    /// showing nothing would be worse than a hard cut.
    #[tokio::test]
    async fn a_single_overlong_word_is_hard_cut() {
        let out = ChapterTool
            .execute(json!({ "title": "x".repeat(120) }), &ctx())
            .await
            .expect("accepted");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        let shown = parsed["chapter"].as_str().expect("a chapter");
        assert_eq!(shown.chars().count(), MAX_TITLE_LEN);
        assert!(shown.ends_with('…'), "{shown}");
    }

    /// Counted in CHARACTERS, not bytes. A `.len()` here would make the limit
    /// roughly a third as long for anyone not writing ASCII.
    #[tokio::test]
    async fn the_budget_is_characters_not_bytes() {
        // 40 three-byte characters: 120 bytes, well under the char limit.
        let cjk = "码".repeat(40);
        let out = ChapterTool
            .execute(json!({ "title": cjk.clone() }), &ctx())
            .await
            .expect("accepted");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(parsed["chapter"], cjk);
        assert!(parsed.get("note").is_none());
    }

    /// A title whose only whitespace sits near the front must not collapse to
    /// that first word. Honouring the boundary blindly turned
    /// `"a <80-character-word>"` into `"a…"`.
    #[test]
    fn an_early_lone_space_does_not_eat_the_whole_title() {
        let shown = shorten_title(&format!("a {}", "x".repeat(80))).expect("shortened");
        assert!(shown.chars().count() <= MAX_TITLE_LEN, "{shown}");
        assert!(
            shown.chars().count() >= MAX_TITLE_LEN / 2,
            "shortening kept only {:?}",
            shown
        );
    }

    /// The ordinary case: cut at the last space, and keep whole words.
    #[test]
    fn a_normal_sentence_is_cut_at_a_word_boundary() {
        let shown =
            shorten_title("Read the reload path and then fix the tool join before running tests")
                .expect("shortened");
        assert_eq!(shown, "Read the reload path and then fix the tool join before…");
        assert!(shown.chars().count() <= MAX_TITLE_LEN, "{shown}");
    }

    #[test]
    fn registers_under_its_documented_name() {
        let mut reg = ToolRegistry::new();
        register(&mut reg);
        assert_eq!(reg.len(), TOOL_NAMES.len());
        let tool = reg.get("chapter").expect("registered");
        assert_eq!(tool.schema().name, "chapter");
        assert!(
            !tool.requires_permission(),
            "naming the work changes nothing and must never prompt"
        );
    }
}
