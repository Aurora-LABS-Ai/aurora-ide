//! Dedicated DeepSeek streaming adapter.
//!
//! DeepSeek is technically an OpenAI-compatible API, but the official
//! documentation calls out a handful of differences that the generic
//! [`super::openai_compat::OpenAICompatAdapter`] can't express without
//! polluting the shared code path. This dedicated adapter keeps those
//! tweaks in one place:
//!
//! - **Thinking mode wire shape.** When the canonical reasoning request is enabled, DeepSeek
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
//!
//! # Three wires, one account
//!
//! DeepSeek serves the same models and the same key on three request
//! shapes, and the row's `provider_type` picks which one Aurora speaks:
//!
//! | type | endpoint | adapter |
//! |---|---|---|
//! | `deepseek` | `https://api.deepseek.com/v1/chat/completions` | this file |
//! | `deepseek-messages` | `https://api.deepseek.com/anthropic/v1/messages` | [`super::anthropic`] |
//! | `deepseek-responses` | `https://api.deepseek.com/v1/responses` | [`super::responses`] |
//!
//! All three were measured against a live account on 2026-09-20. Each one
//! needs the same three DeepSeek-specific things said in its own vocabulary,
//! which is what [`apply_messages_tweaks`] and [`apply_responses_tweaks`]
//! exist for:
//!
//! - **Thinking is ON by default and has to be turned OFF explicitly.**
//!   Every other provider Aurora talks to treats an absent thinking field as
//!   "don't think". DeepSeek treats it as "think, at effort `high`" — a
//!   request with no `thinking` key came back with `reasoning_content` and 26
//!   reasoning tokens. So "thinking off" in the composer has to be spelled
//!   out: `{"thinking": {"type": "disabled"}}` on the chat and Messages
//!   wires, `{"reasoning": {"effort": "none"}}` on Responses. Without it the
//!   switch in Aurora's UI did nothing here.
//! - **The effort knob has a different name on each wire.**
//!   `reasoning_effort` (chat), `output_config.effort` (Messages — DeepSeek
//!   ignores Anthropic's `thinking.budget_tokens` entirely), `reasoning.effort`
//!   (Responses).
//! - **`user_id` buckets the KV cache**, and rides in a different place again:
//!   top-level on chat, `metadata.user_id` on Messages, `user` on Responses.
//!
//! # Cache telemetry, per wire
//!
//! All three report it, in two different conventions — measured on one 4,033
//! token prefix sent twice:
//!
//! - chat: `prompt_cache_hit_tokens: 3840` **inside** `prompt_tokens: 4033`
//! - Responses: `input_tokens_details.cached_tokens: 3840` **inside**
//!   `input_tokens: 4033`
//! - Messages: `cache_read_input_tokens: 3840` **beside** `input_tokens: 193`
//!
//! Aurora's UI math is Anthropic's (the cache figure ADDS to the input), so
//! the two OpenAI-shaped wires subtract the hit count before emitting `Usage`
//! and the Messages wire needs no correction. That already happens in
//! [`super::openai_compat`] and [`super::responses`]; it is written down here
//! because it is the one number that looks the same on all three wires and
//! means something different on two of them.

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
    build_openai_body, build_openai_headers, build_openai_url, map_reqwest_error,
    map_status_error_with_headers, unprefix_model, RequestOrigin,
};

/// Chat Completions — the default wire, and the one this adapter drives.
pub const DEEPSEEK_PROVIDER_TYPE: &str = "deepseek";
/// Anthropic Messages, served at `<base>/anthropic`.
pub const DEEPSEEK_MESSAGES_TYPE: &str = "deepseek-messages";
/// OpenAI Responses, served at `<base>/responses`.
pub const DEEPSEEK_RESPONSES_TYPE: &str = "deepseek-responses";

/// Whether this provider type is one of DeepSeek's three wires.
#[must_use]
pub fn is_deepseek_type(provider_type: &str) -> bool {
    let t = provider_type.trim();
    t.eq_ignore_ascii_case(DEEPSEEK_PROVIDER_TYPE)
        || t.eq_ignore_ascii_case(DEEPSEEK_MESSAGES_TYPE)
        || t.eq_ignore_ascii_case(DEEPSEEK_RESPONSES_TYPE)
}

