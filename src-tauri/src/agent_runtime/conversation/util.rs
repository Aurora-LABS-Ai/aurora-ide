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
/// The processes this batch's own `shell_read_output` calls read to their
/// end (`running: false`). A `shell_execute` that happened to print the same
/// JSON does not count.
pub(super) fn endings_read_in(
    results: &[ContentBlock],
    read_output_call_ids: &[String],
) -> Vec<String> {
    results
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
        .collect()
}

/// Whether a queued "background process ended / stopped" note repeats an
/// ending the model has already read.
///
/// `shell_read_output` with `wait_ms` blocks until the process ends and then
/// quotes how it ended (`running: false`, `ending: "Stopped by the user …"`).
/// The frontend hears the same ending and queues a note, so without this the
/// model got the fact twice in one tool message (harness run 2026-09-28,
/// thread `5c20f9a3`), or, when the note was queued just after the read
/// returned, once more in the NEXT turn, out of context (2026-10-17, thread
/// `3b6fffb1`). `endings_read` is every ending read in this conversation, not
/// only this batch, which is what closes the second case.
///
/// The note is dropped only when EVERY process it names was read to its end;
/// a note about some other process, or one whose read stopped short, still
/// goes through.
pub(super) fn process_ending_already_read(
    queued: &crate::agent_runtime::session::QueuedUserMessage,
    endings_read: &std::collections::HashSet<String>,
) -> bool {
    if queued.origin != crate::agent_runtime::types::InjectedOrigin::Process {
        return false;
    }
    let mentioned = named_process_ids(&queued.text);
    !mentioned.is_empty() && mentioned.iter().all(|id| endings_read.contains(*id))
}

/// The process ids a note names. Both notes write them as `(id <id>)` or
/// `(id <id>, …)`: `bg-…` for a spawn, `shell_execute:61` for a command the
/// user moved to the background. Matching only `bg-` missed the second kind.
fn named_process_ids(text: &str) -> Vec<&str> {
    text.match_indices("(id ")
        .filter_map(|(at, marker)| {
            let rest = &text[at + marker.len()..];
            let end = rest.find([',', ')', ' ']).unwrap_or(rest.len());
            let id = rest[..end].trim();
            (!id.is_empty()).then_some(id)
        })
        .collect()
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
            subagent_kind: None,
            text: text.into(),
            display_text: None,
            chips: None,
            mid_turn: true,
            origin,
            queued_at_ms: 0,
            agent: None,
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

    const NOTE: &str =
        "The background process \"Short-lived failing job\" (id bg-1894371b-1790624482646) \
                        has ended with exit code 7. Nothing more will arrive from it.";

    /// What one batch adds to the conversation's `endings_read`.
    fn read_in(blocks: &[ContentBlock], call: &str) -> std::collections::HashSet<String> {
        endings_read_in(blocks, &[call.to_string()])
            .into_iter()
            .collect()
    }

    #[test]
    fn a_note_about_a_process_read_to_its_end_is_dropped() {
        let read = read_in(
            &[read_result("call-1", "bg-1894371b-1790624482646", false)],
            "call-1",
        );
        assert!(process_ending_already_read(
            &note(InjectedOrigin::Process, NOTE),
            &read
        ));
    }

    #[test]
    fn a_read_that_stopped_short_of_the_ending_keeps_the_note() {
        let read = read_in(
            &[read_result("call-1", "bg-1894371b-1790624482646", true)],
            "call-1",
        );
        assert!(!process_ending_already_read(
            &note(InjectedOrigin::Process, NOTE),
            &read
        ));
    }

    #[test]
    fn a_note_about_a_different_process_keeps_going() {
        let read = read_in(&[read_result("call-1", "bg-other-1", false)], "call-1");
        assert!(!process_ending_already_read(
            &note(InjectedOrigin::Process, NOTE),
            &read
        ));
    }

    /// Only results from the batch's own `shell_read_output` calls count; a
    /// `shell_execute` that happened to print the same JSON does not.
    #[test]
    fn only_read_output_results_count() {
        let read = read_in(
            &[read_result("call-9", "bg-1894371b-1790624482646", false)],
            "call-1",
        );
        assert!(!process_ending_already_read(
            &note(InjectedOrigin::Process, NOTE),
            &read
        ));
    }

    #[test]
    fn a_persons_message_is_never_dropped() {
        let read = read_in(
            &[read_result("call-1", "bg-1894371b-1790624482646", false)],
            "call-1",
        );
        assert!(!process_ending_already_read(
            &note(InjectedOrigin::User, NOTE),
            &read
        ));
    }

    /// Thread `3b6fffb1`, 2026-10-17: a command the user moved to the
    /// background and then stopped. Its id is `shell_execute:61`, not `bg-…`,
    /// and the model read the stop (wait_ms, `running: false`) 236 ms BEFORE
    /// the note was queued, so the note came out at the first boundary of the
    /// next turn. The set remembers the read across that gap.
    #[test]
    fn a_stop_note_already_read_in_an_earlier_turn_is_dropped() {
        const STOP: &str =
            "The user stopped the background process \"cd packages/quantumkick-core \
                            && printf …\" (id shell_execute:61, `cd packages/quantumkick-core && \
                            printf '20\\n\\n' | pnpm exec tsx scripts/login-probe.ts`). It is no \
                            longer running.";
        // Turn 1: the read, in its own batch. No note queued yet.
        let read = read_in(
            &[read_result(
                "shell_read_output:62",
                "shell_execute:61",
                false,
            )],
            "shell_read_output:62",
        );
        // Turn 2: an unrelated batch drains the late note.
        assert!(process_ending_already_read(
            &note(InjectedOrigin::Process, STOP),
            &read
        ));
    }

    #[test]
    fn named_process_ids_reads_both_note_shapes() {
        assert_eq!(named_process_ids(NOTE), vec!["bg-1894371b-1790624482646"]);
        assert_eq!(
            named_process_ids("process \"x\" (id shell_execute:61, `ls`). Stopped."),
            vec!["shell_execute:61"]
        );
        assert!(named_process_ids("no id here").is_empty());
    }
}
