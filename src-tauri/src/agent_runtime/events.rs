//! Streaming events emitted during one assistant turn, plus the
//! per-turn completion summary.
//!
//! Wire shape is consumer-facing: every `AssistantEvent` is delivered
//! to the frontend wrapped in an [`super::ipc::AgentEventEnvelope`] via
//! a Tauri event channel. The variants here are the **only** event
//! types the agent runtime ever emits during a turn — anything outside
//! this enum is a bug in the runtime.
//!
//! [`AssistantEvent`] is `Serialize`-only because events flow strictly
//! from Rust to the frontend; the frontend never round-trips them back.
//!
//! [`TurnCompletion`] is the once-per-turn summary written when the
//! assistant loop reaches a `MessageStop`. Phase 1 keeps it minimal —
//! Phase 2 will populate it from the `ConversationRuntime`.

#![allow(dead_code)]

use serde::Serialize;

use super::types::{ConversationMessage, TokenUsage};

/// One event in the assistant's response stream.
///
/// Wire format: internally tagged with `"type"` (snake_case variant
/// name). For struct variants the inner fields appear at the top level
/// alongside `"type"`. For the [`Self::Usage`] newtype variant, serde
/// flattens the inner `TokenUsage` so consumers see e.g.
/// `{"type":"usage","input_tokens":12,"output_tokens":7}`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantEvent {
    /// A delta of hidden chain-of-thought output. `signature` is the
    /// per-block opaque token Anthropic requires us to echo back on the
    /// next multi-turn request — losing it produces a 400.
    Thinking {
        text: String,
        signature: Option<String>,
    },

    /// A delta of visible assistant text.
    TextDelta { delta: String },

    /// Model is requesting a tool call. Emitted **once per tool call**
    /// after the provider has finished streaming the tool's arguments
    /// JSON; `input` is the canonical, fully-parsed object the runtime
    /// will hand to the executor.
    ///
    /// During streaming, the adapter also emits one or more
    /// [`Self::ToolUseDelta`] events as the JSON arguments arrive — those
    /// are what powers the chat UI's "tool card appearing immediately"
    /// behaviour and the live in-editor file preview while the model
    /// is still typing.
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },

    /// Streaming preview of a tool call's arguments.
    ///
    /// Fired the moment a new `tool_use` content block starts so the
    /// chat UI can render the tool card right away, then again for
    /// every chunk of `arguments` JSON the provider streams. The
    /// payload always carries the **full accumulated** raw JSON
    /// string (not just the delta), so consumers don't need to keep
    /// state across events — just overwrite their per-`id` buffer on
    /// every receipt.
    ///
    /// Carries the raw, possibly-incomplete JSON because for live
    /// previews (`live-file-preview.ts` parsing `path` / `content` out
    /// of a `file_create` tool call as the model types it) we need
    /// the unparsed text. Frontends that only want the parsed object
    /// can ignore this event entirely and wait for [`Self::ToolUse`].
    ToolUseDelta {
        id: String,
        name: String,
        /// Full accumulated raw JSON arguments string so far. The
        /// final `ToolUse.input` is the parsed form of this same
        /// buffer once streaming completes.
        arguments: String,
    },

    /// Runtime has started executing a native Rust tool.
    ///
    /// Bridge tools that already execute in the frontend do not emit
    /// this event; their lifecycle is driven by `agent_tool_pending`
    /// and `agent_post_tool_result` instead.
    ToolExecutionStart {
        id: String,
        name: String,
        input: serde_json::Value,
    },

    /// Runtime has finished executing a native Rust tool.
    ///
    /// `is_error` mirrors the `ToolResult.is_error` block that is
    /// appended to conversation history and lets the UI decide whether
    /// to call its completion or error callback.
    ToolExecutionResult {
        id: String,
        name: String,
        input: serde_json::Value,
        content: String,
        is_error: bool,
    },

    /// Token-usage update reported by the provider mid- or end-stream.
    /// The inner `TokenUsage` is flattened onto the event object.
    Usage(TokenUsage),

    /// End-of-message marker. `stop_reason` mirrors the upstream
    /// provider's stop reason (`"end_turn"`, `"tool_use"`,
    /// `"max_tokens"`, …) so the frontend can render it without a
    /// translation table.
    MessageStop { stop_reason: String },

    /// Stream-level error. `recoverable` tells the frontend whether a
    /// retry is sensible (e.g. transient HTTP 5xx) or whether the user
    /// must intervene (e.g. invalid API key).
    Error { message: String, recoverable: bool },
}

/// Per-turn summary written at the end of one full assistant turn —
/// i.e. one user message → assistant message(s) → optional tool calls
/// → optional tool results → final assistant message.
///
/// Phase 1 keeps this struct minimal. Phase 2 populates it inside the
/// `ConversationRuntime` agent loop and surfaces it back to the
/// frontend as the closing event of an `agent_chat_v2` call.
#[derive(Debug, Clone, Serialize)]
pub struct TurnCompletion {
    pub turn_id: String,
    /// Mirrors the upstream provider's stop reason.
    pub stop_reason: String,
    /// How many model calls the runtime made for this turn (1 for a
    /// no-tool response, more when the model called tools).
    pub iterations: u32,
    /// Sum of usage across every model call in the turn.
    pub usage: TokenUsage,
    pub assistant_messages: Vec<ConversationMessage>,
    pub tool_results: Vec<ConversationMessage>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::types::{ContentBlock, MessageRole};

