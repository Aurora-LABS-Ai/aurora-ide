//! Dedicated DeepSeek streaming adapter.
//!
//! DeepSeek is technically an OpenAI-compatible API, but the official
//! documentation calls out a handful of differences that the generic
//! [`super::openai_compat::OpenAICompatAdapter`] can't express without
//! polluting the shared code path. This dedicated adapter keeps those
//! tweaks in one place:
//!
//! - **Thinking mode wire shape.** When `thinking_enabled`, DeepSeek
//!   expects `extra_body.thinking = {type: "enabled"}` **and** a
//!   `reasoning_effort` knob (`"high"` for regular requests, `"max"`
//!   for heavy agent runs). The legacy provider_kernel path already
//!   sets the first; we add the second here. DeepSeek's `low` and
//!   `medium` values are silently mapped to `high` server-side so
//!   they're useless from the client.
//!
//! - **Thinking-mode parameter scrub.** Per the docs, DeepSeek
//!   silently ignores `temperature`, `top_p`, `presence_penalty`,
//!   and `frequency_penalty` while thinking is on. Sending them is
//!   not a hard error, but stripping them keeps wire bodies clean
//!   and prevents accidental config drift if DeepSeek tightens this
//!   in the future.
//!
//! - **`stream_options.include_usage: true`** is force-enabled. Without
//!   it DeepSeek skips the usage chunk entirely, which means we never
//!   see `prompt_cache_hit_tokens` — the entire point of the
//!   integration. The shared builder already toggles this for
//!   `deepseek`, but the dedicated adapter re-asserts it as a defense
//!   against future regressions.
//!
//! - **Context-cache telemetry.** DeepSeek's
//!   `prompt_cache_hit_tokens` is a **subset** of `prompt_tokens`
//!   (the disk-cached portion). Anthropic's `cache_read_input_tokens`
//!   is **additive** to `input_tokens`. To keep
//!   `useContextStore.updateUsage` (which sums the two) numerically
//!   correct on both providers, we subtract the hit count from
//!   `input_tokens` before emitting the [`AssistantEvent::Usage`]
//!   frame. The original total stays recoverable as
//!   `input_tokens + cache_read_input_tokens`.
//!
//! - **`user_id` for KVCache isolation.** DeepSeek partitions its
//!   internal prefix cache per `user_id` (also drives scheduling and
//!   content-safety isolation). If the user has set one in their
//!   provider's `customParams.user_id`, it rides through unchanged.
//!   If not, we generate a deterministic one from a hash of the
//!   provider's base URL + model — stable across runs of the same
//!   workspace so the cache prefix can settle, opaque enough not to
//!   leak PII. Users who want a different bucket per workspace can
//!   override via `customParams.user_id`.
//!
//! - **Strict-tool beta endpoint.** When
//!   `customParams.aurora_strict_tools = true`, every emitted tool
//!   gets `function.strict = true` and the chat endpoint is rewritten
//!   to `<base>/beta/chat/completions`. Opt-in, off by default —
//!   strict mode validates the JSON schema server-side and rejects
//!   schemas DeepSeek doesn't support.
//!
//! The HTTP + SSE driver delegates to
//! [`super::openai_compat::drive_openai_stream`] so we share the
//! `tool_use` aggregation, the `SseFrameBuffer` byte-level frame
//! splitter, the cancellation-token plumbing, and the reasoning_content
//! → `Thinking` event mapping. The only thing we customize is the
//! outgoing request body (and the URL when strict mode is on).

#![allow(dead_code)]

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ApiRequest, StreamingApiClient, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;

use super::client::ProviderConfigSnapshot;
use super::openai_compat::drive_openai_stream;
use super::provider_kernel_adapter::{
    build_openai_body, build_openai_headers, build_openai_url, map_reqwest_error, map_status_error,
};

/// DeepSeek-specific reasoning-effort knob. Mirrors the doc's
/// `low | medium | high | max` schema with the documented client-side
/// collapse (`low` / `medium` → `high`, `xhigh` → `max`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeepSeekEffort {
    /// Server-side default for regular chat (`reasoning_effort: "high"`).
    High,
    /// Heavy agent runs — multi-tool reasoning, Claude-Code-style
    /// loops. Matches what DeepSeek's docs say the API auto-selects
    /// for OpenCode / Claude Code; we surface the knob so heavy
    /// Aurora agent turns get the same treatment.
    Max,
}

impl DeepSeekEffort {
    fn as_str(self) -> &'static str {
        match self {
            DeepSeekEffort::High => "high",
            DeepSeekEffort::Max => "max",
        }
    }

    /// Parse a user-supplied effort string. Unknown values fall back
    /// to [`Self::High`] (DeepSeek's documented default) so a typo in
    /// `customParams.aurora_reasoning_effort` doesn't break the call.
    fn from_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "max" | "xhigh" | "x-high" => DeepSeekEffort::Max,
            _ => DeepSeekEffort::High,
        }
    }
}

