//! One-shot "does this model actually answer?" probe for the provider
//! settings page.
//!
//! The whole point is that this is **not** a bespoke HTTP call. It goes
//! through [`crate::api::build_api_client`] — the same factory the agent
//! loop uses — so the probe exercises the real adapter, the real body
//! builder, the real URL join and the real SSE parser. A probe that
//! passed while a turn failed would be worse than no probe at all.
//!
//! It reports the wire shape and endpoint it resolved to, because that
//! is precisely the thing that can silently disagree with what the user
//! selected: dispatch used to key on the provider row id, so every
//! user-added provider quietly fell back to Chat Completions no matter
//! which API type was picked. Surfacing the resolved shape makes that
//! class of bug visible instead of invisible.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ApiRequest};
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::{ContentBlock, ConversationMessage};
use crate::api::client::{ProviderConfigSnapshot, ProviderKind};
use crate::api::codex::CODEX_RESPONSES_URL;
use crate::api::cursor::CURSOR_API_BASE;
use crate::api::provider_kernel_adapter::{build_anthropic_url, build_openai_url};
use crate::api::responses::build_responses_url;

/// Hard ceiling on one probe. Long enough for a cold reasoning model to
/// produce its first tokens, short enough that a black-holed endpoint
/// reports back instead of spinning forever.
const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

/// How much assistant text to keep. Enough to prove real generation
/// happened, small enough for a tooltip.
const SNIPPET_LIMIT: usize = 280;

/// Output cap for a plain connectivity probe. Small on purpose — this costs
/// the user real money on every click.
const PROBE_MAX_TOKENS: u32 = 64;

/// Legacy Anthropic thinking has a 1,024-token floor and is omitted entirely
/// when the answer allowance is not larger than that. A 64-token probe would
/// therefore claim it tested reasoning while the adapter correctly sent none.
/// This is still only a cap; the exact-answer prompt normally stops far below
/// it.
const REASONING_PROBE_MAX_TOKENS: u32 = 2_048;

/// Deterministic but not a bare echo: reasoning-capable routes get a small
/// problem to reason about, while the visible answer stays one cheap line.
const PROBE_PROMPT: &str = concat!(
    "Compare 17 × 19 with 18 × 18. If the first is smaller, reply exactly: ",
    "Aurora connection OK. Otherwise reply exactly: Aurora connection failed. ",
    "Do not show calculations in the final answer."
);
const EXPECTED_PROBE_REPLY: &str = "Aurora connection OK";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestReport {
    /// Did the model produce usable output?
    pub ok: bool,
    /// Human-readable wire shape actually used — "Responses",
    /// "Chat Completions", "Anthropic Messages", "Codex".
    pub wire_shape: String,
    /// The provider type the dispatch resolved to. Lets the UI show that
    /// the user's API-type selection was honoured.
    pub resolved_type: String,
    /// The endpoint the adapter actually POSTed to.
    pub url: String,
    /// First slice of the assistant's reply. Empty when the call failed
    /// or the provider streamed nothing.
    pub snippet: String,
    /// Round-trip wall time in milliseconds.
    pub latency_ms: u64,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    /// Whether this exact saved model profile asked the adapter for reasoning.
    pub reasoning_requested: bool,
    /// Whether any non-empty reasoning text actually came back.
    pub reasoning_received: bool,
    /// A connected model can still silently lose a configured capability.
    pub warning: Option<String>,
    /// Present only on failure. Already human-readable.
    pub error: Option<String>,
}

