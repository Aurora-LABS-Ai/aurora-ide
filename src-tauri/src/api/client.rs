//! Provider config snapshot and the [`build_api_client`] factory.
//!
//! [`ProviderConfigSnapshot`] is a frozen, plain-Rust view of one
//! Aurora LLM provider's configuration — what the [`StreamingApiClient`]
//! impls need to actually fire a streaming HTTP request. It deserializes
//! from the camelCase JSON the frontend already sends to
//! `aurora_provider_*` so the Tauri command surface (Implementer E) can
//! pass the existing payload through unchanged.
//!
//! The factory dispatches purely on `provider_type` — the user's
//! explicit "API type" selection — falling back to `provider_id` when no
//! type was sent (no `base_url` introspection; that path is brittle).
//! A type of `"anthropic"` or `"minimax"` returns an
//! [`AnthropicAdapter`]; everything else (including empty / unknown
//! types) returns an [`OpenAICompatAdapter`].
//!
//! Dispatching on `provider_id` was a bug: user-added providers carry a
//! generated UUID there, so every custom provider silently fell through
//! to Chat Completions no matter which API type the user picked.
//!
//! [`StreamingApiClient`]: crate::agent_runtime::api_client::StreamingApiClient

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_runtime::api_client::{ReasoningConfig, StreamingApiClient};

use super::anthropic::AnthropicAdapter;
use super::codex::adapter::CodexAdapter;
use super::cursor::adapter::CursorAdapter;
use super::deepseek::DeepSeekAdapter;
use super::openai_compat::OpenAICompatAdapter;
use super::responses::OpenAIResponsesAdapter;

/// Frozen view of one Aurora provider's configuration as the API client
/// adapters need to see it.
///
/// Deserializable from the camelCase frontend payload so the Tauri
/// command surface can pass `aurora_provider_chat`-shaped payloads
/// through unchanged. Not itself a `#[tauri::command]` argument — the
/// command layer (Implementer E) wraps this struct.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigSnapshot {
    /// Frontend-managed provider **row** identifier. For built-in presets
    /// this happens to equal the provider type (`"anthropic"`,
    /// `"deepseek"`, `"openai-responses"`, …); for user-added providers it
    /// is a generated UUID.
    ///
    /// Identity only — never infer the wire shape from it. That is
    /// [`Self::provider_type`]'s job. This *is* the right key for
    /// [`super::provider_kernel_adapter::unprefix_model`], which strips a
    /// `"{row_id}:"` prefix off the model name.
    #[serde(default)]
    pub provider_id: String,
    /// The user's explicit **API type** selection — the "API type" dropdown
    /// on the provider settings page: `"openai"`, `"openai-responses"`,
    /// `"anthropic"`, `"deepseek"`, `"codex"`, `"glm"`, `"minimax"`,
    /// `"fireworks"`, `"lmstudio"`, `"ollama"`, `"custom"`.
    ///
    /// This — not `provider_id` — decides the wire shape and every other
    /// provider-family behaviour (prompt caching, `stream_options`,
    /// reasoning-field replay). Optional so pre-cutover payloads keep
    /// working: when absent, [`Self::effective_provider_type`] falls back
    /// to `provider_id`, which is correct for the built-in rows whose id
    /// equals their type.
    #[serde(default, alias = "provider_type")]
    pub provider_type: Option<String>,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    /// Optional API-key POOL. When it holds more than one non-empty key,
    /// [`build_api_client`] wraps the adapter in a [`super::pool::PooledStreamingClient`]
    /// that rotates keys round-robin per turn and fails over to the next
    /// key on an auth / rate-limit / server error — same request, different
    /// key. Generic across every provider; AgentRouter (5+ accounts) is the
    /// first consumer. Empty / single-entry → the plain single-key path.
    #[serde(default)]
    pub api_keys: Option<Vec<String>>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub custom_headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub custom_params: Option<HashMap<String, Value>>,
    #[serde(default)]
    pub default_temperature: Option<f32>,
    #[serde(default)]
    pub default_max_tokens: Option<u32>,
    #[serde(default)]
    pub supports_thinking: bool,
    /// Fully resolved reasoning intent for this exact model. Optional for
    /// older payloads; the command layer falls back to the legacy fields.
    #[serde(default)]
    pub reasoning: Option<ReasoningConfig>,
    /// Does the active model accept image content blocks?
    /// `true` switches the API adapter into vision mode for tool
    /// results (Anthropic uses native multimodal `tool_result`,
    /// OpenAI-compat emits a content array with `image_url` blocks).
    /// `false` strips screenshot markers down to a placeholder so the
    /// model isn't poisoned with unusable base64.
    #[serde(default)]
    pub supports_vision: bool,
}

