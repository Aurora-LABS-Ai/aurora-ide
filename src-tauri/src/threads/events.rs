//! Thread Event Schema
//!
//! Aurora persists every conversation as an append-only stream of typed events
//! (one JSONL line per event). This module defines the canonical schema —
//! everything else (writer, reader, projector, context engine) operates on
//! these events.
#![allow(dead_code)]
//
// Several constructors and accessors below (e.g. typed `user_message` /
// `parent_id` / `turn_id` helpers) are part of the module's public API and
// will be consumed by upcoming command refactors. Suppress dead-code warnings
// at the file level rather than annotating every helper individually.
//!
//! Design rules:
//! - Every event is self-describing: `type` discriminator + `id` + `thread_id`
//!   + `timestamp` (RFC3339 UTC millisecond precision).
//! - Every event except [`ThreadEvent::Session`] carries `parent_id`, which
//!   chains the event to the previous logical predecessor (last event in the
//!   thread for round-level events, the assistant message for tool results,
//!   etc.). The chain lets readers verify ordering and detect tampering.
//! - Mutations (title rename, model change, summary attach) are emitted as
//!   *new* events instead of rewriting prior events. The projector folds the
//!   stream and applies "latest wins" semantics for those mutable fields.
//! - The schema is forward-tolerant: unknown event types are deserialized into
//!   [`ThreadEvent::Unknown`] so an older client can still load a thread
//!   written by a newer build (it just ignores the events it doesn't know).
//!
//! When you add a new event variant: bump [`SCHEMA_VERSION`], extend
//! [`ThreadEvent`], teach the projector how to fold it, and add a regression
//! test in `tests/`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::db::{ContextUsage, TokenUsage};

/// Schema version emitted in every [`ThreadEvent::Session`].
///
/// Bump on any breaking change to the on-disk JSON shape. Backwards-compatible
/// additions (new optional fields, new event variants) do **not** require a
/// bump because [`ThreadEvent::Unknown`] absorbs unknown variants and serde's
/// `default` attribute absorbs missing fields.
pub const SCHEMA_VERSION: u32 = 1;

// ============================================================================
// EVENT ENUM
// ============================================================================

/// One persisted conversation event.
///
/// Serialized as a JSON object with a `"type"` discriminator that matches the
/// snake-case form of the variant name (e.g. `"user_message"`,
/// `"tool_result"`). Variant fields are inlined onto the object — no nested
/// `"data"` envelope — which keeps each line short and grep-friendly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ThreadEvent {
    /// First event in every thread file. Identifies the thread and pins the
    /// schema version the file was written with.
    Session {
        id: String,
        thread_id: String,
        timestamp: String,
        title: Option<String>,
        schema_version: u32,
    },

    /// Title was changed. Latest wins on projection. Cheap append, no rewrites.
    TitleChanged {
        id: String,
        parent_id: String,
        thread_id: String,
        timestamp: String,
        title: String,
    },

    /// Provider/model swapped mid-conversation. Captured so we can replay the
    /// exact context window the model saw at any point in history.
    ModelChange {
        id: String,
        parent_id: String,
        thread_id: String,
        timestamp: String,
        provider_id: String,
        model: String,
        context_window: u32,
        max_output: u32,
    },

    /// Thinking toggle changed mid-conversation.
    ThinkingLevelChange {
        id: String,
        parent_id: String,
        thread_id: String,
        timestamp: String,
        thinking_enabled: bool,
    },

    /// User submitted a message. Starts a new logical turn whose `turn_id`
    /// equals this event's `id`.
    UserMessage {
        id: String,
        parent_id: String,
        thread_id: String,
        timestamp: String,
        content: String,
        /// IDE context (open files, active selection, etc.) attached to *this*
        /// user message. Persisted so the LLM sees the same workspace state on
        /// replay even if the workspace has since changed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ide_context: Option<String>,
        /// Optional file/resource attachments; opaque JSON for forward
        /// compatibility.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attachments: Option<Vec<Value>>,
    },

    /// One round of assistant output. Carries embedded `tool_calls` if the
    /// model wants to invoke tools — there is no separate "tool call" event,
    /// because the model emits the calls atomically as part of the message.
    AssistantMessage {
        id: String,
        parent_id: String,
        thread_id: String,
        turn_id: String,
        timestamp: String,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thinking: Option<String>,
        /// Empty when the model returned a pure text response.
        #[serde(default)]
        tool_calls: Vec<EventToolCall>,
    },

    /// Result of executing one tool call from the most recent
    /// [`ThreadEvent::AssistantMessage`].
    ToolResult {
        id: String,
        /// `id` of the assistant message that requested the call.
        parent_id: String,
        thread_id: String,
        turn_id: String,
        timestamp: String,
        tool_call_id: String,
        tool_name: String,
        content: String,
        is_error: bool,
        #[serde(default)]
        truncated: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        original_length: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },

    /// Recorded when the user pressed Stop (or a higher-level cancel fired).
    ///
    /// Lists which tool calls already finished and which ones never ran. The
    /// projector uses this to synthesize error tool results for the unfinished
    /// calls so the LLM API contract (every `tool_calls` entry must have a
    /// matching `tool` message) is satisfied on the next request.
    Cancelled {
        id: String,
        parent_id: String,
        thread_id: String,
        turn_id: String,
        timestamp: String,
        completed_tool_call_ids: Vec<String>,
        cancelled_tool_call_ids: Vec<String>,
        reason: CancelReason,
    },

    /// Closes a turn (success, cancellation, or unrecoverable error). The
    /// projector treats this as the boundary that moves a turn from "current"
    /// to "history" and recomputes context usage.
    TurnFinalized {
        id: String,
        parent_id: String,
        thread_id: String,
        turn_id: String,
        timestamp: String,
        outcome: TurnOutcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token_usage: Option<TokenUsage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context_usage: Option<ContextUsage>,
    },

    /// LLM-generated summary attached to a finalized turn (for compaction
    /// when the conversation grows past the summarization threshold).
    TurnSummary {
        id: String,
        parent_id: String,
        thread_id: String,
        turn_id: String,
        timestamp: String,
        summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        original_token_count: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary_token_count: Option<u32>,
    },

    /// Catch-all for events written by a newer build. The reader keeps these
    /// around verbatim so we don't lose data on a downgrade — the projector
    /// simply ignores them.
    #[serde(other)]
    Unknown,
}

