//! Reply suggestions written by a CLOUD model, from the whole conversation.
//!
//! The local llama.cpp path stays light on purpose (`prompt_refine`): one
//! exchange in, a numbered list out. A cloud model can read far more, so it
//! gets the conversation brief ([`brief`]), the project's record of what this
//! developer did with earlier suggestions ([`log::recent_outcomes`]), and one
//! tool to answer with.
//!
//! **Why a tool.** The answer is data — four replies and what each is for —
//! and a tool call delivers data without a preamble to strip or a list to
//! guess at. The model is asked to call it; it is not forced, because several
//! providers refuse a forced tool while their model is thinking, and a model
//! that answers in text instead is still read (`answered_via: "text"` in the
//! log says how often that happens).
//!
//! **Thinking.** Not requested — four short replies do not need it, and it is
//! the cost. Some models think regardless, so the output budget leaves room
//! for it; whatever they think is logged and never shown.
//!
//! Every run is written to the conversation's `suggestions.jsonl`
//! ([`log`]) whether it worked or not.

pub mod brief;
#[cfg(test)]
mod live_tests;
pub mod log;

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::agent_runtime::api_client::{ApiRequest, ReasoningControl, ReasoningRequest, ToolSchema};
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::{ContentBlock, ConversationMessage};
use crate::api::client::ProviderConfigSnapshot;

/// Bumped whenever [`CLOUD_SYSTEM`] or the tool changes, so the log shows
/// which instruction produced each run.
pub const CLOUD_PROMPT_VERSION: &str = "cloud-v2";

/// The tool the model answers with.
pub const TOOL_NAME: &str = "suggest_replies";

/// Room for four short replies, and for a model that thinks whether asked to
/// or not.
const MAX_OUTPUT_TOKENS: u32 = 2_000;

/// A suggestion is only useful while the developer is still deciding what to
/// type; a thinking model on a long brief needs longer than the old 30s.
const TIMEOUT: Duration = Duration::from_secs(45);

/// The longest reply a chip accepts on this path, and what the model is told.
/// The local model's limit stays at 12: measured on a real 13-turn chat
/// (MiniMax M3, 2026-10-12), a 12-word filter threw away half of the cloud
/// model's replies, and they were the ones that sounded most like the
/// developer. 20 is Alvan's call.
const MAX_WORDS: usize = 20;

const CLOUD_SYSTEM: &str = "You predict what a developer will type next to their AI coding assistant, so they can tap it instead of typing.

You are given a brief of the conversation: every message the developer sent, in their own words; what the assistant did and said in its latest turn; how earlier turns ended; any unfinished checklist tasks; and, when there are any, what this developer did with earlier suggestions — which they tapped, which they changed, and what they typed instead.

Write the 4 messages this developer is most likely to send next.
- In THEIR voice: match how they actually write — length, tone, wording, even their habits (terse \"go\", a typo-tolerant style, a standing instruction they repeat). Not a polite assistant's voice.
- Short. Most real messages are under 12 words; aim for 6 to 12, never past 20. One thing per message, not a stacked list of instructions.
- Plain words. No flags, option names, identifiers, file names or numbers unless they appear in the brief word for word. Nothing invented.
- Anchored to the latest turn: answer the assistant's question if it asked one, take up what it offered, react to what failed, or move to the next open task.
- The four cover different moves. Always include one plain QUESTION about something in the reply (what does X mean, which one, did you use Y), and one REACTION or redirect in their words (what they dislike, what to do instead). The other two carry on or go deeper.
- Do not offer re-running tests, typecheck, lint or builds unless they asked for a check earlier in this conversation.
- Learn from the past suggestions: if they keep ignoring a kind of suggestion, stop offering it; if they keep rewriting suggestions a certain way, write them that way. Take their style and direction from those examples; never repeat an old message word for word — it answered a different moment.
- No numbering, no quotes.

Answer by calling the suggest_replies tool exactly once. Do not write anything else.";

/// The same job for an Aurora Chat conversation, which is not a coding
/// session: research, questions, writing, pictures. Its own instruction rather
/// than a tweak of the one above, because the intents are different — a chat
/// user digs deeper, asks for sources, changes the angle, or moves on, where a
/// developer runs tests and reviews diffs. Same tool, same limits.
const CHAT_SYSTEM: &str = "You predict what a person will type next to Aurora, their AI assistant, so they can tap it instead of typing.

You are given a brief of the conversation: every message they sent, in their own words; what Aurora did and said in its latest turn (searches, pages read, things it made); how earlier turns ended; and, when there are any, what this person did with earlier suggestions — which they tapped, which they changed, and what they typed instead.

Write the 4 messages this person is most likely to send next.
- In THEIR voice: match how they actually write — length, tone, wording, habits. Not a polite assistant's voice.
- Short. Aim for 6 to 12 words, never past 20. One thing per message.
- Plain words. No names, numbers or terms unless they appear in the brief word for word. Nothing invented.
- Anchored to the latest turn: answer Aurora's question if it asked one, take up what it offered, push back on what looks wrong, or go deeper on the part that matters most.
- The four cover different moves. Always include one plain QUESTION about something in the reply, and one REACTION or change of angle in their words. The other two go deeper or move on.
- Learn from the past suggestions: if they keep ignoring a kind of suggestion, stop offering it; if they keep rewriting suggestions a certain way, write them that way. Take their style and direction from those examples; never repeat an old message word for word — it answered a different moment.
- No numbering, no quotes.

Answer by calling the suggest_replies tool exactly once. Do not write anything else.";

/// Which instruction a chat-mode run used, for the log.
pub const CHAT_PROMPT_VERSION: &str = "cloud-chat-v2";

fn tool_schema() -> ToolSchema {
    ToolSchema {
        name: TOOL_NAME.to_string(),
        description: "Deliver the 4 messages the developer is most likely to send next.".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "replies": {
                    "type": "array",
                    "description": "Exactly 4 replies, most likely first.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "text": {
                                "type": "string",
                                "description": "The message, in the developer's own voice, at most 20 words."
                            },
                            "intent": {
                                "type": "string",
                                "enum": ["continue", "verify", "correct", "ask", "other"],
                                "description": "What the message does."
                            }
                        },
                        "required": ["text", "intent"]
                    }
                }
            },
            "required": ["replies"]
        }),
    }
}