/// Fire one real, minimal turn at the given provider + model.
///
/// Takes the fully-resolved snapshot the frontend would send for a real
/// turn — including the model's own overrides — so what is tested is
/// what will actually run.
#[tauri::command]
pub async fn provider_test_model(
    config: ProviderConfigSnapshot,
    model: String,
) -> Result<ProviderTestReport, String> {
    let kind = ProviderKind::detect(config.effective_provider_type());
    let (wire_shape, url) = describe_route(kind, &config);
    let resolved_type = config.effective_provider_type().to_string();
    let reasoning = config.reasoning.clone().unwrap_or_else(|| {
        crate::agent_runtime::api_client::ReasoningConfig::legacy(config.supports_thinking, None)
    });
    let reasoning_requested = reasoning.enabled && config.supports_thinking;

    let mut report = ProviderTestReport {
        ok: false,
        wire_shape: wire_shape.to_string(),
        resolved_type,
        url,
        snippet: String::new(),
        latency_ms: 0,
        input_tokens: None,
        output_tokens: None,
        reasoning_requested,
        reasoning_received: false,
        warning: None,
        error: None,
    };

    // Fail fast on the two mistakes that otherwise surface as a confusing
    // upstream 401/404.
    if config.base_url.trim().is_empty() {
        report.error = Some("No base URL set for this provider.".into());
        return Ok(report);
    }
    if model.trim().is_empty() {
        report.error = Some("No model ID set.".into());
        return Ok(report);
    }

    let client = crate::api::build_api_client(&config);
    let messages = vec![ConversationMessage::user_text(PROBE_PROMPT, 0)];
    let request = ApiRequest {
        model: &model,
        system_prompt: None,
        messages: &messages,
        tools: &[],
        temperature: None,
        max_output_tokens: if reasoning_requested {
            REASONING_PROBE_MAX_TOKENS
        } else {
            PROBE_MAX_TOKENS
        },
        reasoning: reasoning.as_request(),
        // A connectivity probe sends no tools.
        tool_bridge: None,
        // …and belongs to no conversation, so no cache-affinity key.
        session_key: None,
        volatile_tail_messages: 0,
    };

    // Drain the sink concurrently. The adapters `.send().await` into this
    // channel, so nothing may block on a full buffer or the stream
    // deadlocks against itself.
    let (tx, mut rx) = mpsc::channel::<AssistantEvent>(64);
    let collector = tokio::spawn(async move {
        let mut text = String::new();
        let mut saw_reasoning = false;
        while let Some(event) = rx.recv().await {
            match event {
                AssistantEvent::TextDelta { delta } => {
                    if text.len() < SNIPPET_LIMIT {
                        text.push_str(&delta);
                    }
                }
                AssistantEvent::Thinking { text, .. } if !text.trim().is_empty() => {
                    saw_reasoning = true
                }
                _ => {}
            }
        }
        (text, saw_reasoning)
    });

    let started = Instant::now();
    let outcome = tokio::time::timeout(
        PROBE_TIMEOUT,
        client.stream(request, tx, CancellationToken::new()),
    )
    .await;
    report.latency_ms = started.elapsed().as_millis() as u64;

    let (streamed, streamed_reasoning) = collector.await.unwrap_or_default();

    match outcome {
        Err(_elapsed) => {
            report.error = Some(format!(
                "No response within {}s. The endpoint accepted the request but never streamed anything.",
                PROBE_TIMEOUT.as_secs()
            ));
        }
        Ok(Err(err)) => {
            report.error = Some(humanize(&err));
        }
        Ok(Ok(usage)) => {
            report.input_tokens = Some(usage.usage.input_tokens);
            report.output_tokens = Some(usage.usage.output_tokens);

            // Prefer the reconstructed message: it is what the agent loop
            // would actually receive. Fall back to raw deltas so a
            // provider that only streams (and returns an empty final
            // message) still shows its text.
            let assembled = collect_text(&usage.assistant_message);
            report.reasoning_received = streamed_reasoning
                || usage.assistant_message.blocks.iter().any(|block| {
                    matches!(block, ContentBlock::Thinking { text, .. } if !text.trim().is_empty())
                });
            let text = if assembled.trim().is_empty() {
                streamed
            } else {
                assembled
            };
            let trimmed = text.trim();

            if trimmed.is_empty() {
                // The exact failure that looks like success: HTTP 200,
                // a clean stream close, and not one token of content.
                report.error = Some(
                    "Connected, but the provider returned an empty response — no text, no error. Check that the base URL and model ID are correct for this API type."
                        .into(),
                );
            } else if !probe_reply_is_valid(trimmed) {
                // This is more than a style miss. The prompt is a fixed,
                // deterministic comparison, so a wrong/unrelated answer means
                // the route is not delivering usable behavior for this model
                // even though transport succeeded. Kenari's Responses shim on
                // GLM 5.3 returned both "Aurora connection failed" and an
                // identity sentence here while Chat answered correctly.
                report.error = Some(format!(
                    "Connected, but this API format did not return the deterministic test answer. Expected ‘{EXPECTED_PROBE_REPLY}’; received ‘{}’. This route may not support this model correctly.",
                    truncate(trimmed, 120)
                ));
            } else {
                report.ok = true;
                report.snippet = truncate(trimmed, SNIPPET_LIMIT);
                if report.reasoning_requested && !report.reasoning_received {
                    report.warning = Some(
                        "The model answered, but this API format returned no reasoning. Some gateways accept reasoning fields and silently discard the output. Try another API format or change this model's Reasoning request setting."
                            .into(),
                    );
                }
            }
        }
    }

    Ok(report)
}

/// The wire shape and endpoint this config resolves to, computed with the
/// same helpers the adapters use so the report cannot drift from reality.
fn describe_route(kind: ProviderKind, config: &ProviderConfigSnapshot) -> (&'static str, String) {
    match kind {
        ProviderKind::Anthropic => ("Anthropic Messages", build_anthropic_url(&config.base_url)),
        ProviderKind::OpenAIResponses => ("Responses", build_responses_url(&config.base_url)),
        ProviderKind::Codex => ("Codex", CODEX_RESPONSES_URL.to_string()),
        // Not a URL the user configured: the endpoint is fixed and the wire
        // is an agent protocol, not a chat API. Reporting the configured base
        // URL here would describe a route this provider never takes.
        ProviderKind::Cursor => (
            "Cursor Agent",
            format!("{CURSOR_API_BASE}/agent.v1.AgentService/Run"),
        ),
        ProviderKind::DeepSeek | ProviderKind::OpenAICompat => {
            ("Chat Completions", build_openai_url(&config.base_url))
        }
    }
}

