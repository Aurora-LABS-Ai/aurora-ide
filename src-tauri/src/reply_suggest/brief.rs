//! The conversation brief a cloud reply-suggestion model reads.
//!
//! The local model keeps reading one exchange (`prompt_refine`). A cloud model
//! gets this instead: everything that predicts the developer's next message,
//! and nothing that does not.
//!
//! - **Every developer message, in their words.** Their habits and the thread
//!   of what they want are the strongest signal there is.
//! - **The last turn in full:** every text the assistant wrote in it (not only
//!   the final message, which can be a bare "Done."), and one line per tool
//!   call it made, with failures marked.
//! - **Earlier turns, short:** the last paragraph of what the assistant said,
//!   which is where its questions and offers sit, and how many calls it made.
//! - **The compaction summary**, standing in for turns the chat no longer holds.
//!
//! Tool RESULTS never go in: they are the bulk of a conversation and say almost
//! nothing about what the developer will type next.
//!
//! The brief is written oldest first and an earlier turn renders the same way
//! every time, so successive briefs for one conversation share their whole
//! start. Providers with a prompt cache read that part at the cache rate. When
//! the budget runs out, old turns are dropped in large chunks rather than one
//! at a time, so the shared start breaks rarely.

use crate::agent_runtime::session::MID_TURN_PREAMBLE;
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};

/// About 24k tokens at the ~3.7 characters per token of mixed prose and code.
/// Leaves room in a 30k context for the instruction and the answer.
pub const BRIEF_BUDGET_CHARS: usize = 90_000;
/// One developer message. Their messages are short; a pasted log is not, and
/// its head says what it is.
const USER_MESSAGE_CHARS: usize = 2_000;
/// Everything the assistant wrote in the last turn. The END is kept: that is
/// where the summary and the "want me to…?" are.
const LAST_REPLY_CHARS: usize = 12_000;
/// What an earlier turn keeps of the assistant: its last paragraph.
const EARLIER_REPLY_CHARS: usize = 600;
/// Tool lines listed for the last turn.
const LAST_TURN_TOOL_LINES: usize = 40;
/// One tool line's target (a path, a pattern, a command).
const TOOL_TARGET_CHARS: usize = 140;

/// One developer message and what followed it, up to the next one.
#[derive(Debug, Default)]
struct Turn {
    /// The developer's words: the message that opened the turn, plus any they
    /// sent mid-turn, in order.
    developer: Vec<String>,
    /// Every visible text the assistant wrote in this turn, in order.
    replies: Vec<String>,
    /// One line per tool call.
    tools: Vec<String>,
    failed_tools: usize,
}

/// What [`build`] produced, with the counts the log records.
#[derive(Debug)]
pub struct Brief {
    pub text: String,
    pub turns_total: usize,
    pub turns_included: usize,
    pub compacted: bool,
}

/// Build the brief for `messages`, appending `open_tasks` and `past_outcomes`
/// (already rendered, possibly empty) after the conversation so the
/// conversation itself stays a stable prefix.
#[cfg(test)]
#[must_use]
pub fn build(messages: &[ConversationMessage], open_tasks: &str, past_outcomes: &str) -> Brief {
    build_for(messages, open_tasks, past_outcomes, "Developer")
}

