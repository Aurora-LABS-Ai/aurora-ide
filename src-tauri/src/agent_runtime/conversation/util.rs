//! Agent runtime — Small shared helpers with no home of their own.
//!
//! Split out of `conversation.rs` verbatim; see `mod.rs` for the map.

use super::*;

pub(super) fn collect_tool_calls(message: &ConversationMessage) -> Vec<PendingToolCall> {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, name, input } => Some(PendingToolCall {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            }),
            _ => None,
        })
        .collect()
}

pub(super) async fn emit_native_tool_event(
    event_sink: &mpsc::Sender<AgentEventEnvelope>,
    turn_id: &str,
    seq: &mut u64,
    event: AssistantEvent,
) {
    let envelope = AgentEventEnvelope {
        turn_id: turn_id.to_string(),
        seq: *seq,
        event,
    };
    *seq = (*seq).saturating_add(1);
    let _ = event_sink.send(envelope).await;
}

/// Same, from a counter several concurrent tasks can draw from.
///
/// A `&mut u64` cannot be shared by the futures in a concurrent tool batch,
/// and those futures must be able to announce their own completion the
/// moment it happens — see `tool_exec::execute_tool_calls`. Numbers stay
/// contiguous; which call gets which depends on completion order, which is
/// the point.
pub(super) async fn emit_native_tool_event_shared(
    event_sink: &mpsc::Sender<AgentEventEnvelope>,
    turn_id: &str,
    seq: &AtomicU64,
    event: AssistantEvent,
) {
    let envelope = AgentEventEnvelope {
        turn_id: turn_id.to_string(),
        seq: seq.fetch_add(1, AtomicOrdering::Relaxed),
        event,
    };
    let _ = event_sink.send(envelope).await;
}

pub(super) fn sum_usage(a: TokenUsage, b: TokenUsage) -> TokenUsage {
    TokenUsage {
        input_tokens: a.input_tokens.saturating_add(b.input_tokens),
        output_tokens: a.output_tokens.saturating_add(b.output_tokens),
        cache_creation_input_tokens: sum_opt(
            a.cache_creation_input_tokens,
            b.cache_creation_input_tokens,
        ),
        cache_read_input_tokens: sum_opt(a.cache_read_input_tokens, b.cache_read_input_tokens),
        // Sticky across the turn: if ANY request in it was an estimate, the
        // turn's totals are approximate and must not read as measured.
        estimated: match (a.estimated, b.estimated) {
            (Some(true), _) | (_, Some(true)) => Some(true),
            _ => None,
        },
        // Money adds. `None + None` stays `None` so "the provider never priced
        // this" is distinguishable from "the provider priced it at zero" — the
        // first must fall back to catalog rates, the second must not.
        cost_usd: match (a.cost_usd, b.cost_usd) {
            (Some(x), Some(y)) => Some(x + y),
            (Some(x), None) | (None, Some(x)) => Some(x),
            (None, None) => None,
        },
    }
}

pub(super) fn sum_opt(a: Option<u32>, b: Option<u32>) -> Option<u32> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.saturating_add(y)),
        (Some(x), None) | (None, Some(x)) => Some(x),
        (None, None) => None,
    }
}

pub(super) fn generate_turn_id() -> String {
    // ULID would sort better, but we don't carry that crate yet —
    // UUIDv4 is good enough for Phase 2.1 since `seq` already gives
    // intra-turn ordering.
    Uuid::new_v4().to_string()
}