impl ProviderConfigSnapshot {
    /// The provider family every wire-shape decision must key on.
    ///
    /// Prefers the user's explicit API-type selection; falls back to
    /// `provider_id` only when no type was sent. Without the fallback,
    /// pre-cutover payloads (which carried the type *in* `provider_id`)
    /// would all collapse to OpenAI Chat Completions.
    #[must_use]
    pub fn effective_provider_type(&self) -> &str {
        self.provider_type
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.provider_id.trim())
    }

    /// The ordered list of API keys to try for this provider. Dedupes the
    /// pool while preserving order, drops blanks, and always falls back to
    /// the single `api_key` when the pool is empty. Guaranteed non-empty
    /// only if at least one of `api_key` / `api_keys` is non-blank —
    /// callers that need auth should check `.is_empty()`.
    #[must_use]
    pub fn effective_keys(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut push = |k: &str| {
            let k = k.trim();
            if !k.is_empty() && !out.iter().any(|e| e == k) {
                out.push(k.to_string());
            }
        };
        if let Some(pool) = &self.api_keys {
            for k in pool {
                push(k);
            }
        }
        push(&self.api_key);
        out
    }
}

/// Wire-shape kind chosen by the factory. Distinct from `provider_id`
/// because (a) two ids share the Anthropic shape (`anthropic`,
/// `minimax`) and (b) DeepSeek is technically OpenAI-compatible but
/// has enough provider-specific wire tweaks (thinking-mode
/// `reasoning_effort`, `user_id` KVCache isolation, strict-mode beta
/// branch, prompt-cache token normalization) that we hand it a
/// dedicated adapter. See [`super::deepseek::DeepSeekAdapter`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Anthropic,
    DeepSeek,
    /// OpenAI's typed-event `/responses` endpoint. An *additional*
    /// wire shape users opt into per provider — Chat Completions
    /// (`OpenAICompat`) stays the default for `"openai"` and every
    /// other OpenAI-shaped id.
    OpenAIResponses,
    /// Codex-tier models over the ChatGPT backend, authenticated with
    /// the user's ChatGPT subscription (OAuth, no API key). Same
    /// Responses wire shape; auth + endpoint live in
    /// [`super::codex`].
    Codex,
    /// Cursor's `agent.v1` agent protocol, authenticated with the user's
    /// Cursor subscription (no API key). Not an OpenAI-shaped wire at all —
    /// Connect-RPC over HTTP/2, protobuf framed. See [`super::cursor`].
    Cursor,
    OpenAICompat,
}

impl ProviderKind {
    /// Decide kind purely from the provider **type** (see
    /// [`ProviderConfigSnapshot::effective_provider_type`]). Empty /
    /// unknown → OpenAI Chat Completions.
    #[must_use]
    pub fn detect(provider_type: &str) -> Self {
        match provider_type.trim() {
            "anthropic" | "minimax" | "kenari-messages" | "opencode-go-messages" => {
                ProviderKind::Anthropic
            }
            "deepseek" => ProviderKind::DeepSeek,
            // On OpenCode Go the wire belongs to the MODEL, not the row: the
            // same key and base URL answer all three formats and each model
            // accepts only its own (GLM returns 500 on anything but chat
            // completions, GPT 5.6 Luna on anything but responses, the Qwen and
            // MiniMax ids want messages). The type that arrives here has
            // therefore already been resolved per model by
            // `applyOpenCodeWire`; these arms only say which adapter each of
            // the three names means. `opencode-go-chat` falls through to OpenAI
            // Chat Completions below.
            "openai-responses" | "openai_responses" | "kenari-responses" | "opencode-go" => {
                ProviderKind::OpenAIResponses
            }
            "codex" => ProviderKind::Codex,
            "cursor" => ProviderKind::Cursor,
            _ => ProviderKind::OpenAICompat,
        }
    }
}