/// [`build`], naming the person `who`: "Developer" in a project conversation,
/// "User" in Aurora Chat, where nobody is necessarily writing code.
#[must_use]
pub fn build_for(
    messages: &[ConversationMessage],
    open_tasks: &str,
    past_outcomes: &str,
    who: &str,
) -> Brief {
    // Only what comes after the last compaction is still the conversation;
    // the summary stands in for the rest.
    let (summary, tail) = match messages.iter().rposition(is_compaction) {
        Some(at) => (compaction_summary(&messages[at]), &messages[at + 1..]),
        None => (None, messages),
    };
    let turns = split_turns(tail);
    let turns_total = turns.len();

    let rendered: Vec<String> = turns
        .iter()
        .enumerate()
        .map(|(i, turn)| render_turn(i + 1, turn, i + 1 == turns.len(), who))
        .collect();

    // Drop old turns, a quarter of what is left at a time, until it fits. The
    // last turn is always kept.
    let fixed = summary.as_deref().map_or(0, str::len) + open_tasks.len() + past_outcomes.len();
    let mut start = 0;
    while start + 1 < rendered.len()
        && fixed + rendered[start..].iter().map(String::len).sum::<usize>() > BRIEF_BUDGET_CHARS
    {
        let remaining = rendered.len() - 1 - start;
        start += (remaining / 4).max(1);
    }

    let mut text = String::new();
    if let Some(summary) = &summary {
        text.push_str("<earlier_work_summary>\n");
        text.push_str(summary.trim());
        text.push_str("\n</earlier_work_summary>\n\n");
    }
    text.push_str("<conversation>\n");
    if start > 0 {
        text.push_str(&format!("[{start} earlier turns left out for length]\n\n"));
    }
    for turn in &rendered[start..] {
        text.push_str(turn);
        text.push('\n');
    }
    text.push_str("</conversation>\n");
    if !open_tasks.trim().is_empty() {
        text.push_str("\n<open_tasks>\n");
        text.push_str(open_tasks.trim());
        text.push_str("\n</open_tasks>\n");
    }
    if !past_outcomes.trim().is_empty() {
        text.push_str("\n<past_suggestions>\n");
        text.push_str(past_outcomes.trim());
        text.push_str("\n</past_suggestions>\n");
    }

    Brief {
        text,
        turns_total,
        turns_included: rendered.len() - start,
        compacted: summary.is_some(),
    }
}

fn is_compaction(message: &ConversationMessage) -> bool {
    message
        .blocks
        .iter()
        .any(|b| matches!(b, ContentBlock::Compaction { .. }))
}

fn compaction_summary(message: &ConversationMessage) -> Option<String> {
    message.blocks.iter().find_map(|b| match b {
        ContentBlock::Compaction { summary, .. } => Some(summary.clone()),
        _ => None,
    })
}

