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
        /// Wall-clock the model spent on this reasoning segment, in ms.
        ///
        /// Persisted because the UI shows it ("Thought · 4m 14s") and a
        /// RELOADED turn has no other way to know: the reasoning block is
        /// rebuilt from this struct, and nothing else in the JSONL records
        /// when it started. Without it the same turn would show a duration
        /// while streaming and a blank after reopening the chat.
        ///
        /// `Option` + `default` so sessions written before this field still
        /// deserialize; they render no number rather than a wrong one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
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

    /// A context-compaction boundary marker (see `DOCS/compaction-design.md`).
    ///
    /// Carried in a [`MessageRole::System`] message inserted into the JSONL
    /// stream at the cut point: `[head…][System(Compaction)][tail…]`. It is a
    /// **persisted, summary-backed** boundary — never sent to a provider. The
    /// API-view builder (`conversation::apply_compaction`) replaces everything
    /// at/older than the last such marker with `summary` and keeps the tail
    /// verbatim, so the model's working set shrinks while the UI transcript
    /// stays whole.
    ///
    /// `summary` is for the MODEL only; the UI renders a card showing the
    /// `before_tokens → after_tokens` drop and NEVER displays the summary text.
    Compaction {
        summary: String,
        before_tokens: u32,
        after_tokens: u32,
        /// Unix epoch milliseconds when compaction fired.
        created_at: i64,
    },

    /// Something the RUNTIME needs to tell the user about this turn — most
    /// importantly that the reply was cut off at the output-token limit.
    ///
    /// Carried in a [`MessageRole::System`] message appended straight after the
    /// assistant message it describes, so it reloads in the right place. Like
    /// [`ContentBlock::Compaction`] it is **never sent to a provider**: the model
    /// does not need to be told about its own truncation, and echoing product
    /// copy back into the conversation would teach it to imitate the voice.
    ///
    /// It exists because the live-only version vanished on thread reload — the
    /// truncated reply persisted but the explanation for it did not, so
    /// reopening a thread turned a diagnosed turn back into a mystery.
    Notice {
        message: String,
        /// Unix epoch milliseconds when the notice was raised.
        created_at: i64,
    },
}

/// Token usage attributed to a single assistant turn.
///
/// `cache_*` fields are populated when the provider reports prompt-
/// cache telemetry (Anthropic, GLM, DeepSeek). They are skipped on the
/// wire when absent so the type stays compatible with providers that
/// don't emit them.
// Not `Eq`: `cost_usd` is an `f64`. Comparisons stay structural via
// `PartialEq`, which is all any caller (and every test) needs.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u32>,
    /// `Some(true)` when these counts are Aurora's own tiktoken estimate
    /// rather than provider-reported usage.
    ///
    /// This drives a MONEY figure, so the distinction cannot be dropped: a
    /// provider that reports nothing (Ollama, LM Studio, some custom
    /// gateways) would otherwise have its cost render as an exact `$0.00`,
    /// which is a false number rather than a missing one. Anything derived
    /// from an estimated call must be presented as approximate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated: Option<bool>,
    /// What the PROVIDER charged for this request, in USD, when it says so.
    ///
    /// This outranks any price Aurora multiplies out. A catalog rate is a
    /// published list price; this is the number on the bill, already
    /// reflecting gateway markup, BYOK, promos and account-level discounts.
    /// `None` means the provider reported no cost and the request must be
    /// priced from the model's configured rates instead.
    ///
    /// Kept per-request rather than per-turn so a conversation that mixes a
    /// reporting provider with a non-reporting one can price each request
    /// with the best source available to it, and say which was used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
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
/// Compact, display-only record of an element the user picked with the
/// in-app browser inspector. Persisted on the user [`ConversationMessage`]
/// so the chip survives thread reopen — it becomes a permanent part of the
/// JSONL transcript. The *full* element context is sent to the model via
/// `ide_context`; this struct exists purely so the UI can re-render the
/// pill above the user bubble after a reload.
///
/// Field names are camelCase on the wire to match the TS
/// `AttachedSelectedElement` interface (`thread-service.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedSelectedElement {
    pub index: i64,
    pub selector: String,
    pub tag_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Display metadata for an exact composer pill attached to a user message.
