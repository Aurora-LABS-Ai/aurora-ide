//! [`CodexAdapter`] — Responses-API streaming against the ChatGPT backend.
//!
//! Reuses the OpenAI Responses builders wholesale ([`build_responses_body`]
//! / [`drive_responses_stream`]); what's Codex-specific is confined to:
//!
//! - auth: a fresh OAuth access token per call (refreshed on expiry, and
//!   force-refreshed once on a 401 in case the token was revoked early),
//! - headers: `ChatGPT-Account-Id`, `originator`, `session_id`,
//! - body: `max_output_tokens` is stripped — the Codex backend rejects an
//!   output cap (Codex CLI never sends one),
//! - URL: fixed to [`CODEX_RESPONSES_URL`]; the provider's configured
//!   base URL is ignored on purpose so a stale preset can't misroute.

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ApiRequest, StreamingApiClient, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;

use super::auth::{self, CodexAccess};
use super::{CODEX_ORIGINATOR, CODEX_RESPONSES_URL, CODEX_USER_AGENT};
use crate::api::client::ProviderConfigSnapshot;
use crate::api::provider_kernel_adapter::{map_reqwest_error, map_status_error};
use crate::api::responses::{build_responses_body, drive_responses_stream};

pub struct CodexAdapter {
    config: ProviderConfigSnapshot,
    http: reqwest::Client,
}

impl CodexAdapter {
    pub fn new(config: ProviderConfigSnapshot) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { config, http }
    }
}

/// Headers for one Codex backend call.
fn build_codex_headers(access: &CodexAccess, session_id: &str) -> Result<HeaderMap, ApiError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    headers.insert(USER_AGENT, HeaderValue::from_static(CODEX_USER_AGENT));
    headers.insert("originator", HeaderValue::from_static(CODEX_ORIGINATOR));
    headers.insert(
        "OpenAI-Beta",
        HeaderValue::from_static("responses=experimental"),
    );
    let bearer = format!("Bearer {}", access.access_token);
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&bearer)
            .map_err(|e| ApiError::InvalidRequest(format!("invalid access token header: {e}")))?,
    );
    if let Some(account_id) = &access.account_id {
        headers.insert(
            "ChatGPT-Account-Id",
            HeaderValue::from_str(account_id).map_err(|e| {
                ApiError::InvalidRequest(format!("invalid ChatGPT account id header: {e}"))
            })?,
        );
    }
    headers.insert(
        "session_id",
        HeaderValue::from_str(session_id)
            .map_err(|e| ApiError::InvalidRequest(format!("invalid session id header: {e}")))?,
    );
    Ok(headers)
}

/// Build the request body: standard Responses shape minus the output cap.
fn build_codex_body(
    request: &ApiRequest<'_>,
    config: &ProviderConfigSnapshot,
) -> serde_json::Value {
    let mut body = build_responses_body(request, config);
    if let Some(obj) = body.as_object_mut() {
        obj.remove("max_output_tokens");
    }
    body
}

#[async_trait::async_trait]
impl StreamingApiClient for CodexAdapter {
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

        let body = build_codex_body(&request, &self.config);
        let session_id = uuid::Uuid::new_v4().to_string();

        // One retry on 401: an unexpired-but-revoked token (password
        // change, session invalidation) only reveals itself here.
        let mut refreshed_once = false;
        let response = loop {
            let headers = build_codex_headers(&access, &session_id)?;
            let response = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => return Err(ApiError::Cancelled),
                result = self
                    .http
                    .post(CODEX_RESPONSES_URL)
                    .headers(headers)
                    .json(&body)
                    .send() => match result {
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
            let body = response.text().await.unwrap_or_default();
            if status.as_u16() == 429 {
                // Subscription window exhausted — say so instead of the
                // generic "rate limited" that suggests retrying helps.
                return Err(ApiError::Provider(format!(
                    "ChatGPT usage limit reached for your plan. It resets on a rolling window \u{2014} check Settings \u{2192} Providers \u{2192} Codex. ({})",
                    body.chars().take(160).collect::<String>()
                )));
            }
            return Err(map_status_error(status.as_u16(), body));
        }

        let bytes_stream = response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

        drive_responses_stream(bytes_stream, event_sink, cancel_token).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::api_client::ToolSchema;

    fn config() -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: "codex".into(),
            base_url: "https://chatgpt.com/backend-api/codex".into(),
            api_key: String::new(),
            model: "gpt-5.5".into(),
            custom_headers: None,
            custom_params: None,
            default_temperature: None,
            default_max_tokens: None,
            supports_thinking: true,
            supports_vision: false,
        }
    }

    fn request<'a>(tools: &'a [ToolSchema]) -> ApiRequest<'a> {
        ApiRequest {
            model: "codex:gpt-5.5",
            system_prompt: Some("You are Aurora."),
            messages: &[],
            tools,
            temperature: Some(0.7),
            max_output_tokens: 8192,
            thinking_enabled: true,
        }
    }

    #[test]
    fn body_strips_output_cap_and_keeps_responses_shape() {
        let body = build_codex_body(&request(&[]), &config());
        assert!(body.get("max_output_tokens").is_none());
        assert_eq!(body["model"], "gpt-5.5"); // codex: prefix stripped
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["include"][0], "reasoning.encrypted_content");
        assert_eq!(body["instructions"], "You are Aurora.");
        // gpt-5 family: temperature must be gated off.
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn headers_carry_chatgpt_identity() {
        let access = CodexAccess {
            access_token: "tok_123".into(),
            account_id: Some("acct_9".into()),
        };
        let headers = build_codex_headers(&access, "session-1").expect("headers");
        assert_eq!(headers.get(AUTHORIZATION).unwrap(), "Bearer tok_123");
        assert_eq!(headers.get("ChatGPT-Account-Id").unwrap(), "acct_9");
        assert_eq!(headers.get("originator").unwrap(), CODEX_ORIGINATOR);
        assert_eq!(headers.get("session_id").unwrap(), "session-1");
        assert_eq!(
            headers.get("OpenAI-Beta").unwrap(),
            "responses=experimental"
        );
    }
}