/// Group messages into turns, each opened by a developer message. Anything
/// before the first developer message (a compaction's leftovers) opens a turn
/// with no developer words.
fn split_turns(messages: &[ConversationMessage]) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    for message in messages {
        match message.role {
            MessageRole::User => {
                let words = joined_text(message);
                if words.trim().is_empty() {
                    continue;
                }
                turns.push(Turn {
                    developer: vec![words],
                    ..Turn::default()
                });
            }
            MessageRole::Assistant => {
                if turns.is_empty() {
                    turns.push(Turn::default());
                }
                let turn = turns.last_mut().expect("a turn was just ensured");
                for block in &message.blocks {
                    match block {
                        ContentBlock::Text { text } if !text.trim().is_empty() => {
                            turn.replies.push(text.trim().to_string());
                        }
                        ContentBlock::ToolUse { name, input, .. } => {
                            turn.tools.push(tool_line(name, input));
                        }
                        _ => {}
                    }
                }
            }
            MessageRole::Tool => {
                let Some(turn) = turns.last_mut() else { continue };
                for block in &message.blocks {
                    match block {
                        ContentBlock::ToolResult {
                            is_error: Some(true),
                            ..
                        } => turn.failed_tools += 1,
                        // A message the developer sent while tools were
                        // running rides on the tool message, behind a framing
                        // line meant for the model.
                        ContentBlock::Text { text } => {
                            if let Some(rest) = text.trim_start().strip_prefix(MID_TURN_PREAMBLE) {
                                if !rest.trim().is_empty() {
                                    turn.developer.push(rest.trim().to_string());
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            MessageRole::System => {}
        }
    }
    turns
}

fn joined_text(message: &ConversationMessage) -> String {
    message
        .blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.trim()),
            _ => None,
        })
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `file_read internal/daemon/daemon.go` — the tool and the one argument that
/// says what it touched. Arguments are the model's to shape, so this looks for
/// the usual fields and otherwise names the tool alone.
fn tool_line(name: &str, input: &serde_json::Value) -> String {
    const TARGET_FIELDS: [&str; 9] = [
        "path", "file_path", "paths", "pattern", "query", "command", "name", "url", "subject",
    ];
    let target = TARGET_FIELDS.iter().find_map(|field| match input.get(field)? {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        serde_json::Value::Array(items) => {
            let parts: Vec<&str> = items.iter().filter_map(serde_json::Value::as_str).collect();
            (!parts.is_empty()).then(|| parts.join(", "))
        }
        _ => None,
    });
    match target {
        Some(target) => format!("{name} {}", head(&single_line(&target), TOOL_TARGET_CHARS)),
        None => name.to_string(),
    }
}

fn render_turn(number: usize, turn: &Turn, last: bool, who: &str) -> String {
    let mut out = format!("## Turn {number}\n");
    if turn.developer.is_empty() {
        out.push_str(&format!("{who}: (continuing earlier work)\n"));
    }
    for words in &turn.developer {
        out.push_str(who);
        out.push_str(": ");
        out.push_str(&head(words, USER_MESSAGE_CHARS));
        out.push('\n');
    }

    let calls = turn.tools.len();
    if last {
        if calls > 0 {
            out.push_str(&format!(
                "Assistant's actions ({calls} tool calls{}):\n",
                failed_note(turn.failed_tools)
            ));
            let skipped = calls.saturating_sub(LAST_TURN_TOOL_LINES);
            if skipped > 0 {
                out.push_str(&format!("- … {skipped} earlier calls\n"));
            }
            for line in &turn.tools[skipped..] {
                out.push_str("- ");
                out.push_str(line);
                out.push('\n');
            }
        }
        let reply = turn.replies.join("\n\n");
        out.push_str("Assistant's reply (latest):\n");
        if reply.is_empty() {
            out.push_str("(no text)");
        } else {
            out.push_str(&tail(&reply, LAST_REPLY_CHARS));
        }
        out.push('\n');
    } else {
        if calls > 0 {
            out.push_str(&format!(
                "Assistant used {calls} tool calls{}.\n",
                failed_note(turn.failed_tools)
            ));
        }
        if let Some(reply) = turn.replies.last() {
            out.push_str("Assistant ended with: ");
            out.push_str(&tail(last_paragraph(reply), EARLIER_REPLY_CHARS));
            out.push('\n');
        }
    }
    out
}

fn failed_note(failed: usize) -> String {
    if failed == 0 {
        String::new()
    } else {
        format!(", {failed} failed")
    }
}

fn last_paragraph(text: &str) -> &str {
    text.trim()
        .rsplit("\n\n")
        .find(|p| !p.trim().is_empty())
        .unwrap_or("")
        .trim()
}

fn single_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The first `max` characters, marked when cut.
fn head(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{cut} […]")
}

/// The last `max` characters, marked when cut.
fn tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let cut: String = text.chars().skip(count - max).collect();
    format!("[…] {cut}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(text: &str) -> ConversationMessage {
        ConversationMessage::user_text(text, 0)
    }

    fn assistant(blocks: Vec<ContentBlock>) -> ConversationMessage {
        ConversationMessage::assistant(blocks, 0)
    }

    fn with_role(role: MessageRole, blocks: Vec<ContentBlock>) -> ConversationMessage {
        ConversationMessage {
            role,
            blocks,
            ..ConversationMessage::user_text("", 0)
        }
    }

    fn tool(blocks: Vec<ContentBlock>) -> ConversationMessage {
        with_role(MessageRole::Tool, blocks)
    }

    fn text(t: &str) -> ContentBlock {
        ContentBlock::Text { text: t.into() }
    }

    fn call(id: &str, name: &str, input: serde_json::Value) -> ContentBlock {
        ContentBlock::ToolUse {
            id: id.into(),
            name: name.into(),
            input,
        }
    }

    fn result(id: &str, error: bool) -> ContentBlock {
        ContentBlock::ToolResult {
            tool_use_id: id.into(),
            content: "SECRET FILE CONTENTS".into(),
            is_error: error.then_some(true),
        }
    }

    fn conversation() -> Vec<ConversationMessage> {
        vec![
            user("fix the login crash"),
            assistant(vec![
                text("Looking at the validator."),
                call("a", "file_read", json!({ "path": "src/login.ts" })),
            ]),
            tool(vec![result("a", false)]),
            assistant(vec![text(
                "Fixed it.\n\nWant me to guard the signup form as well?",
            )]),
            user("yes do signup too"),
            assistant(vec![
                text("Guarding signup now."),
                call("b", "file_edit", json!({ "path": "src/signup.ts" })),
                call("c", "shell_execute", json!({ "command": "pnpm test" })),
            ]),
            tool(vec![result("b", false), result("c", true)]),
            assistant(vec![text("Done.")]),
        ]
    }

    #[test]
    fn every_developer_message_is_kept_in_their_words() {
        let brief = build(&conversation(), "", "");
        assert!(brief.text.contains("Developer: fix the login crash"));
        assert!(brief.text.contains("Developer: yes do signup too"));
        assert_eq!(brief.turns_total, 2);
    }

    /// The final message of a turn can be a bare "Done." — the brief carries
    /// every text of the last turn, so the summary written earlier survives.
    #[test]
    fn the_last_turn_keeps_every_reply_text_and_its_tool_lines() {
        let brief = build(&conversation(), "", "");
        assert!(brief.text.contains("Guarding signup now.\n\nDone."));
        assert!(brief.text.contains("- file_edit src/signup.ts"));
        assert!(brief.text.contains("- shell_execute pnpm test"));
        assert!(brief.text.contains("(2 tool calls, 1 failed)"));
    }

    #[test]
    fn an_earlier_turn_keeps_only_its_last_paragraph() {
        let brief = build(&conversation(), "", "");
        assert!(brief
            .text
            .contains("Assistant ended with: Want me to guard the signup form as well?"));
        assert!(!brief.text.contains("Looking at the validator."));
    }

    #[test]
    fn tool_results_never_reach_the_brief() {
        let brief = build(&conversation(), "", "");
        assert!(!brief.text.contains("SECRET FILE CONTENTS"));
    }

    #[test]
    fn a_message_sent_mid_turn_counts_as_the_developers() {
        let mut messages = conversation();
        messages.push(tool(vec![text(&format!(
            "{MID_TURN_PREAMBLE}\nstop, use vitest not jest"
        ))]));
        let brief = build(&messages, "", "");
        assert!(brief.text.contains("Developer: stop, use vitest not jest"));
    }

    #[test]
    fn a_compacted_chat_reads_the_summary_instead_of_the_dropped_turns() {
        let mut messages = vec![user("old request that was compacted away")];
        messages.push(with_role(
            MessageRole::System,
            vec![ContentBlock::Compaction {
                summary: "Built the login fix.".into(),
                before_tokens: 1,
                after_tokens: 1,
                created_at: 0,
            }],
        ));
        messages.extend(conversation());
        let brief = build(&messages, "", "");
        assert!(brief.compacted);
        assert!(brief.text.contains("Built the login fix."));
        assert!(!brief.text.contains("old request that was compacted away"));
    }

    /// Successive briefs for one conversation must share their start, or a
    /// provider's prompt cache never reads any of it.
    #[test]
    fn a_new_turn_leaves_every_turn_before_the_previous_one_unchanged() {
        let first = build(&conversation(), "", "");
        let mut longer = conversation();
        longer.push(user("now run the full suite"));
        longer.push(assistant(vec![text("All green.")]));
        let second = build(&longer, "", "");
        let turn_two_start = first.text.find("## Turn 2").unwrap();
        assert_eq!(first.text[..turn_two_start], second.text[..turn_two_start]);
    }

    #[test]
    fn old_turns_are_dropped_to_fit_and_the_last_turn_is_kept() {
        let mut messages = Vec::new();
        for i in 0..400 {
            messages.push(user(&format!("request {i} {}", "x".repeat(400))));
            messages.push(assistant(vec![text(&"y".repeat(400))]));
        }
        messages.push(user("the final request"));
        messages.push(assistant(vec![text("final answer")]));
        let brief = build(&messages, "", "");
        assert!(brief.text.len() <= BRIEF_BUDGET_CHARS + 2_000);
        assert!(brief.text.contains("Developer: the final request"));
        assert!(brief.text.contains("earlier turns left out for length"));
        assert!(brief.turns_included < brief.turns_total);
    }

    /// Aurora Chat is not a coding session; the brief must not call the
    /// person a developer there.
    #[test]
    fn an_aurora_chat_brief_names_the_person_a_user() {
        let brief = build_for(&conversation(), "", "", "User");
        assert!(brief.text.contains("User: fix the login crash"));
        assert!(!brief.text.contains("Developer:"));
    }

    #[test]
    fn open_tasks_and_past_suggestions_come_after_the_conversation() {
        let brief = build(&conversation(), "- [ ] Add a signup test", "Suggested: … Sent: …");
        let conversation_end = brief.text.find("</conversation>").unwrap();
        assert!(brief.text.find("<open_tasks>").unwrap() > conversation_end);
        assert!(brief.text.find("<past_suggestions>").unwrap() > conversation_end);
    }
}