/// What a cloud run produced, for the caller and the log.
pub struct CloudRun {
    pub suggestions: Vec<String>,
    pub record: log::RunRecord,
}

/// Everything a run needs to know about where it is.
pub struct RunContext<'a> {
    pub run_id: &'a str,
    pub thread_id: &'a str,
    pub thread_dir: &'a Path,
    pub project_dir: &'a Path,
    pub messages: &'a [ConversationMessage],
    /// Ask the model to think first. Off in the app (four short replies do
    /// not need it, and it is the cost); the live tests turn it on to measure
    /// whether it buys better suggestions.
    pub think: bool,
    /// The conversation is an Aurora Chat one, not a project's: it gets
    /// [`CHAT_SYSTEM`] and the person is called "User" in the brief.
    pub chat: bool,
}

/// Ask `model` for suggestions from the whole conversation. Never fails: a
/// failed run returns no suggestions and a record with its `error`, so every
/// attempt is logged the same way.
pub async fn run_cloud(config: &ProviderConfigSnapshot, model: &str, ctx: RunContext<'_>) -> CloudRun {
    let started = Instant::now();
    let tasks = log::open_tasks(ctx.thread_dir);
    let (outcomes, outcome_count) = log::recent_outcomes(ctx.project_dir);
    let who = if ctx.chat { "User" } else { "Developer" };
    let brief = brief::build_for(ctx.messages, &tasks, &outcomes, who);
    let input = format!(
        "{}\nWrite the {}'s 4 most likely next messages with the {TOOL_NAME} tool.",
        brief.text,
        who.to_lowercase(),
    );

    let mut record = log::RunRecord {
        kind: "run",
        run_id: ctx.run_id.to_string(),
        at: chrono::Utc::now().to_rfc3339(),
        thread_id: ctx.thread_id.to_string(),
        path: "cloud",
        model: model.to_string(),
        prompt_version: if ctx.chat { CHAT_PROMPT_VERSION } else { CLOUD_PROMPT_VERSION },
        thinking_requested: ctx.think,
        input_chars: input.chars().count(),
        input: input.clone(),
        brief: Some(log::BriefStats {
            turns_total: brief.turns_total,
            turns_included: brief.turns_included,
            compacted: brief.compacted,
            open_tasks: !tasks.is_empty(),
            past_outcomes: outcome_count,
        }),
        thinking: String::new(),
        raw_text: String::new(),
        tool_input: None,
        answered_via: "none",
        suggestions: Vec::new(),
        usage: None,
        stop_reason: None,
        latency_ms: 0,
        error: None,
    };

    let client = crate::api::build_api_client(config);
    let messages = vec![ConversationMessage::user_text(&input, 0)];
    let tools = [tool_schema()];
    let request = ApiRequest {
        model,
        system_prompt: Some(if ctx.chat { CHAT_SYSTEM } else { CLOUD_SYSTEM }),
        messages: &messages,
        tools: &tools,
        tool_choice: Default::default(),
        temperature: Some(0.7),
        max_output_tokens: MAX_OUTPUT_TOKENS,
        reasoning: if ctx.think {
            ReasoningRequest {
                enabled: true,
                control: ReasoningControl::Toggle,
                effort: Some("high"),
                budget_tokens: None,
                request_mode: Default::default(),
                replay: Default::default(),
            }
        } else {
            ReasoningRequest::disabled()
        },
        tool_bridge: None,
        // The conversation's id, so successive briefs for it — which share
        // their whole start — reach the same provider cache.
        session_key: Some(ctx.thread_id),
    };

    // Drain events concurrently: adapters `.send().await` into the channel, so
    // a full buffer would stall the stream against itself.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<AssistantEvent>(64);
    let collector = tokio::spawn(async move {
        let mut text = String::new();
        let mut thinking = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                AssistantEvent::TextDelta { delta } => text.push_str(&delta),
                AssistantEvent::Thinking { text: t, .. } => thinking.push_str(&t),
                _ => {}
            }
        }
        (text, thinking)
    });

    let outcome = tokio::time::timeout(
        TIMEOUT,
        client.stream(request, tx, tokio_util::sync::CancellationToken::new()),
    )
    .await;
    let (streamed_text, streamed_thinking) = collector.await.unwrap_or_default();
    record.latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    let usage = match outcome {
        Err(_) => {
            record.error = Some(format!("no answer within {}s", TIMEOUT.as_secs()));
            record.raw_text = streamed_text;
            record.thinking = streamed_thinking;
            return CloudRun { suggestions: Vec::new(), record };
        }
        Ok(Err(err)) => {
            record.error = Some(err.to_string());
            record.raw_text = streamed_text;
            record.thinking = streamed_thinking;
            return CloudRun { suggestions: Vec::new(), record };
        }
        Ok(Ok(usage)) => usage,
    };

    let mut text = String::new();
    let mut thinking = String::new();
    let mut tool_input: Option<Value> = None;
    for block in &usage.assistant_message.blocks {
        match block {
            ContentBlock::Text { text: t } => text.push_str(t),
            ContentBlock::Thinking { text: t, .. } => thinking.push_str(t),
            ContentBlock::ToolUse { name, input, .. } if name == TOOL_NAME && tool_input.is_none() => {
                tool_input = Some(input.clone());
            }
            _ => {}
        }
    }
    record.raw_text = if text.trim().is_empty() { streamed_text } else { text };
    record.thinking = if thinking.trim().is_empty() { streamed_thinking } else { thinking };
    record.stop_reason = Some(usage.stop_reason.clone());
    record.usage = serde_json::to_value(&usage.usage).ok();

    let (suggestions, via) = read_answer(tool_input.as_ref(), &record.raw_text);
    record.tool_input = tool_input;
    record.answered_via = via;
    record.suggestions = suggestions.clone();
    if suggestions.is_empty() && record.error.is_none() {
        record.error = Some("the answer held no usable suggestion".to_string());
    }
    CloudRun { suggestions, record }
}

