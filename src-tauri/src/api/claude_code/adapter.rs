//! [`ClaudeCodeAdapter`] — Anthropic Messages streaming with a subscription
//! token.
//!
//! Reuses the Anthropic builders wholesale ([`build_anthropic_body`] /
//! [`drive_anthropic_stream`]); what's subscription-specific is confined to:
//!
//! - auth: a fresh OAuth access token per call as `Authorization: Bearer`
//!   (refreshed on expiry, and force-refreshed once on a 401 in case the
//!   token was revoked early) — never `x-api-key`,
//! - headers: the `oauth-2025-04-20` beta the token is only valid with, the
//!   Claude Code beta beside it, and Claude Code's own user agent,
//! - body: the Claude Code identity sentence as the first system block,
//!   ahead of Aurora's prompt. The endpoint is served to Claude Code
//!   clients and expects that opening line,
//! - URL: fixed to `api.anthropic.com`; the provider row's base URL is
//!   ignored on purpose so a stale preset can't misroute.

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ApiRequest, StreamingApiClient, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;

use super::auth::{self, ClaudeCodeAccess};
use super::{
    CLAUDE_API_BASE, CLAUDE_CODE_BETA, CLAUDE_CODE_IDENTITY, CLAUDE_CODE_USER_AGENT, OAUTH_BETA,
};
use crate::api::anthropic::drive_anthropic_stream;
use crate::api::client::ProviderConfigSnapshot;
use crate::api::provider_kernel_adapter::{
    build_anthropic_body, build_anthropic_url, map_reqwest_error, map_status_error_with_headers,
    unprefix_model, RequestOrigin,
};

pub struct ClaudeCodeAdapter {
    config: ProviderConfigSnapshot,
    http: reqwest::Client,
}

impl ClaudeCodeAdapter {
    pub fn new(config: ProviderConfigSnapshot) -> Self {
        // Same client shape as the Anthropic adapter: no compression (it
        // breaks SSE chunk timing) and keepalives instead of a request
        // timeout, because a long think is legitimate silence.
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

/// The endpoint every request goes to. The row's base URL is not consulted.
pub fn messages_url() -> String {
    build_anthropic_url(&format!("{CLAUDE_API_BASE}/v1"))
}

/// Headers for one subscription call.
fn build_claude_code_headers(access: &ClaudeCodeAccess) -> Result<HeaderMap, ApiError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    headers.insert(USER_AGENT, HeaderValue::from_static(CLAUDE_CODE_USER_AGENT));
    headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
    headers.insert("x-app", HeaderValue::from_static("cli"));
    let betas = format!("{OAUTH_BETA},{CLAUDE_CODE_BETA}");
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_str(&betas)
            .map_err(|e| ApiError::InvalidRequest(format!("invalid beta header: {e}")))?,
    );
    let bearer = format!("Bearer {}", access.access_token);
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&bearer)
            .map_err(|e| ApiError::InvalidRequest(format!("invalid access token header: {e}")))?,
    );
    Ok(headers)
}

/// Standard Messages body with the Claude Code identity in front of the
/// system prompt.
///
/// `build_anthropic_body` writes `system` as a plain string when prompt
/// caching is off and as an array of blocks when it is on; both are
/// promoted to the block form so the identity can sit first. An absent
/// system prompt still gets the identity — it is about the request, not
/// about what Aurora had to say.
fn build_claude_code_body(request: &ApiRequest<'_>, config: &ProviderConfigSnapshot) -> Value {
    let mut body = build_anthropic_body(request, config);
    let identity = json!({ "type": "text", "text": CLAUDE_CODE_IDENTITY });
    let Some(obj) = body.as_object_mut() else {
        return body;
    };
    let system = match obj.remove("system") {
        Some(Value::Array(mut blocks)) => {
            blocks.insert(0, identity);
            blocks
        }
        Some(Value::String(text)) if !text.is_empty() => {
            vec![identity, json!({ "type": "text", "text": text })]
        }
        _ => vec![identity],
    };
    obj.insert("system".to_string(), Value::Array(system));
    body
}

