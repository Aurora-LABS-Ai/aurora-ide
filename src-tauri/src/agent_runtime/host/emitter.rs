//! The production [`EventEmitter`]: a turn's events, sent through the host's
//! [`EventSink`].
//!
//! The desktop app passes its `AppHandle` (the windows get the events); a host
//! with no window passes whatever forwards events to its own clients. Event
//! names and payloads are the same for both, so a client listens for the same
//! channels either way.

use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use super::{EventEmitter, ThreadChanged, THREAD_CHANGED_EVENT};
use crate::agent_runtime::bridge::ToolBridgeRequest;
use crate::agent_runtime::event_batch::{Coalescer, FLUSH_INTERVAL};
use crate::agent_runtime::events::TurnCompletion;
use crate::agent_runtime::ipc::AgentEventEnvelope;
use crate::agent_runtime::recovery::RecoveryHint;
use crate::host_events::{EventSink, Events};

/// Constructed fresh per turn; cloning the sink is cheap.
pub struct HostEmitter {
    events: Events,
}

impl HostEmitter {
    pub fn new(events: Events) -> Self {
        Self { events }
    }

    fn send<T: serde::Serialize>(&self, event: &str, payload: T) -> Result<(), String> {
        <dyn EventSink>::emit(self.events.as_ref(), event, payload)
    }
}

impl EventEmitter for HostEmitter {
    fn emit_event(&self, envelope: &AgentEventEnvelope) {
        // A turn dispatched from `aurora agent` is also being watched in a
        // terminal, so the same events are appended to its transcript. Guarded
        // by `is_active` because this runs per streamed token and the common
        // case — no CLI task anywhere — must cost one atomic check, not a hash
        // lookup. See `cli_delegate::mirror`. Fed the raw event, before
        // batching: the transcript is a record, not a frame rate.
        if crate::cli_delegate::mirror::is_active() {
            crate::cli_delegate::mirror::record(&envelope.turn_id, &envelope.event);
        }

        // Token deltas are held and merged per turn, then released at most
        // every `FLUSH_INTERVAL` (`agent_runtime::event_batch`): one webview
        // evaluation per frame per streaming turn, not one per token. Emitted
        // under the lock so a timer's release and a push's release of the
        // same turn cannot cross.
        let arm_timer = {
            let Ok(mut coalescer) = EVENT_BATCH.lock() else {
                emit_agent_event(&self.events, envelope);
                return;
            };
            let pushed = coalescer.push(envelope, Instant::now());
            for ready in &pushed.emit {
                emit_agent_event(&self.events, ready);
            }
            pushed.arm_timer
        };
        if arm_timer {
            let events = self.events.clone();
            let turn_id = envelope.turn_id.clone();
            crate::rt::spawn(async move {
                tokio::time::sleep(FLUSH_INTERVAL).await;
                flush_agent_events(&events, &turn_id);
            });
        }
    }

    fn emit_thread_changed(&self, change: &ThreadChanged) {
        let _ = self.send(THREAD_CHANGED_EVENT, change);
    }

    fn emit_turn_complete(&self, turn_id: &str, summary: &TurnCompletion) {
        flush_agent_events(&self.events, turn_id);
        let _ = self.send("agent_turn_complete", summary);
        // Closes the transcript with its `result` line. A follower in a
        // terminal stops on that line and nothing else, so a turn that ended
        // without reaching here would leave `aurora agent --follow` waiting on
        // a file that never grows again.
        crate::cli_delegate::mirror::finish(
            turn_id,
            crate::cli_delegate::mirror::Outcome::Complete(summary),
        );
    }

