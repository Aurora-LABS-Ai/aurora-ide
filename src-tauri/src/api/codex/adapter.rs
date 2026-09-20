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

/// The `session_id` header value for one conversation: a UUID derived
/// deterministically from the thread id, so every request of the thread
/// carries the SAME id.
///
/// It used to be a fresh `Uuid::new_v4()` per request, which told the
/// backend every call was a new session — working against the cache
/// affinity the id exists to provide (Codex CLI holds one id for the whole
/// conversation; opencode sends its stable session id). Hashed rather than
/// used raw because the header has always carried a UUID and Aurora thread
/// ids are not UUIDs.
fn stable_session_id(session_key: Option<&str>) -> String {
    let Some(key) = session_key.filter(|k| !k.is_empty()) else {
        // No conversation identity (one-off requests): a random id per
        // call, exactly the previous behaviour.
        return uuid::Uuid::new_v4().to_string();
    };
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(key.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // Stamp the version (4) and variant bits so the id is a well-formed
    // UUID, not just 32 hex digits with hyphens.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
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
        let session_id = stable_session_id(request.session_key);

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
                // One account's window is spent. If the user has stored
                // others, that is a reason to keep working, not to stop: mark
                // this one and hand the turn to the next account. The runtime
                // retries because the rebuilt request carries a different
                // account's token, so it is not the request that just failed.
                //
                // Marking happens whether or not a successor exists, so the
                // switcher can show which accounts are spent and the next turn
                // does not open on one that cannot serve.
                let spent = access.account_id.clone();
                let reset_in = reset_after_seconds(&body);
                if let Some(id) = spent.as_deref() {
                    if let Some(next) = super::accounts::note_exhausted(id, reset_in) {
                        crate::logging::log_warn(
                            "codex.accounts",
                            &format!(
                                "account {id} reported its limit reached — continuing on {} ({})",
                                next.email.as_deref().unwrap_or(&next.account_id),
                                next.account_id
                            ),
                        );
                        return Err(ApiError::CodexAccountRotated {
                            to: next.email.unwrap_or(next.account_id),
                        });
                    }
                }
                // Nothing left to fall back to — say what actually happened
                // rather than the generic "rate limited" that suggests
                // retrying helps.
                return Err(ApiError::Provider(format!(
                    "ChatGPT usage limit reached for your plan, and no other signed-in Codex account has headroom. It resets on a rolling window \u{2014} check Settings \u{2192} Providers \u{2192} Codex. ({})",
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

/// How long the backend says this window has left, in seconds, if it says.
///
/// Preferred over a guess for the obvious reason: parking an account for a
/// flat fifteen minutes when the real window resets in four hours means every
/// turn in between re-discovers the limit the hard way, and parking it for
/// fifteen when it resets in thirty seconds wastes headroom the user paid for.
/// Shapes vary across the backend's own error bodies, so read the ones it is
/// known to send and fall back cleanly when none are present.
pub(crate) fn reset_after_seconds(body: &str) -> Option<i64> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    for path in [
        &["error", "resets_in_seconds"][..],
        &["error", "reset_after_seconds"][..],
        &["resets_in_seconds"][..],
        &["reset_after_seconds"][..],
    ] {
        let mut node = &value;
        let mut found = true;
        for key in path {
            match node.get(*key) {
                Some(next) => node = next,
                None => {
                    found = false;
                    break;
                }
            }
        }
        if found {
            if let Some(secs) = node.as_i64().or_else(|| node.as_f64().map(|f| f as i64)) {
                if secs > 0 {
                    return Some(secs);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::api_client::ToolSchema;

    fn config() -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: "codex".into(),
            provider_type: None,
            base_url: "https://chatgpt.com/backend-api/codex".into(),
            api_key: String::new(),
            api_keys: None,
            model: "gpt-5.5".into(),
            custom_headers: None,
            custom_params: None,
            default_temperature: None,
            default_max_tokens: None,
            supports_thinking: true,
            reasoning: None,
            supports_vision: false,
        }
    }

    fn request<'a>(tools: &'a [ToolSchema]) -> ApiRequest<'a> {
        ApiRequest {
            model: "codex:gpt-5.5",
            system_prompt: Some("You are Aurora."),
            messages: &[],
            tools,
            tool_choice: Default::default(),
            temperature: Some(0.7),
            max_output_tokens: 8192,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest {
                enabled: true,
                control: crate::agent_runtime::api_client::ReasoningControl::Toggle,
                ..crate::agent_runtime::api_client::ReasoningRequest::disabled()
            },
            tool_bridge: None,
            session_key: None,        }
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

    #[test]
    fn session_id_is_stable_per_thread_and_a_well_formed_uuid() {
        // The whole point: every request of a conversation announces the
        // SAME session to the backend, so its cache affinity holds.
        let a = stable_session_id(Some("thread-1"));
        let b = stable_session_id(Some("thread-1"));
        assert_eq!(a, b);
        assert_ne!(a, stable_session_id(Some("thread-2")));
        // Well-formed v4-shaped UUID — the header has always carried one.
        let parsed = uuid::Uuid::parse_str(&a).expect("valid uuid");
        assert_eq!(parsed.get_version_num(), 4);
        // No identity → random per call, the pre-existing behaviour.
        assert_ne!(stable_session_id(None), stable_session_id(None));
    }

    #[test]
    fn conversation_key_rides_into_the_codex_body() {
        let mut req = request(&[]);
        req.session_key = Some("thread-1");
        let body = build_codex_body(&req, &config());
        assert_eq!(body["prompt_cache_key"], "thread-1");
    }
}
