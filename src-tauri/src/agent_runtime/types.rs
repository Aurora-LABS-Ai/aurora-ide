//! Foundation type contracts for the agent runtime.
//!
//! The wire shapes documented here are **consumer-facing**: every
//! frontend chat surface (`ChatPanel`, `AgentMode`, pending-changes,
//! audit timeline) and every Rust command in Phase 2+ observes these
//! types via Tauri events or IPC payloads. Renaming a field, dropping a
//! `serde` attribute, or changing a tag rule is therefore a **breaking
//! change** — bump the channel name when that happens.
//!
//! Modeled on Anthropic's content-block message format so the existing
//! `provider_kernel` Anthropic path can pass through unchanged. OpenAI-
//! shaped providers map onto this model in `services::api_converter`.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Speaker role for a [`ConversationMessage`].
///
/// Wire format: a plain snake_case string (`"system"`, `"user"`,
/// `"assistant"`, `"tool"`). Kept as a small value-typed enum so it can
/// be cheaply copied into provider-specific request builders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

/// One typed unit of conversation content.
///
/// A single message can carry multiple blocks (interleaved text,
/// thinking, tool use, tool result) — matching how Anthropic's
/// `messages` API delivers responses.
///
/// Wire format: internally tagged with a `"type"` discriminator whose
/// value is the snake-case variant name. Optional fields with
/// `skip_serializing_if` are omitted when absent so we don't pollute
/// the request body with `null`s the provider may reject.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// Plain visible text from the user or assistant.
    Text { text: String },

    /// Hidden chain-of-thought ("extended thinking") emitted by the
    /// model. `signature` is opaque to Aurora but **must** be echoed
    /// verbatim back to Anthropic on multi-turn requests — losing it
    /// produces a 400 from the API.
    Thinking {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },

    /// Model is requesting a tool call. `input` is the raw JSON
    /// arguments object as the model emitted it (preserved verbatim so
    /// the dispatcher's parser sees exactly what Anthropic sent).
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },

    /// Result of executing a previous [`ContentBlock::ToolUse`].
    ///
    /// `is_error` is `Option<bool>` and skipped on the wire when
    /// `None` so successful results stay shape-compatible with
    /// providers that reject the field for non-error tool results.
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
}

/// Token usage attributed to a single assistant turn.
///
/// `cache_*` fields are populated when the provider reports prompt-
/// cache telemetry (Anthropic, GLM, DeepSeek). They are skipped on the
/// wire when absent so the type stays compatible with providers that
/// don't emit them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u32>,
}

impl TokenUsage {
    /// Sum of input and output tokens, ignoring cache fields. Returned
    /// as `u64` so it can hold the result of pathological assistant
    /// outputs without saturating.
    #[must_use]
    pub fn total(&self) -> u64 {
        u64::from(self.input_tokens) + u64::from(self.output_tokens)
    }
}

/// One full conversation message — role, ordered content blocks,
/// optional usage attribution, and a unix-millis timestamp.
///
/// Timestamps use unix milliseconds (`i64`) to match the `Date.now()`
/// shape Aurora's frontend already uses for `Message.timestamp`. We
/// pick `i64` over `u64` so subtraction in elapsed-time UIs is
/// straightforward.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationMessage {
    pub role: MessageRole,
    pub blocks: Vec<ContentBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// Unix epoch milliseconds.
    pub timestamp: i64,
}

impl ConversationMessage {
    /// Convenience constructor for a single-block user text message.
    #[must_use]
    pub fn user_text(text: impl Into<String>, timestamp: i64) -> Self {
        Self {
            role: MessageRole::User,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            usage: None,
            timestamp,
        }
    }

    /// Convenience constructor for an assistant message that already
    /// has its content blocks assembled.
    #[must_use]
    pub fn assistant(blocks: Vec<ContentBlock>, timestamp: i64) -> Self {
        Self {
            role: MessageRole::Assistant,
            blocks,
            usage: None,
            timestamp,
        }
    }

