//! `TeamBus` — the lateral-communication mechanism (ground truth §7).
//!
//! Everything an agent does to the shared brain's channel flows through
//! the bus so it is **persisted** (appended to `channel/events.jsonl`)
//! **and** **broadcast live** (streamed to peers and the UI) in a single
//! path. No side channels — that single path is what makes the team
//! observable and resumable.
//!
//! The bus is intentionally transport-agnostic: it depends on a
//! [`TeamEventSink`] trait, not on Tauri. Production wires a Tauri
//! emitter (`lib.rs`) that posts the `"team_event"` channel to the
//! frontend; tests pass a recording sink. This mirrors how the Phase 3
//! tool buckets take an `IdeEventSink` rather than reaching for an
//! `AppHandle` directly.

#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::agent_runtime::error::RuntimeError;

use super::types::{ChannelEvent, TeamStreamDelta};
use super::workspace::ProjectWorkspace;

/// Live broadcast target for team-channel events.
///
/// Implementors deliver an already-persisted [`ChannelEvent`] to live
/// listeners (the UI today; peer agents in later phases). Broadcasting
/// must never fail the post — a dropped UI event is cosmetic, while a
/// persisted event is the source of truth — so the method returns `()`.
pub trait TeamEventSink: Send + Sync {
    /// Deliver one channel event for the given project to live listeners.
    fn emit_team_event(&self, project_id: &str, event: &ChannelEvent);

    /// Deliver one ephemeral live token frame (see [`TeamStreamDelta`]) to live
    /// listeners. These are **not** persisted — they carry a model's tokens as
    /// they stream so the Team view renders in real time. Default no-op so
    /// headless/test sinks need not implement it.
    fn emit_team_stream(&self, _project_id: &str, _delta: &TeamStreamDelta) {}
}

/// Persists channel events and broadcasts them live.
///
/// Holds an optional sink so a headless/test build (or the brief window
/// before the frontend is wired) can still persist events with no live
/// broadcast. The bus owns no workspace state — the caller passes the
/// target [`ProjectWorkspace`] per post, keeping the bus a thin,
/// shareable singleton in Tauri managed state.
pub struct TeamBus {
    sink: Option<Arc<dyn TeamEventSink>>,
}

impl TeamBus {
    #[must_use]
    pub fn new(sink: Option<Arc<dyn TeamEventSink>>) -> Self {
        Self { sink }
    }

    /// Bus with no live broadcast — persistence only.
    #[must_use]
    pub fn headless() -> Self {
        Self { sink: None }
    }

    /// Post one event: append it to the workspace channel, then broadcast.
    ///
    /// Persistence happens first and its failure aborts the post (the
    /// event must reach disk to be real). Broadcast is best-effort and
    /// only runs after a durable write. Returns the event so callers can
    /// echo it straight back to the IPC caller.
    pub fn post(
        &self,
        workspace: &ProjectWorkspace,
        event: ChannelEvent,
    ) -> Result<ChannelEvent, RuntimeError> {
        workspace.append_channel_event(&event)?;
        if let Some(sink) = &self.sink {
            sink.emit_team_event(workspace.project_id(), &event);
        }
        Ok(event)
    }

    /// Broadcast one ephemeral live token frame. Never persists and never
    /// fails the caller — a dropped frame is cosmetic (the authoritative
    /// [`ChannelEvent`]/transcript still lands). No-op on a headless bus.
    pub fn stream(&self, project_id: &str, delta: &TeamStreamDelta) {
        if let Some(sink) = &self.sink {
            sink.emit_team_stream(project_id, delta);
        }
    }
}

/// A per-model-call live streamer bound to one agent + phase.
///
/// Forwards a model's token deltas to the `"team_stream"` broadcast as they
/// arrive so the Team view renders them in real time (parity with the normal
/// chat composer). Construct one around the [`TeamBus`] for the duration of a
/// single [`complete_text`]/[`complete_turn`] call; pass `None` to disable
/// streaming. Cheap and `Sync`, so `&TeamStreamer` is safe to hold across the
/// stream/drain `join!` inside a spawned run.
///
/// [`complete_text`]: super::runner::complete_text
/// [`complete_turn`]: super::build_runner
pub struct TeamStreamer<'a> {
    bus: &'a TeamBus,
    project_id: String,
    agent_id: String,
    phase: String,
    run_id: Option<String>,
    seq: AtomicU64,
    /// When set, visible text deltas are forwarded as THINKING frames. Used for
    /// machine-output calls (the Lead's JSON plan): the user sees the Lead
    /// "reasoning" live instead of raw JSON streaming into the group chat as if
    /// it were a message.
    text_as_thinking: bool,
}

