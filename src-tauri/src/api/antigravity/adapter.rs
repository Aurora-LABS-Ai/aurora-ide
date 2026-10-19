//! [`AntigravityAdapter`]: one streamed model call on the main Antigravity
//! account.
//!
//! Per call: a fresh access token and the account's project
//! ([`super::auth::fresh_access`]), the envelope from [`super::wire`], POST to
//! `streamGenerateContent?alt=sse` on the fixed backend (the row's base URL is
//! ignored, as for Codex and Claude Code), and the reply through
//! [`super::stream`]. A 401 refreshes once and retries.
//!
//! A 429 is two different things here. A short `retryDelay` is ordinary rate
//! limiting and goes back to the runtime's backoff. A quota that resets hours
//! from now is not worth three retries; the person is told when it resets.

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ApiRequest, StreamingApiClient, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;
use crate::api::client::ProviderConfigSnapshot;
use crate::api::provider_kernel_adapter::{
    map_reqwest_error, map_status_error_with_headers, unprefix_model, RequestOrigin,
};

use super::auth::{self, AntigravityAccess};
use super::stream::drive_antigravity_stream;
use super::wire::{build_request_body, WireContext};
use super::{user_agent, API_BASE};

/// Waits up to this long are left to the runtime's retry; longer ones end the
/// turn with the reset time.
const MAX_RETRY_WAIT_SECS: u64 = 60;

pub struct AntigravityAdapter {
    config: ProviderConfigSnapshot,
    http: reqwest::Client,
}

impl AntigravityAdapter {
    pub fn new(config: ProviderConfigSnapshot) -> Self {
        // Same shape as the other streaming adapters: no compression (it
        // breaks SSE chunk timing), keepalives instead of a request timeout.
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

/// Where every request goes. The row's base URL is not consulted.
#[must_use]
pub fn stream_url() -> String {
    format!("{API_BASE}:streamGenerateContent?alt=sse")
}

fn headers(access: &AntigravityAccess) -> Result<HeaderMap, ApiError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(&user_agent())
            .map_err(|e| ApiError::InvalidRequest(format!("invalid user agent: {e}")))?,
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", access.access_token))
            .map_err(|e| ApiError::InvalidRequest(format!("invalid access token header: {e}")))?,
    );
    Ok(headers)
}

/// Seconds until a quota frees up, from Google's `ErrorInfo` / `RetryInfo`
/// details or the "reset after 2h7m23s" message wording.
pub(super) fn quota_wait_secs(body: &str) -> Option<u64> {
    let json: Value = serde_json::from_str(body).ok()?;
    let error = json.get("error")?;
    for detail in error
        .get("details")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(stamp) = detail
            .pointer("/metadata/quotaResetTimeStamp")
            .and_then(Value::as_str)
        {
            if let Ok(at) = chrono::DateTime::parse_from_rfc3339(stamp) {
                let secs = (at.timestamp() - chrono::Utc::now().timestamp()).max(1);
                return u64::try_from(secs).ok();
            }
        }
        if let Some(delay) = detail.get("retryDelay").and_then(Value::as_str) {
            if let Ok(secs) = delay.trim_end_matches('s').parse::<f64>() {
                return Some(secs.ceil().max(1.0) as u64);
            }
        }
    }
    let message = error.get("message").and_then(Value::as_str)?;
    let rest = message.split("reset after ").nth(1)?;
    let mut total = 0u64;
    let mut number = String::new();
    for c in rest.chars() {
        match c {
            '0'..='9' => number.push(c),
            'h' | 'm' | 's' => {
                let n: u64 = number.parse().ok()?;
                total += n * match c {
                    'h' => 3600,
                    'm' => 60,
                    _ => 1,
                };
                number.clear();
            }
            _ => break,
        }
    }
    (total > 0).then_some(total)
}

fn model_not_offered(model: &str) -> String {
    format!(
        "Antigravity doesn't offer {model} on this account. Pick a model from the Antigravity list in the model picker; Providers → Antigravity shows what the account has."
    )
}

fn wait_words(secs: u64) -> String {
    let (h, m) = (secs / 3600, (secs % 3600) / 60);
    match (h, m) {
        (0, 0) => "in under a minute".to_string(),
        (0, m) => format!("in {m} min"),
        (h, 0) => format!("in {h} h"),
        (h, m) => format!("in {h} h {m} min"),
    }
}