// ============================================================================
// EVENT FIELD TYPES
// ============================================================================

/// Tool call as embedded inside [`ThreadEvent::AssistantMessage`].
///
/// We keep this struct dedicated to the on-disk shape (rather than reusing
/// [`crate::context::types::ToolCall`]) so we can evolve persistence and the
/// in-memory projection independently.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON-string arguments as the model emitted them. Kept as a string
    /// (not parsed JSON) so we round-trip exactly what the model said.
    pub arguments: String,
}

/// Outcome recorded on [`ThreadEvent::TurnFinalized`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome {
    Completed,
    Cancelled,
    Error,
}

/// Why a turn was cancelled. Stored on [`ThreadEvent::Cancelled`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    /// User pressed the Stop button.
    UserStop,
    /// Provider returned an error (network, auth, etc.).
    ProviderError,
    /// Tool execution timed out.
    ToolTimeout,
    /// Catch-all for unexpected errors during the turn.
    InternalError,
}

// ============================================================================
// CONSTRUCTORS / METADATA HELPERS
// ============================================================================

impl ThreadEvent {
    /// Build a fresh [`ThreadEvent::Session`] for a brand new thread.
    pub fn session(thread_id: impl Into<String>, title: Option<String>) -> Self {
        Self::Session {
            id: new_event_id(),
            thread_id: thread_id.into(),
            timestamp: now_rfc3339_ms(),
            title,
            schema_version: SCHEMA_VERSION,
        }
    }

    /// Generate a new event id chained to the given parent.
    pub fn user_message(
        thread_id: impl Into<String>,
        parent_id: impl Into<String>,
        content: impl Into<String>,
        ide_context: Option<String>,
        attachments: Option<Vec<Value>>,
    ) -> Self {
        Self::UserMessage {
            id: new_event_id(),
            parent_id: parent_id.into(),
            thread_id: thread_id.into(),
            timestamp: now_rfc3339_ms(),
            content: content.into(),
            ide_context,
            attachments,
        }
    }

