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

/// The model-facing control the user configured. This is semantic metadata,
/// not a request-body field; each adapter chooses its native encoding.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningControl {
    #[default]
    None,
    Toggle,
    Effort,
    Budget,
}

/// Optional override for gateways whose model id does not reveal which
/// generation of a reasoning protocol they implement.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ReasoningRequestMode {
    #[default]
    Auto,
    AnthropicAdaptive,
    AnthropicBudget,
    OpenaiEffort,
    OpenaiThinking,
}

/// How a stored reasoning block should travel on the next request.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningReplayMode {
    #[default]
    Auto,
    ReasoningContent,
    Reasoning,
    Off,
}

/// Owned, provider-neutral reasoning intent carried in a provider snapshot.
///
/// This is the source of truth for a model invocation. It deliberately says
/// nothing about `reasoning_effort`, `thinking`, or `output_config`; those are
/// encodings chosen by the selected adapter.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub control: ReasoningControl,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub budget_tokens: Option<u32>,
    #[serde(default)]
    pub request_mode: ReasoningRequestMode,
    #[serde(default)]
    pub replay: ReasoningReplayMode,
}

impl ReasoningConfig {
    #[must_use]
    pub fn as_request(&self) -> ReasoningRequest<'_> {
        ReasoningRequest {
            enabled: self.enabled,
            control: self.control,
            effort: self.effort.as_deref(),
            budget_tokens: self.budget_tokens.filter(|value| *value > 0),
            request_mode: self.request_mode,
            replay: self.replay,
        }
    }

    /// Backward-compatible fallback for callers that only know the old
    /// `thinking_enabled` + budget pair.
    #[must_use]
    pub fn legacy(enabled: bool, budget_tokens: Option<u32>) -> Self {
        Self {
            enabled,
            control: if budget_tokens.is_some() {
                ReasoningControl::Budget
            } else if enabled {
                ReasoningControl::Toggle
            } else {
                ReasoningControl::None
            },
            budget_tokens: budget_tokens.filter(|value| *value > 0),
            ..Self::default()
        }
    }
}

/// Borrowed form embedded in [`ApiRequest`]. It stays `Copy`, which lets the
/// key-pool adapter retry the identical request without rebuilding history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReasoningRequest<'a> {
    pub enabled: bool,
    pub control: ReasoningControl,
    pub effort: Option<&'a str>,
    pub budget_tokens: Option<u32>,
    pub request_mode: ReasoningRequestMode,
    pub replay: ReasoningReplayMode,
}

impl ReasoningRequest<'static> {
    #[must_use]
    pub const fn disabled() -> Self {
        Self {
            enabled: false,
            control: ReasoningControl::None,
            effort: None,
            budget_tokens: None,
            request_mode: ReasoningRequestMode::Auto,
            replay: ReasoningReplayMode::Auto,
        }
    }
}

/// Provider-neutral control over whether an advertised tool catalogue may be
/// used for this invocation.
///
/// Compaction deliberately keeps the normal catalogue in its request so the
/// conversation prefix can remain cache-compatible, but it must never execute
/// a tool. Making that a wire-level constraint avoids turning one failed
/// summary into a second full-context request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolChoice {
    #[default]
    Auto,
    None,
}