impl<'a> TeamStreamer<'a> {
    #[must_use]
    pub fn new(
        bus: &'a TeamBus,
        project_id: impl Into<String>,
        agent_id: impl Into<String>,
        phase: impl Into<String>,
        run_id: Option<String>,
    ) -> Self {
        Self {
            bus,
            project_id: project_id.into(),
            agent_id: agent_id.into(),
            phase: phase.into(),
            run_id,
            seq: AtomicU64::new(0),
            text_as_thinking: false,
        }
    }

    /// Route visible text deltas to the thinking stream (see field docs).
    #[must_use]
    pub fn text_as_thinking(mut self) -> Self {
        self.text_as_thinking = true;
        self
    }

    fn frame(&self, kind: &str, event: &str, delta: &str) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        self.bus.stream(
            &self.project_id,
            &TeamStreamDelta {
                agent_id: self.agent_id.clone(),
                phase: self.phase.clone(),
                kind: kind.to_string(),
                event: event.to_string(),
                delta: delta.to_string(),
                run_id: self.run_id.clone(),
                seq,
            },
        );
    }

    /// Announce the start of a fresh live message for this agent (the UI opens
    /// an empty live bubble).
    pub fn start(&self) {
        self.frame("text", "start", "");
    }

    /// A chunk of visible answer text.
    pub fn text(&self, delta: &str) {
        if !delta.is_empty() {
            let kind = if self.text_as_thinking {
                "thinking"
            } else {
                "text"
            };
            self.frame(kind, "delta", delta);
        }
    }

    /// A chunk of reasoning/thinking.
    pub fn thinking(&self, delta: &str) {
        if !delta.is_empty() {
            self.frame("thinking", "delta", delta);
        }
    }

    /// Announce the live message is complete (the UI settles/clears the draft
    /// once the authoritative content lands).
    pub fn end(&self) {
        self.frame("text", "end", "");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::team::types::ChannelEventKind;
    use crate::agent_runtime::team::workspace::now_rfc3339;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<(String, String)>>, // (project_id, event_id)
    }

    impl TeamEventSink for RecordingSink {
        fn emit_team_event(&self, project_id: &str, event: &ChannelEvent) {
            self.events
                .lock()
                .unwrap()
                .push((project_id.to_string(), event.id.clone()));
        }
    }

    fn ws() -> (tempfile::TempDir, ProjectWorkspace) {
        let dir = tempfile::tempdir().expect("tempdir");
        let ws = ProjectWorkspace::at_root("pid-bus", dir.path().join("pid-bus"));
        ws.ensure_scaffold("/repo", None).unwrap();
        (dir, ws)
    }

    fn event(id: &str) -> ChannelEvent {
        ChannelEvent {
            id: id.into(),
            ts: now_rfc3339(),
            author: "lead".into(),
            kind: ChannelEventKind::System,
            body: "convened".into(),
            meta: None,
        }
    }

    #[test]
    fn post_persists_and_broadcasts() {
        let (_d, ws) = ws();
        let sink = Arc::new(RecordingSink::default());
        let bus = TeamBus::new(Some(sink.clone()));

        bus.post(&ws, event("e1")).unwrap();
        bus.post(&ws, event("e2")).unwrap();

        // Persisted.
        let on_disk = ws.read_channel(None).unwrap();
        assert_eq!(on_disk.len(), 2);
        assert_eq!(on_disk[0].id, "e1");

        // Broadcast.
        let seen = sink.events.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], ("pid-bus".to_string(), "e1".to_string()));
        assert_eq!(seen[1].1, "e2");
    }

    #[test]
    fn headless_bus_persists_without_broadcast() {
        let (_d, ws) = ws();
        let bus = TeamBus::headless();
        let returned = bus.post(&ws, event("solo")).unwrap();
        assert_eq!(returned.id, "solo");
        assert_eq!(ws.read_channel(None).unwrap().len(), 1);
    }
}