    /// Convenience constructor for an assistant message with attached
    /// usage metadata.
    #[must_use]
    pub fn assistant_with_usage(
        blocks: Vec<ContentBlock>,
        usage: TokenUsage,
        timestamp: i64,
    ) -> Self {
        Self {
            role: MessageRole::Assistant,
            blocks,
            usage: Some(usage),
            timestamp,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(block: ContentBlock) {
        let v = serde_json::to_value(&block).expect("serialize");
        let back: ContentBlock = serde_json::from_value(v).expect("deserialize");
        assert_eq!(block, back, "round-trip mismatch");
    }

    #[test]
    fn content_block_text_round_trip() {
        round_trip(ContentBlock::Text {
            text: "hello world".into(),
        });
    }

    #[test]
    fn content_block_thinking_with_signature_round_trip() {
        let block = ContentBlock::Thinking {
            text: "step 1: think".into(),
            signature: Some("sig-abc-123".into()),
        };
        let v = serde_json::to_value(&block).expect("serialize");
        let back: ContentBlock = serde_json::from_value(v).expect("deserialize");
        assert_eq!(block, back);

        match back {
            ContentBlock::Thinking { signature, .. } => {
                assert_eq!(
                    signature.as_deref(),
                    Some("sig-abc-123"),
                    "signature must survive round-trip"
                );
            }
            other => panic!("expected Thinking variant, got: {other:?}"),
        }
    }

    #[test]
    fn content_block_thinking_without_signature_round_trip() {
        round_trip(ContentBlock::Thinking {
            text: "no sig".into(),
            signature: None,
        });
    }

    #[test]
    fn content_block_thinking_omits_signature_when_none() {
        let block = ContentBlock::Thinking {
            text: "no sig".into(),
            signature: None,
        };
        let s = serde_json::to_string(&block).expect("serialize");
        assert!(
            !s.contains("signature"),
            "signature must be omitted when None, got: {s}"
        );
    }

    #[test]
    fn content_block_tool_use_round_trip() {
        round_trip(ContentBlock::ToolUse {
            id: "call-1".into(),
            name: "shell_execute".into(),
            input: serde_json::json!({"command": "ls -la"}),
        });
    }

    #[test]
    fn content_block_tool_result_with_is_error_round_trip() {
        round_trip(ContentBlock::ToolResult {
            tool_use_id: "call-1".into(),
            content: "file contents".into(),
            is_error: Some(false),
        });
        round_trip(ContentBlock::ToolResult {
            tool_use_id: "call-2".into(),
            content: "permission denied".into(),
            is_error: Some(true),
        });
    }

    #[test]
    fn content_block_tool_result_without_is_error_round_trip() {
        round_trip(ContentBlock::ToolResult {
            tool_use_id: "call-3".into(),
            content: "ok".into(),
            is_error: None,
        });
    }

    #[test]
    fn tool_result_omits_is_error_on_wire_when_none() {
        let block = ContentBlock::ToolResult {
            tool_use_id: "call-x".into(),
            content: "ok".into(),
            is_error: None,
        };
        let s = serde_json::to_string(&block).expect("serialize");
        assert!(
            !s.contains("is_error"),
            "is_error must be omitted when None, got: {s}"
        );
    }

    #[test]
    fn tool_result_keeps_is_error_on_wire_when_some() {
        let block = ContentBlock::ToolResult {
            tool_use_id: "call-x".into(),
            content: "boom".into(),
            is_error: Some(true),
        };
        let s = serde_json::to_string(&block).expect("serialize");
        assert!(
            s.contains("\"is_error\":true"),
            "is_error true must appear on the wire, got: {s}"
        );
    }

    #[test]
    fn conversation_message_omits_usage_when_none() {
        let msg = ConversationMessage::user_text("hi", 12345);
        let s = serde_json::to_string(&msg).expect("serialize");
        assert!(
            !s.contains("\"usage\""),
            "usage field must be omitted when None, got: {s}"
        );
    }

    #[test]
    fn conversation_message_round_trip_preserves_usage() {
        let msg = ConversationMessage::assistant_with_usage(
            vec![ContentBlock::Text {
                text: "hello".into(),
            }],
            TokenUsage {
                input_tokens: 10,
                output_tokens: 4,
                cache_creation_input_tokens: Some(1),
                cache_read_input_tokens: Some(2),
            },
            999,
        );
        let v = serde_json::to_value(&msg).expect("serialize");
        let back: ConversationMessage = serde_json::from_value(v).expect("deserialize");
        assert_eq!(msg, back);
        assert_eq!(back.usage.expect("usage").total(), 14);
    }

    #[test]
    fn message_role_serializes_as_snake_case_string() {
        assert_eq!(
            serde_json::to_string(&MessageRole::System).expect("serialize"),
            "\"system\""
        );
        assert_eq!(
            serde_json::to_string(&MessageRole::User).expect("serialize"),
            "\"user\""
        );
        assert_eq!(
            serde_json::to_string(&MessageRole::Assistant).expect("serialize"),
            "\"assistant\""
        );
        assert_eq!(
            serde_json::to_string(&MessageRole::Tool).expect("serialize"),
            "\"tool\""
        );
        let back: MessageRole =
            serde_json::from_str("\"assistant\"").expect("deserialize role");
        assert_eq!(back, MessageRole::Assistant);
    }

    #[test]
    fn token_usage_default_zeros_and_no_cache_fields_on_wire() {
        let usage = TokenUsage::default();
        let s = serde_json::to_string(&usage).expect("serialize");
        assert!(s.contains("\"input_tokens\":0"));
        assert!(s.contains("\"output_tokens\":0"));
        assert!(
            !s.contains("cache_"),
            "default usage must omit cache_* fields, got: {s}"
        );
    }
}
