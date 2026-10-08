//! [`AnthropicApiAdapter`] — Messages streaming against Anthropic's own API.
//!
//! Reuses the Anthropic builders wholesale ([`build_anthropic_body`],
//! [`build_anthropic_headers`], [`drive_anthropic_stream_detailed`]); what is
//! first-party is confined to [`build_anthropic_api_body`] and the beta header
//! it implies, plus saying so when a refusal fallback served the reply. See the
//! module root for why each addition exists.

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ApiRequest, StreamingApiClient, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;

use super::{
    binds_thinking, has_server_fallback, normalized, wants_hour_cache, SERVER_FALLBACK_BETA,
    THINKING_BINDING_BETA,
};
use crate::api::anthropic::drive_anthropic_stream_detailed;
use crate::api::client::ProviderConfigSnapshot;
use crate::api::provider_kernel_adapter::{
    build_anthropic_body, build_anthropic_headers, build_anthropic_url, map_reqwest_error,
    map_status_error_with_headers, unprefix_model, RequestOrigin,
};

pub struct AnthropicApiAdapter {
    config: ProviderConfigSnapshot,
    http: reqwest::Client,
}

impl AnthropicApiAdapter {
    pub fn new(config: ProviderConfigSnapshot) -> Self {
        // Same client shape as the other Messages adapters: no compression (it
        // breaks SSE chunk timing) and keepalives instead of a request timeout,
        // because a long think is legitimate silence.
        let http = reqwest::Client::builder()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .tcp_keepalive(std::time::Duration::from_secs(30))
            .http2_keep_alive_interval(std::time::Duration::from_secs(20))
            .http2_keep_alive_timeout(std::time::Duration::from_secs(20))
            .http2_keep_alive_while_idle(true)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { config, http }
    }
}

/// The Messages body for Anthropic's own API, and the beta flags it needs.
///
/// Anything the person set by hand in the row's extra request fields has
/// already been merged by `build_anthropic_body` and wins: a field that is
/// already present is left alone.
pub(crate) fn build_anthropic_api_body(
    request: &ApiRequest<'_>,
    config: &ProviderConfigSnapshot,
) -> (Value, Vec<&'static str>) {
    let mut body = build_anthropic_body(request, config);
    let mut betas: Vec<&'static str> = Vec::new();
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(request.model)
        .to_string();
    let Some(obj) = body.as_object_mut() else {
        return (body, betas);
    };

    if binds_thinking(&model) {
        // These models always reason, so the builder already sent adaptive
        // thinking; absent means a hand-set field removed it, and adaptive is
        // what omitting it runs anyway.
        let thinking = obj
            .entry("thinking")
            .or_insert_with(|| json!({ "type": "adaptive" }));
        // Only beside adaptive thinking. Next to `disabled` (Haiku 5.5 accepts
        // that) the control is a 400, and with thinking off there are no new
        // blocks to bind.
        let adaptive = thinking.get("type").and_then(Value::as_str) == Some("adaptive");
        if let (true, Some(thinking)) = (adaptive, thinking.as_object_mut()) {
            thinking
                .entry("block_binding")
                .or_insert_with(|| json!({ "prefix_mismatch_behavior": "drop_block" }));
            betas.push(THINKING_BINDING_BETA);
        }
    }

    if has_server_fallback(&model) && !obj.contains_key("fallbacks") {
        obj.insert("fallbacks".to_string(), Value::String("default".into()));
        betas.push(SERVER_FALLBACK_BETA);
    }

    if wants_hour_cache(config) {
        hold_cache_for_an_hour(&mut body);
    }

    (body, betas)
}

/// Mark every cache breakpoint the builder placed as a one-hour cache.
///
/// The builder already chose WHERE they go (last tool, the static half of the
/// system prompt, the tail of the conversation); this only changes how long
/// each lives. All of them, so the setting means what it says — a pause under
/// an hour re-bills nothing. Anthropic requires one-hour breakpoints to come
/// before five-minute ones; with every marker at one hour there is no order
/// to violate.
fn hold_cache_for_an_hour(body: &mut Value) {
    fn mark(block: &mut Value) {
        if let Some(cache) = block.get_mut("cache_control").and_then(Value::as_object_mut) {
            cache.insert("ttl".to_string(), Value::String("1h".into()));
        }
    }
    for key in ["tools", "system"] {
        if let Some(Value::Array(blocks)) = body.get_mut(key) {
            blocks.iter_mut().for_each(mark);
        }
    }
    if let Some(Value::Array(messages)) = body.get_mut("messages") {
        for message in messages {
            if let Some(Value::Array(content)) = message.get_mut("content") {
                content.iter_mut().for_each(mark);
            }
        }
    }
}