#[async_trait::async_trait]
impl StreamingApiClient for AntigravityAdapter {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        if cancel_token.is_cancelled() {
            return Err(ApiError::Cancelled);
        }
        let mut access = auth::fresh_access().await.map_err(ApiError::Unauthorized)?;
        let model = unprefix_model(request.model, &self.config.provider_id);
        let url = stream_url();

        let mut refreshed_once = false;
        let response = loop {
            let body = build_request_body(
                &request,
                &WireContext {
                    model,
                    project_id: &access.project_id,
                    supports_vision: self.config.supports_vision,
                    supports_thinking: self.config.supports_thinking,
                    default_temperature: self.config.default_temperature,
                },
            );
            let response = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => return Err(ApiError::Cancelled),
                result = self.http.post(&url).headers(headers(&access)?).json(&body).send() => {
                    result.map_err(map_reqwest_error)?
                }
            };
            if response.status().as_u16() == 401 && !refreshed_once {
                refreshed_once = true;
                access = auth::access_after_rejection(&access)
                    .await
                    .map_err(ApiError::Unauthorized)?;
                continue;
            }
            break response;
        };

        let status = response.status();
        if !status.is_success() {
            let response_headers = response.headers().clone();
            let body = response.text().await.unwrap_or_default();
            if status.as_u16() == 429 {
                match quota_wait_secs(&body) {
                    Some(secs) if secs <= MAX_RETRY_WAIT_SECS => {
                        return Err(ApiError::RateLimit {
                            retry_after_secs: Some(secs),
                        });
                    }
                    Some(secs) => {
                        crate::logging::log_warn(
                            "api.antigravity",
                            &format!("quota exhausted for {model}: {body}"),
                        );
                        return Err(ApiError::InvalidRequest(format!(
                            "Antigravity's quota for {model} is used up on this account. It resets {}. Switch model or account until then.",
                            wait_words(secs)
                        )));
                    }
                    None => {}
                }
            }
            if status.as_u16() == 404 {
                // The backend answers "Requested entity was not found" for a
                // model id this account is not offered, e.g. one added by hand.
                crate::logging::log_warn(
                    "api.antigravity",
                    &format!("model {model} not found for this account: {body}"),
                );
                return Err(ApiError::InvalidRequest(model_not_offered(model)));
            }
            return Err(map_status_error_with_headers(
                status.as_u16(),
                body,
                &response_headers,
                RequestOrigin { url: &url, model },
            ));
        }

        let bytes_stream = response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
        drive_antigravity_stream(bytes_stream, event_sink, cancel_token, request.tools).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_endpoint_is_fixed() {
        assert_eq!(
            stream_url(),
            "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn a_missing_model_is_named_with_where_to_look() {
        let text = model_not_offered("gemini-4-argon");
        assert!(text.contains("gemini-4-argon"), "{text}");
        assert!(text.contains("Providers → Antigravity"), "{text}");
    }

    #[test]
    fn quota_waits_are_read_from_details_and_wording() {
        let retry = r#"{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"12.4s"}]}}"#;
        assert_eq!(quota_wait_secs(retry), Some(13));

        let worded = r#"{"error":{"code":429,"message":"You have exhausted your capacity. Your quota will reset after 2h7m23s."}}"#;
        assert_eq!(quota_wait_secs(worded), Some(2 * 3600 + 7 * 60 + 23));

        let later = (chrono::Utc::now() + chrono::Duration::hours(3)).to_rfc3339();
        let stamped = format!(
            r#"{{"error":{{"code":429,"details":[{{"metadata":{{"quotaResetTimeStamp":"{later}"}}}}]}}}}"#
        );
        let secs = quota_wait_secs(&stamped).expect("stamp");
        assert!((3 * 3600 - 5..=3 * 3600).contains(&secs), "{secs}");

        assert_eq!(
            quota_wait_secs(r#"{"error":{"code":429,"message":"busy"}}"#),
            None
        );
        assert_eq!(quota_wait_secs("not json"), None);
    }

    #[test]
    fn waits_read_like_a_person_wrote_them() {
        assert_eq!(wait_words(30), "in under a minute");
        assert_eq!(wait_words(15 * 60), "in 15 min");
        assert_eq!(wait_words(2 * 3600 + 7 * 60), "in 2 h 7 min");
    }
}