/// File pills retain both their serialized reference and resolved absolute
/// path; directive pills retain the kind/title used by the composer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedPromptChip {
    pub kind: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationMessage {
    pub role: MessageRole,
    pub blocks: Vec<ContentBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// Unix epoch milliseconds.
    pub timestamp: i64,
    /// Browser-inspector element chips attached to a user message. `None`
    /// for every non-user message and for user messages without picks.
    /// `#[serde(default)]` keeps pre-existing JSONL (written before this
    /// field existed) loadable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attached_selected_elements: Option<Vec<AttachedSelectedElement>>,
    /// Exact file and `/` pills from the composer, for transcript replay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attached_prompt_chips: Option<Vec<AttachedPromptChip>>,
    /// `"{provider_id}:{model}"` that produced this assistant message.
    ///
    /// Cost is per-model, and the model can be switched mid-thread, so a
    /// thread total computed by summing TOKENS and multiplying once by
    /// whatever model is selected now would be wrong for every call that ran
    /// under a different one. Recording it here lets the total be summed as
    /// MONEY, per model, from the transcript itself.
    ///
    /// `None` on user/tool messages and on assistant messages written before
    /// this field existed — those are reported as unattributed rather than
    /// priced at a model that may not have produced them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// What Aurora attached to a USER message at the moment it was sent: the
    /// files open in the dock, a selection, a slash-attached rule, and the
    /// checklist as it stood. The model reads it as a second text block after
    /// the user's own words (see `fold_message_context`); the UI never renders
    /// it, so the bubble shows only what the person typed.
    ///
    /// Saved WITH the message, which is the whole design. Every reference
    /// implementation vendored in `thirdparty/` writes context into the
    /// transcript once, at the moment it becomes true — Claude Code as a meta
    /// user message, OpenCode as a synthetic part on the user's message, pi as a
    /// `custom_message` entry with a `display` flag — and none of them rebuilds
    /// a block per request. Aurora used to, and then had to find somewhere to
    /// put a block whose bytes changed every request: a second user turn, then
    /// the tail of a tool result. Frozen here it has one home and never moves.
    ///
    /// `None` on every non-user message and on user messages sent before this
    /// field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aurora_context: Option<String>,
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
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
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
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
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
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
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
            duration_ms: Some(4_200),
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
            duration_ms: None,
        });
    }

    #[test]
    fn content_block_thinking_omits_signature_when_none() {
        let block = ContentBlock::Thinking {
            text: "no sig".into(),
            signature: None,
            duration_ms: None,
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
                estimated: None,
                cost_usd: None,
            },
            999,
        );
        let v = serde_json::to_value(&msg).expect("serialize");
        let back: ConversationMessage = serde_json::from_value(v).expect("deserialize");
        assert_eq!(msg, back);
        assert_eq!(back.usage.expect("usage").total(), 14);
    }

    #[test]
    fn conversation_message_round_trip_preserves_prompt_chips() {
        let mut msg = ConversationMessage::user_text("check @src/main.ts", 123);
        msg.attached_prompt_chips = Some(vec![AttachedPromptChip {
            kind: "file".into(),
            title: "main.ts".into(),
            value: Some("src/main.ts".into()),
            path: Some("E:/work/src/main.ts".into()),
        }]);
        let value = serde_json::to_value(&msg).expect("serialize");
        let back: ConversationMessage = serde_json::from_value(value).expect("deserialize");
        assert_eq!(back.attached_prompt_chips, msg.attached_prompt_chips);
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
        let back: MessageRole = serde_json::from_str("\"assistant\"").expect("deserialize role");
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
