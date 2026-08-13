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

/// Longest title accepted. A chapter is a heading, not a paragraph — past this
/// it stops being scannable, which is the only thing it is for.
const MAX_TITLE_LEN: usize = 60;

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

Title it by what you are about to do, in a few plain words: \"Read the reload path\", \"Fix the \
tool join\", \"Run the tests\". Not \"Step 2\", not \"Investigation phase\".

Skip it entirely for short work. Two or three chapters across a long turn is right; a chapter per \
tool call is noise, and one chapter for everything says nothing."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "What you are about to do, in a few plain words."
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

        // Rejected rather than truncated. Silently cutting a title would show
        // the user a heading the model did not write, and the model would never
        // learn that its titles are too long.
        if title.chars().count() > MAX_TITLE_LEN {
            return Err(ToolError::InvalidInput(format!(
                "`title` is {} characters; keep it under {MAX_TITLE_LEN}. \
A chapter is a heading, not a sentence.",
                title.chars().count()
            )));
        }

        Ok(json!({ "success": true, "chapter": title }).to_string())
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
            allow_outside_workspace: false,
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

    #[tokio::test]
    async fn an_overlong_title_is_rejected_not_truncated() {
        let err = ChapterTool
            .execute(json!({ "title": "x".repeat(MAX_TITLE_LEN + 1) }), &ctx())
            .await
            .expect_err("must reject");
        let message = format!("{err:?}");
        assert!(message.contains("heading"), "{message}");
    }

    #[tokio::test]
    async fn a_title_at_the_limit_is_accepted() {
        ChapterTool
            .execute(json!({ "title": "x".repeat(MAX_TITLE_LEN) }), &ctx())
            .await
            .expect("the boundary itself is fine");
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
