//! The tool-call pairing invariant, and the repair that enforces it.
//!
//! Every provider requires that a `tool_use` block is answered by a
//! `tool_result` carrying the same id, and that no `tool_result` appears
//! without the `tool_use` it answers. Anthropic rejects a violation with
//! `messages.N: tool_use ids were found without tool_result blocks`; the OpenAI
//! family rejects it with `An assistant message with 'tool_calls' must be
//! followed by tool messages responding to each 'tool_call_id'`. Either way the
//! turn dies with an HTTP 400 **before a token is generated**, and — this is the
//! part that hurt — it keeps dying, because the malformed history is on disk.
//! Every later prompt in that thread rebuilds the same broken request.
//!
//! ## How history gets broken
//!
//! The reproducer is ordinary use: the model emits tool calls, the user hits
//! Stop before the results come back, then types a new prompt. The assistant
//! message (with its `tool_use` blocks) was already appended to the session;
//! cancellation returns early, so no `tool_result` ever follows it; and the turn
//! epilogue persists the session on the error path too. The thread is now
//! permanently malformed.
//!
//! Cancellation is just the easiest way in. A process kill between the assistant
//! message and the tool batch, a panic inside a tool executor, or a session file
//! written by an older build all leave the same shape.
//!
//! ## Two layers
//!
//! 1. **At the source** — the runtime synthesizes a real `tool_result` for every
//!    call it decided not to run (see `conversation.rs`), so the session is
//!    written correct and the user sees why each card stopped.
//! 2. **At request-build time** — [`repair_tool_pairing`] runs over the final
//!    message view and fixes anything still unpaired. This is what makes the
//!    failure class impossible rather than merely unlikely: it repairs threads
//!    that were already broken on disk, and any future path that forgets rule 1.
//!
//! The repair is **API-view only**, exactly like `inject_ide_context` and
//! `trim_to_budget`: the persisted JSONL is never rewritten, so the UI keeps
//! rendering what actually happened.

use super::types::{ContentBlock, ConversationMessage, MessageRole};

/// Result text for a call the user stopped before it was dispatched.
pub const STOPPED_BEFORE_RUN: &str =
    "Stopped by the user before this tool ran. Nothing was executed.";

/// Result text for a call that was in flight when the user stopped the turn.
pub const STOPPED_MID_RUN: &str =
    "Stopped by the user while this tool was running. Any work it had already \
     done was not recorded.";

/// Result text for a call that was never executed because the assistant message
/// carrying it was cut off by the output-token cap. Its arguments may be
/// silently incomplete, so running it is not safe.
pub const TRUNCATED_CALL: &str =
    "Not executed: the reply hit the model's output limit, so this tool call's \
     arguments may be incomplete. Nothing was executed. Re-issue the call with \
     complete arguments.";

/// Result text used by the request-build repair, where the reason a result is
/// missing is no longer knowable.
const UNRECORDED: &str = "No result was recorded for this tool call — the turn ended before it \
     completed. Nothing was executed.";

/// Outcome of [`repair_tool_pairing`].
#[derive(Debug)]
pub struct PairingRepair {
    /// The repaired message view.
    pub messages: Vec<ConversationMessage>,
    /// How many `tool_result` blocks had to be invented.
    pub synthesized: usize,
    /// How many orphaned `tool_result` blocks were dropped.
    pub dropped: usize,
}

impl PairingRepair {
    /// True when the input violated the invariant.
    pub fn changed(&self) -> bool {
        self.synthesized > 0 || self.dropped > 0
    }
}

/// Ids of every `tool_use` block in a message, in order.
pub fn tool_use_ids(message: &ConversationMessage) -> Vec<String> {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, .. } => Some(id.clone()),
            _ => None,
        })
        .collect()
}

/// Build the `Tool` message that answers `ids`, every result carrying `text` and
/// flagged as an error so the model treats it as a failure rather than output.
pub fn synthetic_tool_results(ids: &[String], text: &str) -> ConversationMessage {
    ConversationMessage {
        event_id: None,
        role: MessageRole::Tool,
        blocks: ids
            .iter()
            .map(|id| ContentBlock::ToolResult {
                tool_use_id: id.clone(),
                content: text.to_string(),
                is_error: Some(true),
            })
            .collect(),
        usage: None,
        timestamp: chrono::Utc::now().timestamp_millis(),
        attached_selected_elements: None,
        attached_prompt_chips: None,
        aurora_context: None,
        model: None,
    }
}

