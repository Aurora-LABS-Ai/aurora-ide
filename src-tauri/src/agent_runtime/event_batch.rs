//! Batching of streamed `agent_event`s before they cross into the window.
//!
//! Every token the model streams is one [`AssistantEvent`], and every event
//! handed to the window is one script evaluation on the webview's main
//! thread, followed by one store write and one React render. One
//! conversation streaming alone is cheap. Four sub-agents streaming at once
//! are not: on 2026-10-08 the runtime emitted 400 events per second for two
//! minutes, peaking at 1,234/s, and the window drew at a few frames per
//! second while the lifecycle events that wake a parent waited 34 s in the
//! same queue.
//!
//! The [`Coalescer`] keeps, per turn, the run of consecutive events that
//! can be merged (text deltas, thinking deltas, a tool call's growing
//! arguments) and releases them as ONE event once [`FLUSH_INTERVAL`] has
//! passed, or at once when an event arrives that cannot be merged. The wire
//! shape does not change: a merged `text_delta` is a longer delta, a merged
//! `thinking` is a longer thought carrying the block's signature, and a
//! merged `tool_use_delta` is the latest full argument buffer, which is what
//! every `tool_use_delta` already carries. Order is kept: nothing is
//! released out of the order it arrived in.
//!
//! The merge rules are pure and tested here. The clock and the emit are the
//! Tauri emitter's (`commands::agent_v2::tauri_layer`).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::events::AssistantEvent;
use super::ipc::AgentEventEnvelope;

/// How long a mergeable run is held before it is released. 40 ms is 25
/// events per second per streaming turn: text still appears as it is typed,
/// and five turns at once cost the window what one turn cost before.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(40);

/// The held run of one turn.
struct Pending {
    /// `seq` of the LAST event merged in. The window does not read `seq`;
    /// the gaps a merge leaves are expected.
    seq: u64,
    event: AssistantEvent,
    /// When the run started. Age is measured from here, not from the last
    /// merge, so a run cannot be held forever by a steady stream.
    since: Instant,
}

/// What [`Coalescer::push`] asks the caller to do.
#[derive(Debug, Default)]
pub struct Pushed {
    /// Envelopes to emit now, in order.
    pub emit: Vec<AgentEventEnvelope>,
    /// A run was just opened for this turn: arm a timer that calls
    /// [`Coalescer::flush`] for it after [`FLUSH_INTERVAL`].
    pub arm_timer: bool,
}

#[derive(Default)]
pub struct Coalescer {
    pending: HashMap<String, Pending>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take one streamed envelope in. Returns what must be emitted now.
    pub fn push(&mut self, envelope: &AgentEventEnvelope, now: Instant) -> Pushed {
        let mut out = Pushed::default();
        if !is_mergeable(&envelope.event) {
            if let Some(held) = self.pending.remove(&envelope.turn_id) {
                out.emit.push(release(&envelope.turn_id, held));
            }
            out.emit.push(envelope.clone());
            return out;
        }

        if let Some(held) = self.pending.get_mut(&envelope.turn_id) {
            if merge(&mut held.event, &envelope.event) {
                held.seq = envelope.seq;
                if now.duration_since(held.since) >= FLUSH_INTERVAL {
                    let held = self.pending.remove(&envelope.turn_id).expect("held");
                    out.emit.push(release(&envelope.turn_id, held));
                }
                return out;
            }
            // A run that cannot take this event: release it, start another.
            let held = self.pending.remove(&envelope.turn_id).expect("held");
            out.emit.push(release(&envelope.turn_id, held));
        }

        self.pending.insert(
            envelope.turn_id.clone(),
            Pending {
                seq: envelope.seq,
                event: envelope.event.clone(),
                since: now,
            },
        );
        out.arm_timer = true;
        out
    }

    /// Release the turn's held run, if any. The timer's call.
    pub fn flush(&mut self, turn_id: &str) -> Option<AgentEventEnvelope> {
        self.pending
            .remove(turn_id)
            .map(|held| release(turn_id, held))
    }

    #[cfg(test)]
    fn is_holding(&self, turn_id: &str) -> bool {
        self.pending.contains_key(turn_id)
    }
}

fn release(turn_id: &str, held: Pending) -> AgentEventEnvelope {
    AgentEventEnvelope {
        turn_id: turn_id.to_string(),
        seq: held.seq,
        event: held.event,
    }
}

/// The events a run is made of. Everything else is a boundary.
fn is_mergeable(event: &AssistantEvent) -> bool {
    matches!(
        event,
        AssistantEvent::TextDelta { .. }
            | AssistantEvent::Thinking { .. }
            | AssistantEvent::ToolUseDelta { .. }
    )
}