fn collect_text(message: &ConversationMessage) -> String {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let cut: String = text.chars().take(limit).collect();
    format!("{}…", cut.trim_end())
}

fn probe_reply_is_valid(text: &str) -> bool {
    let normalized = text
        .trim()
        .trim_matches(|character| matches!(character, '"' | '\'' | '`'))
        .trim_end_matches(['.', '!'])
        .trim();
    normalized.eq_ignore_ascii_case(EXPECTED_PROBE_REPLY)
}

/// Turn an [`ApiError`] into something a person can act on. The raw
/// variants leak wire vocabulary ("decode failure", "provider returned an
/// error: 401 …") that means nothing on a settings page.
fn humanize(err: &ApiError) -> String {
    match err {
        ApiError::Network(msg) => {
            format!("Could not reach the endpoint. {msg}")
        }
        ApiError::Provider(msg) => {
            let lower = msg.to_ascii_lowercase();
            if lower.contains("401") || lower.contains("unauthorized") {
                format!("Rejected the API key (401). {}", first_line(msg))
            } else if lower.contains("404") {
                format!(
                    "No endpoint there (404). The base URL is probably missing a path segment such as /v1. {}",
                    first_line(msg)
                )
            } else if lower.contains("429") {
                format!("Rate limited (429). {}", first_line(msg))
            } else {
                first_line(msg)
            }
        }
        ApiError::Cancelled => "Test cancelled.".to_string(),
        other => first_line(&other.to_string()),
    }
}

/// Providers love returning a full HTML error page or a 4KB JSON blob.
/// Keep the first meaningful line so the tooltip stays readable.
fn first_line(msg: &str) -> String {
    let line = msg.lines().find(|l| !l.trim().is_empty()).unwrap_or(msg);
    truncate(line.trim(), 200)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider_type: &str, base_url: &str) -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: "b1846984-2777-4815-8a29-90e29392a8e6".into(),
            provider_type: Some(provider_type.into()),
            base_url: base_url.into(),
            api_key: "k".into(),
            api_keys: None,
            model: "m".into(),
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
    fn route_follows_the_selected_api_type_for_a_uuid_row() {
        let c = config("openai-responses", "https://api.a6api.com/v1");
        let (shape, url) = describe_route(ProviderKind::detect(c.effective_provider_type()), &c);
        assert_eq!(shape, "Responses");
        assert_eq!(url, "https://api.a6api.com/v1/responses");

        let c = config("openai", "https://api.a6api.com/v1");
        let (shape, url) = describe_route(ProviderKind::detect(c.effective_provider_type()), &c);
        assert_eq!(shape, "Chat Completions");
        assert_eq!(url, "https://api.a6api.com/v1/chat/completions");

        let c = config("anthropic", "https://api.anthropic.com/v1");
        let (shape, _) = describe_route(ProviderKind::detect(c.effective_provider_type()), &c);
        assert_eq!(shape, "Anthropic Messages");
    }

    #[tokio::test]
    async fn blank_base_url_reports_before_any_request() {
        let report = provider_test_model(config("openai", "  "), "gpt-5".into())
            .await
            .expect("command returns a report, never an Err");
        assert!(!report.ok);
        assert!(report.error.unwrap().contains("base URL"));
    }

    #[tokio::test]
    async fn blank_model_reports_before_any_request() {
        let report = provider_test_model(config("openai", "https://example.test/v1"), "   ".into())
            .await
            .expect("command returns a report, never an Err");
        assert!(!report.ok);
        assert!(report.error.unwrap().contains("model ID"));
    }

    #[test]
    fn truncate_keeps_whole_characters() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("abcdef", 3), "abc…");
        // Must not split a multi-byte char.
        assert_eq!(truncate("héllo wörld", 4), "héll…");
    }

    #[test]
    fn deterministic_probe_rejects_wrong_or_unrelated_answers() {
        assert!(probe_reply_is_valid("Aurora connection OK"));
        assert!(probe_reply_is_valid("Aurora connection OK."));
        assert!(!probe_reply_is_valid("Aurora connection failed."));
        assert!(!probe_reply_is_valid("I am GLM-5.3, developed by Z.ai."));
        assert!(!probe_reply_is_valid(
            "The requested result is Aurora connection OK."
        ));
    }

    #[test]
    fn humanize_explains_a_404_as_a_path_problem() {
        let msg = humanize(&ApiError::Provider("404 page not found".into()));
        assert!(
            msg.contains("/v1"),
            "404 must hint at the missing path: {msg}"
        );
    }
}
