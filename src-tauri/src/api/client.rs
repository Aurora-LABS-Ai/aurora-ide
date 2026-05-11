//! Provider config snapshot and the [`build_api_client`] factory.
//!
//! [`ProviderConfigSnapshot`] is a frozen, plain-Rust view of one
//! Aurora LLM provider's configuration — what the [`StreamingApiClient`]
//! impls need to actually fire a streaming HTTP request. It deserializes
//! from the camelCase JSON the frontend already sends to
//! `aurora_provider_*` so the Tauri command surface (Implementer E) can
//! pass the existing payload through unchanged.
//!
//! The factory dispatches purely on `provider_id` (no `base_url`
//! introspection — that path is brittle, and the frontend always sets
//! `provider_id` from a known preset). `provider_id` of `"anthropic"`
//! or `"minimax"` returns an [`AnthropicAdapter`]; everything else
//! (including empty / unknown ids) returns an [`OpenAICompatAdapter`].
//!
//! [`StreamingApiClient`]: crate::agent_runtime::api_client::StreamingApiClient

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_runtime::api_client::StreamingApiClient;

use super::anthropic::AnthropicAdapter;
use super::openai_compat::OpenAICompatAdapter;

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
    /// Frontend-managed provider identifier. Used by [`build_api_client`]
    /// to choose the adapter. Examples: `"anthropic"`, `"minimax"`,
    /// `"deepseek"`, `"glm"`, `"openai"`, `"fireworks"`, `"lmstudio"`,
    /// `"ollama"`, `"custom"`.
    #[serde(default, alias = "provider_type", alias = "providerType")]
    pub provider_id: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
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
    /// Does the active model accept image content blocks?
    /// `true` switches the API adapter into vision mode for tool
    /// results (Anthropic uses native multimodal `tool_result`,
    /// OpenAI-compat emits a content array with `image_url` blocks).
    /// `false` strips screenshot markers down to a placeholder so the
    /// model isn't poisoned with unusable base64.
    #[serde(default)]
    pub supports_vision: bool,
}

/// Wire-shape kind chosen by the factory. Distinct from `provider_id`
/// because two ids share the Anthropic shape (`anthropic`, `minimax`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Anthropic,
    OpenAICompat,
}

impl ProviderKind {
    /// Decide kind purely from `provider_id`. Empty / unknown → OpenAI.
    #[must_use]
    pub fn detect(provider_id: &str) -> Self {
        match provider_id.trim() {
            "anthropic" | "minimax" => ProviderKind::Anthropic,
            _ => ProviderKind::OpenAICompat,
        }
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
    match ProviderKind::detect(&config.provider_id) {
        ProviderKind::Anthropic => Arc::new(AnthropicAdapter::new(config.clone())),
        ProviderKind::OpenAICompat => Arc::new(OpenAICompatAdapter::new(config.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider_id: &str) -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: provider_id.to_string(),
            base_url: "https://example.test".into(),
            api_key: "key".into(),
            model: "any".into(),
            custom_headers: None,
            custom_params: None,
            default_temperature: None,
            default_max_tokens: None,
            supports_thinking: false,
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
    fn detect_openai_compat_for_others() {
        for id in [
            "deepseek",
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
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config("glm"));
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config("openai"));
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config("custom"));
        let _: Arc<dyn StreamingApiClient> = build_api_client(&config(""));
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
    fn config_accepts_provider_type_alias() {
        // The existing aurora frontend payload uses `providerType` /
        // `provider_type`; our serde alias maps both onto `provider_id`.
        let json = serde_json::json!({
            "providerType": "minimax",
            "baseUrl": "https://api.minimax.chat",
            "apiKey": "xxx",
            "model": "abab",
        });
        let cfg: ProviderConfigSnapshot = serde_json::from_value(json).expect("deserialize");
        assert_eq!(cfg.provider_id, "minimax");
    }
}