/// The suggestions in a model's answer: from the tool call when there is one,
/// otherwise from a list in its text. Both go through the same filters as the
/// local path, so a reply is held to one standard whoever wrote it.
fn read_answer(tool_input: Option<&Value>, text: &str) -> (Vec<String>, &'static str) {
    if let Some(input) = tool_input {
        let mut lines: Vec<String> = Vec::new();
        collect_reply_texts(input, &mut lines);
        let parsed = crate::prompt_refine::parse_suggestions_up_to(&lines.join("\n"), MAX_WORDS);
        if !parsed.is_empty() {
            return (parsed, "tool");
        }
    }
    let parsed = crate::prompt_refine::parse_suggestions_up_to(text, MAX_WORDS);
    if parsed.is_empty() {
        (parsed, "none")
    } else {
        (parsed, "text")
    }
}

/// Every reply text in a tool answer, in document order, whatever shape the
/// model gave it.
///
/// The schema asks for `replies[{text, intent}]`. The log from one week of
/// real use (122 runs, 2026-10-19) shows MiniMax M3 answering under `reply`,
/// `Replies`, `runs`, `item`, `rows.item`, and Cursor's composer once under
/// `suggestions` — six runs out of seven lost, each holding four good replies.
/// So the reader walks the whole value: an object with a `text` or `reply`
/// string IS a reply; a bare string in an array is one; everything else is
/// descended into. `intent` values are never replies.
fn collect_reply_texts(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            let own = map.iter().find_map(|(k, v)| {
                let key = k.to_ascii_lowercase();
                if key == "text" || key == "reply" {
                    v.as_str().map(str::to_string)
                } else {
                    None
                }
            });
            if let Some(text) = own {
                out.push(text);
            }
            // The object's own reply is read above; what is left to look at
            // is anything nested under it (`{reply, item: {reply}}`).
            for (k, v) in map {
                if k.eq_ignore_ascii_case("intent") || !(v.is_object() || v.is_array()) {
                    continue;
                }
                collect_reply_texts(v, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                match item {
                    Value::String(s) => out.push(s.clone()),
                    other => collect_reply_texts(other, out),
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shapes MiniMax M3 and Cursor's composer actually answered with in
    /// the first week's log. Each used to be "no usable suggestion".
    #[test]
    fn a_tool_answer_under_another_key_is_still_read() {
        let shapes = [
            json!({ "reply": "Walk me through the matcher", "intent": "continue",
                    "item": { "reply": "Skip the route-group note", "intent": "correct" } }),
            json!({ "runs": [ { "text": "now hit the tablet fix", "intent": "continue" },
                              { "text": "layout shift still pops in", "intent": "verify" } ] }),
            json!({ "Replies": [ { "text": "fix the line endings now", "intent": "continue" } ] }),
            json!({ "item": { "text": "show me the full code", "intent": "verify" } }),
            json!({ "rows": { "item": [ { "text": "map the runtime knobs", "intent": "continue" } ] } }),
            json!({ "suggestions": [ "ok so do i tell him go ahead", "give me the exact curl" ] }),
        ];
        let expected = [2, 2, 1, 1, 1, 2];
        for (shape, want) in shapes.iter().zip(expected) {
            let (suggestions, via) = read_answer(Some(shape), "");
            assert_eq!(via, "tool", "{shape}");
            assert_eq!(suggestions.len(), want, "{shape}");
        }
    }

    /// An `intent` value is a label, never a reply.
    #[test]
    fn an_intent_is_never_read_as_a_reply() {
        let input = json!({ "replies": [ { "intent": "continue", "text": "go" } ] });
        let (suggestions, _) = read_answer(Some(&input), "");
        assert_eq!(suggestions, vec!["go"]);
    }

    #[test]
    fn a_tool_answer_is_read_from_its_replies() {
        let input = json!({ "replies": [
            { "text": "Yes, guard the signup form too", "intent": "continue" },
            { "text": "Run the full suite first", "intent": "verify" },
            { "text": "Why did the email test fail?", "intent": "ask" },
            { "text": "Revert that, use zod instead", "intent": "correct" }
        ]});
        let (suggestions, via) = read_answer(Some(&input), "");
        assert_eq!(via, "tool");
        assert_eq!(suggestions.len(), 4);
        assert_eq!(suggestions[0], "Yes, guard the signup form too");
    }

    /// A model may hand back plain strings instead of objects; the words are
    /// what matter.
    #[test]
    fn a_tool_answer_of_plain_strings_is_still_read() {
        let input = json!({ "replies": ["Run the tests", "Show me the diff"] });
        let (suggestions, via) = read_answer(Some(&input), "");
        assert_eq!(via, "tool");
        assert_eq!(suggestions, vec!["Run the tests", "Show me the diff"]);
    }

    #[test]
    fn a_text_answer_is_read_when_the_tool_was_not_called() {
        let (suggestions, via) = read_answer(None, "1. Run the tests\n2. Show me the diff");
        assert_eq!(via, "text");
        assert_eq!(suggestions.len(), 2);
    }

    /// The cloud model writes in the developer's voice, which runs past the
    /// local model's 12 words. Both of these came back from MiniMax M3 on a
    /// real chat and were dropped by the old limit.
    #[test]
    fn a_reply_in_the_developers_longer_voice_is_kept() {
        let input = json!({ "replies": [
            { "text": "wait the dropdown rule we agreed was pick another streamer opens new empty one right", "intent": "verify" },
            { "text": "hold on didnt we say no console log on compaction i want only file", "intent": "correct" }
        ]});
        let (suggestions, _) = read_answer(Some(&input), "");
        assert_eq!(suggestions.len(), 2);
    }

    #[test]
    fn an_answer_with_nothing_usable_says_so() {
        let (suggestions, via) = read_answer(None, "");
        assert!(suggestions.is_empty());
        assert_eq!(via, "none");
    }

    #[test]
    fn the_tool_asks_for_text_and_an_intent_per_reply() {
        let schema = tool_schema();
        assert_eq!(schema.name, TOOL_NAME);
        assert_eq!(
            schema.input_schema["properties"]["replies"]["items"]["required"],
            json!(["text", "intent"])
        );
    }
}