/// What a stored [`crate::agent_runtime::types::ContentBlock::Thinking`] block
/// costs the NEXT request on a given provider.
///
/// This exists because a thinking block is the one piece of history whose
/// on-disk size says nothing about its wire cost. Aurora persists every
/// reasoning block forever (the transcript renders them), but each provider
/// does something different with it on replay — and two of the three options
/// cost nothing at all. Counting the stored bytes as prompt text, which is
/// what the token estimator used to do, is therefore not a small imprecision:
/// on a chat that ran a Responses-API model and later switched providers it
/// invented ~92k tokens of context that were never sent, and the compaction
/// card reported a "before" size half again larger than the real request.
///
/// Decided from the provider **type** so it matches the wire shape the factory
/// below will actually build — see [`reasoning_replay_for`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReasoningReplay {
    /// The block never reaches the provider. OpenAI Chat Completions,
    /// Fireworks, MiniMax, Ollama and custom gateways all strip it —
    /// `reasoning_field_for` returns `None` and nothing is emitted. Costs
    /// exactly zero, whatever the transcript holds.
    #[default]
    Dropped,
    /// The reasoning TEXT rides along: `reasoning_content` (DeepSeek, GLM),
    /// `reasoning` (OpenRouter, LM Studio), or a native Anthropic `thinking`
    /// block. Costs its own tokens. The `signature` that accompanies it is
    /// transport metadata — an HMAC or item id the provider verifies, never
    /// billed as prompt text.
    Text,
    /// The Responses API replays an opaque encrypted reasoning item built from
    /// `Thinking.signature` (see `super::responses`). It DOES cost tokens, but
    /// its price is the ORIGINAL reasoning the ciphertext stands for — not the
    /// length of the ciphertext, which base64 and block padding have inflated.
    Opaque,
}

/// Which [`ReasoningReplay`] a provider type follows.
///
/// Derived from [`ProviderKind::detect`] plus the same
/// `reasoning_field_for` table the OpenAI request builder consults, so the
/// estimate can never disagree with what the builder emits.
///
/// Takes the model for the same reason the builder does: behind an
/// OpenAI-compatible gateway the provider type is a wire shape, not a vendor,
/// and only the model name says whose reasoning rules apply. Passing a
/// different model here than the request carries would put the estimate and
/// the wire back out of step, which is the one thing this function exists to
/// prevent.
#[must_use]
pub fn reasoning_replay_for(
    provider_type: &str,
    model: &str,
    base_url: &str,
    replay_mode: crate::agent_runtime::api_client::ReasoningReplayMode,
    custom_params: Option<&std::collections::HashMap<String, serde_json::Value>>,
) -> ReasoningReplay {
    match ProviderKind::detect(provider_type) {
        // Anthropic replays `thinking` blocks verbatim and requires it once
        // extended thinking is on.
        ProviderKind::Anthropic => ReasoningReplay::Text,
        ProviderKind::OpenAIResponses | ProviderKind::Codex => ReasoningReplay::Opaque,
        // The SAME resolution the builder runs — learned demand, then the
        // user's `reasoning_replay` directive, then the vendor table. Any
        // half missing here puts the estimate out of step with the wire —
        // the exact class of bug that invented ~92k tokens of phantom
        // context once already.
        _ => match super::provider_kernel_adapter::resolve_reasoning_field(
            provider_type,
            model,
            base_url,
            super::provider_kernel_adapter::reasoning_replay_mode_override(replay_mode).or_else(
                || super::provider_kernel_adapter::reasoning_replay_override(custom_params),
            ),
        ) {
            Some(_) => ReasoningReplay::Text,
            None => ReasoningReplay::Dropped,
        },
    }
}

/// Build the streaming API client for one provider config.
///
/// The factory clones the config into the adapter — adapters retain
/// their own private copy and never see the original. Cheap (the
/// adapter holds an `Arc`-backed `reqwest::Client`), so callers can
/// either build one per `agent_chat_v2` invocation or wrap it in an
/// `Arc` once per process. The latter is recommended; reqwest's
/// internal connection pool benefits from being shared.
#[must_use]
pub fn build_api_client(config: &ProviderConfigSnapshot) -> Arc<dyn StreamingApiClient> {
    // A multi-key pool wraps the concrete adapter with round-robin +
    // failover. A single key (the overwhelming common case) takes the
    // plain path — zero wrapper overhead. The pool builds its own inner
    // adapter per key via `build_single_api_client`, so this dispatch
    // stays the one place that knows the wire shapes.
    let keys = config.effective_keys();
    if keys.len() > 1 {
        return Arc::new(super::pool::PooledStreamingClient::new(
            config.clone(),
            keys,
        ));
    }
    build_single_api_client(config)
}