#[async_trait::async_trait]
impl StreamingApiClient for ClaudeCodeAdapter {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        if cancel_token.is_cancelled() {
            return Err(ApiError::Cancelled);
        }

        let mut access = auth::fresh_access(false)
            .await
            .map_err(ApiError::Provider)?;

        let url = messages_url();
        let body = build_claude_code_body(&request, &self.config);

        // One retry on 401: an unexpired-but-revoked token (password change,
        // session invalidation) only reveals itself here.
        let mut refreshed_once = false;
        let response = loop {
            let headers = build_claude_code_headers(&access)?;
            let response = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => return Err(ApiError::Cancelled),
                result = self.http.post(&url).headers(headers).json(&body).send() => match result {
                    Ok(resp) => resp,
                    Err(err) => return Err(map_reqwest_error(err)),
                }
            };

            if response.status().as_u16() == 401 && !refreshed_once {
                refreshed_once = true;
                access = auth::fresh_access(true).await.map_err(ApiError::Provider)?;
                continue;
            }
            break response;
        };

        let status = response.status();
        if !status.is_success() {
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

        drive_anthropic_stream(bytes_stream, event_sink, cancel_token).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::api_client::ToolSchema;

    fn config() -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: "claude-code".into(),
            provider_type: Some("claude-code".into()),
            base_url: "https://example.invalid/should-be-ignored".into(),
            api_key: String::new(),
            api_keys: None,
            model: "claude-sonnet-5".into(),
            custom_headers: None,
            custom_params: None,
            default_temperature: None,
            default_max_tokens: None,
            supports_thinking: true,
            reasoning: None,
            supports_vision: true,
        }
    }

    fn request<'a>(tools: &'a [ToolSchema], system: Option<&'a str>) -> ApiRequest<'a> {
        ApiRequest {
            model: "claude-code:claude-sonnet-5",
            system_prompt: system,
            messages: &[],
            tools,
            tool_choice: Default::default(),
            temperature: None,
            max_output_tokens: 8192,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: None,
        }
    }

    #[test]
    fn identity_leads_the_system_prompt_in_block_form() {
        let body = build_claude_code_body(&request(&[], Some("You are Aurora.")), &config());
        let system = body["system"].as_array().expect("block form");
        assert_eq!(system[0]["text"], CLAUDE_CODE_IDENTITY);
        assert!(
            system
                .iter()
                .skip(1)
                .any(|b| b["text"].as_str().unwrap_or("").contains("You are Aurora.")),
            "Aurora's prompt follows the identity"
        );
        assert_eq!(body["model"], "claude-sonnet-5", "row prefix stripped");
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn identity_is_present_even_without_a_system_prompt() {
        let body = build_claude_code_body(&request(&[], None), &config());
        let system = body["system"].as_array().expect("block form");
        assert_eq!(system.len(), 1);
        assert_eq!(system[0]["text"], CLAUDE_CODE_IDENTITY);
    }

    #[test]
    fn headers_carry_bearer_and_the_oauth_beta_and_never_an_api_key() {
        let access = ClaudeCodeAccess {
            access_token: "sk-ant-oat01-abc".into(),
        };
        let headers = build_claude_code_headers(&access).expect("headers");
        assert_eq!(headers.get(AUTHORIZATION).unwrap(), "Bearer sk-ant-oat01-abc");
        assert!(headers.get("x-api-key").is_none());
        let betas = headers.get("anthropic-beta").unwrap().to_str().unwrap();
        assert!(betas.split(',').any(|b| b == OAUTH_BETA));
        assert!(betas.split(',').any(|b| b == CLAUDE_CODE_BETA));
        assert_eq!(headers.get("anthropic-version").unwrap(), "2023-06-01");
        assert_eq!(headers.get(USER_AGENT).unwrap(), CLAUDE_CODE_USER_AGENT);
        assert_eq!(headers.get(ACCEPT).unwrap(), "text/event-stream");
    }

    #[test]
    fn url_is_pinned_to_anthropic_regardless_of_the_row() {
        assert_eq!(messages_url(), "https://api.anthropic.com/v1/messages");
    }
}