/// Whether this provider type is DeepSeek on the Anthropic Messages wire.
#[must_use]
pub fn is_messages_wire(provider_type: &str) -> bool {
    provider_type.trim().eq_ignore_ascii_case(DEEPSEEK_MESSAGES_TYPE)
}

/// Whether this provider type is DeepSeek on the OpenAI Responses wire.
#[must_use]
pub fn is_responses_wire(provider_type: &str) -> bool {
    provider_type.trim().eq_ignore_ascii_case(DEEPSEEK_RESPONSES_TYPE)
}

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

        if request.reasoning.enabled && self.config.supports_thinking {
            apply_thinking_tweaks(map, &self.config);
        } else {
            // Said out loud, because silence means the opposite here. DeepSeek
            // thinks by DEFAULT at effort `high`: a request carrying no
            // `thinking` key came back with `reasoning_content` and 26
            // reasoning tokens (measured 2026-09-20). Every other
            // OpenAI-shaped provider Aurora talks to reads an absent field as
            // "off", so until this branch existed the composer's thinking
            // switch was decorative on DeepSeek — the model reasoned, and the
            // user paid for it, whatever the UI said.
            map.insert("thinking".to_string(), json!({ "type": "disabled" }));
            map.remove("reasoning_effort");
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

/// The effort DeepSeek will actually honour, from Aurora's canonical request.
///
/// DeepSeek accepts `low | high | max` and publishes the collapse for
/// everything else (`minimal` → low, `medium` / `xhigh` → high, `ultra` →
/// max). Doing that mapping here rather than passing a value through means
/// the Messages and Responses wires — whose effort fields are typed enums,
/// not free strings — never carry a word DeepSeek has to guess at.
fn deepseek_effort(request: &ApiRequest<'_>, config: &ProviderConfigSnapshot) -> &'static str {
    match request.reasoning.effort {
        Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "minimal" | "low" => "low",
            "max" | "ultra" => "max",
            _ => "high",
        },
        None => resolve_effort(config).as_str(),
    }
}

/// `metadata.user_id` / `user` — the KVCache bucket, if nobody set one.
fn user_id_for(config: &ProviderConfigSnapshot) -> String {
    config
        .custom_params
        .as_ref()
        .and_then(|p| p.get("user_id").or_else(|| p.get("user")))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| stable_user_id(config))
}

/// DeepSeek's dialect of the Anthropic Messages body, applied in place.
///
/// Called from [`super::provider_kernel_adapter::build_anthropic_body`] just
/// before the user's own `customParams` are merged, so anything set by hand
/// still wins. Four differences from Anthropic proper, all measured against a
/// live account on 2026-09-20:
///
/// - **`thinking.budget_tokens` is ignored**, and `output_config.effort` is
///   the knob that works. Aurora's Anthropic builder derives a budget and then
///   raises `max_tokens` to cover it — correct on Anthropic, where reasoning
///   bills against the same cap, and pure inflation here. The cap is put back
///   to what the turn actually asked for.
/// - **Thinking is on unless disabled.** `{"type": "disabled"}` returned a
///   reply with no `thinking` block; omitting the field returned one.
/// - **`metadata.user_id`** is where the KVCache bucket rides on this wire.
/// - **`cache_control` is ignored** — DeepSeek caches automatically. Nothing
///   to do, because `supports_prompt_caching` already excludes this type, so
///   no breakpoints are written in the first place.
pub fn apply_messages_tweaks(
    body: &mut Map<String, Value>,
    request: &ApiRequest<'_>,
    config: &ProviderConfigSnapshot,
) {
    if request.reasoning.enabled && config.supports_thinking {
        body.insert("thinking".to_string(), json!({ "type": "enabled" }));
        body.insert(
            "output_config".to_string(),
            json!({ "effort": deepseek_effort(request, config) }),
        );
    } else {
        body.insert("thinking".to_string(), json!({ "type": "disabled" }));
        body.remove("output_config");
    }

    // The budget is ignored on the wire, so the cap raised to cover it is
    // headroom nothing will use — and on a 384K-output model that is a lot of
    // imaginary headroom for the runtime to reason about.
    body.insert(
        "max_tokens".to_string(),
        Value::from(request.max_output_tokens.max(1)),
    );

    let metadata = body
        .entry("metadata".to_string())
        .or_insert_with(|| json!({}));
    if let Some(obj) = metadata.as_object_mut() {
        obj.entry("user_id".to_string())
            .or_insert_with(|| Value::String(user_id_for(config)));
    }
}