    /// `id` of this event, regardless of variant.
    pub fn id(&self) -> &str {
        match self {
            Self::Session { id, .. }
            | Self::TitleChanged { id, .. }
            | Self::ModelChange { id, .. }
            | Self::ThinkingLevelChange { id, .. }
            | Self::UserMessage { id, .. }
            | Self::AssistantMessage { id, .. }
            | Self::ToolResult { id, .. }
            | Self::Cancelled { id, .. }
            | Self::TurnFinalized { id, .. }
            | Self::TurnSummary { id, .. } => id,
            Self::Unknown => "",
        }
    }

    /// `parent_id` of this event, or `None` for [`ThreadEvent::Session`] /
    /// [`ThreadEvent::Unknown`].
    pub fn parent_id(&self) -> Option<&str> {
        match self {
            Self::Session { .. } | Self::Unknown => None,
            Self::TitleChanged { parent_id, .. }
            | Self::ModelChange { parent_id, .. }
            | Self::ThinkingLevelChange { parent_id, .. }
            | Self::UserMessage { parent_id, .. }
            | Self::AssistantMessage { parent_id, .. }
            | Self::ToolResult { parent_id, .. }
            | Self::Cancelled { parent_id, .. }
            | Self::TurnFinalized { parent_id, .. }
            | Self::TurnSummary { parent_id, .. } => Some(parent_id),
        }
    }

    /// `thread_id` this event belongs to.
    pub fn thread_id(&self) -> Option<&str> {
        match self {
            Self::Session { thread_id, .. }
            | Self::TitleChanged { thread_id, .. }
            | Self::ModelChange { thread_id, .. }
            | Self::ThinkingLevelChange { thread_id, .. }
            | Self::UserMessage { thread_id, .. }
            | Self::AssistantMessage { thread_id, .. }
            | Self::ToolResult { thread_id, .. }
            | Self::Cancelled { thread_id, .. }
            | Self::TurnFinalized { thread_id, .. }
            | Self::TurnSummary { thread_id, .. } => Some(thread_id),
            Self::Unknown => None,
        }
    }

    /// RFC3339 timestamp (UTC, ms) for this event, if known.
    pub fn timestamp(&self) -> Option<&str> {
        match self {
            Self::Session { timestamp, .. }
            | Self::TitleChanged { timestamp, .. }
            | Self::ModelChange { timestamp, .. }
            | Self::ThinkingLevelChange { timestamp, .. }
            | Self::UserMessage { timestamp, .. }
            | Self::AssistantMessage { timestamp, .. }
            | Self::ToolResult { timestamp, .. }
            | Self::Cancelled { timestamp, .. }
            | Self::TurnFinalized { timestamp, .. }
            | Self::TurnSummary { timestamp, .. } => Some(timestamp),
            Self::Unknown => None,
        }
    }

    /// `turn_id` this event participates in, when applicable. The user message
    /// itself is the start of a turn so its `id` *is* the `turn_id`.
    pub fn turn_id(&self) -> Option<&str> {
        match self {
            Self::UserMessage { id, .. } => Some(id),
            Self::AssistantMessage { turn_id, .. }
            | Self::ToolResult { turn_id, .. }
            | Self::Cancelled { turn_id, .. }
            | Self::TurnFinalized { turn_id, .. }
            | Self::TurnSummary { turn_id, .. } => Some(turn_id),
            _ => None,
        }
    }
}

// ============================================================================
// ID + TIMESTAMP HELPERS
// ============================================================================

/// Generate a new opaque event id (UUIDv4, 36-char hyphenated).
///
/// Centralized so every call site uses the same format and so tests can be
/// rewritten if we ever swap to KSUID/ULID for sortable ids.
pub fn new_event_id() -> String {
    Uuid::new_v4().to_string()
}