/// Streaming adapter for the DeepSeek provider.
///
/// Composes over the shared OpenAI-compat SSE driver — see the module
/// docs for the list of DeepSeek-specific tweaks applied on top.
pub struct DeepSeekAdapter {
    config: ProviderConfigSnapshot,
    http: reqwest::Client,
}

impl DeepSeekAdapter {
    pub fn new(config: ProviderConfigSnapshot) -> Self {
        let http = reqwest::Client::builder()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { config, http }
    }

    pub fn with_http_client(config: ProviderConfigSnapshot, http: reqwest::Client) -> Self {
        Self { config, http }
    }

    pub fn config(&self) -> &ProviderConfigSnapshot {
        &self.config
    }

    /// Build the wire-shape body to POST. Starts from the generic
    /// OpenAI body builder so reasoning_content replay, tool-call
    /// JSON shape, image markers etc. all stay consistent with the
    /// generic adapter — then applies the DeepSeek tweaks.
    fn build_body(&self, request: &ApiRequest<'_>) -> Value {
        let mut body = build_openai_body(request, &self.config);

        // build_openai_body returns Value::Object. We need a mutable
        // map; unwrap is safe because we just built it.
        let map = body
            .as_object_mut()
            .expect("build_openai_body returns Object");

        // Force-enable `stream_options.include_usage` so we always get
        // the `prompt_cache_hit_tokens` field on the closing chunk.
        // build_openai_body already adds this for `deepseek` via
        // should_request_stream_usage, but assert it here so the dedicated
        // adapter is correct even if a future refactor changes the helper.
        map.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );

        if request.thinking_enabled && self.config.supports_thinking {
            apply_thinking_tweaks(map, &self.config);
        }

        // user_id: respect a user-supplied custom param, otherwise
        // synthesize a stable bucket so DeepSeek's KVCache & scheduling
        // can converge on this workspace across runs.
        if !map.contains_key("user_id") {
            map.insert(
                "user_id".to_string(),
                Value::String(stable_user_id(&self.config)),
            );
        }

        // Strict-tool mode: opt-in via customParams. Rewrites each
        // `tools[].function.strict = true` and signals the caller to
        // route the request through the /beta endpoint.
        if strict_tools_enabled(&self.config) {
            if let Some(Value::Array(tools)) = map.get_mut("tools") {
                for tool in tools.iter_mut() {
                    if let Some(function) = tool.get_mut("function").and_then(Value::as_object_mut)
                    {
                        function.insert("strict".to_string(), Value::Bool(true));
                    }
                }
            }
        }

        body
    }

    /// Resolve the chat completions URL. Switches to the `/beta`
    /// branch when strict tool mode is enabled.
    fn resolve_url(&self) -> String {
        let base_url = if strict_tools_enabled(&self.config) {
            promote_to_beta(&self.config.base_url)
        } else {
            self.config.base_url.clone()
        };
        build_openai_url(&base_url)
    }
}

/// Apply DeepSeek's thinking-mode tweaks to the prepared body map:
///
/// - Force `thinking = {type: "enabled"}` (the generic builder will
///   only emit this when `config.supports_thinking` is true; we
///   re-assert here so a misconfigured snapshot doesn't drop it).
/// - Inject `reasoning_effort` (`high` / `max`), honoring
///   `customParams.aurora_reasoning_effort` if present.
/// - Strip the four sampling knobs the docs say DeepSeek ignores in
///   thinking mode (`temperature`, `top_p`, `presence_penalty`,
///   `frequency_penalty`). Leaving them in is technically harmless
///   (DeepSeek silently swallows them) but stripping keeps wire bodies
///   minimal and aligned with the official examples.
fn apply_thinking_tweaks(map: &mut Map<String, Value>, config: &ProviderConfigSnapshot) {
    map.insert("thinking".to_string(), json!({ "type": "enabled" }));

    // Respect an explicitly-configured effort. `build_openai_body` has already
    // merged `customParams` (including the composer's per-model `reasoning_effort`
    // and any manual extra-body fields) into the map, so if a value is present we
    // pass it through VERBATIM — `low` / `medium` / `high` / `xhigh` reach DeepSeek
    // exactly as the user set them. Only when nothing was provided do we fall back
    // to the documented default.
    if !map.contains_key("reasoning_effort") {
        let effort = resolve_effort(config);
        map.insert(
            "reasoning_effort".to_string(),
            Value::String(effort.as_str().to_string()),
        );
    }

    for key in &[
        "temperature",
        "top_p",
        "presence_penalty",
        "frequency_penalty",
    ] {
        map.remove(*key);
    }
}