/// Fold `next` into `held`. `false` means they are different runs and the
/// held one must be released first.
fn merge(held: &mut AssistantEvent, next: &AssistantEvent) -> bool {
    match (held, next) {
        (AssistantEvent::TextDelta { delta }, AssistantEvent::TextDelta { delta: more }) => {
            delta.push_str(more);
            true
        }
        // A thinking block streams its text and then, at its end, one event
        // with empty text and the block's signature. The signature closes the
        // run: the next thinking event is another block.
        (
            AssistantEvent::Thinking { text, signature },
            AssistantEvent::Thinking {
                text: more,
                signature: next_signature,
            },
        ) => {
            if signature.is_some() {
                return false;
            }
            text.push_str(more);
            *signature = next_signature.clone();
            true
        }
        // The payload is the whole argument buffer so far: the newest one
        // is the only one worth sending.
        (
            AssistantEvent::ToolUseDelta { id, arguments, .. },
            AssistantEvent::ToolUseDelta {
                id: next_id,
                arguments: next_arguments,
                ..
            },
        ) => {
            if id != next_id {
                return false;
            }
            *arguments = next_arguments.clone();
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::types::TokenUsage;

    fn env(turn: &str, seq: u64, event: AssistantEvent) -> AgentEventEnvelope {
        AgentEventEnvelope {
            turn_id: turn.into(),
            seq,
            event,
        }
    }

    fn text(delta: &str) -> AssistantEvent {
        AssistantEvent::TextDelta {
            delta: delta.into(),
        }
    }

    fn thinking(text: &str, signature: Option<&str>) -> AssistantEvent {
        AssistantEvent::Thinking {
            text: text.into(),
            signature: signature.map(String::from),
        }
    }

    fn args(id: &str, arguments: &str) -> AssistantEvent {
        AssistantEvent::ToolUseDelta {
            id: id.into(),
            name: "file_write".into(),
            arguments: arguments.into(),
        }
    }

    #[test]
    fn consecutive_text_deltas_are_held_and_released_as_one() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        let first = c.push(&env("t", 0, text("Hel")), t0);
        assert!(first.emit.is_empty());
        assert!(first.arm_timer);
        let second = c.push(&env("t", 1, text("lo ")), t0 + Duration::from_millis(10));
        assert!(second.emit.is_empty());
        assert!(!second.arm_timer, "one timer per run");
        let third = c.push(&env("t", 2, text("world")), t0 + Duration::from_millis(20));
        assert!(third.emit.is_empty());

        let released = c.flush("t").expect("held run");
        assert_eq!(released.turn_id, "t");
        assert_eq!(released.seq, 2, "the last merged seq");
        match released.event {
            AssistantEvent::TextDelta { delta } => assert_eq!(delta, "Hello world"),
            other => panic!("expected text, got {other:?}"),
        }
        assert!(c.flush("t").is_none(), "released once");
    }

    #[test]
    fn a_run_older_than_the_interval_is_released_on_the_next_push() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        c.push(&env("t", 0, text("a")), t0);
        let pushed = c.push(&env("t", 1, text("b")), t0 + FLUSH_INTERVAL);
        assert_eq!(pushed.emit.len(), 1);
        match &pushed.emit[0].event {
            AssistantEvent::TextDelta { delta } => assert_eq!(delta, "ab"),
            other => panic!("expected text, got {other:?}"),
        }
        assert!(!c.is_holding("t"));
    }

    #[test]
    fn a_boundary_event_releases_the_run_first_and_keeps_order() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        c.push(&env("t", 0, text("done.")), t0);
        let pushed = c.push(
            &env(
                "t",
                1,
                AssistantEvent::MessageStop {
                    stop_reason: "end_turn".into(),
                },
            ),
            t0 + Duration::from_millis(1),
        );
        assert_eq!(pushed.emit.len(), 2);
        assert!(matches!(pushed.emit[0].event, AssistantEvent::TextDelta { .. }));
        assert!(matches!(pushed.emit[1].event, AssistantEvent::MessageStop { .. }));
        assert!(!pushed.arm_timer);
        assert!(!c.is_holding("t"));
    }

    #[test]
    fn thinking_takes_its_signature_and_the_next_block_starts_a_new_run() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        c.push(&env("t", 0, thinking("I should ", None)), t0);
        c.push(&env("t", 1, thinking("check.", None)), t0);
        let closed = c.push(&env("t", 2, thinking("", Some("sig-1"))), t0);
        assert!(closed.emit.is_empty(), "the signature joins the held run");
        let next_block = c.push(&env("t", 3, thinking("Then ", None)), t0);
        assert_eq!(next_block.emit.len(), 1, "a signed run is closed");
        match &next_block.emit[0].event {
            AssistantEvent::Thinking { text, signature } => {
                assert_eq!(text, "I should check.");
                assert_eq!(signature.as_deref(), Some("sig-1"));
            }
            other => panic!("expected thinking, got {other:?}"),
        }
        assert!(next_block.arm_timer);
        assert!(c.is_holding("t"));
    }

    #[test]
    fn tool_arguments_keep_the_latest_buffer_and_split_on_a_new_call() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        c.push(&env("t", 0, args("call-1", "{\"pa")), t0);
        c.push(&env("t", 1, args("call-1", "{\"path\": \"a.rs\"")), t0);
        let split = c.push(&env("t", 2, args("call-2", "{")), t0);
        assert_eq!(split.emit.len(), 1);
        match &split.emit[0].event {
            AssistantEvent::ToolUseDelta { id, arguments, .. } => {
                assert_eq!(id, "call-1");
                assert_eq!(arguments, "{\"path\": \"a.rs\"");
            }
            other => panic!("expected tool arguments, got {other:?}"),
        }
    }

    #[test]
    fn different_kinds_of_delta_do_not_merge() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        c.push(&env("t", 0, thinking("hm", None)), t0);
        let pushed = c.push(&env("t", 1, text("Answer")), t0);
        assert_eq!(pushed.emit.len(), 1);
        assert!(matches!(pushed.emit[0].event, AssistantEvent::Thinking { .. }));
        assert!(c.is_holding("t"));
    }

    #[test]
    fn turns_are_held_apart() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        c.push(&env("parent", 0, text("p")), t0);
        c.push(&env("child", 0, text("c")), t0);
        let pushed = c.push(
            &env("child", 1, AssistantEvent::Usage(TokenUsage::default())),
            t0,
        );
        assert_eq!(pushed.emit.len(), 2);
        assert_eq!(pushed.emit[0].turn_id, "child");
        assert!(c.is_holding("parent"), "the parent's run is untouched");
    }
}