/// Spawn a task that drains `api_rx` into `event_sink`, wrapping
/// each [`AssistantEvent`] in an [`AgentEventEnvelope`] with a
/// monotonic sequence number drawn from `seq`.
///
/// The counter is shared rather than owned because a bidirectional provider
/// runs its tools **while this forwarder is still streaming** (see
/// [`crate::agent_runtime::tool_bridge`]). Two independent counters starting
/// from the same number would hand the same `seq` to a text delta and to a
/// tool card, and the frontend orders on it — the reply would render
/// interleaved with itself. One counter, drawn from by both, keeps a single
/// order over everything the turn emits.
///
/// The returned handle resolves once `api_rx` closes; read `seq` afterwards
/// for the next number.
/// Whether a queued "background process ended" note repeats an ending the
/// model has already read in THIS batch.
///
/// `shell_read_output` with `wait_ms` blocks until the process ends and then
/// quotes how it ended (`running: false`, `ending: "Exited with code 7 …"`).
/// The frontend watcher hears the same ending on `shell-process-ended` and
/// queues a note for the running turn, so the model got the fact twice in one
/// tool message (harness run 2026-09-28, thread `5c20f9a3`). The note is
/// dropped only when EVERY process it names was read to its end by one of the
/// batch's own `shell_read_output` results; a note about some other process,
/// or one whose read stopped short of the ending, still goes through.
pub(super) fn process_ending_already_read(
    queued: &crate::agent_runtime::session::QueuedUserMessage,
    results: &[ContentBlock],
    read_output_call_ids: &[String],
) -> bool {
    if queued.origin != crate::agent_runtime::types::InjectedOrigin::Process {
        return false;
    }
    let read_to_the_end: Vec<String> = results
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                ..
            } if read_output_call_ids.contains(tool_use_id) => {
                serde_json::from_str::<serde_json::Value>(content).ok()
            }
            _ => None,
        })
        .filter(|result| result.get("running") == Some(&serde_json::Value::Bool(false)))
        .filter_map(|result| {
            result
                .get("processId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .collect();
    if read_to_the_end.is_empty() {
        return false;
    }
    // The note names the process by id in prose: `(id bg-…)`.
    let mentioned: Vec<&str> = queued
        .text
        .split_whitespace()
        .filter(|word| word.starts_with("bg-"))
        .map(|word| word.trim_end_matches([')', '.', ',', ';', ':']))
        .collect();
    !mentioned.is_empty()
        && mentioned
            .iter()
            .all(|id| read_to_the_end.iter().any(|read| read == id))
}

pub(super) fn spawn_event_forwarder(
    turn_id: String,
    seq: Arc<AtomicU64>,
    mut api_rx: mpsc::Receiver<AssistantEvent>,
    event_sink: mpsc::Sender<AgentEventEnvelope>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(event) = api_rx.recv().await {
            let envelope = AgentEventEnvelope {
                turn_id: turn_id.clone(),
                seq: seq.fetch_add(1, AtomicOrdering::Relaxed),
                event,
            };
            if event_sink.send(envelope).await.is_err() {
                // Caller dropped the receiver — stop forwarding.
                break;
            }
        }
    })
}

#[cfg(test)]
mod process_ending_tests {
    use super::*;
    use crate::agent_runtime::session::QueuedUserMessage;
    use crate::agent_runtime::types::InjectedOrigin;

    fn note(origin: InjectedOrigin, text: &str) -> QueuedUserMessage {
        QueuedUserMessage {
            text: text.into(),
            display_text: None,
            chips: None,
            mid_turn: true,
            origin,
            queued_at_ms: 0,
        }
    }

    fn read_result(call_id: &str, process_id: &str, running: bool) -> ContentBlock {
        ContentBlock::ToolResult {
            tool_use_id: call_id.into(),
            content: format!(
                r#"{{"success":true,"processId":"{process_id}","running":{running},"output":"tick"}}"#
            ),
            is_error: None,
        }
    }

    const NOTE: &str = "The background process \"Short-lived failing job\" (id bg-1894371b-1790624482646) \
                        has ended with exit code 7. Nothing more will arrive from it.";

    #[test]
    fn a_note_about_a_process_read_to_its_end_this_batch_is_dropped() {
        let blocks = vec![read_result("call-1", "bg-1894371b-1790624482646", false)];
        assert!(process_ending_already_read(
            &note(InjectedOrigin::Process, NOTE),
            &blocks,
            &["call-1".to_string()],
        ));
    }

    #[test]
    fn a_read_that_stopped_short_of_the_ending_keeps_the_note() {
        let blocks = vec![read_result("call-1", "bg-1894371b-1790624482646", true)];
        assert!(!process_ending_already_read(
            &note(InjectedOrigin::Process, NOTE),
            &blocks,
            &["call-1".to_string()],
        ));
    }

    #[test]
    fn a_note_about_a_different_process_keeps_going() {
        let blocks = vec![read_result("call-1", "bg-other-1", false)];
        assert!(!process_ending_already_read(
            &note(InjectedOrigin::Process, NOTE),
            &blocks,
            &["call-1".to_string()],
        ));
    }

    /// Only results from the batch's own `shell_read_output` calls count; a
    /// `shell_execute` that happened to print the same JSON does not.
    #[test]
    fn only_read_output_results_count() {
        let blocks = vec![read_result("call-9", "bg-1894371b-1790624482646", false)];
        assert!(!process_ending_already_read(
            &note(InjectedOrigin::Process, NOTE),
            &blocks,
            &["call-1".to_string()],
        ));
    }

    #[test]
    fn a_persons_message_is_never_dropped() {
        let blocks = vec![read_result("call-1", "bg-1894371b-1790624482646", false)];
        assert!(!process_ending_already_read(
            &note(InjectedOrigin::User, NOTE),
            &blocks,
            &["call-1".to_string()],
        ));
    }
}