    fn emit_turn_error(&self, turn_id: &str, error: &str, recovery_hint: Option<RecoveryHint>) {
        // The frontend `TurnErrorPayload` accepts both `turnId` and
        // `turn_id`; camelCase matches the rest of the IPC surface.
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ErrorPayload<'a> {
            turn_id: &'a str,
            error: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            recovery_hint: Option<RecoveryHint>,
        }
        flush_agent_events(&self.events, turn_id);
        let _ = self.send(
            "agent_turn_error",
            ErrorPayload {
                turn_id,
                error,
                recovery_hint,
            },
        );
        // The other way a turn can end. Cancellation arrives here too, as the
        // literal "cancelled"; the transcript tells the two apart, because a
        // task the user stopped did not fail.
        crate::cli_delegate::mirror::finish(
            turn_id,
            crate::cli_delegate::mirror::Outcome::Failed(error),
        );
    }

    fn emit_tool_pending(&self, request: &ToolBridgeRequest) {
        // Wire-channel: `"agent_tool_pending"`. The payload is the camelCased
        // ToolBridgeRequest verbatim (turnId, toolUseId, name, input).
        let _ = self.send("agent_tool_pending", request);
    }

    fn emit_subagent(&self, event: &crate::agent_runtime::subagents::SubagentEvent) {
        use crate::agent_runtime::subagents::SubagentEvent;
        // A handful per task, so each one is worth a log line: when the window
        // shows a stale agent list this is the half of the story Rust can tell.
        let (kind, agent_id) = match event {
            SubagentEvent::Started { agent_id, .. } => ("started", agent_id.as_str()),
            SubagentEvent::Finished { agent_id, .. } => ("finished", agent_id.as_str()),
            SubagentEvent::Message { agent_id, .. } => ("message", agent_id.as_str()),
            SubagentEvent::Report { agent_id, .. } => ("report", agent_id.as_str()),
        };
        self.events.emit_value(
            crate::agent_runtime::subagents::events::SUBAGENT_EVENT_CHANNEL,
            stamp_emitted_at(event),
        );
        crate::logging::log_info("subagents.events", &format!("emitted {kind} for {agent_id}"));
    }
}

/// A lifecycle event with `emittedAtMs` beside its own fields, so the window
/// can measure how long the event channel took to deliver it. On 2026-10-08
/// four `report` events were emitted on time and processed 58 s later; the
/// two log lines (`emitted …` here, `received … lag N ms` in the window) are
/// what showed it, and the stamp makes the lag a number instead of a diff of
/// two timestamps by hand.
fn stamp_emitted_at(event: &crate::agent_runtime::subagents::SubagentEvent) -> serde_json::Value {
    let mut value = serde_json::to_value(event).unwrap_or(serde_json::Value::Null);
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "emittedAtMs".to_string(),
            serde_json::Value::from(chrono::Utc::now().timestamp_millis()),
        );
    }
    value
}

/// The held token runs of every streaming turn. One for the process: the
/// emitter is built fresh per turn, and a child's emitter wraps its
/// parent's, so the state cannot live on either.
static EVENT_BATCH: LazyLock<Mutex<Coalescer>> = LazyLock::new(|| Mutex::new(Coalescer::new()));

/// One `agent_event` across the wire, counted.
///
/// Channel name is hardcoded — the frontend hardcodes the matching literal,
/// and we deliberately don't share a `const` so the contract is explicit at
/// both ends.
fn emit_agent_event(events: &Events, envelope: &AgentEventEnvelope) {
    let _ = <dyn EventSink>::emit(events.as_ref(), "agent_event", envelope);
    note_agent_event_rate();
}

/// Release what the turn is holding. The timer's call, and the turn's
/// ending's: a turn must not end with a token still held.
fn flush_agent_events(events: &Events, turn_id: &str) {
    let Ok(mut coalescer) = EVENT_BATCH.lock() else {
        return;
    };
    if let Some(ready) = coalescer.flush(turn_id) {
        emit_agent_event(events, &ready);
    }
}

/// Streamed `agent_event`s per second over which a log line is written.
///
/// Every emit is one main-thread script evaluation in the webview. Before
/// token deltas were batched (2026-10-09), every token of every running turn
/// was one emit: four sub-agents streaming at once held 400/s for two
/// minutes, peaking at 1,234/s, the window drew at a few frames per second,
/// and lifecycle events were delivered 34 s late. Batched, a streaming turn
/// is at most 25/s, so the line now marks a regression, not the weather.
const AGENT_EVENT_RATE_WARN_PER_SEC: u32 = 250;

/// `(second, count)` for the second currently being counted.
static AGENT_EVENT_RATE: Mutex<(i64, u32)> = Mutex::new((0, 0));

fn note_agent_event_rate() {
    let now = chrono::Utc::now().timestamp();
    let Ok(mut window) = AGENT_EVENT_RATE.lock() else {
        return;
    };
    if window.0 == now {
        window.1 += 1;
        return;
    }
    let (second, count) = *window;
    *window = (now, 1);
    if second != 0 && count > AGENT_EVENT_RATE_WARN_PER_SEC {
        crate::logging::log_warn(
            "agent_runtime.events",
            &format!("agent_event rate {count}/s: lifecycle events may be delivered late"),
        );
    }
}