/// Build the concrete streaming adapter for exactly one key (the config's
/// `api_key`). This is the single-key path and the per-key builder the
/// [`super::pool::PooledStreamingClient`] calls for each failover attempt.
/// It never wraps in a pool — that would recurse.
#[must_use]
pub fn build_single_api_client(config: &ProviderConfigSnapshot) -> Arc<dyn StreamingApiClient> {
    match ProviderKind::detect(config.effective_provider_type()) {
        ProviderKind::Anthropic => Arc::new(AnthropicAdapter::new(config.clone())),
        ProviderKind::DeepSeek => Arc::new(DeepSeekAdapter::new(config.clone())),
        ProviderKind::OpenAIResponses => Arc::new(OpenAIResponsesAdapter::new(config.clone())),
        ProviderKind::Codex => Arc::new(CodexAdapter::new(config.clone())),
        ProviderKind::Cursor => Arc::new(CursorAdapter::new(config.clone())),
        ProviderKind::OpenAICompat => Arc::new(OpenAICompatAdapter::new(config.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider_id: &str) -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: provider_id.to_string(),
            provider_type: None,
            base_url: "https://example.test".into(),
            api_key: "key".into(),
            api_keys: None,
            model: "any".into(),
            custom_headers: None,
            custom_params: None,
            default_temperature: None,
            default_max_tokens: None,
            supports_thinking: false,
            reasoning: None,
            supports_vision: false,
        }
    }

    #[test]
    fn detect_anthropic_for_anthropic_id() {
        assert_eq!(ProviderKind::detect("anthropic"), ProviderKind::Anthropic);
    }

    #[test]
    fn detect_anthropic_for_minimax_id() {
        assert_eq!(ProviderKind::detect("minimax"), ProviderKind::Anthropic);
    }

    #[test]
    fn detect_deepseek_routes_to_dedicated_adapter() {
        assert_eq!(ProviderKind::detect("deepseek"), ProviderKind::DeepSeek);
    }

    #[test]
    fn detect_openai_responses_routes_to_dedicated_adapter() {
        assert_eq!(
            ProviderKind::detect("openai-responses"),
            ProviderKind::OpenAIResponses
        );
        assert_eq!(
            ProviderKind::detect("openai_responses"),
            ProviderKind::OpenAIResponses
        );
        // Plain "openai" must stay on Chat Completions — the Responses
        // wire shape is opt-in, not a replacement.
        assert_eq!(ProviderKind::detect("openai"), ProviderKind::OpenAICompat);
    }

    #[test]
    fn detect_codex_routes_to_dedicated_adapter() {
        assert_eq!(ProviderKind::detect("codex"), ProviderKind::Codex);
    }

    #[test]
    fn detect_openai_compat_for_others() {
        for id in [
            "glm",
            "openai",
            "fireworks",
            "lmstudio",
            "ollama",
            "custom",
            "totally-unknown",
        ] {
            assert_eq!(
                ProviderKind::detect(id),
                ProviderKind::OpenAICompat,
                "id {id} should map to OpenAI-compat"
            );
        }
    }

    #[test]
    fn detect_empty_provider_id_defaults_to_openai_compat() {
        assert_eq!(ProviderKind::detect(""), ProviderKind::OpenAICompat);
        assert_eq!(ProviderKind::detect("   "), ProviderKind::OpenAICompat);
    }

    #[test]
    fn factory_returns_arc_dyn_for_each_provider() {
        // The factory must not panic for any of these.
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config("anthropic"));
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config("minimax"));
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config("deepseek"));
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config("openai-responses"));
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config("codex"));
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config("glm"));
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config("openai"));
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config("custom"));
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config(""));
    }

    #[test]
    fn effective_keys_prefers_pool_dedups_and_falls_back() {
        // Pool + a distinct single key: order preserved, single key appended.
        let mut c = config("custom");
        c.api_key = "solo".into();
        c.api_keys = Some(vec!["a".into(), "b".into()]);
        assert_eq!(c.effective_keys(), vec!["a", "b", "solo"]);

        // Blanks dropped, duplicates removed (incl. the single key already
        // present in the pool).
        let mut c = config("custom");
        c.api_key = "a".into();
        c.api_keys = Some(vec!["a".into(), "  ".into(), "b".into(), "a".into()]);
        assert_eq!(c.effective_keys(), vec!["a", "b"]);

        // No pool → just the single key.
        let mut c = config("custom");
        c.api_key = "only".into();
        c.api_keys = None;
        assert_eq!(c.effective_keys(), vec!["only"]);
    }

    #[test]
    fn build_api_client_wraps_pool_for_multiple_keys() {
        // Two distinct keys must not panic and must build the pooled path.
        let mut c = config("custom");
        c.api_key = String::new();
        c.api_keys = Some(vec!["k1".into(), "k2".into()]);
        let _: Arc<dyn StreamingApiClient> = build_api_client(&c);

        // A single effective key must take the plain path (also no panic).
        let mut c = config("openai");
        c.api_key = "k1".into();
        c.api_keys = Some(vec!["k1".into()]);
        let _: Arc<dyn StreamingApiClient> = build_api_client(&c);
    }

    #[test]
    fn config_deserializes_from_camelcase_frontend_payload() {
        let json = serde_json::json!({
            "providerId": "anthropic",
            "baseUrl": "https://api.anthropic.com/v1",
            "apiKey": "sk-ant-...",
            "model": "claude-3-7-sonnet",
            "supportsThinking": true,
            "defaultTemperature": 0.7,
            "defaultMaxTokens": 4096,
        });
        let cfg: ProviderConfigSnapshot = serde_json::from_value(json).expect("deserialize");
        assert_eq!(cfg.provider_id, "anthropic");
        assert_eq!(cfg.base_url, "https://api.anthropic.com/v1");
        assert!(cfg.supports_thinking);
        assert_eq!(cfg.default_temperature, Some(0.7));
    }

    #[test]
    fn config_accepts_provider_type_in_both_cases() {
        for key in ["providerType", "provider_type"] {
            let json = serde_json::json!({
                "providerId": "25879d0f-72b3-4f56-875a-32254420d5ec",
                key: "minimax",
                "baseUrl": "https://api.minimax.chat",
                "apiKey": "xxx",
                "model": "abab",
            });
            let cfg: ProviderConfigSnapshot = serde_json::from_value(json).expect("deserialize");
            assert_eq!(cfg.provider_type.as_deref(), Some("minimax"), "key {key}");
            assert_eq!(cfg.effective_provider_type(), "minimax", "key {key}");
        }
    }

    /// The reported bug: a user adds a provider, picks "OpenAI Responses"
    /// as the API type, and Aurora posts Chat Completions anyway — because
    /// dispatch keyed on the row id, which for a user-added provider is a
    /// UUID that matches no known type.
    #[test]
    fn custom_provider_honours_selected_api_type_not_row_id() {
        let mut c = config("b1846984-2777-4815-8a29-90e29392a8e6");
        c.provider_type = Some("openai-responses".into());
        assert_eq!(
            ProviderKind::detect(c.effective_provider_type()),
            ProviderKind::OpenAIResponses,
        );

        // Every other family must survive a UUID row id too.
        for (api_type, expected) in [
            ("anthropic", ProviderKind::Anthropic),
            ("minimax", ProviderKind::Anthropic),
            ("deepseek", ProviderKind::DeepSeek),
            ("codex", ProviderKind::Codex),
            ("openai", ProviderKind::OpenAICompat),
            ("glm", ProviderKind::OpenAICompat),
            ("custom", ProviderKind::OpenAICompat),
        ] {
            let mut c = config("b1846984-2777-4815-8a29-90e29392a8e6");
            c.provider_type = Some(api_type.into());
            assert_eq!(
                ProviderKind::detect(c.effective_provider_type()),
                expected,
                "api type {api_type} must not be overridden by the row id",
            );
        }
    }

    #[test]
    fn effective_provider_type_falls_back_to_row_id_when_absent() {
        // Built-in rows (id == type) and pre-cutover payloads that never
        // send a type must keep working unchanged.
        let c = config("deepseek");
        assert_eq!(c.effective_provider_type(), "deepseek");
        assert_eq!(
            ProviderKind::detect(c.effective_provider_type()),
            ProviderKind::DeepSeek,
        );

        // A blank type is treated as absent, not as "unknown → OpenAI".
        let mut c = config("anthropic");
        c.provider_type = Some("   ".into());
        assert_eq!(c.effective_provider_type(), "anthropic");
    }
}
