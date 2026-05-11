//! Streaming API client trait — Phase 2.1 surface.
//!
//! [`StreamingApiClient`] is the abstraction the [`super::conversation::ConversationRuntime`]
//! agent loop uses to talk to an LLM provider. The runtime holds an
//! `Arc<dyn StreamingApiClient>`; concrete implementations live in
//! `src-tauri/src/api/` (Phase 5 restructure of `commands::provider_kernel`).
//!
//! Design notes:
//!
//! - **Sink-driven, not vec-buffered.** `stream` takes an
//!   `mpsc::Sender<AssistantEvent>` and pushes events to it as they
//!   arrive. The runtime forwards them out to the frontend without
//!   waiting for the whole turn to complete. This matches Anthropic's
//!   SSE wire shape and lets the UI render thinking deltas the moment
//!   they appear.
//! - **Cancellation via `CancellationToken`.** No polling, no
//!   `RwLock<HashMap<String, bool>>`. The implementation is expected to
//!   `tokio::select!` between socket reads and `cancel.cancelled()`.
//!   Phase 5 already converted the in-tree `provider_kernel` streams to
//!   this pattern.
//! - **Returns the reconstructed assistant message.** The trait's
//!   contract is "stream the events for the UI **and** return the
//!   final message so the runtime can append it to the session." The
//!   runtime must not have to re-aggregate deltas itself.
//! - **No provider-specific knobs.** Every preset-specific concern
//!   (thinking config, tool-stream flags, anthropic-version header)
//!   lives behind the impl. The trait sees a uniform [`ApiRequest`].

#![allow(dead_code)]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::events::AssistantEvent;
use super::types::{ConversationMessage, TokenUsage};

/// One model invocation: messages plus tool catalogue plus knobs.
///
/// Borrowed so the runtime can keep ownership of its `Vec<…>`s during
/// the turn — the impl is expected to read this and immediately build
/// its provider-specific request body.
#[derive(Debug, Clone, Copy)]
pub struct ApiRequest<'a> {
    /// Provider-qualified model identifier, e.g.
    /// `"anthropic:claude-3-7-sonnet"` or `"openai:gpt-5"`. The impl
    /// strips the provider prefix when building the upstream request.
    pub model: &'a str,
    /// Optional system prompt prepended ahead of `messages`.
    pub system_prompt: Option<&'a str>,
    /// Conversation history in chronological order. The impl must not
    /// reorder or drop messages — context budgeting is handled outside
    /// the trait by Aurora's existing context engine.
    pub messages: &'a [ConversationMessage],
    /// Tool schemas advertised to the model on this turn. Empty slice
    /// means tool-less; the impl decides whether to omit the `tools`
    /// key entirely or send `[]`.
    pub tools: &'a [ToolSchema],
    /// Sampling temperature. `None` lets the impl pick its preset
    /// default (DeepSeek's reasoner, for example, ignores this).
    pub temperature: Option<f32>,
    /// Hard cap on output tokens for this single call. Aurora's
    /// session-level cap is enforced one layer above the trait.
    pub max_output_tokens: u32,
    /// Whether to enable extended thinking for providers that support
    /// it (Anthropic, MiniMax, GLM, DeepSeek). Impls without thinking
    /// support must ignore this flag silently.
    pub thinking_enabled: bool,
}

/// Schema entry for one tool the model may call.
///
/// Wire-shape mirrors Anthropic's `tools[]` payload. OpenAI-shaped
/// providers map this onto `tools[].function.{name,description,parameters}`
/// inside the impl.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// What the API client returns at the end of one streaming call:
/// the reconstructed assistant message plus aggregated usage and the
/// upstream stop reason (`"end_turn"`, `"tool_use"`, `"max_tokens"`).
#[derive(Debug, Clone)]
pub struct TurnUsage {
    pub usage: TokenUsage,
    pub stop_reason: String,
    /// Full assistant message reconstructed from the stream — text
    /// blocks, thinking blocks (with their signatures), and tool-use
    /// blocks aggregated in emit order.
    pub assistant_message: ConversationMessage,
}