/// Look up `customParams.aurora_reasoning_effort`. Defaults to
/// [`DeepSeekEffort::High`], which mirrors the DeepSeek docs'
/// "default effort is high for regular requests."
fn resolve_effort(config: &ProviderConfigSnapshot) -> DeepSeekEffort {
    config
        .custom_params
        .as_ref()
        .and_then(|p| p.get("aurora_reasoning_effort"))
        .and_then(Value::as_str)
        .map(DeepSeekEffort::from_str)
        .unwrap_or(DeepSeekEffort::High)
}

fn strict_tools_enabled(config: &ProviderConfigSnapshot) -> bool {
    config
        .custom_params
        .as_ref()
        .and_then(|p| p.get("aurora_strict_tools"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Promote `https://api.deepseek.com` or `https://api.deepseek.com/v1`
/// to the documented Beta branch `https://api.deepseek.com/beta`.
/// Already-`/beta`-rooted URLs round-trip unchanged.
fn promote_to_beta(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.contains("/beta") {
        return trimmed.to_string();
    }
    // Strip an optional `/v1` segment first — the official strict-mode
    // example uses `https://api.deepseek.com/beta`, not `/v1/beta`.
    let stripped = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    format!("{stripped}/beta")
}

/// Stable, opaque `user_id` derived from the provider config so
/// DeepSeek's KVCache & scheduling buckets the same workspace's
/// requests together across runs. Hashing the `base_url:model` pair
/// gives:
///
/// - Stable across app restarts (same workspace → same id)
/// - Different per logical "tier" the user has configured (e.g.
///   one preset for `deepseek-v4-pro`, another for `deepseek-v4-flash`)
/// - PII-free (no path, no machine id, no API key bytes)
///
/// Truncated to 32 hex characters to stay well under DeepSeek's 512-char
/// `user_id` limit and the `[a-zA-Z0-9\-_]+` regex.
fn stable_user_id(config: &ProviderConfigSnapshot) -> String {
    let mut hasher = DefaultHasher::new();
    "aurora-deepseek-v1".hash(&mut hasher);
    config.base_url.hash(&mut hasher);
    config.model.hash(&mut hasher);
    let digest = hasher.finish();
    format!("aurora-{digest:016x}")
}

#[async_trait]
impl StreamingApiClient for DeepSeekAdapter {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        if cancel_token.is_cancelled() {
            return Err(ApiError::Cancelled);
        }

        let url = self.resolve_url();
        let headers = build_openai_headers(&self.config)?;
        let body = self.build_body(&request);

        let response = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => return Err(ApiError::Cancelled),
            result = self.http.post(&url).headers(headers).json(&body).send() => match result {
                Ok(resp) => resp,
                Err(err) => return Err(map_reqwest_error(err)),
            }
        };

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(map_status_error(status.as_u16(), body));
        }

        let bytes_stream = response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

        drive_openai_stream(bytes_stream, event_sink, cancel_token).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn base_config() -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: "deepseek".into(),
            provider_type: None,
            base_url: "https://api.deepseek.com/v1".into(),
            api_key: "test-key".into(),
            api_keys: None,
            model: "deepseek-v4-pro".into(),
            custom_headers: None,
            custom_params: None,
            default_temperature: Some(1.0),
            default_max_tokens: Some(4096),
            supports_thinking: true,
            supports_vision: false,
        }
    }

    fn empty_request() -> ApiRequest<'static> {
        ApiRequest {
            model: "deepseek:deepseek-v4-pro",
            system_prompt: None,
            messages: &[],
            tools: &[],
            temperature: Some(0.7),
            max_output_tokens: 1024,
            thinking_enabled: true,
            thinking_budget_tokens: None,
        }
    }

    #[test]
    fn thinking_mode_drops_temperature_and_adds_reasoning_effort() {
        let adapter = DeepSeekAdapter::new(base_config());
        let body = adapter.build_body(&empty_request());
        assert_eq!(
            body.get("reasoning_effort").and_then(Value::as_str),
            Some("high"),
            "default thinking effort must be 'high'"
        );
        assert!(
            body.get("temperature").is_none(),
            "temperature must be stripped in thinking mode"
        );
        assert!(
            body.get("top_p").is_none(),
            "top_p must be stripped in thinking mode"
        );
        assert_eq!(
            body.get("thinking"),
            Some(&json!({"type": "enabled"})),
            "thinking block must be present"
        );
        assert_eq!(
            body.get("stream_options"),
            Some(&json!({"include_usage": true})),
            "stream_options.include_usage must be forced on"
        );
    }

    #[test]
    fn thinking_off_keeps_temperature() {
        let adapter = DeepSeekAdapter::new(base_config());
        let mut req = empty_request();
        req.thinking_enabled = false;
        let body = adapter.build_body(&req);
        assert!(
            body.get("temperature").is_some(),
            "temperature must survive when thinking is off"
        );
        assert!(
            body.get("reasoning_effort").is_none(),
            "reasoning_effort must not appear outside thinking mode"
        );
        assert!(
            body.get("thinking").is_none(),
            "thinking block must not appear when thinking is off"
        );
    }

    #[test]
    fn custom_params_can_promote_effort_to_max() {
        let mut config = base_config();
        let mut params = HashMap::new();
        params.insert(
            "aurora_reasoning_effort".to_string(),
            Value::String("max".to_string()),
        );
        config.custom_params = Some(params);
        let adapter = DeepSeekAdapter::new(config);
        let body = adapter.build_body(&empty_request());
        assert_eq!(
            body.get("reasoning_effort").and_then(Value::as_str),
            Some("max")
        );
    }

    #[test]
    fn effort_unknown_falls_back_to_high() {
        let mut config = base_config();
        let mut params = HashMap::new();
        params.insert(
            "aurora_reasoning_effort".to_string(),
            Value::String("turbo".to_string()),
        );
        config.custom_params = Some(params);
        let adapter = DeepSeekAdapter::new(config);
        let body = adapter.build_body(&empty_request());
        assert_eq!(
            body.get("reasoning_effort").and_then(Value::as_str),
            Some("high"),
            "unknown effort must fall back to 'high'"
        );
    }

    #[test]
    fn stable_user_id_is_deterministic_across_calls() {
        let adapter_a = DeepSeekAdapter::new(base_config());
        let adapter_b = DeepSeekAdapter::new(base_config());
        let body_a = adapter_a.build_body(&empty_request());
        let body_b = adapter_b.build_body(&empty_request());
        assert_eq!(body_a["user_id"], body_b["user_id"]);
        assert!(
            body_a["user_id"]
                .as_str()
                .map(|s| s.starts_with("aurora-"))
                .unwrap_or(false),
            "stable user_id must be prefixed for traceability"
        );
    }

    #[test]
    fn stable_user_id_changes_per_model() {
        let adapter_a = DeepSeekAdapter::new(base_config());
        let mut cfg_b = base_config();
        cfg_b.model = "deepseek-v4-flash".to_string();
        let adapter_b = DeepSeekAdapter::new(cfg_b);
        let body_a = adapter_a.build_body(&empty_request());
        let body_b = adapter_b.build_body(&empty_request());
        assert_ne!(
            body_a["user_id"], body_b["user_id"],
            "different models should produce different user_id buckets"
        );
    }

    #[test]
    fn user_supplied_user_id_wins_over_synthesized_default() {
        let mut config = base_config();
        let mut params = HashMap::new();
        params.insert(
            "user_id".to_string(),
            Value::String("alvan-prod".to_string()),
        );
        config.custom_params = Some(params);
        let adapter = DeepSeekAdapter::new(config);
        let body = adapter.build_body(&empty_request());
        assert_eq!(body["user_id"].as_str(), Some("alvan-prod"));
    }

    #[test]
    fn strict_mode_toggles_tools_and_url() {
        let mut config = base_config();
        let mut params = HashMap::new();
        params.insert("aurora_strict_tools".to_string(), Value::Bool(true));
        config.custom_params = Some(params);
        let adapter = DeepSeekAdapter::new(config);

        let request_tools = vec![crate::agent_runtime::api_client::ToolSchema {
            name: "get_weather".into(),
            description: "weather for a city".into(),
            input_schema: json!({
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
                "additionalProperties": false,
            }),
        }];
        let request = ApiRequest {
            model: "deepseek:deepseek-v4-pro",
            system_prompt: None,
            messages: &[],
            tools: &request_tools,
            temperature: Some(0.7),
            max_output_tokens: 1024,
            thinking_enabled: false,
            thinking_budget_tokens: None,
        };

        let body = adapter.build_body(&request);
        let tools = body
            .get("tools")
            .and_then(Value::as_array)
            .expect("tools array");
        let strict = tools[0]["function"]["strict"].as_bool();
        assert_eq!(strict, Some(true), "strict mode must add strict:true");

        assert_eq!(
            adapter.resolve_url(),
            "https://api.deepseek.com/beta/chat/completions",
            "strict mode must route through /beta endpoint"
        );
    }

    #[test]
    fn promote_to_beta_handles_v1_and_already_beta_inputs() {
        assert_eq!(
            promote_to_beta("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/beta"
        );
        assert_eq!(
            promote_to_beta("https://api.deepseek.com/"),
            "https://api.deepseek.com/beta"
        );
        assert_eq!(
            promote_to_beta("https://api.deepseek.com/beta"),
            "https://api.deepseek.com/beta"
        );
    }

    #[test]
    fn non_strict_mode_uses_v1_endpoint() {
        let adapter = DeepSeekAdapter::new(base_config());
        assert_eq!(
            adapter.resolve_url(),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }
}