/// Add `betas` to whatever `anthropic-beta` value the row already sends.
///
/// A row's custom headers may carry their own beta flags; replacing that
/// header would silently switch them off, so the lists are joined.
fn merge_beta_header(headers: &mut HeaderMap, betas: &[&str]) -> Result<(), ApiError> {
    if betas.is_empty() {
        return Ok(());
    }
    let mut flags: Vec<String> = headers
        .get("anthropic-beta")
        .and_then(|v| v.to_str().ok())
        .map(|existing| {
            existing
                .split(',')
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    for beta in betas {
        if !flags.iter().any(|f| f == beta) {
            flags.push((*beta).to_string());
        }
    }
    let value = HeaderValue::from_str(&flags.join(","))
        .map_err(|e| ApiError::InvalidRequest(format!("invalid anthropic-beta header: {e}")))?;
    headers.insert("anthropic-beta", value);
    Ok(())
}

/// Did a model other than the requested one write this reply?
///
/// After a refusal fallback Anthropic keeps sending a conversation to the
/// fallback model for about an hour, and those replies carry no `fallback`
/// block. `message_start` still names the model that ran, and the person
/// picked a different one, so it has to be said.
fn served_by_another_model(requested: &str, served: Option<&str>) -> Option<String> {
    let served = served?.trim();
    if served.is_empty() {
        return None;
    }
    let requested = normalized(requested);
    let served_id = normalized(served);
    // A dated snapshot of the requested model is the requested model. Only a
    // date: `claude-opus-5-5` is not a snapshot of `claude-opus-5`.
    let is_snapshot = served_id
        .strip_prefix(&format!("{requested}-"))
        .is_some_and(|rest| rest.len() == 8 && rest.chars().all(|c| c.is_ascii_digit()));
    if served_id == requested || is_snapshot {
        return None;
    }
    Some(served.to_string())
}

#[async_trait::async_trait]
impl StreamingApiClient for AnthropicApiAdapter {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        if cancel_token.is_cancelled() {
            return Err(ApiError::Cancelled);
        }

        let url = build_anthropic_url(&self.config.base_url);
        let (body, betas) = build_anthropic_api_body(&request, &self.config);
        let mut headers = build_anthropic_headers(&self.config)?;
        merge_beta_header(&mut headers, &betas)?;
        let model = unprefix_model(request.model, &self.config.provider_id);

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
            // Cloned before `text()` consumes the response: on a 429 the
            // `Retry-After` header is the wait Anthropic actually asked for.
            let headers = response.headers().clone();
            let body = response.text().await.unwrap_or_default();
            return Err(map_status_error_with_headers(
                status.as_u16(),
                body,
                &headers,
                RequestOrigin { url: &url, model },
            ));
        }

        let bytes_stream = response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

        let outcome = drive_anthropic_stream_detailed(bytes_stream, event_sink, cancel_token).await?;
        let mut turn = outcome.turn;
        if has_server_fallback(model) {
            if let Some(served) = served_by_another_model(model, outcome.served_model.as_deref()) {
                // The switch itself already explained this reply.
                if !turn.notices.iter().any(|n| n.contains(&served)) {
                    turn.notices.push(format!(
                        "This reply came from {served}, not {model}. An earlier request in this \
                         conversation was declined, and Anthropic keeps sending the conversation \
                         to its fallback model for about an hour."
                    ));
                }
            }
        }
        Ok(turn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::api_client::ReasoningRequest;
    use crate::agent_runtime::types::ConversationMessage;

    fn config() -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: "anthropic".into(),
            provider_type: Some(super::super::ANTHROPIC_API_PROVIDER_TYPE.into()),
            base_url: super::super::ANTHROPIC_API_BASE_URL.into(),
            api_key: "sk-ant-test".into(),
            api_keys: None,
            model: "claude-opus-5-5".into(),
            custom_headers: None,
            custom_params: None,
            default_temperature: None,
            default_max_tokens: None,
            supports_thinking: true,
            reasoning: None,
            supports_vision: true,
        }
    }

    fn request<'a>(model: &'a str, messages: &'a [ConversationMessage]) -> ApiRequest<'a> {
        ApiRequest {
            model,
            system_prompt: Some("You are Aurora Agent."),
            messages,
            tools: &[],
            tool_choice: Default::default(),
            temperature: None,
            max_output_tokens: 8_000,
            reasoning: ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: None,
        }
    }

    #[test]
    fn opus_5_5_gets_fallbacks_and_drop_block_binding_with_both_betas() {
        let messages = [ConversationMessage::user_text("hi", 0)];
        let (body, betas) = build_anthropic_api_body(&request("claude-opus-5-5", &messages), &config());

        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(
            body["thinking"]["block_binding"],
            json!({ "prefix_mismatch_behavior": "drop_block" })
        );
        assert!(betas.contains(&SERVER_FALLBACK_BETA));
        assert!(betas.contains(&THINKING_BINDING_BETA));
        // Opus 5.5 rejects `disabled` at every effort; reasoning off is low effort.
        assert_ne!(body["thinking"]["type"], "disabled");
        assert_eq!(body["output_config"]["effort"], "low");
    }

    #[test]
    fn haiku_5_5_binds_thinking_but_has_no_server_fallback() {
        let messages = [ConversationMessage::user_text("hi", 0)];
        let (body, betas) = build_anthropic_api_body(&request("claude-haiku-5-5", &messages), &config());

        assert!(body.get("fallbacks").is_none());
        assert!(!betas.contains(&SERVER_FALLBACK_BETA));
        assert!(betas.contains(&THINKING_BINDING_BETA));
        // Haiku 5.5 rejects `budget_tokens` with a 400; it must be adaptive.
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert!(body["thinking"].get("budget_tokens").is_none());
    }

    #[test]
    fn opus_5_gets_fallbacks_and_no_binding_control() {
        let messages = [ConversationMessage::user_text("hi", 0)];
        let (body, betas) = build_anthropic_api_body(&request("claude-opus-5", &messages), &config());

        assert_eq!(body["fallbacks"], "default");
        assert!(body["thinking"].get("block_binding").is_none());
        assert_eq!(betas, vec![SERVER_FALLBACK_BETA]);
    }

    #[test]
    fn a_hand_set_fallbacks_field_is_left_alone() {
        let mut config = config();
        config.custom_params = Some(std::collections::HashMap::from([(
            "fallbacks".to_string(),
            json!([{ "model": "claude-opus-4-8" }]),
        )]));
        let messages = [ConversationMessage::user_text("hi", 0)];
        let (body, betas) = build_anthropic_api_body(&request("claude-opus-5-5", &messages), &config);

        assert_eq!(body["fallbacks"], json!([{ "model": "claude-opus-4-8" }]));
        assert!(!betas.contains(&SERVER_FALLBACK_BETA));
    }

    fn cached_request<'a>(
        messages: &'a [ConversationMessage],
        tools: &'a [crate::agent_runtime::api_client::ToolSchema],
    ) -> ApiRequest<'a> {
        let mut r = request("claude-opus-5-5", messages);
        r.tools = tools;
        r
    }

    /// The `ttl` of every `cache_control` marker in the body, in any position.
    fn ttls(body: &Value) -> Vec<Option<String>> {
        let mut found = Vec::new();
        fn walk(v: &Value, out: &mut Vec<Option<String>>) {
            match v {
                Value::Object(map) => {
                    if let Some(cache) = map.get("cache_control") {
                        out.push(cache.get("ttl").and_then(Value::as_str).map(str::to_string));
                    }
                    map.values().for_each(|x| walk(x, out));
                }
                Value::Array(items) => items.iter().for_each(|x| walk(x, out)),
                _ => {}
            }
        }
        walk(body, &mut found);
        found
    }

    #[test]
    fn the_cache_is_five_minutes_unless_the_row_asks_for_an_hour() {
        let messages = [ConversationMessage::user_text("hi", 0)];
        let tools = [crate::agent_runtime::api_client::ToolSchema {
            name: "grep".into(),
            description: "t".into(),
            input_schema: json!({ "type": "object" }),
        }];

        let (body, _) = build_anthropic_api_body(&cached_request(&messages, &tools), &config());
        let default = ttls(&body);
        assert_eq!(default.len(), 3, "tools, system and conversation are all cached");
        assert!(default.iter().all(Option::is_none), "default is Anthropic's five minutes");

        let mut hour = config();
        hour.custom_params = Some(std::collections::HashMap::from([(
            super::super::PROMPT_CACHE_TTL_PARAM.to_string(),
            json!("1h"),
        )]));
        let (body, _) = build_anthropic_api_body(&cached_request(&messages, &tools), &hour);
        let marked = ttls(&body);
        assert_eq!(marked.len(), 3);
        assert!(
            marked.iter().all(|t| t.as_deref() == Some("1h")),
            "every breakpoint lives an hour: {marked:?}"
        );
        // The setting is Aurora's; Anthropic would reject it as a body field.
        assert!(body.get("prompt_cache_ttl").is_none());
    }

    #[test]
    fn row_betas_are_kept_beside_the_adapters_own() {
        let mut headers = HeaderMap::new();
        headers.insert("anthropic-beta", HeaderValue::from_static("context-1m-2025-08-07"));
        merge_beta_header(&mut headers, &[SERVER_FALLBACK_BETA, "context-1m-2025-08-07"])
            .expect("valid header");
        assert_eq!(
            headers["anthropic-beta"],
            format!("context-1m-2025-08-07,{SERVER_FALLBACK_BETA}")
        );
    }

    #[test]
    fn a_reply_from_the_fallback_model_is_reported_and_the_requested_one_is_not() {
        assert_eq!(
            served_by_another_model("claude-opus-5-5", Some("claude-opus-4-8")),
            Some("claude-opus-4-8".to_string())
        );
        assert_eq!(served_by_another_model("claude-opus-5-5", Some("claude-opus-5-5")), None);
        assert_eq!(
            served_by_another_model("claude-opus-5", Some("claude-opus-5-20260301")),
            None,
            "a dated snapshot of the requested model is the requested model"
        );
        assert_eq!(
            served_by_another_model("claude-opus-5", Some("claude-opus-5-5")),
            Some("claude-opus-5-5".to_string()),
            "a newer model is not a snapshot of an older one"
        );
        assert_eq!(served_by_another_model("claude-opus-5-5", None), None);
    }
}