/// DeepSeek's dialect of the Responses body, applied in place.
///
/// Called from [`super::responses::build_responses_body`] just before the
/// user's own `customParams` are merged. Measured 2026-09-20:
///
/// - **`reasoning.effort: "none"` is how thinking is turned off** here, and
///   the only way: a body with no `reasoning` object reasoned anyway.
/// - **`user`** carries the KVCache bucket on this wire.
/// - `include`, `prompt_cache_key`, `store` and `parallel_tool_calls` are
///   accepted and ignored, so they are left alone — a body DeepSeek silently
///   drops is not worth a branch, and stripping them would cost the shared
///   builder a special case for no gain.
pub fn apply_responses_tweaks(
    body: &mut Map<String, Value>,
    request: &ApiRequest<'_>,
    config: &ProviderConfigSnapshot,
) {
    if request.reasoning.enabled && config.supports_thinking {
        body.insert(
            "reasoning".to_string(),
            json!({ "effort": deepseek_effort(request, config) }),
        );
    } else {
        body.insert("reasoning".to_string(), json!({ "effort": "none" }));
    }
    body.entry("user".to_string())
        .or_insert_with(|| Value::String(user_id_for(config)));
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
            // See the note in `anthropic.rs`: headers first, because `text()`
            // takes the response and a 429's `Retry-After` goes with it.
            let headers = response.headers().clone();
            let body = response.text().await.unwrap_or_default();
            return Err(map_status_error_with_headers(
                status.as_u16(),
                body,
                &headers,
                RequestOrigin {
                    url: &url,
                    model: unprefix_model(request.model, &self.config.provider_id),
                },
            ));
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
            reasoning: None,
            supports_vision: false,
        }
    }

    fn empty_request() -> ApiRequest<'static> {
        ApiRequest {
            model: "deepseek:deepseek-v4-pro",
            system_prompt: None,
            messages: &[],
            tools: &[],
            tool_choice: Default::default(),
            temperature: Some(0.7),
            max_output_tokens: 1024,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest {
                enabled: true,
                control: crate::agent_runtime::api_client::ReasoningControl::Toggle,
                ..crate::agent_runtime::api_client::ReasoningRequest::disabled()
            },
            tool_bridge: None,
            session_key: None,        }
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
    fn canonical_effort_keeps_deepseek_thinking_enabled() {
        let adapter = DeepSeekAdapter::new(base_config());
        let mut request = empty_request();
        request.reasoning = crate::agent_runtime::api_client::ReasoningRequest {
            enabled: true,
            control: crate::agent_runtime::api_client::ReasoningControl::Effort,
            effort: Some("max"),
            request_mode: crate::agent_runtime::api_client::ReasoningRequestMode::OpenaiEffort,
            ..crate::agent_runtime::api_client::ReasoningRequest::disabled()
        };

        let body = adapter.build_body(&request);

        assert_eq!(body["reasoning_effort"], "max");
        assert_eq!(body["thinking"], json!({"type": "enabled"}));
        assert!(body.get("temperature").is_none());
    }

    /// The switch in the composer has to reach the wire.
    ///
    /// DeepSeek reasons unless told not to — a request with no `thinking` key
    /// came back with `reasoning_content` and 26 reasoning tokens. Omitting
    /// the field, which is what every other OpenAI-shaped adapter does for
    /// "off", left the model thinking and the user paying for it.
    #[test]
    fn thinking_off_is_stated_rather_than_omitted() {
        let adapter = DeepSeekAdapter::new(base_config());
        let mut req = empty_request();
        req.reasoning.enabled = false;
        let body = adapter.build_body(&req);
        assert_eq!(body["thinking"], json!({ "type": "disabled" }));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn messages_wire_uses_output_config_and_drops_the_budget_inflated_cap() {
        let mut config = base_config();
        config.provider_type = Some(DEEPSEEK_MESSAGES_TYPE.to_string());
        let mut request = empty_request();
        request.reasoning = crate::agent_runtime::api_client::ReasoningRequest {
            enabled: true,
            control: crate::agent_runtime::api_client::ReasoningControl::Effort,
            effort: Some("max"),
            ..crate::agent_runtime::api_client::ReasoningRequest::disabled()
        };
        request.max_output_tokens = 4096;

        let mut body = Map::new();
        // What the shared Anthropic builder leaves behind: a budget DeepSeek
        // ignores, and a cap raised to cover it.
        body.insert(
            "thinking".to_string(),
            json!({ "type": "enabled", "budget_tokens": 12_000 }),
        );
        body.insert("max_tokens".to_string(), Value::from(16_096));
        apply_messages_tweaks(&mut body, &request, &config);

        assert_eq!(body["thinking"], json!({ "type": "enabled" }));
        assert_eq!(body["output_config"], json!({ "effort": "max" }));
        assert_eq!(
            body["max_tokens"], 4096,
            "the cap raised to cover an ignored budget must be put back"
        );
        assert!(body["metadata"]["user_id"]
            .as_str()
            .is_some_and(|s| s.starts_with("aurora-")));
    }

    #[test]
    fn messages_wire_turns_thinking_off_explicitly() {
        let mut config = base_config();
        config.provider_type = Some(DEEPSEEK_MESSAGES_TYPE.to_string());
        let mut request = empty_request();
        request.reasoning = crate::agent_runtime::api_client::ReasoningRequest::disabled();

        let mut body = Map::new();
        apply_messages_tweaks(&mut body, &request, &config);

        assert_eq!(body["thinking"], json!({ "type": "disabled" }));
        assert!(body.get("output_config").is_none());
    }

    #[test]
    fn messages_wire_keeps_a_user_supplied_bucket() {
        let mut config = base_config();
        config.provider_type = Some(DEEPSEEK_MESSAGES_TYPE.to_string());
        let mut params = HashMap::new();
        params.insert("user_id".to_string(), Value::String("alvan-prod".into()));
        config.custom_params = Some(params);

        let mut body = Map::new();
        apply_messages_tweaks(&mut body, &empty_request(), &config);
        assert_eq!(body["metadata"]["user_id"], "alvan-prod");
    }

    #[test]
    fn responses_wire_spells_thinking_off_as_effort_none() {
        let mut config = base_config();
        config.provider_type = Some(DEEPSEEK_RESPONSES_TYPE.to_string());
        let mut request = empty_request();
        request.reasoning = crate::agent_runtime::api_client::ReasoningRequest::disabled();

        let mut body = Map::new();
        // The shared builder's summary block, which DeepSeek accepts and never
        // fills — it must not survive as a reason to keep reasoning on.
        body.insert("reasoning".to_string(), json!({ "summary": "auto" }));
        apply_responses_tweaks(&mut body, &request, &config);

        assert_eq!(body["reasoning"], json!({ "effort": "none" }));
        assert!(body["user"].as_str().is_some_and(|s| s.starts_with("aurora-")));
    }

    #[test]
    fn effort_words_deepseek_does_not_take_are_collapsed_before_they_ship() {
        // `medium` and `xhigh` are Aurora vocabulary; DeepSeek's enum is
        // low/high/max, and the Messages and Responses fields are typed.
        let mut config = base_config();
        config.provider_type = Some(DEEPSEEK_RESPONSES_TYPE.to_string());
        for (asked, expected) in [
            ("minimal", "low"),
            ("low", "low"),
            ("medium", "high"),
            ("high", "high"),
            ("xhigh", "high"),
            ("max", "max"),
            ("ultra", "max"),
        ] {
            let mut request = empty_request();
            request.reasoning = crate::agent_runtime::api_client::ReasoningRequest {
                enabled: true,
                control: crate::agent_runtime::api_client::ReasoningControl::Effort,
                effort: Some(asked),
                ..crate::agent_runtime::api_client::ReasoningRequest::disabled()
            };
            let mut body = Map::new();
            apply_responses_tweaks(&mut body, &request, &config);
            assert_eq!(body["reasoning"]["effort"], expected, "asked for {asked}");
        }
    }

    #[test]
    fn thinking_off_keeps_temperature() {
        let adapter = DeepSeekAdapter::new(base_config());
        let mut req = empty_request();
        req.reasoning.enabled = false;
        let body = adapter.build_body(&req);
        assert!(
            body.get("temperature").is_some(),
            "temperature must survive when thinking is off"
        );
        assert!(
            body.get("reasoning_effort").is_none(),
            "reasoning_effort must not appear outside thinking mode"
        );
        assert_eq!(
            body["thinking"],
            json!({ "type": "disabled" }),
            "an absent thinking block means ON at DeepSeek, so off is stated"
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
            tool_choice: Default::default(),
            temperature: Some(0.7),
            max_output_tokens: 1024,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: None,        };

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