/// Now, formatted as `YYYY-MM-DDTHH:MM:SS.sssZ` — RFC3339 in UTC with
/// millisecond precision. Millisecond resolution is enough to order events
/// from a single client, and the file-position order is the real source of
/// truth anyway.
pub fn now_rfc3339_ms() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip a Session event through serde and confirm shape stability.
    #[test]
    fn session_event_roundtrips() {
        let ev = ThreadEvent::session("thread-abc", Some("My chat".into()));
        let json = serde_json::to_string(&ev).expect("serialize");

        // Spot-check we emit the snake_case discriminator and snake_case fields.
        assert!(json.contains("\"type\":\"session\""), "json was: {json}");
        assert!(json.contains("\"thread_id\":\"thread-abc\""));
        assert!(json.contains("\"schema_version\":1"));

        let back: ThreadEvent = serde_json::from_str(&json).expect("deserialize");
        match back {
            ThreadEvent::Session {
                thread_id,
                title,
                schema_version,
                ..
            } => {
                assert_eq!(thread_id, "thread-abc");
                assert_eq!(title.as_deref(), Some("My chat"));
                assert_eq!(schema_version, SCHEMA_VERSION);
            }
            _ => panic!("expected Session"),
        }
    }

    /// User message + assistant response + tool result round-trip cleanly.
    #[test]
    fn turn_chain_roundtrips() {
        let user = ThreadEvent::user_message(
            "t1",
            "session-id",
            "do the thing",
            Some("ide ctx".into()),
            None,
        );
        let user_id = user.id().to_string();

        let asst = ThreadEvent::AssistantMessage {
            id: new_event_id(),
            parent_id: user_id.clone(),
            thread_id: "t1".into(),
            turn_id: user_id.clone(),
            timestamp: now_rfc3339_ms(),
            content: "ok".into(),
            thinking: None,
            tool_calls: vec![EventToolCall {
                id: "call-1".into(),
                name: "file_read".into(),
                arguments: "{\"path\":\"/x\"}".into(),
            }],
        };
        let asst_id = asst.id().to_string();

        let result = ThreadEvent::ToolResult {
            id: new_event_id(),
            parent_id: asst_id.clone(),
            thread_id: "t1".into(),
            turn_id: user_id.clone(),
            timestamp: now_rfc3339_ms(),
            tool_call_id: "call-1".into(),
            tool_name: "file_read".into(),
            content: "contents".into(),
            is_error: false,
            truncated: false,
            original_length: None,
            duration_ms: Some(12),
        };

        for ev in [&user, &asst, &result] {
            let json = serde_json::to_string(ev).expect("serialize");
            let back: ThreadEvent = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back.id(), ev.id());
            assert_eq!(back.thread_id(), ev.thread_id());
        }

        // Parent chain intact.
        assert_eq!(asst.parent_id(), Some(user_id.as_str()));
        assert_eq!(result.parent_id(), Some(asst_id.as_str()));
        assert_eq!(result.turn_id(), Some(user_id.as_str()));
    }

    /// Unknown event types deserialize to `Unknown` instead of erroring.
    #[test]
    fn unknown_event_type_does_not_break_reader() {
        let raw = r#"{"type":"some_future_event","id":"x","thread_id":"t","timestamp":"2026-05-03T00:00:00.000Z"}"#;
        let ev: ThreadEvent = serde_json::from_str(raw).expect("deserialize");
        assert!(matches!(ev, ThreadEvent::Unknown));
    }

    /// A Cancelled event records both completed and cancelled tool ids.
    #[test]
    fn cancelled_event_carries_partial_progress() {
        let ev = ThreadEvent::Cancelled {
            id: new_event_id(),
            parent_id: "asst-1".into(),
            thread_id: "t".into(),
            turn_id: "turn-1".into(),
            timestamp: now_rfc3339_ms(),
            completed_tool_call_ids: vec!["call-1".into(), "call-2".into()],
            cancelled_tool_call_ids: vec!["call-3".into()],
            reason: CancelReason::UserStop,
        };
        let json = serde_json::to_string(&ev).expect("serialize");
        let back: ThreadEvent = serde_json::from_str(&json).expect("deserialize");
        match back {
            ThreadEvent::Cancelled {
                completed_tool_call_ids,
                cancelled_tool_call_ids,
                reason,
                ..
            } => {
                assert_eq!(completed_tool_call_ids.len(), 2);
                assert_eq!(cancelled_tool_call_ids, vec!["call-3"]);
                assert_eq!(reason, CancelReason::UserStop);
            }
            _ => panic!("expected Cancelled"),
        }
    }

    /// Timestamps include millisecond precision.
    #[test]
    fn timestamps_have_millisecond_precision() {
        let ts = now_rfc3339_ms();
        // Format: 2026-05-03T11:22:33.456Z = 24 chars.
        assert_eq!(ts.len(), 24, "ts was: {ts}");
        assert!(ts.ends_with('Z'));
        assert!(ts.contains('.'));
    }
}