/// Errors raised by [`StreamingApiClient::stream`].
///
/// All variants implement `Clone` so the runtime can keep one for its
/// own bookkeeping while propagating another via `?`. They are
/// **not** wrappers around `reqwest::Error` because that type is not
/// `Clone`; impls flatten transport errors into the `Network` variant
/// with an already-rendered message.
#[derive(Debug, Clone, Error)]
pub enum ApiError {
    #[error("network: {0}")]
    Network(String),
    #[error("provider returned an error: {0}")]
    Provider(String),
    #[error("decode failure: {0}")]
    Decode(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("rate limited (retry recommended)")]
    RateLimit,
    #[error("unauthorized — check API key")]
    Unauthorized,
    #[error("request was cancelled")]
    Cancelled,
}

impl ApiError {
    /// Whether a retry is sensible. Used by the runtime to decide
    /// whether to surface the error as `recoverable` to the frontend.
    #[must_use]
    pub fn is_recoverable(&self) -> bool {
        matches!(
            self,
            ApiError::Network(_) | ApiError::Provider(_) | ApiError::RateLimit
        )
    }
}

/// Streaming-only API client. The runtime never calls a non-streaming
/// path — every Aurora provider supports streaming, and unifying on
/// one trait surface keeps the runtime simple.
///
/// Implementors must:
///
/// 1. Push every received event onto `event_sink` as `AssistantEvent`
///    deltas. **Do not buffer.** The frontend's "thinking…" indicator
///    relies on first-byte latency.
/// 2. Watch `cancel_token` and abort the upstream request the moment
///    it's cancelled. Returning `Err(ApiError::Cancelled)` is the
///    expected outcome on cancel; do not return `Ok` with a partial
///    message.
/// 3. Reconstruct and return the full assistant message in
///    [`TurnUsage::assistant_message`] when the stream completes
///    cleanly. The runtime appends this to the session verbatim.
/// 4. Be `Send + Sync` — the runtime holds the impl behind `Arc<dyn …>`
///    and dispatches turns from arbitrary tokio tasks.
#[async_trait]
pub trait StreamingApiClient: Send + Sync {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::types::{ContentBlock, MessageRole};

    /// Compile-time check: a struct can implement the trait and be
    /// stored behind `Arc<dyn …>`. Verifies the object-safety bound.
    struct DummyClient;

    #[async_trait]
    impl StreamingApiClient for DummyClient {
        async fn stream(
            &self,
            _request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            event_sink
                .send(AssistantEvent::TextDelta {
                    delta: "hi".into(),
                })
                .await
                .map_err(|_| ApiError::Network("sink closed".into()))?;
            Ok(TurnUsage {
                usage: TokenUsage::default(),
                stop_reason: "end_turn".into(),
                assistant_message: ConversationMessage {
                    role: MessageRole::Assistant,
                    blocks: vec![ContentBlock::Text { text: "hi".into() }],
                    usage: None,
                    timestamp: 0,
                },
            })
        }
    }

    #[test]
    fn streaming_api_client_is_object_safe() {
        let _client: std::sync::Arc<dyn StreamingApiClient> = std::sync::Arc::new(DummyClient);
    }

    #[tokio::test]
    async fn dummy_client_emits_event_and_returns_message() {
        let client = DummyClient;
        let (tx, mut rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let request = ApiRequest {
            model: "test:dummy",
            system_prompt: None,
            messages: &[],
            tools: &[],
            temperature: None,
            max_output_tokens: 16,
            thinking_enabled: false,
        };
        let result = client.stream(request, tx, cancel).await.expect("ok");
        let event = rx.recv().await.expect("event");
        match event {
            AssistantEvent::TextDelta { delta } => assert_eq!(delta, "hi"),
            other => panic!("expected TextDelta, got {other:?}"),
        }
        assert_eq!(result.stop_reason, "end_turn");
    }

    #[test]
    fn api_error_recoverable_classification() {
        assert!(ApiError::Network("conn reset".into()).is_recoverable());
        assert!(ApiError::Provider("503".into()).is_recoverable());
        assert!(ApiError::RateLimit.is_recoverable());
        assert!(!ApiError::Unauthorized.is_recoverable());
        assert!(!ApiError::InvalidRequest("missing field".into()).is_recoverable());
        assert!(!ApiError::Cancelled.is_recoverable());
        assert!(!ApiError::Decode("bad json".into()).is_recoverable());
    }

    #[test]
    fn tool_schema_round_trips_through_serde() {
        let schema = ToolSchema {
            name: "read_file".into(),
            description: "read a file".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"],
            }),
        };
        let s = serde_json::to_string(&schema).expect("serialize");
        let back: ToolSchema = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(back.name, "read_file");
        assert_eq!(back.description, "read a file");
        assert_eq!(back.input_schema, schema.input_schema);
    }
}