impl ToolChoice {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::None => "none",
        }
    }
}

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
    /// Whether the model may select one of the advertised tools. Normal agent
    /// calls use `Auto`; single-shot internal calls such as compaction use
    /// `None` while retaining schemas for prompt-cache compatibility.
    pub tool_choice: ToolChoice,
    /// Sampling temperature. `None` lets the impl pick its preset
    /// default (DeepSeek's reasoner, for example, ignores this).
    pub temperature: Option<f32>,
    /// Hard cap on output tokens for this single call. Aurora's
    /// session-level cap is enforced one layer above the trait.
    pub max_output_tokens: u32,
    /// One provider-neutral reasoning request. Adapters translate this into
    /// their own fields instead of reverse-engineering intent from custom body
    /// parameters and a boolean whose old meaning changed by provider.
    pub reasoning: ReasoningRequest<'a>,
    /// Where to run tools **without** ending the stream, for the providers
    /// whose wire keeps the connection open and waits for results on it.
    ///
    /// `None` — the normal case — means the impl reports `tool_use` blocks and
    /// stops, and the runtime runs them before opening the next request. Impls
    /// that do not speak a bidirectional protocol must ignore this field
    /// entirely; it is not a capability to opt into, it is a channel back to
    /// the caller that only helps if the far end is genuinely waiting.
    ///
    /// It is a borrow so [`ApiRequest`] stays `Copy` and can be rebuilt per
    /// retry attempt for free. See [`super::tool_bridge`].
    pub tool_bridge: Option<&'a super::tool_bridge::ToolBridge>,
    /// Stable identity of the conversation this request belongs to (the
    /// thread id). Not part of the prompt — it exists so an impl can tell
    /// the provider "these requests share a prefix": OpenAI's
    /// `prompt_cache_key` and the Codex backend's `session_id` header both
    /// route same-key requests to the same cache. Measured without it,
    /// long turns kept falling to the implicit-routing floor — only the
    /// system-prompt-and-tools region read from cache while the
    /// conversation body re-billed as fresh input. `None` (one-off
    /// requests, tests) simply sends no affinity hint; impls with no such
    /// concept ignore it entirely.
    pub session_key: Option<&'a str>,
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
    RateLimit {
        /// Seconds the provider asked us to wait, parsed from `Retry-After`.
        ///
        /// A 429 is the one failure where the other side has already told us
        /// the answer. Guessing with exponential backoff instead means either
        /// hammering a provider that asked for a minute, or idling for thirty
        /// seconds when it asked for two. `None` when the header was absent or
        /// unparseable, which is the only case the backoff ladder has to guess.
        retry_after_secs: Option<u64>,
    },
    /// A 401. The payload is what the provider said, or `check API key` when
    /// it said nothing.
    ///
    /// It carries a message because 401 is not always about credentials.
    /// OpenCode answers a model id it does not recognise with `401
    /// {"error":{"type":"ModelError","message":"Model gpt-5-6-luna is not
    /// supported"}}` — the status is wrong, the body is exactly right, and
    /// discarding it left Aurora telling the user to check a key that was
    /// working. Naming a cause nobody measured is worse than quoting one.
    #[error("unauthorized — {0}")]
    Unauthorized(String),
    /// The endpoint refused the request because the reasoning it produced on an
    /// earlier turn was not handed back to it.
    ///
    /// Unlike every other 400, this one is worth re-issuing: the endpoint has
    /// just told us what the next request must contain, the requirement is
    /// recorded against that endpoint and model, and the rebuilt request is
    /// therefore NOT byte-identical. Retrying is acting on new information
    /// rather than hoping.
    #[error("this endpoint requires its reasoning to be replayed — retrying with it")]
    ReasoningReplayRequired,
    /// The endpoint refused the request BECAUSE it carried replayed reasoning.
    ///
    /// The mirror of [`Self::ReasoningReplayRequired`], and retryable for the
    /// identical reason: the endpoint has just told us what the next request
    /// must NOT contain, the refusal is recorded against that endpoint and
    /// model, and the rebuilt request therefore differs from the one that
    /// failed. Aurora replays reasoning by default on unknown OpenAI-shaped
    /// gateways, so this is how a strict backend (Fireworks: `Extra inputs are
    /// not permitted, field: reasoning_content`) turns it off without the user
    /// having to find a setting.
    #[error("this endpoint rejects replayed reasoning — retrying without it")]
    ReasoningReplayRefused,
    /// The endpoint refused the request BECAUSE it carried `prompt_cache_key`.
    ///
    /// The third of the same family, and retryable for the same reason: the
    /// refusal is recorded against the endpoint and model, so the rebuilt
    /// request omits the field and is not the request that failed.
    ///
    /// It cannot be predicted from the provider type. Probed 2026-08-30 with
    /// Aurora's own body: `us-api.x5m5x.com` accepts it on all five models
    /// tested, `vectide.cn` answers 400 — and both rows are typed `openai`.
    /// Vectide's rejection never names the field ("请求参数值或格式不受支持"),
    /// which is why the endpoint has to teach us rather than the body.
    #[error("this endpoint rejects the prompt cache key — retrying without it")]
    PromptCacheKeyRefused,
    /// One Codex account hit its usage limit and another has taken over.
    ///
    /// Retryable for the same reason as the two above: the rebuilt request
    /// carries a different account's token, so it is not the request that just
    /// failed. Carries the account that took over so the turn can say what
    /// happened rather than stalling silently on someone else's credits.
    #[error("Codex account limit reached — continuing on {to}")]
    CodexAccountRotated { to: String },
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
            ApiError::Network(_) | ApiError::Provider(_) | ApiError::RateLimit { .. }
        )
    }

    /// Whether the runtime should re-issue the request **itself**,
    /// without the user asking.
    ///
    /// Deliberately separate from [`Self::is_recoverable`]: that one
    /// answers "tell the user a retry may help", this one answers
    /// "spend their money retrying it right now". The two sets agree
    /// today, and they are still not the same question — folding them
    /// into one predicate would mean a change to how an error is
    /// *presented* silently changes what the runtime *does*.
    ///
    /// Retried:
    /// - `Network` — the connection dropped mid-stream. The most common
    ///   real failure in `aurora.log`, and transient by definition.
    /// - `Provider` — every 5xx maps here (see `map_status_error`). A
    ///   gateway briefly out of healthy upstreams clears in seconds.
    /// - `RateLimit` — clears by waiting; that is what it means.
    ///
    /// Not retried, and why each stays out:
    /// - `InvalidRequest` — the request itself is wrong (a 404 for a
    ///   model that will not accept tools). Byte-identical on every
    ///   attempt, so N tries buy N times the same error.
    /// - `Decode` — the bytes did not parse. Re-reading them will not
    ///   change them.
    /// - `Unauthorized` — a key does not become valid by waiting.
    /// - `Cancelled` — the user pressed Stop. Retrying would be the
    ///   opposite of what they asked for.
    /// - `Provider` carrying a context-overflow rejection — see
    ///   [`Self::is_context_overflow`]. It arrives in the retryable bucket
    ///   and must be pulled back out: the request is byte-identical on
    ///   every attempt and too big on every attempt.
    /// - `ReasoningReplayRequired` — the one 400 that IS worth re-issuing. It
    ///   is retried because the request changes: the endpoint named what it
    ///   needs, that is now recorded against it, and the rebuilt body carries
    ///   the reasoning. Retrying an unchanged request would still be pointless;
    ///   this one is not unchanged.
    #[must_use]
    pub fn is_retryable(&self) -> bool {
        if self.is_context_overflow() {
            return false;
        }
        matches!(
            self,
            ApiError::Network(_)
                | ApiError::Provider(_)
                | ApiError::RateLimit { .. }
                | ApiError::ReasoningReplayRequired
                | ApiError::ReasoningReplayRefused
                | ApiError::PromptCacheKeyRefused
                | ApiError::CodexAccountRotated { .. }
        )
    }

    /// The provider refused the request because the prompt is larger than the
    /// model's **real** context window.
    ///
    /// Matched on the message text because no two providers agree on a code:
    /// the OpenAI Responses stream sends `"code": "context_too_large"`, chat
    /// completions `"context_length_exceeded"`, Anthropic answers
    /// `"prompt is too long"`. All of them land in [`ApiError::Provider`],
    /// which is otherwise the transient-5xx bucket — so before this predicate
    /// existed the runtime re-sent the same oversized body three times, waited
    /// out the backoff, and then killed the turn
    /// (`aurora.log`, 2026-08-15T03:43:42 → 03:43:59, three attempts).
    ///
    /// This is not a user error and not a transient one. It means the
    /// configured context window is larger than what the endpoint actually
    /// serves, so the ONLY thing that clears it is sending less — which is
    /// exactly what the forced-compaction branch in `Conversation::run_turn`
    /// does. The configured window cannot be trusted to predict it, which is
    /// why the runtime waits to be told rather than trying to stay under a
    /// number it now knows is wrong.
    #[must_use]
    pub fn is_context_overflow(&self) -> bool {
        let text = match self {
            ApiError::Provider(message) | ApiError::InvalidRequest(message) => message,
            _ => return false,
        };
        let lower = text.to_ascii_lowercase();
        [
            "context_too_large",
            "context_length_exceeded",
            "exceeds the context window",
            "maximum context length",
            "prompt is too long",
            "too many total text bytes",
            "reduce the length of the messages",
            "input is too long",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
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
                .send(AssistantEvent::TextDelta { delta: "hi".into() })
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
                    attached_selected_elements: None,
                    attached_prompt_chips: None,
                    aurora_context: None,
                    model: None,
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
            tool_choice: Default::default(),
            temperature: None,
            max_output_tokens: 16,
            reasoning: ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: None,        };
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
        assert!(ApiError::RateLimit {
            retry_after_secs: None
        }
        .is_recoverable());
        assert!(!ApiError::Unauthorized("no key".into()).is_recoverable());
        assert!(!ApiError::InvalidRequest("missing field".into()).is_recoverable());
        assert!(!ApiError::Cancelled.is_recoverable());
        assert!(!ApiError::Decode("bad json".into()).is_recoverable());
    }

    /// The verbatim rejection from `aurora.log` 2026-08-15T03:43, which the
    /// runtime re-sent three times (8s of backoff) before killing the turn —
    /// because it arrives as `Provider`, the transient-5xx bucket.
    #[test]
    fn context_overflow_is_recognised_and_pulled_out_of_the_retry_bucket() {
        let measured = ApiError::Provider(
            "Your input exceeds the context window of this model. \
             Please adjust your input and try again."
                .into(),
        );
        assert!(measured.is_context_overflow());
        assert!(
            !measured.is_retryable(),
            "an oversized body is byte-identical on every attempt"
        );
        // Still worth telling the user a retry may help: the forced
        // compaction that answers it makes the next one smaller.
        assert!(measured.is_recoverable());
    }

    #[test]
    fn context_overflow_spans_the_provider_wordings_aurora_talks_to() {
        for message in [
            r#"{"type":"error","code":"context_too_large","message":"…"}"#,
            r#"{"error":{"code":"context_length_exceeded"}}"#,
            "prompt is too long: 219431 tokens > 200000 maximum",
            "This model's maximum context length is 128000 tokens",
        ] {
            assert!(
                ApiError::Provider(message.into()).is_context_overflow(),
                "should classify: {message}"
            );
        }
    }

    /// The predicate keys on text, so it has to stay narrow: a 5xx that merely
    /// mentions a window must still be retried, or a transient gateway blip
    /// would trigger a full-history summarization request instead.
    #[test]
    fn ordinary_failures_are_not_mistaken_for_context_overflow() {
        assert!(!ApiError::Provider("503 upstream unavailable".into()).is_context_overflow());
        assert!(!ApiError::Network("connection reset".into()).is_context_overflow());
        assert!(!ApiError::RateLimit {
            retry_after_secs: None
        }
        .is_context_overflow());
        assert!(!ApiError::Unauthorized("no key".into()).is_context_overflow());
        assert!(ApiError::Provider("503 upstream unavailable".into()).is_retryable());
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