    #[test]
    fn tool_use_event_has_required_keys() {
        let ev = AssistantEvent::ToolUse {
            id: "call-1".into(),
            name: "shell_execute".into(),
            input: serde_json::json!({"command": "ls"}),
        };
        let s = serde_json::to_string(&ev).expect("serialize");
        assert!(
            s.contains("\"type\":\"tool_use\""),
            "missing type tag, got: {s}"
        );
        assert!(s.contains("\"id\":\"call-1\""), "missing id, got: {s}");
        assert!(
            s.contains("\"name\":\"shell_execute\""),
            "missing name, got: {s}"
        );
        assert!(s.contains("\"input\""), "missing input, got: {s}");
    }

    #[test]
    fn text_delta_event_emits_snake_case_tag() {
        let ev = AssistantEvent::TextDelta {
            delta: "hello".into(),
        };
        let s = serde_json::to_string(&ev).expect("serialize");
        assert!(s.contains("\"type\":\"text_delta\""), "wrong tag, got: {s}");
        assert!(s.contains("\"delta\":\"hello\""), "missing delta, got: {s}");
    }

    #[test]
    fn thinking_event_carries_optional_signature() {
        let with_sig = AssistantEvent::Thinking {
            text: "step 1".into(),
            signature: Some("sig-1".into()),
        };
        let s = serde_json::to_string(&with_sig).expect("serialize");
        assert!(s.contains("\"type\":\"thinking\""));
        assert!(s.contains("\"text\":\"step 1\""));
        assert!(s.contains("\"signature\":\"sig-1\""));

        let without_sig = AssistantEvent::Thinking {
            text: "step 2".into(),
            signature: None,
        };
        let s = serde_json::to_string(&without_sig).expect("serialize");
        assert!(s.contains("\"type\":\"thinking\""));
        // No skip_serializing_if on the field => null is emitted, which
        // is intentional for the streaming wire shape (frontend reads
        // the absence of `signature` differently from `null`).
        assert!(
            s.contains("\"signature\":null"),
            "expected explicit null, got: {s}"
        );
    }

    #[test]
    fn usage_event_flattens_token_usage_fields() {
        let ev = AssistantEvent::Usage(TokenUsage {
            input_tokens: 12,
            output_tokens: 7,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: Some(3),
        });
        let s = serde_json::to_string(&ev).expect("serialize");
        assert!(s.contains("\"type\":\"usage\""), "wrong tag, got: {s}");
        assert!(s.contains("\"input_tokens\":12"));
        assert!(s.contains("\"output_tokens\":7"));
        assert!(s.contains("\"cache_read_input_tokens\":3"));
        assert!(
            !s.contains("cache_creation_input_tokens"),
            "None cache field must be skipped, got: {s}"
        );
    }

    #[test]
    fn native_tool_lifecycle_events_have_required_keys() {
        let start = AssistantEvent::ToolExecutionStart {
            id: "call-1".into(),
            name: "file_read".into(),
            input: serde_json::json!({"path":"a.rs"}),
        };
        let s = serde_json::to_string(&start).expect("serialize start");
        assert!(s.contains("\"type\":\"tool_execution_start\""));
        assert!(s.contains("\"id\":\"call-1\""));
        assert!(s.contains("\"name\":\"file_read\""));
        assert!(s.contains("\"input\""));

        let result = AssistantEvent::ToolExecutionResult {
            id: "call-1".into(),
            name: "file_read".into(),
            input: serde_json::json!({"path":"a.rs"}),
            content: "ok".into(),
            is_error: false,
        };
        let s = serde_json::to_string(&result).expect("serialize result");
        assert!(s.contains("\"type\":\"tool_execution_result\""));
        assert!(s.contains("\"content\":\"ok\""));
        assert!(s.contains("\"is_error\":false"));
    }

    #[test]
    fn message_stop_event_emits_stop_reason() {
        let ev = AssistantEvent::MessageStop {
            stop_reason: "end_turn".into(),
        };
        let s = serde_json::to_string(&ev).expect("serialize");
        assert!(
            s.contains("\"type\":\"message_stop\""),
            "wrong tag, got: {s}"
        );
        assert!(
            s.contains("\"stop_reason\":\"end_turn\""),
            "missing stop_reason, got: {s}"
        );
    }

    #[test]
    fn error_event_emits_recoverable_flag() {
        let ev = AssistantEvent::Error {
            message: "timeout".into(),
            recoverable: true,
        };
        let s = serde_json::to_string(&ev).expect("serialize");
        assert!(s.contains("\"type\":\"error\""));
        assert!(s.contains("\"message\":\"timeout\""));
        assert!(s.contains("\"recoverable\":true"));
    }

    #[test]
    fn turn_completion_serializes_with_messages() {
        let summary = TurnCompletion {
            turn_id: "turn-1".into(),
            stop_reason: "end_turn".into(),
            iterations: 2,
            usage: TokenUsage::default(),
            assistant_messages: vec![ConversationMessage {
                role: MessageRole::Assistant,
                blocks: vec![ContentBlock::Text { text: "ok".into() }],
                usage: None,
                timestamp: 0,
            }],
            tool_results: Vec::new(),
        };
        let s = serde_json::to_string(&summary).expect("serialize");
        assert!(s.contains("\"turn_id\":\"turn-1\""));
        assert!(s.contains("\"iterations\":2"));
        assert!(s.contains("\"stop_reason\":\"end_turn\""));
        assert!(s.contains("\"assistant_messages\""));
        assert!(s.contains("\"tool_results\":[]"));
    }
}