/// Enforce the pairing invariant over a whole message view.
///
/// - A `tool_use` with no matching `tool_result` **anywhere later** gets a
///   synthetic error result, inserted immediately after its assistant message.
/// - A `tool_result` with no matching `tool_use` **anywhere earlier** is
///   dropped; a message left with no blocks at all is dropped with it.
///
/// A well-formed conversation round-trips unchanged, so this is safe to run on
/// every request.
pub fn repair_tool_pairing(messages: Vec<ConversationMessage>) -> PairingRepair {
    use std::collections::HashMap;

    // Index scan. Position matters: a result must come *after* the call it
    // answers, so plain id-set membership is not enough — a result that
    // precedes its call is as invalid as one with no call at all.
    let mut first_use: HashMap<&str, usize> = HashMap::new();
    let mut last_result: HashMap<&str, usize> = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        for block in &message.blocks {
            match block {
                ContentBlock::ToolUse { id, .. } => {
                    first_use.entry(id.as_str()).or_insert(index);
                }
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    last_result.insert(tool_use_id.as_str(), index);
                }
                _ => {}
            }
        }
    }

    // Plan the repair while the borrows are alive, then apply it after they are
    // dropped (the apply pass consumes `messages`).
    let mut unanswered_at: HashMap<usize, Vec<String>> = HashMap::new();
    let mut orphans_at: HashMap<usize, Vec<String>> = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        for block in &message.blocks {
            match block {
                ContentBlock::ToolUse { id, .. } => {
                    if last_result
                        .get(id.as_str())
                        .is_none_or(|&answer| answer <= index)
                    {
                        unanswered_at.entry(index).or_default().push(id.clone());
                    }
                }
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    if first_use
                        .get(tool_use_id.as_str())
                        .is_none_or(|&call| call >= index)
                    {
                        orphans_at
                            .entry(index)
                            .or_default()
                            .push(tool_use_id.clone());
                    }
                }
                _ => {}
            }
        }
    }

    // The overwhelmingly common case: every call answered, every answer earned.
    // Bail before allocating a new vector.
    if unanswered_at.is_empty() && orphans_at.is_empty() {
        return PairingRepair {
            messages,
            synthesized: 0,
            dropped: 0,
        };
    }

    let mut out: Vec<ConversationMessage> = Vec::with_capacity(messages.len() + 1);
    let mut synthesized = 0usize;
    let mut dropped = 0usize;

    for (index, mut message) in messages.into_iter().enumerate() {
        if let Some(orphans) = orphans_at.get(&index) {
            let before = message.blocks.len();
            message.blocks.retain(|block| match block {
                ContentBlock::ToolResult { tool_use_id, .. } => !orphans.contains(tool_use_id),
                _ => true,
            });
            dropped += before - message.blocks.len();
            // A Tool message that was nothing but orphaned results carries no
            // meaning, and sending an empty content array is itself a 400 on
            // several providers. Drop it — but only when it is empty, so a
            // mid-turn user injection riding on the same message survives.
            if message.blocks.is_empty() {
                continue;
            }
        }

        out.push(message);

        if let Some(unanswered) = unanswered_at.get(&index) {
            synthesized += unanswered.len();
            out.push(synthetic_tool_results(unanswered, UNRECORDED));
        }
    }

    PairingRepair {
        messages: out,
        synthesized,
        dropped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(role: MessageRole, body: &str) -> ConversationMessage {
        ConversationMessage {
            event_id: None,
            role,
            blocks: vec![ContentBlock::Text {
                text: body.to_string(),
            }],
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        }
    }

    fn assistant_calling(ids: &[&str]) -> ConversationMessage {
        ConversationMessage {
            event_id: None,
            role: MessageRole::Assistant,
            blocks: ids
                .iter()
                .map(|id| ContentBlock::ToolUse {
                    id: (*id).to_string(),
                    name: "file_read".to_string(),
                    input: serde_json::json!({ "path": "a.rs" }),
                })
                .collect(),
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        }
    }

    fn results_for(ids: &[&str]) -> ConversationMessage {
        ConversationMessage {
            event_id: None,
            role: MessageRole::Tool,
            blocks: ids
                .iter()
                .map(|id| ContentBlock::ToolResult {
                    tool_use_id: (*id).to_string(),
                    content: "ok".to_string(),
                    is_error: None,
                })
                .collect(),
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        }
    }

    fn result_ids(message: &ConversationMessage) -> Vec<String> {
        message
            .blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_well_formed_conversation_is_untouched() {
        let messages = vec![
            text(MessageRole::User, "read it"),
            assistant_calling(&["call_1", "call_2"]),
            results_for(&["call_1", "call_2"]),
            text(MessageRole::Assistant, "done"),
        ];
        let repaired = repair_tool_pairing(messages.clone());
        assert!(!repaired.changed());
        assert_eq!(repaired.messages.len(), messages.len());
    }

    /// The reported bug: Stop pressed after the tool calls streamed in but
    /// before any result came back, then a new prompt. Without repair the
    /// provider 400s on this shape forever.
    #[test]
    fn a_cancelled_turn_leaves_no_unanswered_tool_call() {
        let messages = vec![
            text(MessageRole::User, "read it"),
            assistant_calling(&["call_1", "call_2"]),
            // <- user hit Stop here; no Tool message was ever appended
            text(MessageRole::User, "actually, do this instead"),
        ];
        let repaired = repair_tool_pairing(messages);
        assert_eq!(repaired.synthesized, 2);
        assert_eq!(repaired.dropped, 0);

        // The synthetic results sit directly after the assistant message.
        assert!(matches!(repaired.messages[2].role, MessageRole::Tool));
        assert_eq!(result_ids(&repaired.messages[2]), ["call_1", "call_2"]);
        // …and the user's new prompt still follows.
        assert!(matches!(repaired.messages[3].role, MessageRole::User));
    }

    #[test]
    fn a_partially_answered_batch_only_gains_the_missing_results() {
        let messages = vec![
            assistant_calling(&["call_1", "call_2", "call_3"]),
            results_for(&["call_1", "call_3"]),
        ];
        let repaired = repair_tool_pairing(messages);
        assert_eq!(repaired.synthesized, 1);
        assert_eq!(result_ids(&repaired.messages[1]), ["call_2"]);
        // Real results keep their position after the synthetic ones.
        assert_eq!(result_ids(&repaired.messages[2]), ["call_1", "call_3"]);
    }

    /// Compaction or a head trim can cut between the call and its answer,
    /// stranding the result. Providers reject that just as hard.
    #[test]
    fn an_orphaned_tool_result_is_dropped() {
        let messages = vec![
            // the assistant message that requested `call_1` was cut away
            results_for(&["call_1"]),
            text(MessageRole::Assistant, "here you go"),
        ];
        let repaired = repair_tool_pairing(messages);
        assert_eq!(repaired.dropped, 1);
        assert_eq!(repaired.synthesized, 0);
        // The now-empty Tool message went with it.
        assert_eq!(repaired.messages.len(), 1);
        assert!(matches!(repaired.messages[0].role, MessageRole::Assistant));
    }

    #[test]
    fn a_tool_message_keeps_its_other_blocks_when_one_result_is_orphaned() {
        let mut message = results_for(&["call_1"]);
        // Mid-turn user injection rides on the Tool message as a Text block.
        message.blocks.push(ContentBlock::Text {
            text: "wait, stop".to_string(),
        });
        let repaired = repair_tool_pairing(vec![message]);
        assert_eq!(repaired.dropped, 1);
        assert_eq!(repaired.messages.len(), 1);
        assert_eq!(repaired.messages[0].blocks.len(), 1);
        assert!(matches!(
            repaired.messages[0].blocks[0],
            ContentBlock::Text { .. }
        ));
    }

    /// A result that arrives BEFORE its call is as invalid as one with no call:
    /// id-set membership alone would call this pair well-formed.
    #[test]
    fn a_result_preceding_its_call_is_treated_as_an_orphan() {
        let messages = vec![results_for(&["call_1"]), assistant_calling(&["call_1"])];
        let repaired = repair_tool_pairing(messages);
        assert_eq!(repaired.dropped, 1, "the early result is dropped");
        assert_eq!(repaired.synthesized, 1, "the call still needs an answer");
        // Left with the call followed by its synthetic result, in that order.
        assert_eq!(repaired.messages.len(), 2);
        assert!(matches!(repaired.messages[0].role, MessageRole::Assistant));
        assert_eq!(result_ids(&repaired.messages[1]), ["call_1"]);
    }

    #[test]
    fn synthetic_results_are_flagged_as_errors() {
        let message = synthetic_tool_results(&["call_1".to_string()], STOPPED_BEFORE_RUN);
        match &message.blocks[0] {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id, "call_1");
                assert_eq!(content, STOPPED_BEFORE_RUN);
                assert_eq!(*is_error, Some(true));
            }
            other => panic!("expected a tool result, got {other:?}"),
        }
    }
}
