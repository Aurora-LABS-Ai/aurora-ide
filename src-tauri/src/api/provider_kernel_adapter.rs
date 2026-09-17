//! Shared helpers for the Phase 2.2 streaming adapters.
//!
//! Two things live here:
//!
//! 1. **A byte-level SSE frame buffer + per-frame `data:` extractor.**
//!    Phase 5 (Sub-E) factored these into [`super::sse_shared`] so the
//!    `api::anthropic` and `api::openai_compat` adapters call the same
//!    code. We re-export them here for backwards compatibility — every
//!    existing call site under `api/` keeps using
//!    `provider_kernel_adapter::SseFrameBuffer` / `frame_payloads`. The
//!    `commands::provider_kernel::streaming` copy is left untouched per
//!    the Phase 5 audit (`api/AUDIT.md`).
//! 2. **The wire-shape JSON types** for Anthropic and OpenAI streaming
//!    SSE payloads, plus error-mapping helpers (`reqwest::Error` →
//!    [`ApiError`], HTTP status → [`ApiError`]).
//!
//! The adapters in [`super::anthropic`] and [`super::openai_compat`]
//! consume both halves and translate the wire events into
//! [`AssistantEvent`] (streamed) plus a final [`ConversationMessage`]
//! (returned in [`TurnUsage`]).

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::agent_runtime::api_client::{
    ApiError, ApiRequest, ReasoningControl, ReasoningReplayMode, ReasoningRequestMode, ToolSchema,
};
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};

use super::client::ProviderConfigSnapshot;

// ---------------------------------------------------------------------------
// SSE frame buffering. Byte-level so multi-byte UTF-8 sequences split
// across two `Bytes` chunks reassemble cleanly. The implementation
// lives in [`super::sse_shared`] post-Phase-5; we re-export here so
// every adapter call site keeps compiling unchanged.
// ---------------------------------------------------------------------------

pub use super::sse_shared::{frame_has_done_marker, frame_payloads, SseFrameBuffer};

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/// Turn an HTTP status code + response body into the appropriate
/// [`ApiError`] variant per the brief's mapping table.
/// Longest `Retry-After` Aurora will honour.
///
/// The header is the provider's number, not ours, and an app that blocks for
/// however long a misconfigured gateway names is an app that looks hung. Past
/// this the wait stops being a retry and starts being an outage the user
/// should hear about instead.
const MAX_RETRY_AFTER_SECS: u64 = 120;

/// Read `Retry-After` as a delay in seconds.
///
/// Only the delta-seconds form is accepted. RFC 9110 also allows an HTTP-date,
/// but no provider Aurora talks to sends one, and a half-parsed date is worse
/// than the backoff ladder we would fall back to anyway.
#[must_use]
pub fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let secs: u64 = raw.trim().parse().ok()?;
    Some(secs.min(MAX_RETRY_AFTER_SECS))
}

/// Which request an upstream rejection belongs to.
///
/// Carried only so the log line can name it. Borrowed rather than owned: every
/// caller already has both strings on hand at the point of failure.
#[derive(Debug, Clone, Copy)]
pub struct RequestOrigin<'a> {
    /// The URL actually posted to, after base-URL joining.
    pub url: &'a str,
    /// The model as sent on the wire, provider prefix already stripped.
    pub model: &'a str,
}

/// [`map_status_error`] with the response headers, so a 429 keeps the wait the
/// provider asked for, and the request's identity so the log names it.
pub fn map_status_error_with_headers(
    status: u16,
    body: String,
    headers: &reqwest::header::HeaderMap,
    origin: RequestOrigin<'_>,
) -> ApiError {
    map_status_error_inner(status, body, parse_retry_after(headers), origin)
}

pub fn map_status_error(status: u16, body: String) -> ApiError {
    map_status_error_inner(
        status,
        body,
        None,
        RequestOrigin {
            url: "unknown",
            model: "unknown",
        },
    )
}

fn map_status_error_inner(
    status: u16,
    body: String,
    retry_after: Option<u64>,
    origin: RequestOrigin<'_>,
) -> ApiError {
    // Full body to the log file: 401/429 discard it entirely below, and the
    // other arms keep only a summary slice — but a production diagnosis
    // usually lives in exactly the part that gets cut.
    //
    // The URL and model are logged with it because without them the line is
    // not actionable. A user running eighteen providers who finds
    // `upstream HTTP 403 rejected request: <html>…403 Forbidden…` has no way
    // to tell WHICH endpoint said it, and an HTML body carries no clue of its
    // own — that exact line cost an hour of bisecting on 2026-08-23 before the
    // answer turned out to be a transient edge block on one provider.
    crate::logging::log_error(
        "api.http",
        &format!(
            "upstream HTTP {status} from {} (model {}) rejected request: {body}",
            origin.url, origin.model,
        ),
    );
    let summary = summarize_body(&body);
    let message = if summary.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {summary}")
    };
    match status {
        // The body is kept, not discarded: a 401 that explains itself is
        // explaining something the user can act on, and it is not always the
        // key (see `ApiError::Unauthorized`). Still `Unauthorized`, so key
        // failover and "do not retry this" are unchanged.
        401 => ApiError::Unauthorized(if summary.is_empty() {
            "check API key".to_string()
        } else {
            summary
        }),
        429 => ApiError::RateLimit {
            retry_after_secs: retry_after,
        },
        500..=599 => ApiError::Provider(message),
        // A 4xx normally means "the request is wrong", and re-sending
        // identical bytes cannot make it right — which is exactly why
        // `InvalidRequest` is not retryable. The exception is a gateway
        // reporting its OWN upstream failure with a client-error status: that
        // is a 5xx wearing the wrong number, and it clears on its own.
        //
        // So classify by the BODY, the way `openclaude`'s
        // `classifyOpenAIHttpFailure` reads 400 bodies for quota / context
        // overflow / tool incompatibility rather than trusting the status
        // alone. The request-fault check gets the first and final say.
        400..=499 => {
            // One 4xx names a fault in the request AND tells us how to fix it.
            // Checked before everything else because the body mentions
            // "thinking mode", which the request-fault list would otherwise
            // read as a parameter problem and give up on.
            //
            // No table can predict this one. Aurora's own history has DeepSeek
            // behind an OpenAI-shaped gateway running 79 clean turns without
            // replayed reasoning, and the same vendor behind AgentRouter
            // failing on the second request — so the requirement belongs to
            // the endpoint, and the endpoint is the only thing that knows it.
            // Record what it said and let the retry act on it.
            if let Some(field) = reasoning_requirement_from_body(&body) {
                remember_reasoning_requirement(origin.url, origin.model, field);
                return ApiError::ReasoningReplayRequired;
            }
            // The same statement in the opposite direction, and it has to be
            // read for the same reason: replay is now ON by default for
            // unknown OpenAI-shaped gateways, so the strict ones need a way to
            // turn it off that does not involve the user finding a setting.
            // Recorded against the endpoint, then re-issued without the field.
            if body_rejects_replayed_reasoning(&body) {
                remember_reasoning_refusal(origin.url, origin.model);
                return ApiError::ReasoningReplayRefused;
            }
            // Same mechanism again, for the cache-affinity key. It has to be
            // learned rather than predicted: two gateways on the same provider
            // TYPE answered oppositely when probed with Aurora's own body
            // (`should_send_prompt_cache_key`), and the one that refuses says
            // only "a parameter is unsupported" without naming which. So the
            // trigger is narrow on both sides — this endpoint must actually
            // have been sent the field, and the 400 must be about a parameter
            // rather than context, tools or money.
            {
                let lower = body.to_lowercase();
                if prompt_cache_key_was_sent(origin.url, origin.model)
                    && !prompt_cache_key_refused(origin.url, origin.model)
                    && body_names_parameter_fault(&lower, &body)
                {
                    remember_prompt_cache_key_refusal(origin.url, origin.model);
                    return ApiError::PromptCacheKeyRefused;
                }
            }
            let lower = body.to_lowercase();
            if !body_names_request_fault(&lower) && body_names_output_cap_fault(&lower, &body) {
                return ApiError::Provider(message);
            }
            if !body_names_request_fault(&lower) && body_names_upstream_fault(&lower, &body) {
                ApiError::Provider(message)
            } else {
                ApiError::InvalidRequest(message)
            }
        }
        _ => ApiError::InvalidRequest(message),
    }
}

/// Whether a 4xx body describes a fault in the REQUEST — something that will
/// be byte-identical on the next attempt and rejected identically.
///
/// Checked first, and it wins outright. Several of these carry retry-flavoured
/// prose ("please try again with a shorter prompt") that would otherwise read
/// as transient, and the two that matter most are conditions Aurora has to
/// *fix* rather than wait out: an overflowing context is compaction's job, and
/// a broken tool pairing is `repair_tool_pairing`'s. A thread malformed on
/// disk 400s forever — three attempts at it is three times the wait for the
/// same dead end, plus two more misleading lines in the log.
fn body_names_request_fault(lower: &str) -> bool {
    // Context overflow.
    lower.contains("context length")
        || lower.contains("context_length")
        || lower.contains("maximum context")
        || lower.contains("too many tokens")
        || lower.contains("request too large")
        || lower.contains("prompt is too long")
        || lower.contains("input length")
        // Tool pairing / tool-calling shape.
        || lower.contains("tool_use")
        || lower.contains("tool_result")
        || lower.contains("tool_call")
        // The model or the parameters are wrong.
        || lower.contains("unknown model")
        || lower.contains("model_not_found")
        || lower.contains("does not exist")
        || lower.contains("unsupported parameter")
        || lower.contains("unknown parameter")
        || lower.contains("unrecognized")
        || lower.contains("extra_forbidden")
        // Money. Waiting does not add credit.
        || lower.contains("quota")
        || lower.contains("billing")
        || lower.contains("credit")
        || lower.contains("insufficient")
        || lower.contains("payment required")
}

/// Whether a 4xx body is complaining about the OUTPUT-LENGTH parameter
/// (`max_tokens` / `max_completion_tokens`) rather than about the conversation.
///
/// Normally a rejected parameter is a dead end — the next request carries the
/// same bytes and earns the same 400. This one is different, because a gateway
/// fronting a pool does not answer it consistently. Measured against
/// `vectide.cn` on 2026-08-29, eight identical `glm-5.2` requests each:
///
/// ```text
/// max_tokens =     8,192  →  8 accepted, 0 rejected
/// max_tokens =   131,072  →  5 accepted, 3 rejected   ← same bytes, both answers
/// max_tokens =   200,000  →  4 accepted, 4 rejected
/// ```
///
/// The nodes behind one hostname disagree about the ceiling, so which one
/// answers decides whether the turn runs. Treating that as unfixable ends a
/// conversation on a coin flip; re-issuing it re-rolls, and by
/// `MAX_STREAM_ATTEMPTS` a value that works on most nodes has almost certainly
/// landed on one.
///
/// Retrying is cheap in exactly the way [`body_names_upstream_fault`] describes:
/// a 4xx is refused before generation, so the extra attempt bills nothing. A cap
/// that no node accepts still fails — it just costs the backoff ladder first,
/// which is the right trade against ending a turn that would have worked.
///
/// Aurora should not be ASKING for an impossible cap in the first place; that is
/// the catalogue's job, and `models-dev.ts::agreedLimits` is where it was fixed.
/// This is the backstop for the endpoints that are simply inconsistent.
fn body_names_output_cap_fault(lower: &str, body: &str) -> bool {
    let names_the_parameter = lower.contains("max_tokens")
        || lower.contains("max_completion_tokens")
        || lower.contains("max_output_tokens");
    if !names_the_parameter {
        return false;
    }
    // A body that names the parameter as ONE suspect among many is the
    // gateway's generic "something in here is wrong" and says nothing about the
    // cap — `vectide` answers exactly that, listing model, temperature, top_p,
    // max_tokens, tools and tool_choice together.
    let blames_it_alone = !(lower.contains("temperature") && lower.contains("tool_choice"));
    blames_it_alone
        && (lower.contains("must be")
            || lower.contains("invalid")
            || lower.contains("greater than")
            || lower.contains("out of range")
            // 输出长度参数格式错误 — "output length parameter format error", the
            // sentence the Chinese-language gateways answer with. `lower` keeps
            // non-ASCII verbatim; matched against `body` so that is plain.
            || body.contains("输出长度")
            || body.contains("必须是大于"))
}

/// Whether a 4xx body describes a transient fault UPSTREAM of the endpoint we
/// called — the gateway's own problem, reported with a client-error status.
///
/// Aggregating gateways (OpenRouter-likes, "smart routing" relays, anything
/// fronting a pool of real providers) answer 400 rather than 502/503 more
/// often than they should: from their HTTP layer's point of view the request
/// could not be served, so it was "bad". The status describes their
/// bookkeeping; the body describes what actually happened. Verbatim, from a
/// real turn:
///
/// ```text
/// HTTP 400 {"type":"upstream_unavailable",
///           "code":"upstream_unavailable",
///           "message":"上游服务暂时不可用。…请稍后重试。"}
/// ```
///
/// That is a 503 with the wrong number on it. It cleared on the next attempt,
/// but the user had to notice the failure and press Retry by hand.
///
/// Being wrong in the retry direction is cheap here: a 4xx is rejected before
/// generation, so the extra attempt bills no tokens. The price of a false
/// positive is the backoff delay, bounded by `MAX_STREAM_ATTEMPTS`.
fn body_names_upstream_fault(lower: &str, body: &str) -> bool {
    lower.contains("upstream_unavailable")
        || lower.contains("upstream_error")
        || lower.contains("no healthy upstream")
        || lower.contains("service_unavailable")
        || lower.contains("temporarily unavailable")
        || lower.contains("temporarily_unavailable")
        || lower.contains("bad_gateway")
        || lower.contains("bad gateway")
        || lower.contains("overloaded")
        || lower.contains("try again later")
        || lower.contains("retry later")
        || (lower.contains("upstream") && lower.contains("unavailable"))
        // Relays that answer in Chinese often carry no ASCII marker at all:
        // 上游服务 (upstream service), 暂时不可用 (temporarily unavailable),
        // 请稍后重试 (please retry shortly). Matched against the original
        // body — `to_lowercase` leaves CJK alone, but reading it here says
        // plainly that these are not case-folded strings.
        || body.contains("上游服务")
        || body.contains("暂时不可用")
        || body.contains("请稍后重试")
}

/// Map a [`reqwest::Error`] to [`ApiError`]. Connection / timeout / IO
/// failures all flatten to [`ApiError::Network`].
pub fn map_reqwest_error(err: reqwest::Error) -> ApiError {
    if err.is_timeout() || err.is_connect() || err.is_request() || err.is_body() {
        ApiError::Network(err.to_string())
    } else if err.is_decode() {
        ApiError::Decode(err.to_string())
    } else {
        ApiError::Network(err.to_string())
    }
}

/// Trim a long error body so user-facing error messages stay scannable.
fn summarize_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.len() <= 512 {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(512).collect();
    format!("{head}…")
}

// ---------------------------------------------------------------------------
// Anthropic streaming JSON types (subset — only the fields we read).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AnthropicStreamEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub index: Option<i32>,
    pub message: Option<AnthropicMessageEnvelope>,
    pub content_block: Option<AnthropicContentBlockMeta>,
    pub delta: Option<AnthropicDelta>,
    pub usage: Option<AnthropicUsageWire>,
    /// Anthropic's in-band `event: error` payload (`overloaded_error`,
    /// `api_error`, …), delivered after HTTP 200 like everyone else's.
    /// Same reasoning as [`OpenAiStreamingResponse::error`]: unparsed, it
    /// fell through the event match and the turn ended in silence.
    #[serde(default)]
    pub error: Option<OpenAiStreamError>,
}

#[derive(Debug, Deserialize)]
pub struct AnthropicMessageEnvelope {
    pub usage: Option<AnthropicUsageWire>,
}

#[derive(Debug, Deserialize)]
pub struct AnthropicContentBlockMeta {
    #[serde(rename = "type")]
    pub block_type: String,
    pub id: Option<String>,
    pub name: Option<String>,
    /// Payload of a `redacted_thinking` block: the model's reasoning, encrypted
    /// by Anthropic's safety systems instead of returned as readable text.
    /// Opaque, and must be replayed verbatim or the history is rejected.
    pub data: Option<String>,
}

/// The five effort tiers Anthropic accepts under `output_config.effort`.
///
/// Ordered, because the ladder grew over time and a tier a model does not know
/// is a 400 — `xhigh` arrived with Opus 4.7 and does not exist on 4.6.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AnthropicEffort {
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

impl AnthropicEffort {
    #[must_use]
    pub fn wire(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
        }
    }

    /// Parse a user-supplied tier. Accepts the hyphenated spelling some
    /// gateways use for `xhigh`.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "low" | "minimal" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "xhigh" | "x-high" | "extra-high" => Some(Self::XHigh),
            "max" | "maximum" => Some(Self::Max),
            _ => None,
        }
    }
}

/// How one Anthropic model's reasoning surface is shaped.
///
/// The `/v1/messages` reasoning contract changed materially at Claude 4.7 and
/// the old shape is now a hard error, not a deprecation: `budget_tokens` and
/// `temperature`/`top_p`/`top_k` each return a 400 on Opus 4.7 and later. A
/// single request shape therefore cannot serve both generations — Aurora has
/// to know which one it is talking to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnthropicSurface {
    /// `true` → `{"type":"adaptive"}` and `output_config.effort`.
    /// `false` → the legacy `{"type":"enabled","budget_tokens":N}`.
    pub adaptive: bool,
    /// Omitting `thinking` entirely still reasons (Opus 5, Sonnet 5, Fable 5).
    pub thinks_by_default: bool,
    /// `{"type":"disabled"}` is accepted at all — Fable 5 rejects it outright
    /// and wants the parameter omitted instead.
    pub allows_disabled: bool,
    /// Highest tier this model accepts; `None` means it has no effort control.
    pub max_effort: Option<AnthropicEffort>,
    /// `temperature` / `top_p` / `top_k` are accepted.
    pub allows_sampling: bool,
    /// `thinking.display` defaults to `"omitted"`, so a readable summary has to
    /// be asked for. On 4.6 the default was `"summarized"` and asking is a
    /// no-op — but harmless, so this only gates whether we bother.
    pub summaries_need_opt_in: bool,
}

/// The reasoning surface for a model id.
///
/// Matching is on a normalized id so a Bedrock `anthropic.` prefix, a dated
/// snapshot suffix, or a gateway's casing all land on the same row.
///
/// **Unknown models get the legacy shape**, deliberately. A provider typed
/// "anthropic" is very often a gateway that speaks the Messages API without
/// being Anthropic, and `{"type":"enabled","budget_tokens":N}` is the shape
/// those gateways universally implement — `adaptive` is recent and many do not
/// know it. Guessing modern on an unknown id would break every gateway; the
/// cost of guessing legacy on a genuinely new Claude is one 400 the user can
/// fix by naming the model.
#[must_use]
pub fn anthropic_surface_for(model: &str) -> AnthropicSurface {
    let id = model
        .trim()
        .to_ascii_lowercase()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim_start_matches("anthropic.")
        .to_string();

    let has = |needle: &str| id.contains(needle);

    // Claude Fable 5 / Mythos 5 — thinking is always on and cannot be turned
    // off; an explicit `disabled` is a 400 at any effort.
    if has("fable-5") || has("mythos-5") {
        return AnthropicSurface {
            adaptive: true,
            thinks_by_default: true,
            allows_disabled: false,
            max_effort: Some(AnthropicEffort::Max),
            allows_sampling: false,
            summaries_need_opt_in: true,
        };
    }

    // Claude Opus 5 / Sonnet 5 — adaptive by default when `thinking` is
    // omitted, which is the opposite of 4.8/4.7.
    if has("opus-5") || has("sonnet-5") {
        return AnthropicSurface {
            adaptive: true,
            thinks_by_default: true,
            allows_disabled: true,
            max_effort: Some(AnthropicEffort::Max),
            allows_sampling: false,
            summaries_need_opt_in: true,
        };
    }

    // Opus 4.7 / 4.8 — same request surface, but omitting `thinking` means no
    // thinking, so it has to be asked for explicitly.
    if has("opus-4-8") || has("opus-4.8") || has("opus-4-7") || has("opus-4.7") {
        return AnthropicSurface {
            adaptive: true,
            thinks_by_default: false,
            allows_disabled: true,
            max_effort: Some(AnthropicEffort::Max),
            allows_sampling: false,
            summaries_need_opt_in: true,
        };
    }

    // Opus 4.6 / Sonnet 4.6 — adaptive exists and is recommended, but the
    // ladder stops at `max` with no `xhigh`, sampling is still accepted, and
    // summaries are already the default.
    if has("opus-4-6") || has("opus-4.6") || has("sonnet-4-6") || has("sonnet-4.6") {
        return AnthropicSurface {
            adaptive: true,
            thinks_by_default: false,
            allows_disabled: true,
            max_effort: Some(AnthropicEffort::Max),
            allows_sampling: true,
            summaries_need_opt_in: false,
        };
    }

    // Everything older, and everything unrecognized: the legacy budget shape.
    AnthropicSurface {
        adaptive: false,
        thinks_by_default: false,
        allows_disabled: true,
        // Opus 4.5 accepted low/medium/high; nothing older takes effort at all.
        max_effort: (has("opus-4-5") || has("opus-4.5")).then_some(AnthropicEffort::High),
        allows_sampling: true,
        summaries_need_opt_in: false,
    }
}

/// Pack a `redacted_thinking` payload into the `Thinking.signature` slot,
/// tagged so replay can tell it apart from a real signature (and from the
/// Responses adapter's encrypted reasoning items, which use the same slot).
///
/// Reusing the slot rather than adding a `ContentBlock` variant keeps this to
/// the two adapters that care: everything in between — persistence, token
/// counting, the UI's "Thought" affordance, `ReasoningReplay` — already treats
/// it correctly as a thinking block with no readable text.
#[must_use]
pub fn encode_redacted_thinking(data: &str) -> String {
    json!({ "provider": "anthropic-redacted", "data": data }).to_string()
}

/// The payload of a signature written by [`encode_redacted_thinking`], or
/// `None` when this is an ordinary signature.
#[must_use]
pub fn decode_redacted_thinking(signature: &str) -> Option<String> {
    let value: Value = serde_json::from_str(signature).ok()?;
    if value.get("provider")?.as_str()? != "anthropic-redacted" {
        return None;
    }
    Some(value.get("data")?.as_str()?.to_string())
}

/// Anthropic delta. Used for both `content_block_delta` (where
/// `delta_type` is set) and `message_delta` (where it carries
/// `stop_reason` instead). `delta_type` is therefore optional — if
/// the event is a `message_delta`, the upstream JSON has no `type`
/// inside the delta object and a required field would fail the whole
/// parse and silently drop the usage tally.
#[derive(Debug, Deserialize)]
pub struct AnthropicDelta {
    #[serde(rename = "type")]
    pub delta_type: Option<String>,
    pub text: Option<String>,
    pub thinking: Option<String>,
    pub signature: Option<String>,
    pub partial_json: Option<String>,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AnthropicUsageWire {
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub cache_creation_input_tokens: Option<u32>,
    pub cache_read_input_tokens: Option<u32>,
}

// ---------------------------------------------------------------------------
// OpenAI-compat streaming JSON types (subset).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct OpenAiStreamingResponse {
    #[serde(default)]
    pub choices: Vec<OpenAiStreamingChoice>,
    pub usage: Option<OpenAiUsageData>,
    /// An error the provider streamed **in-band**, after having already
    /// returned HTTP 200.
    ///
    /// This is how upstream timeouts, capacity errors and moderation stops
    /// actually arrive from OpenAI-compatible backends and the proxies in
    /// front of them: the headers say 200, the body carries
    /// `data: {"error":{...}}`, and the stream then closes — usually with a
    /// `[DONE]` right behind it.
    ///
    /// Without this field the frame still deserialized *successfully* into
    /// `{choices: [], usage: None}`, so the message was dropped on the floor
    /// and the turn ended looking like a clean, empty completion. That is
    /// the entire reason agent turns appeared to stop mid-task for no
    /// reason. Never remove this field.
    #[serde(default)]
    pub error: Option<OpenAiStreamError>,
}

/// The in-band error envelope. Every field is optional because the shape
/// varies by vendor; [`OpenAiStreamError::render`] copes with all of them.
#[derive(Debug, Deserialize)]
pub struct OpenAiStreamError {
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub code: Option<Value>,
}

impl OpenAiStreamError {
    /// A message worth showing a person. Falls back through the envelope's
    /// other fields so an error with no `message` still says something more
    /// useful than "the turn ended".
    #[must_use]
    pub fn render(&self) -> String {
        if let Some(msg) = self
            .message
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
        {
            return msg.to_string();
        }
        let code = self.code.as_ref().map(|c| match c {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        });
        match (self.kind.as_deref(), code.as_deref()) {
            (Some(kind), Some(code)) => format!("provider error {code} ({kind})"),
            (Some(kind), None) => format!("provider error ({kind})"),
            (None, Some(code)) => format!("provider error {code}"),
            (None, None) => "the provider reported an error but gave no detail".to_string(),
        }
    }

    /// Is this envelope actually populated? Some backends emit
    /// `"error": null` or `"error": {}` on ordinary chunks; those must not
    /// abort a healthy stream.
    #[must_use]
    pub fn is_populated(&self) -> bool {
        self.message
            .as_deref()
            .is_some_and(|m| !m.trim().is_empty())
            || self.kind.is_some()
            || self.code.is_some()
    }
}

#[derive(Debug, Deserialize)]
pub struct OpenAiStreamingChoice {
    pub delta: OpenAiStreamingDelta,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct OpenAiStreamingDelta {
    pub content: Option<String>,
    pub reasoning: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls: Option<Vec<OpenAiStreamingToolCall>>,
}

#[derive(Debug, Deserialize)]
pub struct OpenAiStreamingToolCall {
    pub index: i32,
    pub id: Option<String>,
    pub function: Option<OpenAiStreamingFunction>,
}

#[derive(Debug, Deserialize)]
pub struct OpenAiStreamingFunction {
    pub name: Option<String>,
    pub arguments: Option<String>,
}

// `Default` is for constructing partial usage in tests. It does NOT relax the
// wire contract: `#[serde(default)]` is per-field here, not on the struct, so
// `prompt_tokens` and `completion_tokens` are still required on the wire.
#[derive(Debug, Default, Deserialize)]
pub struct OpenAiUsageData {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    #[serde(default)]
    pub total_tokens: u32,
    /// DeepSeek context-cache telemetry. `prompt_cache_hit_tokens` is the
    /// portion of `prompt_tokens` that was served from DeepSeek's disk
    /// cache (zero cost on their billing) — `prompt_cache_miss_tokens`
    /// is the freshly-computed remainder. Mapped onto Aurora's
    /// `TokenUsage.cache_read_input_tokens` so the existing UI badges
    /// surface DeepSeek hits the same way they surface Anthropic ones.
    ///
    /// Important: unlike Anthropic, where `cache_read_input_tokens` is
    /// *additive* to `input_tokens`, DeepSeek's hit count is a *subset*
    /// of `prompt_tokens`. The DeepSeek adapter normalizes this before
    /// emitting `Usage` events so the context store math (which adds
    /// `cacheReadTokens` to `promptTokens`) stays correct for both.
    #[serde(default)]
    pub prompt_cache_hit_tokens: Option<u32>,
    #[serde(default)]
    pub prompt_cache_miss_tokens: Option<u32>,
    /// Standard OpenAI cache telemetry (`usage.prompt_tokens_details`).
    /// OpenAI, and OpenAI-compatible routers (AgentRouter, OpenRouter, …),
    /// report cache reads here as `cached_tokens` — a *subset* of
    /// `prompt_tokens`, exactly like DeepSeek's `prompt_cache_hit_tokens`.
    /// Nullable: streaming responses often send `prompt_tokens_details: null`.
    #[serde(default)]
    pub prompt_tokens_details: Option<OpenAiPromptTokensDetails>,
    /// What the PROVIDER says this request cost, in USD.
    ///
    /// Routers in the OpenRouter family report this on the final usage chunk.
    /// When present it outranks anything Aurora can compute: it already
    /// includes gateway markup, BYOK rates, promotional pricing and
    /// per-account discounts, none of which a published list price knows
    /// about. Absent for direct providers (Anthropic, OpenAI), where the
    /// catalog price is the best available answer.
    #[serde(default)]
    pub cost: Option<f64>,
}

/// The `usage.prompt_tokens_details` sub-object in the OpenAI wire shape.
/// Only the cache field is read; other members (`audio_tokens`, …) are
/// ignored.
#[derive(Debug, Deserialize, Default)]
pub struct OpenAiPromptTokensDetails {
    #[serde(default)]
    pub cached_tokens: Option<u32>,
}

impl OpenAiUsageData {
    /// Cache-read token count from whichever field the provider populated:
    /// DeepSeek's top-level `prompt_cache_hit_tokens` takes precedence, then
    /// the standard OpenAI `prompt_tokens_details.cached_tokens`. In both
    /// wire shapes the value is a subset of `prompt_tokens`, so callers must
    /// subtract it from `input_tokens` to keep Aurora's additive context math
    /// correct.
    ///
    /// `Some(0)` and `None` mean different things and both are returned.
    /// `Some(0)` is the provider stating this request missed cache; `None` is
    /// the provider saying nothing about cache at all. This used to be
    /// filtered down to `None` in both cases, which cost the UI the ability to
    /// tell "your cache just broke" apart from "this provider doesn't report
    /// caching" — it rendered the first as the second, i.e. as nothing.
    /// Subtracting `Some(0)` from `input_tokens` is a no-op, so the context
    /// math is unaffected.
    #[must_use]
    pub fn cache_read_tokens(&self) -> Option<u32> {
        self.prompt_cache_hit_tokens.or_else(|| {
            self.prompt_tokens_details
                .as_ref()
                .and_then(|d| d.cached_tokens)
        })
    }
}

// ---------------------------------------------------------------------------
// Request body builders. Minimum-viable wire-shape generators that match
// what Aurora's existing kernel sends. Tests against real upstream APIs
// are out of scope for the verify crate; we only need a valid JSON body
// so the HTTP request reaches the (mocked) server.
// ---------------------------------------------------------------------------

/// Strip a leading `provider_id:` prefix from a model identifier.
/// `"anthropic:claude-3"` → `"claude-3"`. `"claude-3"` → `"claude-3"`.
pub fn unprefix_model<'a>(model: &'a str, provider_id: &str) -> &'a str {
    if !provider_id.is_empty() {
        if let Some(rest) = model.strip_prefix(&format!("{provider_id}:")) {
            return rest;
        }
    }
    // Fall back to "strip whatever is before the first colon" — keeps
    // pre-cutover frontend code that emits unqualified models working.
    model.split_once(':').map(|(_, rest)| rest).unwrap_or(model)
}

/// Build the JSON body for an Anthropic `/v1/messages` streaming call.
pub fn build_anthropic_body(request: &ApiRequest<'_>, config: &ProviderConfigSnapshot) -> Value {
    let model = unprefix_model(request.model, &config.provider_id);
    let (system, messages) = anthropic_split_system_and_messages(request, config.supports_vision);

    let max_tokens = request.max_output_tokens.max(1);
    // No invented default. See `insert_temperature`.
    let temperature = request.temperature.or(config.default_temperature);

    let caching = supports_prompt_caching(config);
    let mut messages = messages;
    if caching {
        // Rolling breakpoint on the tail of history. Each iteration appends
        // an assistant message plus its tool results, so marking the end of
        // the current history means the NEXT iteration reads all of it from
        // cache and only writes the delta. Without this, a 25-iteration turn
        // re-pays full price for the whole conversation 25 times.
        mark_last_content_block(&mut messages);
    }

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model.to_string()));
    body.insert("messages".to_string(), Value::Array(messages));
    body.insert("max_tokens".to_string(), Value::from(max_tokens));
    body.insert("stream".to_string(), Value::Bool(true));
    insert_temperature(&mut body, temperature);

    if let Some(system_prompt) = system {
        if !system_prompt.is_empty() {
            let (static_half, dynamic_half) = split_system_boundary(&system_prompt);
            body.insert(
                "system".to_string(),
                if caching {
                    // Caching needs the block form; the plain-string form has
                    // nowhere to hang `cache_control`.
                    //
                    // The breakpoint goes on the STATIC half only. Everything
                    // after it — the execution-mode section, the MCP server
                    // summary — changes mid-conversation, and a marker at the
                    // very end (what this used to do) meant one MCP server
                    // connecting re-billed the entire prompt. Measured on a
                    // 7.2k-token prompt, on the turn the volatile text changed:
                    // 7,280 billed / 1.5% cache hit before, 96 / 98.7% after.
                    let mut blocks = vec![json!({
                        "type": "text",
                        "text": static_half,
                        "cache_control": { "type": "ephemeral" },
                    })];
                    if let Some(dynamic) = dynamic_half {
                        blocks.push(json!({ "type": "text", "text": dynamic }));
                    }
                    Value::Array(blocks)
                } else {
                    Value::String(strip_system_boundary(&system_prompt).into_owned())
                },
            );
        }
    }

    if !request.tools.is_empty() {
        let mut tools: Vec<Value> = request.tools.iter().map(anthropic_tool_schema).collect();
        if caching {
            // Anthropic caches the prefix UP TO each breakpoint, and the
            // request prefix is ordered tools → system → messages. Marking
            // the last tool caches the whole schema list, which is the
            // largest fixed payload Aurora sends and is re-sent on every
            // one of a turn's iterations.
            if let Some(last) = tools.last_mut() {
                set_cache_control(last);
            }
        }
        body.insert("tools".to_string(), Value::Array(tools));
        if request.tool_choice == crate::agent_runtime::api_client::ToolChoice::None {
            body.insert("tool_choice".to_string(), json!({ "type": "none" }));
        }
    }

    // One semantic request lands here. The adapter translates it; the
    // frontend no longer has to smuggle an OpenAI field through custom params
    // and hope this builder notices it.
    let effort = request
        .reasoning
        .effort
        // Backward compatibility for persisted/manual pre-cutover fields.
        .or_else(|| {
            config
                .custom_params
                .as_ref()
                .and_then(|p| p.get("reasoning_effort"))
                .and_then(Value::as_str)
        })
        .map(str::to_ascii_lowercase);

    let wants_thinking = request.reasoning.enabled && config.supports_thinking;

    // What THIS model accepts. The reasoning contract changed at Claude 4.7 and
    // the old shape is a hard error there, so one body cannot serve both.
    let mut surface = anthropic_surface_for(request.model);
    match request.reasoning.request_mode {
        ReasoningRequestMode::AnthropicAdaptive => {
            // Explicit compatibility override for a gateway/model whose id is
            // not a Claude family name. Adaptive APIs reject budget_tokens and
            // sampling, and readable summaries need to be requested.
            surface.adaptive = true;
            surface.thinks_by_default = false;
            surface.allows_disabled = true;
            surface.max_effort = Some(AnthropicEffort::Max);
            surface.allows_sampling = false;
            surface.summaries_need_opt_in = true;
        }
        ReasoningRequestMode::AnthropicBudget => {
            surface.adaptive = false;
            surface.thinks_by_default = false;
            surface.allows_disabled = true;
            surface.max_effort = None;
            surface.allows_sampling = true;
            surface.summaries_need_opt_in = false;
        }
        _ => {}
    }

    let thinking_on = if surface.adaptive {
        // ── Claude 4.6+ ──────────────────────────────────────────────
        // `budget_tokens` is a 400 here. Depth is `output_config.effort`;
        // the `thinking` object only says on, off, or how to display.
        let on = wants_thinking || surface.thinks_by_default;

        if on {
            let mut thinking = json!({ "type": "adaptive" });
            if surface.summaries_need_opt_in {
                // `display` defaults to "omitted" on 4.7+, which streams
                // thinking blocks whose text is empty. Aurora renders those
                // blocks, so without this the UI shows a reasoning card with
                // nothing in it and a long pause before the answer.
                thinking["display"] = Value::String("summarized".into());
            }
            body.insert("thinking".to_string(), thinking);
        } else if surface.allows_disabled {
            body.insert("thinking".to_string(), json!({ "type": "disabled" }));
        }
        // Fable 5 with reasoning off: omit the field entirely — an explicit
        // `disabled` is a 400 there, and omitting it runs adaptive anyway.

        if let Some(ceiling) = surface.max_effort {
            // Clamp rather than reject: a tier the model doesn't know is a 400,
            // and `xhigh` does not exist below 4.7.
            let mut level = effort
                .as_deref()
                .and_then(AnthropicEffort::parse)
                .unwrap_or(AnthropicEffort::High)
                .min(ceiling);
            // Disabling thinking is only accepted at `high` or below; pairing
            // it with `xhigh`/`max` is a 400 on Opus 5.
            if !on {
                level = level.min(AnthropicEffort::High);
            }
            body.insert(
                "output_config".to_string(),
                json!({ "effort": level.wire() }),
            );
        }
        on
    } else {
        // ── Claude 4.6 and earlier, and every unrecognized model ─────
        // The legacy budget shape, which is also what Anthropic-compatible
        // gateways implement.
        if wants_thinking {
            match anthropic_thinking_plan(
                request.reasoning.budget_tokens,
                effort.as_deref(),
                max_tokens,
            ) {
                Some((budget, total_max_tokens)) => {
                    body.insert(
                        "thinking".to_string(),
                        json!({ "type": "enabled", "budget_tokens": budget }),
                    );
                    // Reasoning tokens bill against `max_tokens` too, so the cap
                    // has to cover the budget ON TOP of the answer the user asked
                    // for. Without this the model can spend the whole allowance
                    // thinking and get cut off at `max_tokens` mid-thought, having
                    // emitted no reply at all.
                    body.insert("max_tokens".to_string(), Value::from(total_max_tokens));
                    true
                }
                // Answer budget too small to pair with a valid reasoning budget —
                // omit `thinking` rather than send a body Anthropic would reject.
                None => false,
            }
        } else {
            false
        }
    };

    // Sampling parameters were REMOVED at Claude 4.7 — sending `temperature`
    // at all is a 400 there, not merely ignored. On the models that still take
    // it, extended thinking additionally pins it to 1, so any other value is
    // also rejected; dropping it beats fighting the provider's default.
    if !surface.allows_sampling || thinking_on {
        body.remove("temperature");
        body.remove("top_p");
        body.remove("top_k");
    }

    if let Some(custom) = &config.custom_params {
        for (key, value) in custom {
            // Never forward `reasoning_effort` — it is not an Anthropic field and
            // was already translated into `thinking` above. `reasoning_replay`
            // is an Aurora directive for the OpenAI-compat path; Anthropic
            // replays thinking natively, so here it is only noise to strip.
            if key.eq_ignore_ascii_case("reasoning_effort")
                || key.eq_ignore_ascii_case("reasoning_replay")
            {
                continue;
            }
            body.insert(key.clone(), value.clone());
        }
    }

    Value::Object(body)
}

/// Pick an Anthropic `thinking.budget_tokens`.
///
/// Anthropic constrains the budget to `1024 <= budget < max_tokens`, and
/// counts reasoning tokens against `max_tokens` alongside the visible reply.
///
/// The budget is therefore **additive, not a share**: it is sized from the
/// caller's *answer* budget and the total cap is raised to cover both (see
/// [`anthropic_max_tokens_with_thinking`]). Carving the budget out of
/// `max_tokens` instead — the previous behaviour — meant picking `xhigh`
/// left the model ~10% of the cap to answer in, so a long reasoning pass
/// consumed the entire allowance and the turn ended at `max_tokens` with
/// nothing but thinking to show for it.
///
/// An `explicit` budget (the user's own choice, for models whose reasoning
/// control is a budget slider rather than an effort tier) wins and is only
/// clamped to the floor.
///
/// Returns `None` when the answer budget is too small to be worth pairing
/// with reasoning — the caller then omits `thinking` entirely instead of
/// emitting an invalid body.
///
/// `None` effort means a plain thinking toggle (no tier picked); it gets the
/// same middle multiple as `medium`.
fn anthropic_thinking_budget(
    explicit: Option<u32>,
    effort: Option<&str>,
    answer_tokens: u32,
) -> Option<u32> {
    const MIN_BUDGET: u32 = 1024;
    if answer_tokens <= MIN_BUDGET {
        return None;
    }
    // The user picked a number — respect it. It no longer competes with the
    // answer budget, so the only bound left is Anthropic's 1024 floor.
    if let Some(budget) = explicit.filter(|b| *b > 0) {
        return Some(budget.max(MIN_BUDGET));
    }
    // Multiples of the answer budget. A higher tier buys MORE thinking on top
    // of the same reply allowance rather than trading one for the other.
    let (num, den): (u64, u64) = match effort {
        Some("low") => (1, 2),
        Some("high") => (2, 1),
        Some("xhigh") | Some("max") => (3, 1),
        // "medium", an unrecognized tier, or a plain toggle.
        _ => (1, 1),
    };
    let want = (u64::from(answer_tokens) * num / den).min(u64::from(u32::MAX)) as u32;
    Some(want.max(MIN_BUDGET))
}

/// Anthropic's hard ceiling for `max_tokens` across current models. The
/// additive budget can outgrow what any model will accept (a 32k answer
/// budget on `xhigh` asks for 128k), and an over-cap request is a flat 400,
/// so the combined total is clamped here. Users on a model that accepts more
/// can still override `max_tokens` through `customParams` — those merge last.
const ANTHROPIC_MAX_TOKENS_CEILING: u32 = 64_000;

/// Anthropic's floor for `thinking.budget_tokens`.
const ANTHROPIC_MIN_THINKING_BUDGET: u32 = 1024;

/// Resolve the reasoning budget and the combined output cap **together**, so
/// they cannot contradict each other.
///
/// Two invariants have to hold at once, and clamping them independently gets
/// one of them wrong:
///
/// 1. `budget_tokens < max_tokens` — Anthropic rejects the request otherwise.
/// 2. `max_tokens <= ANTHROPIC_MAX_TOKENS_CEILING` — models 400 above their cap.
///
/// When the requested total exceeds the ceiling we shrink the *reasoning*
/// budget and leave the answer allowance whole, because starving the reply is
/// the exact failure this whole path exists to prevent. Only when the answer
/// budget alone fills the ceiling — leaving no room to think — do we split the
/// cap and accept a shorter reply.
///
/// Returns `None` when no split can satisfy both invariants; the caller then
/// omits `thinking` rather than sending a body Anthropic would reject.
fn anthropic_thinking_plan(
    explicit: Option<u32>,
    effort: Option<&str>,
    answer_tokens: u32,
) -> Option<(u32, u32)> {
    let desired = anthropic_thinking_budget(explicit, effort, answer_tokens)?;
    let total = answer_tokens
        .saturating_add(desired)
        .min(ANTHROPIC_MAX_TOKENS_CEILING);

    // Room the ceiling leaves for reasoning once the answer keeps its share.
    let room = total.saturating_sub(answer_tokens);
    let budget = if room >= ANTHROPIC_MIN_THINKING_BUDGET {
        desired.min(room)
    } else {
        // The answer budget alone is at/over the ceiling. Concede half the cap
        // so reasoning still happens; the reply gets the other half.
        (total / 2).max(ANTHROPIC_MIN_THINKING_BUDGET)
    };

    // Invariant 1. If even the floor can't fit under the cap, there is no valid
    // thinking config at this size.
    if budget >= total {
        return None;
    }
    Some((budget, total))
}

fn anthropic_tool_schema(schema: &ToolSchema) -> Value {
    json!({
        "name": schema.name,
        "description": schema.description,
        "input_schema": schema.input_schema,
    })
}

/// Separates the session-stable half of the system prompt from the half that
/// changes while a conversation is open (execution mode, active plan, the MCP
/// server summary).
///
/// The frontend composes the prompt as `{static}\n\n{BOUNDARY}\n\n{dynamic}`
/// (`src/apps/agent/services/runtime/agent-prompt.ts`). The literal is
/// duplicated there because the prompt crosses IPC as an opaque string, and
/// `the_boundary_literal_matches_the_frontend` pins both copies.
///
/// The model must never see this line: the Anthropic path consumes it to place
/// a cache breakpoint, every other path strips it.
pub(crate) const SYSTEM_PROMPT_DYNAMIC_BOUNDARY: &str = "__AURORA_SYSTEM_DYNAMIC_BOUNDARY__";

/// Split a composed system prompt at the boundary.
///
/// Returns `(static_half, Some(dynamic_half))` when the marker is present, and
/// `(whole, None)` when it is not — an older frontend, a caller that built the
/// prompt by hand, or a team/subagent prompt all land in the second case and
/// keep the previous single-block behaviour.
///
/// Both halves are trimmed: the marker is surrounded by the same `\n\n` the
/// sections are joined with, and leaving that on would put a blank line at the
/// head of the dynamic block.
pub(crate) fn split_system_boundary(prompt: &str) -> (&str, Option<&str>) {
    match prompt.split_once(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) {
        Some((head, tail)) => {
            let tail = tail.trim();
            (
                head.trim_end(),
                if tail.is_empty() { None } else { Some(tail) },
            )
        }
        None => (prompt, None),
    }
}

/// Remove the boundary marker for providers that cannot act on it.
///
/// Borrows when there is nothing to strip, which is the common case for every
/// provider whose prompt never carried a marker.
pub(crate) fn strip_system_boundary(prompt: &str) -> std::borrow::Cow<'_, str> {
    if !prompt.contains(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) {
        return std::borrow::Cow::Borrowed(prompt);
    }
    let (head, tail) = split_system_boundary(prompt);
    std::borrow::Cow::Owned(match tail {
        Some(tail) => format!("{head}\n\n{tail}"),
        None => head.to_string(),
    })
}

/// Whether this provider understands Anthropic's `cache_control` markers.
///
/// Deliberately narrow. `cache_control` is an unknown field to everything that
/// merely speaks an Anthropic-shaped wire format, and an unknown field is how
/// Aurora has been bitten before (the `oneOf` 400s on xAI, the `budget_tokens`
/// handling on compat proxies). The cost of a false negative is the status quo,
/// full price and no cache; the cost of a false positive is every request
/// failing with HTTP 400, so this errs hard toward off.
///
/// **MiniMax was excluded on that caution and it was wrong.** Measured against
/// the live endpoint on 2026-09-09, two identical requests carrying one
/// `cache_control` breakpoint on a 1,582-token system prompt:
///
/// | | first call | second call |
/// |---|---|---|
/// | `cache_creation_input_tokens` | 1582 | 0 |
/// | `cache_read_input_tokens` | 0 | **1582** |
/// | `input_tokens` | 0 | 0 |
///
/// A clean write then a clean hit, and `input_tokens` at zero confirms the
/// three fields are DISJOINT and additive exactly as Anthropic reports them —
/// which is what Aurora's context arithmetic already assumes everywhere.
///
/// Their docs put cache reads at $0.06/M against $0.30/M for fresh input, so
/// the exclusion was costing 20x on the cached part of every single turn.
/// MiniMax caps a request at 4 `cache_control` markers; Aurora places at most
/// four (asserted by `at_most_four_cache_breakpoints_are_emitted`).
fn supports_prompt_caching(config: &ProviderConfigSnapshot) -> bool {
    let provider_type = config.effective_provider_type();
    provider_type.eq_ignore_ascii_case("anthropic")
        // The subscription route is Anthropic's own endpoint; the plan bills
        // cached reads at the same discount as the API does.
        || provider_type.eq_ignore_ascii_case(super::claude_code::CLAUDE_CODE_PROVIDER_TYPE)
        || provider_type.eq_ignore_ascii_case(super::minimax::MINIMAX_PROVIDER_TYPE)
}

/// Attach an ephemeral `cache_control` marker to a JSON object in place.
/// Non-objects are left alone rather than silently coerced.
fn set_cache_control(block: &mut Value) {
    if let Some(obj) = block.as_object_mut() {
        obj.insert("cache_control".to_string(), json!({ "type": "ephemeral" }));
    }
}

/// Put a cache breakpoint on the final content block of the last message.
///
/// A breakpoint caches the exact prefix up to itself, so this only pays
/// while the last message is one the next request will send unchanged. It
/// always is: the runtime appends nothing to a request that is not already
/// in the transcript exactly as sent (it used to end requests with a
/// rebuilt state block, and the breakpoint had to step back over it).
///
/// Handles both content shapes Anthropic accepts: a bare string (promoted
/// to a one-element text block, since a string has nowhere to hang the
/// marker) and an array of blocks (marks the last one).
///
/// Anthropic allows at most 4 breakpoints per request; this is the third
/// and last one Aurora sets, after tools and system.
fn mark_last_content_block(messages: &mut [Value]) {
    let Some(last_message) = messages.last_mut() else {
        return;
    };
    let Some(content) = last_message.get_mut("content") else {
        return;
    };

    match content {
        Value::String(text) => {
            *content = json!([{
                "type": "text",
                "text": std::mem::take(text),
                "cache_control": { "type": "ephemeral" },
            }]);
        }
        Value::Array(blocks) => {
            if let Some(last) = blocks.last_mut() {
                set_cache_control(last);
            }
        }
        _ => {}
    }
}

fn anthropic_split_system_and_messages(
    request: &ApiRequest<'_>,
    supports_vision: bool,
) -> (Option<String>, Vec<Value>) {
    let mut system_chunks: Vec<String> = Vec::new();
    if let Some(prompt) = request.system_prompt {
        if !prompt.is_empty() {
            system_chunks.push(prompt.to_string());
        }
    }

    let mut output: Vec<Value> = Vec::new();
    for message in request.messages {
        match message.role {
            MessageRole::System => {
                for block in &message.blocks {
                    if let ContentBlock::Text { text } = block {
                        if !text.is_empty() {
                            system_chunks.push(text.clone());
                        }
                    }
                }
            }
            MessageRole::User => {
                output.push(json!({
                    "role": "user",
                    "content": message_blocks_to_anthropic_content(&message.blocks, supports_vision),
                }));
            }
            MessageRole::Assistant => {
                output.push(json!({
                    "role": "assistant",
                    "content": message_blocks_to_anthropic_content(&message.blocks, supports_vision),
                }));
            }
            MessageRole::Tool => {
                output.push(json!({
                    "role": "user",
                    "content": message_blocks_to_anthropic_content(&message.blocks, supports_vision),
                }));
            }
        }
    }

    let system = if system_chunks.is_empty() {
        None
    } else {
        Some(system_chunks.join("\n\n"))
    };
    (system, output)
}

/// Expand a (possibly image-bearing) text body into Anthropic content
/// blocks. A `<aurora_image>` marker becomes a real `image` block for
/// vision models; for non-vision models the markers are stripped to a
/// placeholder so the request stays text-only.
fn anthropic_text_to_blocks(text: &str, supports_vision: bool) -> Vec<Value> {
    if !text.contains("<aurora_image ") {
        return vec![json!({ "type": "text", "text": text })];
    }
    if !supports_vision {
        return vec![json!({
            "type": "text",
            "text": strip_aurora_images_for_text(text),
        })];
    }
    split_aurora_images(text)
        .into_iter()
        .filter_map(|p| match p {
            AuroraImagePiece::Text(t) if t.trim().is_empty() => None,
            AuroraImagePiece::Text(t) => Some(json!({ "type": "text", "text": t })),
            AuroraImagePiece::Image { media_type, base64 } => Some(json!({
                "type": "image",
                "source": { "type": "base64", "media_type": media_type, "data": base64 },
            })),
        })
        .collect()
}

fn message_blocks_to_anthropic_content(blocks: &[ContentBlock], supports_vision: bool) -> Value {
    if blocks.is_empty() {
        return Value::String(String::new());
    }
    let mut arr: Vec<Value> = Vec::new();
    for block in blocks {
        match block {
            ContentBlock::Text { text } => {
                arr.extend(anthropic_text_to_blocks(text, supports_vision));
            }
            ContentBlock::Thinking {
                text, signature, ..
            } => {
                // A redacted block must go back as `redacted_thinking` with its
                // original `data`. Re-sending it as a `thinking` block whose
                // signature is our own JSON wrapper is a signature Anthropic
                // cannot verify, and it rejects the whole request.
                match signature.as_deref().and_then(decode_redacted_thinking) {
                    Some(data) => arr.push(json!({
                        "type": "redacted_thinking",
                        "data": data,
                    })),
                    None => {
                        let mut obj = json!({
                            "type": "thinking",
                            "thinking": text,
                        });
                        if let Some(sig) = signature {
                            obj["signature"] = Value::String(sig.clone());
                        }
                        arr.push(obj);
                    }
                }
            }
            ContentBlock::ToolUse { id, name, input } => arr.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": tool_input_for_wire(input),
            })),
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                // Detect `<aurora_image>` markers (emitted by
                // `browser_screenshot` and by `file_read` on a picture)
                // and rewrite the tool_result
                // content as a multimodal array — but only if the
                // selected model declares vision support. Otherwise
                // strip the marker down to a placeholder so the
                // model isn't poisoned with unusable base64.
                let content_value = if supports_vision {
                    anthropic_tool_result_content(content)
                } else {
                    Value::String(strip_aurora_images_for_text(content))
                };
                let mut obj = json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content_value,
                });
                if let Some(err) = is_error {
                    obj["is_error"] = Value::Bool(*err);
                }
                arr.push(obj);
            }
            // A compaction marker is an internal, persisted boundary — never
            // sent to a provider. `apply_compaction` replaces it with a plain
            // summary text block before the request is built, so reaching here
            // would be a bug; skip it defensively rather than emit junk.
            ContentBlock::Compaction { .. } => {}
            // A runtime notice is product copy for the USER ("this reply is cut
            // off"). Sending it would both waste tokens and teach the model to
            // imitate Aurora's own voice back at us.
            ContentBlock::Notice { .. } => {}
            // A background process the agent started has ended. Unlike a
            // notice, this IS the model's business — it is a fact about the
            // work, and the next move is usually to read the process's log —
            // so the detail copy goes on the wire as ordinary text.
            ContentBlock::ProcessEvent { detail, .. } => {
                arr.push(json!({ "type": "text", "text": detail }));
            }
            // A directly made picture: one line of text. Anthropic rejects
            // image blocks in assistant turns, and the model needs the name,
            // not the pixels, to refer to it.
            ContentBlock::Image { .. } => {
                if let Some(line) = block.image_as_text() {
                    arr.push(json!({ "type": "text", "text": line }));
                }
            }
        }
    }
    Value::Array(arr)
}

/// Aurora returns pictures — a `browser_screenshot` capture, an image
/// `file_read` opened — inside an
/// `<aurora_image media_type="image/jpeg">BASE64</aurora_image>` marker.
/// For Anthropic the marker is split out into a real `image` content
/// block so the model literally sees the picture; the surrounding
/// text becomes a sibling `text` block. Plain text content (the vast
/// majority of tool results) round-trips as a single string for
/// minimum wire-format churn.
fn anthropic_tool_result_content(content: &str) -> Value {
    let pieces = split_aurora_images(content);
    if pieces
        .iter()
        .all(|p| matches!(p, AuroraImagePiece::Text(_)))
    {
        // No images: keep the legacy string shape.
        return Value::String(content.to_string());
    }
    let blocks: Vec<Value> = pieces
        .into_iter()
        .filter_map(|p| match p {
            AuroraImagePiece::Text(t) if t.trim().is_empty() => None,
            AuroraImagePiece::Text(t) => Some(json!({ "type": "text", "text": t })),
            AuroraImagePiece::Image { media_type, base64 } => Some(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": base64,
                },
            })),
        })
        .collect();
    Value::Array(blocks)
}

#[derive(Debug)]
pub(crate) enum AuroraImagePiece {
    Text(String),
    Image { media_type: String, base64: String },
}

/// Split a tool_result body into image and surrounding text segments.
///
/// Detection is delegated to [`crate::api::aurora_image`], which only accepts a
/// **structurally valid** marker: well-formed attributes, an `image/*`
/// `media_type`, a close tag, and a body that is either valid base64 or blank
/// (lean). Text that merely quotes the marker syntax — this project's own docs
/// and source do, repeatedly — stays text, instead of being shipped as an image
/// part the provider then rejects with HTTP 400.
///
/// Capped at 8 images per result.
pub(crate) fn split_aurora_images(content: &str) -> Vec<AuroraImagePiece> {
    use crate::api::aurora_image::find_marker;

    const MAX_IMAGES: usize = 8;
    let mut pieces: Vec<AuroraImagePiece> = Vec::new();
    let mut images_emitted = 0usize;
    let mut cursor = 0usize;

    while images_emitted < MAX_IMAGES {
        let Some(marker) = find_marker(content, cursor) else {
            break;
        };
        if marker.start > cursor {
            let leading = content[cursor..marker.start].trim_matches(['\n', '\r']);
            if !leading.is_empty() {
                pieces.push(AuroraImagePiece::Text(leading.to_string()));
            }
        }
        let media_type = marker.media_type().to_string();
        if let Some(payload) = marker.payload() {
            // Inline base64 (composer attachments, legacy threads, or a capture
            // whose on-disk save failed so the body carries the bytes directly).
            // Validated as base64 by the parser.
            pieces.push(AuroraImagePiece::Image {
                media_type,
                base64: payload.to_string(),
            });
            images_emitted += 1;
        } else if let Some(base64) = rehydrate_image_from_src(marker.src()) {
            // Lean marker: the base64 was stripped from history to keep the JSONL
            // small; the PNG lives on disk (referenced by `src`). Re-read it now.
            pieces.push(AuroraImagePiece::Image { media_type, base64 });
            images_emitted += 1;
        }
        // else: empty body + unreadable/absent `src` (e.g. pruned screenshot) →
        // drop the image; the caption text is still emitted so context stays
        // coherent and the model isn't handed a broken reference.
        cursor = marker.end;
    }

    if cursor < content.len() {
        let trailing = content[cursor..].trim_matches(['\n', '\r']);
        if !trailing.is_empty() {
            pieces.push(AuroraImagePiece::Text(trailing.to_string()));
        }
    }
    if pieces.is_empty() {
        pieces.push(AuroraImagePiece::Text(content.to_string()));
    }
    pieces
}

/// Rehydrate a screenshot's base64 from the on-disk PNG referenced by a lean
/// marker's `src`. The persisted/model-history copy stores the path, not the
/// bytes (small JSONL, no re-uploading base64 every turn); this reads the file
/// back at request-build time. Returns `None` when there's no `src` or the file
/// can't be read (e.g. it was pruned) — the caller then keeps only the caption
/// text.
fn rehydrate_image_from_src(src: Option<&str>) -> Option<String> {
    use base64::Engine;
    // The value was minimally XML-escaped when written into the attribute.
    let path = crate::api::aurora_image::unescape_attr(src?);
    let bytes = std::fs::read(&path).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// OpenAI-compat counterpart to `anthropic_tool_result_content`.
/// Converts a tool_result string with `<aurora_image>` markers into
/// the `content: [{type:"text",text}, {type:"image_url",image_url:
/// {url:"data:..."}}]` array shape that vision-capable
/// OpenAI-compatible providers (Fireworks, Together, Groq, OpenAI
/// itself, OpenRouter) accept on the `tool` role. Falls back to a
/// plain string when no images are present so non-screenshot tool
/// results stay shape-compatible with strict providers.
/// Build the `content` of a `role: "user"` message that may embed
/// `<aurora_image>` markers (composer paste/drop, and now the screenshots
/// relocated off tool results).
///
/// This is the placement that works on every provider tested, which is why
/// [`openai_tool_result_split`] moves images here.
fn openai_user_content(content: &str) -> Value {
    let pieces = split_aurora_images(content);
    if pieces
        .iter()
        .all(|p| matches!(p, AuroraImagePiece::Text(_)))
    {
        return Value::String(content.to_string());
    }
    let blocks: Vec<Value> = pieces
        .into_iter()
        .filter_map(|p| match p {
            AuroraImagePiece::Text(t) if t.trim().is_empty() => None,
            AuroraImagePiece::Text(t) => Some(json!({ "type": "text", "text": t })),
            AuroraImagePiece::Image { media_type, base64 } => Some(json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{media_type};base64,{base64}") },
            })),
        })
        .collect();
    Value::Array(blocks)
}

/// Note left in the `role: "tool"` message when its images had to travel in a
/// separate user message, so the model knows to look at what follows rather
/// than concluding the screenshot failed.
pub(crate) const OPENAI_IMAGE_HANDOFF_NOTE: &str =
    "[The screenshot from this tool call is attached in the next message.]";

/// Split a tool result into the text a `role: "tool"` message may carry, and
/// the image parts that are delivered separately.
///
/// **Whether a `role: "tool"` message can carry an image is provider-specific,
/// and the failure mode is silent.** Aurora used to build the tool result as a
/// multimodal array with `image_url` parts in it, mirroring what the Anthropic
/// path does natively. Lenient servers accept that; strict ones return HTTP
/// 200, no error, no warning — and simply never put the image in the prompt.
/// Measured with one screenshot, three providers, same request otherwise:
///
/// | endpoint / model              | image in `role:"tool"` | in a `user` msg |
/// |-------------------------------|------------------------|-----------------|
/// | a6api · `claude-opus-5`       | dropped (`NO_IMAGE`)   | read correctly  |
/// | a6api · `gpt-5.6-luna`        | dropped (`NO_IMAGE`)   | read correctly  |
/// | MODAL (vLLM) · `kimi-k3`      | read correctly         | read correctly  |
///
/// So this is not "OpenAI forbids it" — it is that only the user-message
/// placement works EVERYWHERE, and the providers that reject it do so without
/// saying so. That silence is why `browser_screenshot` looked like it worked
/// while the agent kept reasoning from the page outline instead of the
/// picture. Images therefore ride in a following user message on every
/// OpenAI-compatible provider, and the tool message keeps the text plus
/// [`OPENAI_IMAGE_HANDOFF_NOTE`] so the model knows to look ahead.
///
/// (The Anthropic and Responses adapters are unaffected: Anthropic supports
/// images inside `tool_result` natively, and `responses.rs` already appended
/// them as a trailing user item.)
fn openai_tool_result_split(content: &str) -> (String, Vec<Value>) {
    let mut text = String::new();
    let mut images = Vec::new();
    for piece in split_aurora_images(content) {
        match piece {
            AuroraImagePiece::Text(t) => {
                if t.trim().is_empty() {
                    continue;
                }
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&t);
            }
            AuroraImagePiece::Image { media_type, base64 } => images.push(json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{media_type};base64,{base64}") },
            })),
        }
    }
    (text, images)
}

/// Replace every `<aurora_image …>BASE64</aurora_image>` block with a
/// short placeholder string so non-vision providers see context about
/// what happened without ingesting tens of thousands of base64 tokens.
pub(crate) fn strip_aurora_images_for_text(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let pieces = split_aurora_images(content);
    for (i, piece) in pieces.iter().enumerate() {
        if i > 0 && !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        match piece {
            AuroraImagePiece::Text(t) => out.push_str(t),
            AuroraImagePiece::Image { media_type, .. } => {
                // Deliberately not "screenshot": images now also arrive from
                // `file_read`, and a model told its own file read produced a
                // screenshot learns something false about what it just did.
                // The caption line that follows names the source either way.
                out.push_str(&format!(
                    "[Image omitted: {media_type} — the selected model does not accept images]"
                ));
            }
        }
    }
    out
}

/// Build the JSON body for an OpenAI-compatible `/chat/completions`
/// streaming call.
/// Put `temperature` in the body — **only when somebody actually chose one.**
///
/// Aurora used to fabricate a value at two layers: the composer resolved an
/// unset temperature to 0.8, and if that never arrived this function's
/// predecessor substituted 1.0. So every request carried a sampling setting the
/// user had never touched, sent to providers that document their own defaults.
///
/// That is wrong on preference grounds and it is wrong on correctness grounds.
/// Some models reject the parameter outright, and some accept it only in a
/// narrower form than a float gives you — OpenCode's Go surface answers
/// `The temperature parameter is illegal.：限制小数点[2]位` and fails the whole
/// request over decimal places. An invented value cannot be right for a model
/// nobody set it for, and it turns a preference into a hard failure.
///
/// Absent means absent: the provider applies its own default, which is the
/// documented behaviour of every API Aurora speaks to. Rounded to two decimals
/// because no model distinguishes finer than that, while float arithmetic will
/// happily produce `0.7000000000000001` and get the request refused.
fn insert_temperature(body: &mut Map<String, Value>, temperature: Option<f32>) {
    if let Some(value) = temperature {
        let rounded = (f64::from(value) * 100.0).round() / 100.0;
        body.insert("temperature".to_string(), Value::from(rounded));
    }
}

pub fn build_openai_body(request: &ApiRequest<'_>, config: &ProviderConfigSnapshot) -> Value {
    let model = unprefix_model(request.model, &config.provider_id);
    let max_tokens = request.max_output_tokens.max(1);
    // No invented default. See `insert_temperature`.
    let temperature = request.temperature.or(config.default_temperature);

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model.to_string()));
    body.insert(
        "messages".to_string(),
        Value::Array(openai_messages(
            request,
            config.supports_vision,
            config.effective_provider_type(),
            &config.base_url,
            reasoning_replay_override_for_config(config),
        )),
    );
    body.insert("stream".to_string(), Value::Bool(true));
    body.insert("max_tokens".to_string(), Value::from(max_tokens));
    insert_temperature(&mut body, temperature);

    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    }
                })
            })
            .collect();
        body.insert("tools".to_string(), Value::Array(tools));
        body.insert(
            "tool_choice".to_string(),
            Value::String(request.tool_choice.as_str().to_string()),
        );
    }

    if request.reasoning.enabled && config.supports_thinking {
        let effort_mode =
            matches!(
                request.reasoning.request_mode,
                ReasoningRequestMode::OpenaiEffort
            ) || (matches!(request.reasoning.request_mode, ReasoningRequestMode::Auto)
                && request.reasoning.control == ReasoningControl::Effort);

        if effort_mode {
            if let Some(effort) = request.reasoning.effort {
                body.insert(
                    "reasoning_effort".to_string(),
                    Value::String(effort.to_string()),
                );
            }
        } else {
            // `budget_tokens` rides along only when the user explicitly picked
            // one. Unknown compat backends often reject it, so a toggle stays
            // the bare enable object.
            match request.reasoning.budget_tokens.filter(|b| *b > 0) {
                Some(budget) => body.insert(
                    "thinking".to_string(),
                    json!({
                        "type": "enabled",
                        "budget_tokens": budget.min(max_tokens.saturating_sub(1).max(1)),
                    }),
                ),
                None => body.insert("thinking".to_string(), json!({ "type": "enabled" })),
            };
        }
    }

    // Ask the provider to emit `usage` on the final stream chunk.
    // Without this OpenAI / DeepSeek / GLM all skip the closing usage
    // event entirely, which is why pre-Phase-2.2 runs reported zero
    // tokens and never surfaced DeepSeek's `prompt_cache_hit_tokens`.
    // Fireworks, Ollama and "custom" providers can reject unknown body
    // fields with HTTP 400 — gate by provider TYPE (a custom provider's
    // row id is a UUID and would match nothing).
    if should_request_stream_usage(config.effective_provider_type()) {
        body.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );
    }

    // Cache-routing affinity: same conversation, same key, same cache node.
    // The Responses adapter has carried this since the prompt-cache work
    // landed (`api/responses.rs`); the chat wire never did, so every request
    // was free to arrive at a machine holding no copy of the thread — and a
    // gateway that cannot find the copy re-reads the whole conversation and
    // bills it. Placed BEFORE `custom_params` so a user who needs a different
    // key can still override it.
    if should_send_prompt_cache_key(config.effective_provider_type(), &config.base_url, model) {
        if let Some(session_key) = request.session_key.filter(|key| !key.is_empty()) {
            body.insert(
                "prompt_cache_key".to_string(),
                Value::String(session_key.to_string()),
            );
            note_prompt_cache_key_sent(&config.base_url, model);
        }
    }

    if let Some(custom) = &config.custom_params {
        for (key, value) in custom {
            // Aurora directive, not a wire parameter — already consumed by
            // `reasoning_replay_override` above; strict backends 400 on it.
            if key == "reasoning_replay" {
                continue;
            }
            body.insert(key.clone(), value.clone());
        }
    }

    Value::Object(body)
}

/// Which OpenAI-compatible providers accept `stream_options:
/// {include_usage: true}` without rejecting the request. Mirrors the
/// legacy `provider_kernel::presets::ProviderPreset.include_stream_options`
/// matrix — keeping the two stacks aligned avoids a regression when
/// Phase 5 retires the legacy kernel.
pub(crate) fn should_request_stream_usage(provider_type: &str) -> bool {
    matches!(
        provider_type.to_ascii_lowercase().as_str(),
        // Verified to accept `stream_options: {include_usage: true}` and emit a
        // closing usage chunk. NOTE: Fireworks, Ollama and "custom" providers are
        // deliberately absent — they HTTP 400 on unknown body fields. The agent
        // window falls back to a local tiktoken estimate for those instead.
        "deepseek"
            | "glm"
            | "zhipu"
            | "z-ai"
            | "zai"
            | "openai"
            | "lmstudio"
            | "lm-studio"
            | "openrouter"
            | "together"
            | "togetherai"
            | "groq"
            | "xai"
            | "x-ai"
            | "grok"
            | "mistral"
            | "moonshot"
            | "kimi"
            | "perplexity"
    )
}

/// Which OpenAI-compatible providers may carry `prompt_cache_key`.
///
/// It is the Chat Completions counterpart of the field `api/responses.rs`
/// already sends: requests sharing a key land on the same cache node, so a
/// long thread reads its own prefix instead of depending on routing luck.
/// Measured on the user's own sessions before this was added — threads on
/// generic gateways sat at 26–78% cache reads with sudden mid-turn collapses
/// to zero, against 99% on the Responses wire, which does send it.
///
/// **The provider TYPE cannot decide this, and a first version that thought it
/// could would have broken every Vectide turn.** Probed 2026-08-30 with the
/// exact body Aurora sends (streaming, tools, `stream_options`), both rows
/// typed `openai`:
///
/// | endpoint | without the field | with it |
/// |---|---|---|
/// | `us-api.x5m5x.com` (5 models) | 200 | **200** |
/// | `vectide.cn` (glm-5.3) | 200 | **400** |
///
/// So the type gate only says "this is a generic OpenAI-shaped gateway, try
/// it"; the endpoint gets the final say via [`prompt_cache_key_refused`], the
/// same shape [`learned_reasoning`] uses — on by default, and the strict ones
/// turn it off themselves without the user having to find a setting.
/// Dedicated vendor types (deepseek, glm, moonshot, …) stay out entirely: they
/// run their own automatic prefix caching and have never documented the field.
pub(crate) fn should_send_prompt_cache_key(
    provider_type: &str,
    base_url: &str,
    model: &str,
) -> bool {
    matches!(provider_type.to_ascii_lowercase().as_str(), "openai")
        && !prompt_cache_key_refused(base_url, model)
}

/// Endpoints that have carried `prompt_cache_key`, and endpoints that rejected
/// it. Two sets rather than one so a 400 is only ever blamed on the field at an
/// endpoint that actually received it — everywhere else the retry would be
/// byte-identical, which is the one thing a retry must never be.
///
/// Process-global and not persisted, for the reason [`learned_reasoning`]
/// gives: a table that survived restarts would also survive a gateway changing
/// its mind. One rejected request per endpoint per run is the whole cost.
fn prompt_cache_key_state() -> &'static std::sync::Mutex<(HashSet<String>, HashSet<String>)> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<(HashSet<String>, HashSet<String>)>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new((HashSet::new(), HashSet::new())))
}

/// Note that this endpoint has been sent the field, so a 400 from it is worth
/// reading as a rejection of the field.
fn note_prompt_cache_key_sent(base_url: &str, model: &str) {
    if let Ok(mut state) = prompt_cache_key_state().lock() {
        state.0.insert(endpoint_key(base_url, model));
    }
}

pub(crate) fn prompt_cache_key_was_sent(url: &str, model: &str) -> bool {
    prompt_cache_key_state()
        .lock()
        .map(|state| state.0.contains(&endpoint_key(url, model)))
        .unwrap_or(false)
}

/// Record that this endpoint rejected the field, and say so once in the log.
pub(crate) fn remember_prompt_cache_key_refusal(url: &str, model: &str) {
    if let Ok(mut state) = prompt_cache_key_state().lock() {
        if state.1.insert(endpoint_key(url, model)) {
            crate::logging::log_warn(
                "api.cache",
                &format!(
                    "{url} (model {model}) rejected `prompt_cache_key` — recorded, retrying \
                     without it. Later turns on this endpoint will omit it, and its prompt \
                     cache will depend on the gateway's own routing."
                ),
            );
        }
    }
}

pub(crate) fn prompt_cache_key_refused(url: &str, model: &str) -> bool {
    prompt_cache_key_state()
        .lock()
        .map(|state| state.1.contains(&endpoint_key(url, model)))
        .unwrap_or(false)
}

/// Whether a 4xx body is complaining about a request PARAMETER, as opposed to
/// the conversation being too big, the tool blocks being malformed, or the
/// account being out of money — all of which have their own handling and must
/// not be mistaken for "drop the cache key and try again".
///
/// The CJK phrases are not decoration: `vectide.cn` answers
/// `请求参数值或格式不受支持` ("the request parameter value or format is not
/// supported") and never names the offending field, so an English-only matcher
/// reads its rejection as an unexplained `InvalidRequest` and ends the turn.
fn body_names_parameter_fault(lower: &str, body: &str) -> bool {
    if lower.contains("context length")
        || lower.contains("context_length")
        || lower.contains("maximum context")
        || lower.contains("too many tokens")
        || lower.contains("prompt is too long")
        || lower.contains("tool_use")
        || lower.contains("tool_result")
        || lower.contains("tool_call")
        || lower.contains("quota")
        || lower.contains("billing")
        || lower.contains("insufficient")
    {
        return false;
    }
    lower.contains("unsupported parameter")
        || lower.contains("unknown parameter")
        || lower.contains("unrecognized")
        || lower.contains("extra_forbidden")
        || lower.contains("invalid parameter")
        || body.contains("参数")
        || body.contains("不受支持")
}

/// Which key (if any) a given provider expects for replayed
/// reasoning. OpenAI-compat is a tribe, not a spec — Fireworks
/// rejects unknown fields with HTTP 400, so we cannot just spray
/// both keys at every backend.
///
/// Returns `Some("reasoning_content")`, `Some("reasoning")`, or
/// `None` (= drop reasoning entirely from outgoing messages).
/// Endpoints that have told us, in their own 400, that they need reasoning
/// replayed. Keyed by host + model, because the requirement belongs to neither
/// on its own: `agentrouter.org` needs it for `deepseek-v4-flash` and not for
/// `glm-5.2`, and Byteplus needs it for neither.
///
/// Process-global and not persisted. One failed request per endpoint per run
/// is a cheap price for never guessing, and a learned table that survives
/// restarts would also survive a gateway changing its mind.
fn learned_reasoning() -> &'static std::sync::Mutex<HashMap<String, &'static str>> {
    static LEARNED: std::sync::OnceLock<std::sync::Mutex<HashMap<String, &'static str>>> =
        std::sync::OnceLock::new();
    LEARNED.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Host + model, normalised so the URL a request was SENT to and the base URL a
/// request is BUILT from produce the same key.
fn endpoint_key(url_or_base: &str, model: &str) -> String {
    let host = url_or_base
        .split("://")
        .nth(1)
        .unwrap_or(url_or_base)
        .split('/')
        .next()
        .unwrap_or(url_or_base)
        .to_ascii_lowercase();
    format!("{host}|{}", model.to_ascii_lowercase())
}

/// Record that this endpoint rejected a request for want of replayed reasoning.
pub(crate) fn remember_reasoning_requirement(url: &str, model: &str, field: &'static str) {
    if let Ok(mut map) = learned_reasoning().lock() {
        if map.insert(endpoint_key(url, model), field).is_none() {
            crate::logging::log_warn(
                "api.reasoning",
                &format!(
                    "{url} (model {model}) requires `{field}` to be replayed — recorded, \
                     retrying with it. Later turns on this endpoint will include it from the start."
                ),
            );
        }
    }
}

/// What this endpoint has already told us it needs, if anything.
pub(crate) fn learned_reasoning_field(url: &str, model: &str) -> Option<&'static str> {
    learned_reasoning()
        .lock()
        .ok()
        .and_then(|map| map.get(&endpoint_key(url, model)).copied())
}

/// Endpoints that have REFUSED replayed reasoning — the mirror of
/// [`learned_reasoning`], and the reason Aurora can afford to send the field by
/// default.
///
/// Replay is on for unknown OpenAI-shaped gateways (see [`reasoning_field_for`])
/// because a model that cannot see its own earlier thinking re-derives it every
/// tool call. The cost of that default is the strict backends — Fireworks
/// answers `Extra inputs are not permitted, field: reasoning_content` — where an
/// always-on field would fail every request forever.
///
/// So the default is a question, not an assumption: send it, and if the endpoint
/// says no, stop sending it to that endpoint. One rejected request, which bills
/// nothing because a 4xx is refused before generation, buys the answer for the
/// rest of the run.
fn refused_reasoning() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static REFUSED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    REFUSED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Record that this endpoint rejected the request BECAUSE it carried replayed
/// reasoning.
pub(crate) fn remember_reasoning_refusal(url: &str, model: &str) {
    if let Ok(mut set) = refused_reasoning().lock() {
        if set.insert(endpoint_key(url, model)) {
            crate::logging::log_warn(
                "api.reasoning",
                &format!(
                    "{url} (model {model}) rejects replayed reasoning — recorded, retrying \
                     without it. Later turns on this endpoint will omit it from the start."
                ),
            );
        }
    }
}

/// Whether this endpoint has told us to stop sending replayed reasoning.
pub(crate) fn reasoning_is_refused(url: &str, model: &str) -> bool {
    refused_reasoning()
        .lock()
        .ok()
        .is_some_and(|set| set.contains(&endpoint_key(url, model)))
}

/// The user's explicit replay decision for this provider, read from its
/// Whether the user has forced thinking replay on or off, through the
/// custom params (`"reasoning_replay"`). This is an Aurora directive, not a
/// wire parameter — every body builder strips the key before sending.
///
/// Exists because the automatic policy cannot see one case: a gateway that
/// silently ACCEPTS replayed reasoning. Endpoints that require it teach us
/// via their 400; endpoints that reject it must never receive it; but an
/// accepting gateway gives no signal, and dropping there costs the model its
/// own earlier plans. Only the user can know their gateway forwards the
/// field, so this is their switch:
///
/// - `"reasoning_content"` / `"reasoning"` — force replay under that key.
/// - `"off"` (also `"none"`, `"drop"`, `false`) — force replay off.
///
/// Returns `None` for no directive (automatic policy applies),
/// `Some(Some(key))` to force a key, `Some(None)` to force off.
pub(crate) fn reasoning_replay_override(
    custom_params: Option<&std::collections::HashMap<String, Value>>,
) -> Option<Option<&'static str>> {
    let value = custom_params?.get("reasoning_replay")?;
    if value.as_bool() == Some(false) {
        return Some(None);
    }
    match value.as_str().map(str::to_ascii_lowercase).as_deref() {
        Some("reasoning_content") => Some(Some("reasoning_content")),
        Some("reasoning") => Some(Some("reasoning")),
        Some("off" | "none" | "drop" | "false") => Some(None),
        other => {
            crate::logging::log_warn(
                "api.reasoning",
                &format!(
                    "ignoring invalid `reasoning_replay` custom param {other:?} — expected \
                     \"reasoning_content\", \"reasoning\", or \"off\""
                ),
            );
            None
        }
    }
}

/// Typed replay policy from the resolved model request. `Auto` deliberately
/// returns no override so endpoint learning and the provider table still work.
#[must_use]
pub(crate) fn reasoning_replay_mode_override(
    mode: ReasoningReplayMode,
) -> Option<Option<&'static str>> {
    match mode {
        ReasoningReplayMode::Auto => None,
        ReasoningReplayMode::ReasoningContent => Some(Some("reasoning_content")),
        ReasoningReplayMode::Reasoning => Some(Some("reasoning")),
        ReasoningReplayMode::Off => Some(None),
    }
}

/// Resolve the new typed policy first, then the legacy custom-param directive
/// for rows that have not yet been edited since the cutover.
#[must_use]
pub(crate) fn reasoning_replay_override_for_config(
    config: &ProviderConfigSnapshot,
) -> Option<Option<&'static str>> {
    config
        .reasoning
        .as_ref()
        .and_then(|reasoning| reasoning_replay_mode_override(reasoning.replay))
        .or_else(|| reasoning_replay_override(config.custom_params.as_ref()))
}

/// Which key (if any) replayed reasoning goes out under, combining every source
/// in precedence order:
///
/// 1. What the endpoint DEMANDED in its own 400 (`learned_reasoning_field`) —
///    ground truth, and it must outrank a user "off" or the request would
///    just fail again.
/// 2. What the endpoint REFUSED in its own 400 (`reasoning_is_refused`) — the
///    same ground truth pointing the other way. It outranks the user's choice
///    for the same reason: an endpoint that rejects the field rejects every
///    request carrying it, so honouring a "Send" setting here would leave the
///    provider unusable and the cause invisible.
/// 3. The user's explicit `reasoning_replay` directive.
/// 4. The built-in per-provider table (`reasoning_field_for`).
pub(crate) fn resolve_reasoning_field(
    provider_type: &str,
    model: &str,
    base_url: &str,
    override_directive: Option<Option<&'static str>>,
) -> Option<&'static str> {
    if let Some(demanded) = learned_reasoning_field(base_url, model) {
        return Some(demanded);
    }
    if reasoning_is_refused(base_url, model) {
        return None;
    }
    match override_directive {
        Some(forced) => forced,
        None => reasoning_field_for(provider_type, model),
    }
}

/// A body complaining that the field is UNWANTED rather than missing.
///
/// The two read almost identically to a substring check and mean opposite
/// things, and acting on the wrong one puts Aurora in a loop: add the field,
/// get refused, record the refusal as a demand, add it again. Fireworks is the
/// live example — `Extra inputs are not permitted, field: reasoning_content`.
///
/// Checked before anything else, so no later branch can act on it.
fn body_refuses_the_field(lower: &str) -> bool {
    lower.contains("not permitted")
        || lower.contains("not allowed")
        || lower.contains("unknown field")
        || lower.contains("unrecognized")
        || lower.contains("extra inputs")
}

/// Whether a 4xx says the request was rejected FOR CARRYING replayed reasoning.
///
/// [`body_refuses_the_field`] answers "is this a refusal?" and is used to stop a
/// refusal being misread as a demand. This answers the narrower question the
/// retry needs: is the refused field the reasoning one? Both halves must be
/// present — a gateway rejecting some other unknown parameter says nothing about
/// replay, and dropping the reasoning in response would be a guess.
///
/// Verbatim from Fireworks, which is why the check exists at all:
/// `Extra inputs are not permitted, field: reasoning_content`.
fn body_rejects_replayed_reasoning(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    body_refuses_the_field(&lower)
        && (lower.contains("reasoning_content") || lower.contains("reasoning"))
}

/// The REPLAY field named in an OpenAI-shaped error's machine-readable slots.
///
/// `param` says which argument is at fault and `code` is a stable identifier,
/// so a gateway that fills either has named the field in a form no phrasebook
/// can miss. That matters more than it looks: these errors are written for
/// humans, and not all of those humans read English.
///
/// Both checks are EXACT, and that is the whole of the care here. The same
/// gateway also rejects `reasoning_effort` with
/// `"code":"VectorTide_invalid_reasoning_effort"` — a complaint about a
/// sampling knob, which merely contains the word. A loose `contains("reasoning")`
/// reads that as "replay your thinking", starts sending a field the endpoint
/// never asked for, and buries the real fault under a bogus retry.
fn reasoning_named_in_error_fields(body: &str) -> Option<&'static str> {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let error = parsed.get("error")?;
    let slot = |key: &str| {
        error
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_ascii_lowercase)
    };

    // `param` is a field PATH — `messages.reasoning_content`. Only its leaf is
    // the field name, and it has to match one outright.
    if let Some(param) = slot("param") {
        match param.rsplit('.').next().unwrap_or(&param) {
            "reasoning_content" => return Some("reasoning_content"),
            "reasoning" => return Some("reasoning"),
            _ => {}
        }
    }

    // `code` is a vendor identifier, not a path, so it is read as a phrase:
    // the replay field spelled out AND a word that means the request lacked it.
    if let Some(code) = slot("code") {
        if code.contains("reasoning_content")
            && (code.contains("required") || code.contains("missing") || code.contains("must"))
        {
            return Some("reasoning_content");
        }
    }
    None
}

/// Does this 400 body say the request was refused for want of replayed
/// reasoning, and if so under which key?
///
/// Two readings, in order of how much they can be trusted.
///
/// **The error's own fields**, when it has them. Observed live on 2026-08-29:
/// `"param":"messages.reasoning_content"`,
/// `"code":"VectorTide_reasoning_content_required"` — as clear a statement of
/// the requirement as an API can make, sitting beside a `message` written
/// entirely in Chinese. The prose-only detector this replaces read four English
/// phrases, matched none of them, classified the 400 as an unfixable bad
/// request, and killed the turn on a gateway that had just explained the fix.
/// A phrasebook was never going to be the right shape for this.
///
/// **Then the prose**, for the endpoints that send nothing else. Deliberately
/// narrow — it wants the field NAME and a phrase about sending it back, so an
/// unrelated 400 that merely mentions reasoning does not start a replay.
pub(crate) fn reasoning_requirement_from_body(body: &str) -> Option<&'static str> {
    let lower = body.to_ascii_lowercase();
    if body_refuses_the_field(&lower) {
        return None;
    }
    if let Some(field) = reasoning_named_in_error_fields(body) {
        return Some(field);
    }
    let asks_for_it = lower.contains("must be passed back")
        || lower.contains("must be returned")
        || lower.contains("should be passed back")
        || lower.contains("is required in the request")
        // 回传 — "send back" — is the verb the Chinese-language gateways use
        // for this, in both halves of the sentence Aurora was given ("必须回传
        // 上一轮 reasoning_content … 请保留并原样回传该字段后重试").
        // `to_ascii_lowercase` leaves non-ASCII alone, so `lower` still carries
        // it verbatim.
        || lower.contains("回传");
    if !asks_for_it {
        return None;
    }
    if lower.contains("reasoning_content") {
        return Some("reasoning_content");
    }
    if lower.contains("reasoning") {
        return Some("reasoning");
    }
    None
}

///
/// `model` is accepted and deliberately unused: the comment on the `_` arm
/// records why reading it here was tried and rejected. Keeping it in the
/// signature keeps the next person's fix in the right place — the endpoint,
/// not another guess about model names.
pub(crate) fn reasoning_field_for(provider_type: &str, _model: &str) -> Option<&'static str> {
    match provider_type.to_ascii_lowercase().as_str() {
        // DeepSeek + GLM thinking-mode models *require* the original
        // `reasoning_content` to be replayed or the API returns 400.
        "deepseek" | "glm" | "zhipu" | "z-ai" | "zai" => Some("reasoning_content"),
        // OpenRouter and LM Studio surface the legacy `reasoning` key.
        // Including it is safe; omitting it is also safe (the model
        // just re-thinks). Match real behaviour and emit it.
        "openrouter" | "lmstudio" | "lm-studio" => Some("reasoning"),
        // Wires where this field does not exist. Not an exemption — a
        // different protocol: Anthropic and MiniMax build `thinking` blocks
        // (`build_anthropic_body`), Responses and Codex replay an encrypted
        // reasoning item, and Cursor speaks its own. Putting an OpenAI chat
        // field in any of those bodies would be malformed, not merely unwanted.
        "minimax" | "anthropic" | "claude-code" | "openai-responses" | "codex" | "cursor"
        | "kenari-messages" | "kenari-responses" | "modal-messages" | "modal-responses" => None,
        // Every other OpenAI-compatible provider — `"openai"`, `"custom"`,
        // Fireworks, Ollama, kenari, and anything Aurora has never heard of:
        // send it, whether or not that provider is known to want it.
        //
        // This arm used to be `None` — send nothing until an endpoint demands
        // the field in a 400 — and the evidence for that was 587 turns across
        // four gateways with zero failures without it:
        //
        //   f4f41a66 (Larprouter, type openai)  glm-5.3     233 turns, 0 failures
        //   agentrouter (type openai)           glm-5.2     220 turns, 0 failures
        //   9b01ab80 (Byteplus, type openai)    glm-5.2     134 turns, 0 failures
        //   9b01ab80 (Byteplus, type openai)    deepseek-v4-pro  79 turns, 0 failures
        //
        // Those numbers are real and they measured the wrong thing. "Zero
        // failures" says dropping the field does not ERROR. It says nothing
        // about what the model lost — and what it loses is its own reasoning
        // from one tool call to the next, which it then pays to re-derive.
        // Waiting for a 400 only ever finds the gateways rude enough to send
        // one; the polite ones say nothing, and Aurora reads their silence as
        // consent. `vectide.cn` writes "Reasoning content was not preserved by
        // the client" into the reasoning slot instead of erroring, so the
        // learn-from-400 policy never fired and the user watched that sentence
        // render as the model's thoughts, once per tool call, for a whole
        // conversation.
        //
        // opencode reaches the same conclusion with no policy at all: its
        // OpenAI-chat message builder attaches `reasoning_content` to every
        // assistant message that has reasoning, unconditionally, on every
        // provider (`packages/llm/src/protocols/openai-chat.ts`,
        // `lowerAssistantMessage`). No table, no learning, no waiting.
        //
        // The cost this arm used to avoid — tokens spent on gateways that did
        // not need the field — is real but small next to a model re-thinking
        // every iteration. The cost it could NOT avoid, a strict backend that
        // rejects unknown fields, is now handled where it belongs: Fireworks
        // answers `Extra inputs are not permitted, field: reasoning_content`
        // once, `remember_reasoning_refusal` records it, and the retry goes out
        // clean. That single rejected request bills nothing — a 4xx is refused
        // before generation — which is what makes "send it to everyone" an
        // affordable default rather than a gamble with the user's provider.
        _ => Some("reasoning_content"),
    }
}

fn openai_messages(
    request: &ApiRequest<'_>,
    supports_vision: bool,
    provider_type: &str,
    // The endpoint this body is bound for. Only consulted for reasoning
    // replay, and only when the provider type has no opinion — see
    // `learned_reasoning_field`. Empty in the pure-builder tests below.
    base_url: &str,
    // The user's explicit replay directive, if any — see
    // `reasoning_replay_override`. `None` in the pure-builder tests.
    reasoning_override: Option<Option<&'static str>>,
) -> Vec<Value> {
    let mut output: Vec<Value> = Vec::new();

    if let Some(prompt) = request.system_prompt {
        if !prompt.is_empty() {
            // Chat-completions has no cache breakpoint to place, so the
            // boundary is stripped rather than acted on. The section ORDER it
            // implies still pays here: kenari, ark and DeepSeek cache on the
            // longest common prefix, and volatile text at the front truncated
            // that prefix on every mode flip.
            output.push(json!({
                "role": "system",
                "content": strip_system_boundary(prompt),
            }));
        }
    }

    for message in request.messages {
        match message.role {
            MessageRole::System => {
                let text = collect_text(&message.blocks);
                if !text.is_empty() {
                    output.push(json!({"role":"system","content":text}));
                }
            }
            MessageRole::User => {
                // The user message may carry `<aurora_image>` markers (pasted /
                // dropped images from the composer). Split them into a
                // multimodal `content` array for vision models; strip them to a
                // placeholder otherwise so a non-vision model isn't fed unusable
                // base64. Reuses the same splitter as tool-result images.
                let text = collect_text(&message.blocks);
                let content = if supports_vision {
                    openai_user_content(&text)
                } else {
                    Value::String(strip_aurora_images_for_text(&text))
                };
                output.push(json!({"role":"user","content":content}));
            }
            MessageRole::Assistant => {
                let text = collect_text(&message.blocks);
                let tool_calls = openai_tool_calls(&message.blocks);
                let reasoning = collect_reasoning(&message.blocks);
                let mut payload = Map::new();
                payload.insert("role".into(), Value::String("assistant".into()));
                if !text.is_empty() {
                    payload.insert("content".into(), Value::String(text));
                } else if !tool_calls.is_empty() {
                    payload.insert("content".into(), Value::Null);
                } else {
                    payload.insert("content".into(), Value::String(String::new()));
                }
                if !tool_calls.is_empty() {
                    payload.insert("tool_calls".into(), Value::Array(tool_calls));
                }
                // Reasoning replay is provider-specific. DeepSeek/GLM
                // *require* `reasoning_content` to be present (HTTP
                // 400 otherwise). Fireworks *rejects* both `reasoning`
                // and `reasoning_content` as unknown fields (HTTP
                // 400). OpenAI-compat is a tribe, not a spec — emit
                // whichever key (if any) the actual provider accepts.
                if !reasoning.is_empty() {
                    // Endpoint's own demand, then the user's directive, then
                    // the vendor table — see `resolve_reasoning_field`.
                    let key = resolve_reasoning_field(
                        provider_type,
                        request.model,
                        base_url,
                        reasoning_override,
                    );
                    if let Some(key) = key {
                        payload.insert(key.into(), Value::String(reasoning));
                    }
                }
                output.push(Value::Object(payload));
            }
            MessageRole::Tool => {
                // Tool-role messages can now carry an extra Text block
                // alongside the tool_result blocks — that's how the
                // mid-turn user-message queue rides in (see
                // `ConversationRuntime::run_turn_with_id` injection
                // point). OpenAI's wire format has no concept of a
                // text body on a `role: "tool"` entry, so we emit one
                // `role: "tool"` per tool_result and a final
                // `role: "user"` for the concatenated text blocks. The
                // text follows the tool messages, preserving the
                // human-intended ordering ("here's the result, and
                // also …").
                let mut injected_text = String::new();
                // Images pulled out of tool results, waiting for the user
                // message below. See `openai_tool_result_split`: a tool-role
                // message cannot deliver them.
                let mut pending_images: Vec<Value> = Vec::new();
                for block in &message.blocks {
                    match block {
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } => {
                            let content_value = if supports_vision {
                                let (mut text, images) = openai_tool_result_split(content);
                                if !images.is_empty() {
                                    if !text.is_empty() && !text.ends_with('\n') {
                                        text.push('\n');
                                    }
                                    text.push_str(OPENAI_IMAGE_HANDOFF_NOTE);
                                    pending_images.extend(images);
                                }
                                Value::String(text)
                            } else {
                                Value::String(strip_aurora_images_for_text(content))
                            };
                            output.push(json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": content_value,
                            }));
                        }
                        ContentBlock::Text { text } => {
                            if !injected_text.is_empty() {
                                injected_text.push_str("\n\n");
                            }
                            injected_text.push_str(text);
                        }
                        _ => {
                            // ToolUse / Thinking inside a Tool message
                            // would be a runtime bug — drop silently so
                            // we don't corrupt the request.
                        }
                    }
                }
                // One user message carrying whatever could not ride on a
                // tool-role entry: the screenshots first (the model reads them
                // as the answer to the call it just made), then any mid-turn
                // text the human queued. The injected text itself can carry
                // `<aurora_image>` markers (mid-turn composer attachments) —
                // expand them through the same splitter a user message uses,
                // vision-gated, so they arrive as real image parts rather
                // than base64 prose.
                let injected_content: Option<Value> = if injected_text.is_empty() {
                    None
                } else if supports_vision {
                    Some(openai_user_content(&injected_text))
                } else {
                    Some(Value::String(strip_aurora_images_for_text(&injected_text)))
                };
                if pending_images.is_empty() {
                    if let Some(content) = injected_content {
                        output.push(json!({ "role": "user", "content": content }));
                    }
                } else {
                    let mut parts = pending_images;
                    match injected_content {
                        Some(Value::Array(injected_parts)) => parts.extend(injected_parts),
                        Some(Value::String(text)) if !text.is_empty() => {
                            parts.push(json!({ "type": "text", "text": text }));
                        }
                        _ => {}
                    }
                    output.push(json!({ "role": "user", "content": Value::Array(parts) }));
                }
            }
        }
    }

    output
}

pub(crate) fn collect_text(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.clone()),
            // A directly made picture is text to every provider: its one-line
            // description, so the model can name it, never its pixels.
            ContentBlock::Image { .. } => b.image_as_text(),
            // A background process the agent started has ended. This IS the
            // model's business — a fact about the work, whose next move is
            // usually to read the process's log — so the detail copy goes on
            // the wire as ordinary text, exactly as the Anthropic path already
            // sends it (`message_blocks_to_anthropic_content`).
            //
            // It used to fall through the `_ => None` below, which meant every
            // OpenAI-compatible provider — most of them — was handed the
            // message with NOTHING in it. Caught by reading a model's own
            // thinking on a live run: "No user content — just an empty message.
            // The background process likely finished by now." It was never
            // told; it guessed, and it happened to guess right.
            ContentBlock::ProcessEvent { detail, .. } => Some(detail.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Concatenate every `Thinking` block in a message into a single
/// reasoning string. Used to re-emit `reasoning_content` on OpenAI
/// assistant payloads (DeepSeek thinking mode demands it).
fn collect_reasoning(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Thinking { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn openai_tool_calls(blocks: &[ContentBlock]) -> Vec<Value> {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolUse { id, name, input } => Some(json!({
                "id": id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": tool_input_for_wire(input).to_string(),
                }
            })),
            _ => None,
        })
        .collect()
}

/// Coerce a tool call's input to something a provider will accept in
/// history.
///
/// A call whose arguments never parsed carries its raw text as a
/// [`Value::String`] (see [`parse_tool_input`]) so the dispatcher can
/// report precisely what arrived. That representation must not reach the
/// wire: every provider requires `tool_use.input` to be an object and
/// rejects the whole request otherwise — which would turn one malformed
/// block into a hard failure of every subsequent turn. The call has
/// already been answered with a `MalformedInput` tool result by the time
/// this runs, so the model has the detail it needs; history only has to
/// stay well-formed.
fn tool_input_for_wire(input: &Value) -> Value {
    if input.is_object() {
        input.clone()
    } else {
        json!({})
    }
}

// ---------------------------------------------------------------------------
// Header builders
// ---------------------------------------------------------------------------

/// What Aurora calls itself on the wire.
///
/// `reqwest` sends **no** `User-Agent` at all unless one is configured, and a
/// missing UA is a request shape that plenty of edges refuse outright. Measured
/// against `messages-beta.api.thegrid.ai` on 2026-08-23: no header returns a
/// bare nginx `403 Forbidden` HTML page, an empty string returns the same, and
/// literally any non-empty value returns 200. The API behind it never saw the
/// request — every genuine auth failure there answers with JSON.
///
/// This is why the same call succeeded from every script and failed from the
/// app: curl, PowerShell and Python all send a UA of their own.
///
/// Inserted before `custom_headers`, so a user who sets their own still wins.
pub const AURORA_USER_AGENT: &str = concat!("Aurora/", env!("CARGO_PKG_VERSION"));

pub fn build_anthropic_headers(
    config: &ProviderConfigSnapshot,
) -> Result<reqwest::header::HeaderMap, ApiError> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE, USER_AGENT};
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    headers.insert(USER_AGENT, HeaderValue::from_static(AURORA_USER_AGENT));
    insert_header(&mut headers, "anthropic-version", "2023-06-01")?;
    if !config.api_key.is_empty() {
        if anthropic_wire_uses_bearer(&config.effective_provider_type()) {
            // Modal's gateway takes the workspace proxy token ONLY as
            // `Authorization: Bearer`; `x-api-key` is a 401 `proxy auth
            // required` (measured 2026-09-02).
            let value = format!("Bearer {}", config.api_key);
            let header_value = HeaderValue::from_str(&value)
                .map_err(|e| ApiError::InvalidRequest(format!("invalid api key header: {e}")))?;
            headers.insert(reqwest::header::AUTHORIZATION, header_value);
        } else {
            insert_header(&mut headers, "x-api-key", &config.api_key)?;
        }
    }
    if let Some(custom) = &config.custom_headers {
        for (key, value) in custom {
            insert_header_owned(&mut headers, key, value)?;
        }
    }
    let _ = HeaderName::from_static("accept"); // satisfy dead_code lint variants
    Ok(headers)
}

/// Anthropic-shaped wires that authenticate with a Bearer token rather than
/// `x-api-key`. Anthropic itself, MiniMax and kenari all take `x-api-key`.
#[must_use]
pub fn anthropic_wire_uses_bearer(provider_type: &str) -> bool {
    matches!(provider_type.trim().to_ascii_lowercase().as_str(), "modal-messages")
}

pub fn build_openai_headers(
    config: &ProviderConfigSnapshot,
) -> Result<reqwest::header::HeaderMap, ApiError> {
    use reqwest::header::{
        HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT,
    };
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    // See [`AURORA_USER_AGENT`]: a missing UA is refused outright by some
    // gateways, with a bare HTML 403 that never reaches their API.
    headers.insert(USER_AGENT, HeaderValue::from_static(AURORA_USER_AGENT));
    if !config.api_key.is_empty() {
        let value = format!("Bearer {}", config.api_key);
        let header_value = HeaderValue::from_str(&value)
            .map_err(|e| ApiError::InvalidRequest(format!("invalid api key header: {e}")))?;
        headers.insert(AUTHORIZATION, header_value);
    }
    if let Some(custom) = &config.custom_headers {
        for (key, value) in custom {
            insert_header_owned(&mut headers, key, value)?;
        }
    }
    Ok(headers)
}

/// The header OpenCode Go uses to tie a request to its conversation.
///
/// OpenCode's own client sends it on every inference call
/// (`packages/opencode/src/session/llm/request.ts`), with the raw session id
/// as the value, and their gateway logs it as a metric per request. On
/// 2026-09-03 they emailed that requests from `Aurora/2.0.0` were arriving
/// without it and that from 2026-09-06 such requests may error. Aurora had
/// measured the header as unnecessary when the provider shipped; it was, and
/// now it is not.
pub const OPENCODE_SESSION_HEADER: &str = "x-opencode-session";

/// Which client is calling — `cli`, `desktop`, and now `aurora`. Their gateway
/// reads it beside the session header. Not demanded, but it costs nothing and
/// is the honest answer to "we don't recognize this client".
pub const OPENCODE_CLIENT_HEADER: &str = "x-opencode-client";

/// Is this request bound for OpenCode Go?
///
/// The provider type is the normal signal — the frontend resolves one of
/// `opencode-go`, `opencode-go-chat` or `opencode-go-messages` per model. The
/// host is checked too so a hand-made row pointing at `opencode.ai` with a
/// generic type does not silently go back to being an unrecognised client.
#[must_use]
pub fn is_opencode_go(config: &ProviderConfigSnapshot) -> bool {
    config
        .effective_provider_type()
        .to_ascii_lowercase()
        .starts_with("opencode-go")
        || config
            .base_url
            .to_ascii_lowercase()
            .contains("://opencode.ai/")
}

/// Add OpenCode's per-conversation headers when the request is bound there.
///
/// Called by every adapter an OpenCode Go model can resolve to, after the
/// wire's own headers and the user's custom headers are in place. A value the
/// user set explicitly in custom headers is kept, in line with the rest of the
/// header builders.
///
/// `session_key` is the conversation identity the runtime already puts on
/// every request (`ApiRequest::session_key`, the thread id), so every request
/// of one chat — its tool iterations, retries, and compaction — names the same
/// session, which is exactly what "one stable ID per conversation" asks for.
/// A request with no conversation (the settings connection test) gets a fresh
/// id, because the point is that the header is never missing.
pub fn apply_opencode_headers(
    headers: &mut reqwest::header::HeaderMap,
    config: &ProviderConfigSnapshot,
    session_key: Option<&str>,
) -> Result<(), ApiError> {
    use reqwest::header::{HeaderName, HeaderValue};

    if !is_opencode_go(config) {
        return Ok(());
    }

    let session_name = HeaderName::from_static(OPENCODE_SESSION_HEADER);
    if !headers.contains_key(&session_name) {
        let value = match session_key.map(str::trim).filter(|key| !key.is_empty()) {
            Some(key) => key.to_string(),
            None => uuid::Uuid::new_v4().to_string(),
        };
        let header_value = HeaderValue::from_str(&value).map_err(|e| {
            ApiError::InvalidRequest(format!("invalid {OPENCODE_SESSION_HEADER} header: {e}"))
        })?;
        headers.insert(session_name, header_value);
    }

    let client_name = HeaderName::from_static(OPENCODE_CLIENT_HEADER);
    if !headers.contains_key(&client_name) {
        headers.insert(client_name, HeaderValue::from_static("aurora"));
    }

    Ok(())
}

fn insert_header(
    headers: &mut reqwest::header::HeaderMap,
    key: &'static str,
    value: &str,
) -> Result<(), ApiError> {
    use reqwest::header::{HeaderName, HeaderValue};
    let name = HeaderName::from_static(key);
    let header_value = HeaderValue::from_str(value)
        .map_err(|e| ApiError::InvalidRequest(format!("invalid header value: {e}")))?;
    headers.insert(name, header_value);
    Ok(())
}

fn insert_header_owned(
    headers: &mut reqwest::header::HeaderMap,
    key: &str,
    value: &str,
) -> Result<(), ApiError> {
    use reqwest::header::{HeaderName, HeaderValue};
    let name = HeaderName::from_bytes(key.as_bytes())
        .map_err(|e| ApiError::InvalidRequest(format!("invalid header name: {e}")))?;
    let header_value = HeaderValue::from_str(value)
        .map_err(|e| ApiError::InvalidRequest(format!("invalid header value: {e}")))?;
    headers.insert(name, header_value);
    Ok(())
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

pub fn build_anthropic_url(base_url: &str) -> String {
    join_endpoint(base_url, "/messages")
}

pub fn build_openai_url(base_url: &str) -> String {
    join_endpoint(base_url, "/chat/completions")
}

fn join_endpoint(base_url: &str, endpoint: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let endpoint_no_slash = endpoint.trim_start_matches('/');
    if base.ends_with(endpoint) || base.ends_with(endpoint_no_slash) {
        return base.to_string();
    }
    if base.ends_with("/v1") && endpoint.starts_with("/chat") {
        return format!("{base}{endpoint}");
    }
    format!("{base}{endpoint}")
}

// ---------------------------------------------------------------------------
// Misc utilities
// ---------------------------------------------------------------------------

/// Anthropic streams `output_tokens` incrementally on `message_delta`
/// events; we want the *latest* count (it grows monotonically) plus the
/// `input_tokens` from `message_start`. Cache fields are taken from
/// whichever event most recently provided them.
pub fn merge_usage(
    current: &mut crate::agent_runtime::types::TokenUsage,
    wire: &AnthropicUsageWire,
) {
    if let Some(input) = wire.input_tokens {
        if input > current.input_tokens || current.input_tokens == 0 {
            current.input_tokens = input;
        }
    }
    if let Some(output) = wire.output_tokens {
        if output > current.output_tokens || current.output_tokens == 0 {
            current.output_tokens = output;
        }
    }
    if let Some(cache_create) = wire.cache_creation_input_tokens {
        current.cache_creation_input_tokens = Some(cache_create);
    }
    if let Some(cache_read) = wire.cache_read_input_tokens {
        current.cache_read_input_tokens = Some(cache_read);
    }
}

/// Unix epoch milliseconds, saturating to 0 on a backwards clock.
pub fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Per-block aggregation state used by both adapters.
// ---------------------------------------------------------------------------

/// One in-flight content block we're aggregating from the stream.
/// `index` is the upstream block index (Anthropic) or the synthetic
/// position-in-emission-order (OpenAI). Blocks are converted to
/// [`ContentBlock`] in finalization order.
#[derive(Debug)]
pub enum BlockState {
    Text {
        text: String,
    },
    Thinking {
        text: String,
        signature: Option<String>,
        /// Epoch ms of the first reasoning delta in this segment, and of the
        /// most recent one. Their span is the wall clock the UI reports.
        ///
        /// Measured per-delta rather than at finalization because EVERY block
        /// in a turn is finalized together at stream end (see the single
        /// `into_content_block` call site) — so a `now - started` computed
        /// there would charge a short reasoning pass for all the text and
        /// tool streaming that followed it.
        started_at_ms: i64,
        ended_at_ms: i64,
    },
    ToolUse {
        id: String,
        name: String,
        raw_input: String,
    },
    // (impl below carries `has_content`, used to tell a gateway that forgot to
    // terminate its stream from one that was cut off before saying anything.)
}

impl BlockState {
    /// Whether this block actually carries something the model produced.
    ///
    /// A stream that ends without its terminator is two different failures
    /// wearing one face: a gateway that never sends `message_stop` (the reply
    /// is complete and usable) and a connection cut off before the model said
    /// anything (it is not). An opened-but-empty block is the tell.
    #[must_use]
    pub fn has_content(&self) -> bool {
        match self {
            BlockState::Text { text } | BlockState::Thinking { text, .. } => !text.is_empty(),
            // A tool call is only actionable once its name is known; the
            // arguments may legitimately still be an empty object.
            BlockState::ToolUse { name, .. } => !name.is_empty(),
        }
    }

    /// Open a reasoning block and start its clock.
    pub fn new_thinking(text: String, signature: Option<String>) -> Self {
        let now = now_unix_ms();
        BlockState::Thinking {
            text,
            signature,
            started_at_ms: now,
            ended_at_ms: now,
        }
    }

    /// Append a reasoning delta AND extend the segment's clock.
    ///
    /// Every append site must go through this. Writing `text.push_str(..)`
    /// against the variant directly compiles fine and silently freezes the
    /// duration at whatever the opening delta stamped — the block still
    /// renders, just with a number that is always too small, which is the
    /// shape of bug nobody files.
    ///
    /// Returns `false` when `self` is not a reasoning block, so callers can
    /// fall through to opening one.
    pub fn push_thinking(&mut self, delta: &str) -> bool {
        match self {
            BlockState::Thinking {
                text, ended_at_ms, ..
            } => {
                text.push_str(delta);
                *ended_at_ms = now_unix_ms();
                true
            }
            _ => false,
        }
    }

    pub fn into_content_block(self) -> ContentBlock {
        match self {
            BlockState::Text { text } => ContentBlock::Text { text },
            BlockState::Thinking {
                text,
                signature,
                started_at_ms,
                ended_at_ms,
            } => ContentBlock::Thinking {
                text,
                signature,
                // `saturating_sub` so a clock that steps backwards mid-turn
                // reports 0 rather than wrapping into a nonsense duration.
                duration_ms: Some(ended_at_ms.saturating_sub(started_at_ms).max(0) as u64),
            },
            BlockState::ToolUse {
                id,
                name,
                raw_input,
            } => {
                let input = parse_tool_input(&raw_input);
                ContentBlock::ToolUse { id, name, input }
            }
        }
    }
}

/// Parse an accumulated tool-call argument string.
///
/// - Empty / whitespace → `{}`. A zero-argument tool call is legitimate,
///   and every provider represents it this way.
/// - Valid JSON object → itself, after Windows-path repair.
/// - **Anything else → the raw text as a [`Value::String`].**
///
/// That last case used to return `{}` as well, and it was the single most
/// expensive line in the runtime. When a tool call is truncated by an
/// output cap or mangled by a bad escape, substituting an empty object
/// makes the executor report `path is required` — to a model that *did*
/// send `path`. The model cannot reconcile that, so it retries, rephrases,
/// and starts reaching for other tools. What looks like a model calling
/// the wrong tool is the harness having silently eaten its arguments.
///
/// Returning the raw text keeps the failure legible and recoverable: no
/// schema is anything but `type: object`, so a non-object input is
/// unambiguously broken, and the dispatcher ([`crate::agent_runtime::conversation`])
/// turns it into a `MalformedInput` error that quotes back what actually
/// arrived. Request builders sanitize it to `{}` on the way out, since
/// providers only accept objects in history.
pub fn parse_tool_input(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    // Valid JSON is NEVER rewritten. The repair below is a recovery pass for
    // payloads that do not parse; running it on a well-formed one can only
    // damage it. It did: a `file_write` whose `content` merely began with an
    // absolute path had the whole document treated as a path, which doubled
    // every `\n` and ended the string at the first `\"` — so a correct call
    // came back "malformed", and did so again on every retry, because nothing
    // about the corruption was random.
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        if value.is_object() {
            return value;
        }
    }
    let normalized = normalize_absolute_windows_paths(raw);
    if let Ok(value) = serde_json::from_str::<Value>(&normalized) {
        if value.is_object() {
            return value;
        }
    }
    // Second recovery pass: a value written without its quotes.
    //
    // `{"path": README.md}` — measured off GLM-5.2, five times in a row in one
    // turn, and the model could not recover because nothing told it which
    // character was wrong. Running this AFTER the path pass keeps the ordering
    // honest: a payload the first pass can fix is fixed by the first pass, and
    // this one only ever sees what is still broken.
    let quoted = quote_bare_scalar_values(raw);
    if let Ok(value) = serde_json::from_str::<Value>(&quoted) {
        if value.is_object() {
            return value;
        }
    }

    // Third recovery pass: every value is complete and only the closing
    // braces are missing.
    //
    // See [`unclosed_containers`] for why that is a different thing from a
    // payload cut off mid-value, and why only this one can be repaired.
    if let Some(closers) = unclosed_containers(raw) {
        let closed = format!("{raw}{closers}");
        if let Ok(value) = serde_json::from_str::<Value>(&closed) {
            if value.is_object() {
                return value;
            }
        }
    }

    // A parsed-but-not-object payload (a bare array, a quoted string)
    // is just as unusable as a parse failure — carry the raw text
    // through the same path rather than handing an executor a shape
    // it will misreport.
    Value::String(raw.to_string())
}

/// The closers that would finish this payload, if nothing else is missing.
///
/// `Some("}}")` means the text is a complete run of complete values with
/// unclosed containers around them, and appending those characters loses
/// nothing. `None` means it is not that — either it parses already, or it stops
/// somewhere that no number of closers can repair.
///
/// ## Why the distinction is the whole point
///
/// `serde_json` answers both cases with `Category::Eof`, so Aurora treated them
/// as one and told the model its call "was almost certainly cut off by the
/// output-token limit" either way. Measured 2026-09-16, thread `e186eb4b`
/// (`modal-messages`, GLM-5.3): five `call_tool` blocks in one message, and the
/// first four arrived missing exactly one character each — their outermost `}`.
/// The fifth was intact. A token cap truncates the message tail at ONE point;
/// it does not shave the last brace off four blocks and leave the fifth whole.
///
/// The two cases need opposite handling, which is why they cannot share an
/// answer:
///
/// - `{"command": "rm -rf /tmp/ca` — cut mid-string. The argument is a
///   FRAGMENT of what the model meant. Closing it would hand an executor a
///   plausible-looking command that is not the one that was written, and
///   `ssh_execute` would run it. This must stay an error.
/// - `{"command": "whoami", "use_sudo": true}` (missing one `}`) — every key
///   and value is whole and only the wrapper is open. Nothing is guessed by
///   closing it.
///
/// The test is conservative on purpose: the payload must end on a character
/// that can only appear at the END of a complete value (`"`, `}`, `]`). A
/// trailing bare token is refused even though it looks finished, because `12`
/// is what a truncated `1234` looks like and no inspection can tell them apart.
pub(crate) fn unclosed_containers(raw: &str) -> Option<String> {
    let mut stack: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    let mut last_significant = '\0';

    for c in raw.chars() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
                last_significant = '"';
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' | '[' => {
                stack.push(c);
                last_significant = c;
            }
            '}' | ']' => {
                match (stack.pop(), c) {
                    (Some('{'), '}') | (Some('['), ']') => {}
                    // Mismatched or unbalanced: not this failure.
                    _ => return None,
                }
                last_significant = c;
            }
            c if c.is_whitespace() => {}
            other => last_significant = other,
        }
    }

    // Stopped inside a string, or inside an escape: genuinely cut.
    if in_string || escaped {
        return None;
    }
    // Nothing open — it failed for some other reason.
    if stack.is_empty() {
        return None;
    }
    // Must stop where a complete value stops. A trailing `,` or `:` means the
    // next value never arrived; a bare token may be half of a longer one.
    if !matches!(last_significant, '"' | '}' | ']') {
        return None;
    }

    Some(
        stack
            .iter()
            .rev()
            .map(|open| if *open == '{' { '}' } else { ']' })
            .collect(),
    )
}

/// Longest bare token this pass will quote.
///
/// A forgotten pair of quotes happens around a short scalar — a path, an id, a
/// mode. Past this length the thing being scanned is far more likely to be a
/// payload that broke some other way, and guessing at it is how a recovery pass
/// starts destroying calls instead of saving them.
const MAX_BARE_VALUE_SCAN: usize = 512;

/// Put quotes back around a value that was written without them.
///
/// The failure this exists for, verbatim off the wire:
///
/// ```text
/// {"path": README.md}
/// {"path": E:\sub2api\README.md}
/// ```
///
/// Both are one missing pair of quotes. Aurora refused them correctly and said
/// so, but the message listed likely causes instead of naming this one, so the
/// model "fixed" the backslashes, re-sent the same unquoted value, and burned
/// five calls before falling back to `cat`. A repair costs nothing when it is
/// wrong (see the safety note below) and saves the whole round trip when it is
/// right.
///
/// ## What counts as a bare value
///
/// Only a token sitting where JSON demands a value — after `:`, after `,`
/// inside an array, or right after `[` — that does not begin one. The token is
/// then handed to `serde_json` on its own: if it parses, it is a number, a
/// boolean or `null` and is left exactly as written. Everything else is quoted.
/// That is what keeps `{"deep": true}` and `{"n": -1.5e3}` untouched without
/// this function needing to know what a JSON number looks like.
///
/// A bare token ends at the first `,`, `}`, `]`, `"`, or line break. None of
/// those can appear inside an unquoted scalar, and stopping there rather than
/// guessing is why `{"a": hello, world}` stays broken instead of becoming
/// something the model never wrote.
///
/// ## Backslashes
///
/// Doubled only when the run is ODD, the same rule
/// [`is_drive_path_value`] uses and for the same reason: an even run was
/// already written as a JSON escape, so re-escaping it would turn `C:\\ws`
/// into `C:\\\\ws` and hand back a path that does not exist.
///
/// ## Why this is safe
///
/// It never sees valid JSON — [`parse_tool_input`] returns before reaching it
/// whenever the payload parses. And its output is thrown away unless it parses
/// as an object, so the worst case is byte-for-byte the behaviour that was
/// there before: the raw text carried through to
/// [`crate::agent_runtime::conversation::malformed_input_error`].
fn quote_bare_scalar_values(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut output = String::with_capacity(raw.len() + 16);
    let mut index = 0usize;
    // True right after `:`, `,` or `[` — the three places JSON expects a value.
    let mut expecting_value = false;

    while index < bytes.len() {
        let byte = bytes[index];

        // Step over a well-formed string whole, so a byte inside it is never
        // read as structure.
        if byte == b'"' {
            let start = index;
            index += 1;
            while index < bytes.len() {
                match bytes[index] {
                    b'\\' => index += 2,
                    b'"' => {
                        index += 1;
                        break;
                    }
                    _ => index += 1,
                }
            }
            output.push_str(&raw[start..index.min(bytes.len())]);
            expecting_value = false;
            continue;
        }

        if byte.is_ascii_whitespace() {
            output.push(byte as char);
            index += 1;
            continue;
        }

        if expecting_value && !opens_json_structure(byte) {
            let token_end = bare_token_end(bytes, index);
            let token = &raw[index..token_end];
            let trimmed = token.trim_end();
            if !trimmed.is_empty() && serde_json::from_str::<Value>(trimmed).is_err() {
                output.push('"');
                push_escaped_bare(&mut output, trimmed);
                output.push('"');
                output.push_str(&token[trimmed.len()..]);
                index = token_end;
                expecting_value = false;
                continue;
            }
        }

        expecting_value = matches!(byte, b':' | b',' | b'[');
        output.push(byte as char);
        index += 1;
    }

    output
}

/// Whether `byte` opens a JSON string, object or array.
///
/// Deliberately NOT "can open a value". A number, `true`, `false` and `null`
/// are left out so they go through the token scan and are decided by
/// `serde_json` rather than by their first character: `truthy` starts with `t`
/// and `12abc` starts with a digit, and both are bare words a first-byte test
/// would wave through. The three that are listed have to shortcut, because
/// walking a nested object or a quoted string as if it were a bare token would
/// mangle it.
const fn opens_json_structure(byte: u8) -> bool {
    matches!(byte, b'"' | b'{' | b'[')
}

/// Where a bare token stops.
///
/// Bounded by [`MAX_BARE_VALUE_SCAN`] so a large malformed payload cannot be
/// walked end to end looking for a delimiter that is not there.
fn bare_token_end(bytes: &[u8], start: usize) -> usize {
    let limit = (start + MAX_BARE_VALUE_SCAN).min(bytes.len());
    let mut index = start;
    while index < limit {
        match bytes[index] {
            b',' | b'}' | b']' | b'"' | b'\n' | b'\r' => return index,
            _ => index += 1,
        }
    }
    limit
}

/// Write `token` as the inside of a JSON string.
///
/// Odd backslash runs are doubled and even ones are left alone — see the note
/// on [`quote_bare_scalar_values`]. Control characters cannot reach here: they
/// terminate the token in [`bare_token_end`] or are not produced by any model
/// writing a path.
fn push_escaped_bare(output: &mut String, token: &str) {
    let bytes = token.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            let run_start = index;
            while index < bytes.len() && bytes[index] == b'\\' {
                index += 1;
            }
            output.push_str(&token[run_start..index]);
            if (index - run_start) % 2 == 1 {
                output.push('\\');
            }
            continue;
        }
        let next = token[index..].chars().next().unwrap_or('\u{fffd}');
        output.push(next);
        index += next.len_utf8();
    }
}

/// The raw argument text of a tool call whose arguments never parsed as a
/// JSON object, or `None` when `input` is a usable object.
///
/// Paired with [`parse_tool_input`]: that function encodes the failure as
/// a [`Value::String`], this one decodes it at the dispatch site.
#[must_use]
pub fn malformed_tool_input(input: &Value) -> Option<&str> {
    match input {
        Value::Object(_) => None,
        Value::String(raw) => Some(raw.as_str()),
        // Shouldn't occur (parse_tool_input only ever emits object|string),
        // but a non-object from any other source is equally unusable.
        _ => Some(""),
    }
}

/// Models occasionally emit Windows paths with literal backslashes inside
/// tool-call JSON. Some of those sequences are invalid JSON (`\U`), while
/// others are valid escapes with the wrong meaning (`\r`, `\n`, `\t`). Repair
/// only strings that unmistakably start with an absolute drive path, leaving
/// command strings, file contents, and already-correct JSON escapes untouched.
/// Longest run of bytes a drive-path candidate may occupy.
///
/// Generous next to any real path, and the point is only to stop a large text
/// value that happens to open with `C:\` from being walked as one.
const MAX_DRIVE_PATH_SCAN: usize = 1_024;

/// Whether the JSON string opening at `open_quote` is plausibly ONE Windows
/// path: it terminates within [`MAX_DRIVE_PATH_SCAN`] bytes and holds no real
/// line break.
///
/// A drive letter at the head is not enough. A document whose first line is an
/// absolute path opens exactly the same way, and rewriting its escapes as
/// though it were a path destroys it.
fn is_drive_path_value(bytes: &[u8], open_quote: usize) -> bool {
    let mut index = open_quote + 1;
    let limit = (index + MAX_DRIVE_PATH_SCAN).min(bytes.len());
    while index < limit {
        match bytes[index] {
            // A real line break cannot occur inside a path.
            b'\n' | b'\r' => return false,
            b'\\' => {
                let run_start = index;
                while index < limit && bytes[index] == b'\\' {
                    index += 1;
                }
                // An EVEN run is an already-escaped backslash, so this value was
                // written as correct JSON — which means its other escapes are
                // real: `\n` is a newline, `\"` is a quote, and rewriting either
                // corrupts it. Only a raw unescaped path needs repair, and every
                // run in one is odd. This is the whole difference between
                // `C:\ws\repo` (broken, repairable) and a document that merely
                // opens with `C:\\ws\\repo\n` (correct, untouchable).
                if (index - run_start).is_multiple_of(2) {
                    return false;
                }
                // Step over the character the odd backslash escapes, so a `\"`
                // cannot be mistaken for the end of the value.
                index += 1;
            }
            b'"' => return true,
            _ => index += 1,
        }
    }
    false
}

fn normalize_absolute_windows_paths(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut output = String::with_capacity(raw.len());
    let mut cursor = 0usize;
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] != b'"' {
            index += 1;
            continue;
        }

        let is_drive_path = index + 3 < bytes.len()
            && bytes[index + 1].is_ascii_alphabetic()
            && bytes[index + 2] == b':'
            && bytes[index + 3] == b'\\'
            && is_drive_path_value(bytes, index);

        if is_drive_path {
            output.push_str(&raw[cursor..=index]);
            let mut segment_start = index + 1;
            let mut path_index = segment_start;

            while path_index < bytes.len() {
                match bytes[path_index] {
                    b'\\' => {
                        output.push_str(&raw[segment_start..path_index]);
                        let run_start = path_index;
                        while path_index < bytes.len() && bytes[path_index] == b'\\' {
                            path_index += 1;
                        }
                        output.push_str(&raw[run_start..path_index]);
                        if (path_index - run_start) % 2 == 1 {
                            output.push('\\');
                        }
                        segment_start = path_index;
                    }
                    b'"' => {
                        output.push_str(&raw[segment_start..=path_index]);
                        index = path_index + 1;
                        cursor = index;
                        break;
                    }
                    _ => path_index += 1,
                }
            }

            if path_index == bytes.len() {
                // Keep malformed/incomplete JSON intact; the caller will apply
                // its established invalid-input fallback.
                output.push_str(&raw[segment_start..]);
                cursor = bytes.len();
                index = bytes.len();
            }
            continue;
        }

        // Skip over an ordinary JSON string so a quote-like byte in its value
        // cannot be mistaken for the start of a path string.
        index += 1;
        while index < bytes.len() {
            if bytes[index] == b'\\' {
                index = (index + 2).min(bytes.len());
            } else if bytes[index] == b'"' {
                index += 1;
                break;
            } else {
                index += 1;
            }
        }
    }

    output.push_str(&raw[cursor..]);
    output
}

/// Build a final assistant [`ConversationMessage`] from accumulated
/// [`BlockState`]s, attaching usage metadata.
pub fn finalize_assistant_message(
    blocks: Vec<BlockState>,
    usage: crate::agent_runtime::types::TokenUsage,
) -> ConversationMessage {
    let final_blocks: Vec<ContentBlock> = blocks
        .into_iter()
        .map(BlockState::into_content_block)
        .collect();
    ConversationMessage::assistant_with_usage(final_blocks, usage, now_unix_ms())
}

// ---------------------------------------------------------------------------
// Internal: unused HashMap import suppressor — kept here so the test
// module below can grow into using HashMap without needing a fresh
// import line.
// ---------------------------------------------------------------------------

#[doc(hidden)]
pub fn __unused_hashmap_marker() -> HashMap<i32, String> {
    HashMap::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The four payloads that arrived short in thread `e186eb4b` (2026-09-16,
    /// `modal-messages`/GLM-5.3), byte for byte off the session on disk.
    ///
    /// Five `call_tool` blocks in one assistant message; the first four each
    /// lost exactly their outermost `}` and the fifth was whole. Every key and
    /// value in all four is complete, so closing them guesses nothing — and
    /// each one was refused with "almost certainly cut off by the output-token
    /// limit", advice the model could not act on because the payload was not
    /// long.
    #[test]
    fn a_call_missing_only_its_closing_brace_is_repaired() {
        let cases = [
            r#"{"name": "mcp_ssh_fastmcp_ssh_list_servers", "arguments": {}"#,
            r#"{"name": "mcp_ssh_fastmcp_ssh_execute", "arguments": {"server": "alvan-quantum-oracle", "command": "pwd; whoami; hostname"}"#,
            r#"{"name": "mcp_ssh_fastmcp_ssh_execute", "arguments": {"server": "alvan-quantum-oracle", "command": "whoami", "use_sudo": true}"#,
            r#"{"name": "mcp_ssh_fastmcp_ssh_file_list", "arguments": {"path": ".", "server": "alvan-quantum-oracle"}"#,
        ];
        for raw in cases {
            assert_eq!(unclosed_containers(raw).as_deref(), Some("}"), "{raw}");
            let parsed = parse_tool_input(raw);
            assert!(parsed.is_object(), "not repaired: {raw}");
            assert!(
                parsed["name"].as_str().unwrap_or_default().starts_with("mcp_ssh"),
                "repair changed the call: {parsed}",
            );
            assert!(parsed.get("arguments").is_some(), "{parsed}");
        }
    }

    /// The case that must NEVER be repaired.
    ///
    /// A payload cut mid-value holds a FRAGMENT of what was written. Closing it
    /// produces a call that parses, looks deliberate, and is not the one the
    /// model sent — and the first example below is an `ssh_execute` that would
    /// then run. A trailing bare token is refused for the same reason: `12` is
    /// indistinguishable from a truncated `1234`.
    #[test]
    fn a_call_cut_mid_value_is_never_closed_and_guessed_at() {
        for raw in [
            // Mid-string: the command is half-written.
            r#"{"name": "x", "arguments": {"command": "rm -rf /tmp/ca"#,
            // Mid-escape.
            r#"{"name": "x", "arguments": {"path": "C:\\Users\\a\"#,
            // The value after the colon never arrived.
            r#"{"name": "x", "arguments": {"server":"#,
            // A trailing comma promises another value.
            r#"{"name": "x", "arguments": {"a": "b","#,
            // A bare token may be half of a longer one.
            r#"{"name": "x", "arguments": {"timeout": 12"#,
            r#"{"name": "x", "arguments": {"flag": tru"#,
        ] {
            assert_eq!(unclosed_containers(raw), None, "would have been closed: {raw}");
            assert!(
                parse_tool_input(raw).is_string(),
                "a cut payload must stay raw, not become a call: {raw}",
            );
        }
    }

    /// Valid JSON is never touched, and neither is a balanced payload that
    /// failed for some other reason.
    #[test]
    fn a_whole_payload_is_left_alone() {
        assert_eq!(unclosed_containers(r#"{"a": 1}"#), None);
        assert_eq!(unclosed_containers(r#"{"a": [1, 2]}"#), None);
        // Nested: both levels reported, innermost first.
        assert_eq!(
            unclosed_containers(r#"{"a": {"b": ["c"]"#).as_deref(),
            Some("}}"),
        );
        // A brace inside a string is text, not structure: the closed string
        // below leaves exactly one real `{` open, and the unclosed one above
        // it is a cut payload however many braces it appears to contain.
        assert_eq!(unclosed_containers(r#"{"a": "}}}}"#), None);
        assert_eq!(unclosed_containers(r#"{"a": "x{y}""#).as_deref(), Some("}"));
    }

    /// The model name must NEVER decide this, however tempting it looks — and
    /// it no longer needs to, because the answer is the same for all of them.
    ///
    /// A live 400 on `agentrouter:deepseek-v4-flash` ("The reasoning_content in
    /// the thinking mode must be passed back to the API") makes "DeepSeek
    /// behind a gateway needs the replay" write itself, and probing on
    /// 2026-08-25 showed the same endpoint returning 200 on every shape that
    /// was supposed to fail. So the requirement follows from neither the vendor
    /// nor the model family, and reading the model id here would be a guess
    /// whichever way it pointed.
    ///
    /// Every OpenAI-compatible gateway now gets the field, wanted or not, so a
    /// per-model branch has nothing left to decide.
    #[test]
    fn the_model_name_never_decides_the_reasoning_field() {
        for model in [
            "deepseek-v4-flash",
            "deepseek-v4-pro",
            "glm-5.2",
            "gpt-5.6",
            "o4-mini",
        ] {
            assert_eq!(
                reasoning_field_for("openai", model),
                Some("reasoning_content"),
                "{model}: the chat wire replays reasoning regardless of the model id"
            );
        }
    }

    /// Every OpenAI-compatible provider replays, including the ones known to
    /// reject it.
    ///
    /// Fireworks answers `Extra inputs are not permitted, field:
    /// reasoning_content`, and that used to earn it a permanent exemption in
    /// this table. A hardcoded exemption is a guess that never gets checked:
    /// it stays wrong after the provider changes, and it silently covers every
    /// gateway nobody has tested. The endpoint saying "no" once — recorded by
    /// `remember_reasoning_refusal`, retried clean, and billed nothing because
    /// a 4xx is refused before generation — is the same answer, measured.
    #[test]
    fn every_openai_compatible_provider_replays() {
        for provider in ["openai", "custom", "fireworks", "ollama", "kenari", ""] {
            assert_eq!(
                reasoning_field_for(provider, "some-model"),
                Some("reasoning_content"),
                "{provider}: the chat wire replays by default"
            );
        }
        // The vendors that publish the legacy key keep it.
        assert_eq!(reasoning_field_for("openrouter", "m"), Some("reasoning"));
        assert_eq!(reasoning_field_for("lmstudio", "m"), Some("reasoning"));
    }

    /// A refusal is recorded and then honoured, so the field stops going out.
    #[test]
    fn an_endpoint_that_rejects_the_field_stops_receiving_it() {
        const URL: &str = "https://strict-backend.example/v1/chat/completions";
        // Before the endpoint has said anything, the default applies.
        assert_eq!(
            resolve_reasoning_field("openai", "m-9", URL, None),
            Some("reasoning_content"),
        );

        let body = r#"{"error":{"message":"Extra inputs are not permitted, field: reasoning_content","type":"invalid_request_error"}}"#;
        let err = map_status_error_inner(
            400,
            body.to_string(),
            None,
            RequestOrigin {
                url: URL,
                model: "m-9",
            },
        );
        assert!(
            matches!(err, ApiError::ReasoningReplayRefused),
            "got {err:?}"
        );
        assert!(
            err.is_retryable(),
            "the rebuilt request differs, so re-issuing acts on new information"
        );

        // Recorded, and it now outranks even an explicit "Send" from the user —
        // honouring that setting here would leave the provider unusable.
        assert_eq!(resolve_reasoning_field("openai", "m-9", URL, None), None);
        assert_eq!(
            resolve_reasoning_field("openai", "m-9", URL, Some(Some("reasoning_content"))),
            None,
        );
        // Scoped to that endpoint and model, like every other learned fact.
        assert_eq!(
            resolve_reasoning_field("openai", "m-10", URL, None),
            Some("reasoning_content"),
        );
    }

    /// A refusal naming some OTHER field must not turn replay off.
    #[test]
    fn an_unrelated_rejected_parameter_leaves_replay_alone() {
        let body = r#"{"error":{"message":"Extra inputs are not permitted, field: top_k","type":"invalid_request_error"}}"#;
        let err = map_status_error_inner(
            400,
            body.to_string(),
            None,
            RequestOrigin {
                url: "https://other.example/v1/chat/completions",
                model: "m-11",
            },
        );
        assert!(
            !matches!(err, ApiError::ReasoningReplayRefused),
            "dropping reasoning over an unrelated field would be a guess, got {err:?}"
        );
    }

    /// Wires where the field does not exist send nothing — a different
    /// protocol, not an exemption.
    #[test]
    fn a_non_chat_wire_sends_nothing() {
        assert_eq!(reasoning_field_for("anthropic", "claude-opus-5"), None);
        assert_eq!(reasoning_field_for("minimax", "deepseek-chat"), None);
        assert_eq!(reasoning_field_for("openai-responses", "gpt-5"), None);
        assert_eq!(reasoning_field_for("codex", "gpt-5"), None);
        assert_eq!(reasoning_field_for("cursor", "claude"), None);
    }

    /// What an endpoint says about itself DOES decide it — that is the whole
    /// point of learning instead of tabulating. Keyed by host and model,
    /// because AgentRouter needs nothing for `glm-5.2` whatever it may need
    /// for another model.
    #[test]
    fn an_endpoint_that_asks_for_its_reasoning_back_is_believed() {
        let url = "https://learn-test.example/v1/chat/completions";
        assert_eq!(
            learned_reasoning_field(url, "m-1"),
            None,
            "nothing learned yet"
        );

        let field = reasoning_requirement_from_body(
            r#"{"error":{"message":"The reasoning_content in the thinking mode must be passed back to the API. [trace_id=9f97f082]"}}"#,
        );
        assert_eq!(
            field,
            Some("reasoning_content"),
            "read straight off the 400"
        );

        remember_reasoning_requirement(url, "m-1", field.unwrap());
        assert_eq!(
            learned_reasoning_field(url, "m-1"),
            Some("reasoning_content")
        );
        // Scoped to that model, and to that host.
        assert_eq!(learned_reasoning_field(url, "m-2"), None);
        assert_eq!(
            learned_reasoning_field("https://other.example/v1", "m-1"),
            None
        );
        // The base URL a request is BUILT from and the URL it was SENT to
        // resolve to the same key.
        assert_eq!(
            learned_reasoning_field("https://learn-test.example/v1", "m-1"),
            Some("reasoning_content")
        );
    }

    /// The match has to be narrow. A 400 that merely mentions reasoning, or
    /// one about something else entirely, must not start a replay.
    #[test]
    fn an_unrelated_400_does_not_trigger_a_replay() {
        for body in [
            r#"{"error":{"message":"unsupported parameter: reasoning_effort"}}"#,
            r#"{"error":{"message":"context length exceeded"}}"#,
            r#"{"error":{"message":"stream_options should be set along with stream = true"}}"#,
            r#"{"error":{"message":"Extra inputs are not permitted, field: reasoning_content"}}"#,
            // The same refusal with the field in `param` too. The structured
            // read must not turn "stop sending this" into "start sending this".
            r#"{"error":{"message":"Extra inputs are not permitted","param":"messages.reasoning_content","code":"unknown_field"}}"#,
            // A DIFFERENT field that merely contains the word. Same gateway,
            // same day, and a loose substring match reads it as a demand for
            // replayed thinking — then retries with a field nobody asked for
            // while the real fault (an effort value the endpoint won't take)
            // goes unreported.
            r#"{"error":{"message":"reasoning_effort 取值无效。请使用 low、medium、high、xhigh 或 none。","type":"invalid_request_error","param":"reasoning_effort","code":"VectorTide_invalid_reasoning_effort"}}"#,
        ] {
            assert_eq!(reasoning_requirement_from_body(body), None, "body: {body}");
        }
    }

    /// The 400 that showed the phrasebook was the wrong shape.
    ///
    /// Verbatim from the gateway on 2026-08-29. Every word of the message is
    /// Chinese; the requirement is stated twice more, in `param` and `code`,
    /// in a form that needs no translation. Reading those is what stops a
    /// turn dying on an endpoint that has just explained how to fix it.
    #[test]
    fn reads_the_requirement_when_the_message_is_not_in_english() {
        let body = r#"{"error":{"message":"thinking 模式的多轮对话必须回传上一轮 reasoning_content。请保留并原样回传该字段后重试。","type":"invalid_request_error","param":"messages.reasoning_content","code":"VectorTide_reasoning_content_required"}}"#;
        assert_eq!(
            reasoning_requirement_from_body(body),
            Some("reasoning_content")
        );

        // …and the prose alone is enough when a gateway sends no `param`.
        assert_eq!(
            reasoning_requirement_from_body(
                r#"{"error":{"message":"多轮对话必须回传上一轮 reasoning_content"}}"#
            ),
            Some("reasoning_content")
        );
    }

    /// A gateway may name the field in `param` without spelling out why. That
    /// is still the endpoint naming what it wants, and it is the only signal
    /// present — so it counts.
    #[test]
    fn a_named_param_is_enough_on_its_own() {
        assert_eq!(
            reasoning_requirement_from_body(
                r#"{"error":{"message":"invalid request","param":"messages.reasoning_content","code":"missing_required_field"}}"#
            ),
            Some("reasoning_content")
        );
    }

    /// kenari's chat wire replays like every other OpenAI-compatible provider.
    ///
    /// It used to be exempt on measured grounds: a second turn on
    /// `deepseek-v4-pro` returned `prompt_tokens: 7661` with the field, without
    /// it, and under either key — identical to the token, because the gateway
    /// strips it before forwarding. That made replay pure waste there.
    ///
    /// The exemption is gone anyway, because "wasted tokens" is not the test
    /// this table should be applying. A stripped field costs a little; a
    /// hardcoded exemption costs correctness the day kenari stops stripping it,
    /// and nothing would notice. The one signal that stays true is the
    /// endpoint's own answer, and kenari never refuses the field — so it is
    /// sent, like everywhere else.
    ///
    /// Its Messages and Responses wires still send nothing: there the field is
    /// not unwanted, it is not part of the protocol.
    #[test]
    fn kenari_chat_replays_and_its_other_wires_do_not() {
        assert_eq!(
            reasoning_field_for("kenari", "deepseek-v4-pro"),
            Some("reasoning_content")
        );
        assert_eq!(
            reasoning_field_for("kenari", "glm-5.2"),
            Some("reasoning_content")
        );
        assert_eq!(reasoning_field_for("kenari-messages", "glm-5.2"), None);
        assert_eq!(reasoning_field_for("kenari-responses", "glm-5.2"), None);
    }

    /// Modal's chat wire renders a replayed `reasoning_content` into the
    /// prompt (prompt_tokens rose by the reasoning's size, measured
    /// 2026-09-02), so it keeps the default; its other two wires carry
    /// thinking natively.
    #[test]
    fn modal_chat_replays_and_its_other_wires_do_not() {
        assert_eq!(
            reasoning_field_for("modal", "maya--ep-kimi-k3-server.us-west.modal.direct"),
            Some("reasoning_content")
        );
        assert_eq!(reasoning_field_for("modal-messages", "x"), None);
        assert_eq!(reasoning_field_for("modal-responses", "x"), None);
    }

    #[test]
    fn only_modal_puts_a_bearer_token_on_the_anthropic_wire() {
        assert!(anthropic_wire_uses_bearer("modal-messages"));
        assert!(anthropic_wire_uses_bearer(" Modal-Messages "));
        for other in ["anthropic", "minimax", "kenari-messages", "opencode-go-messages", ""] {
            assert!(!anthropic_wire_uses_bearer(other), "{other:?}");
        }
    }

    /// The direct providers keep their existing answers.
    #[test]
    fn naming_the_vendor_outright_still_decides_it() {
        assert_eq!(
            reasoning_field_for("deepseek", "deepseek-chat"),
            Some("reasoning_content")
        );
        assert_eq!(
            reasoning_field_for("glm", "glm-4.6"),
            Some("reasoning_content")
        );
        assert_eq!(
            reasoning_field_for("openrouter", "anything"),
            Some("reasoning")
        );
        assert_eq!(
            reasoning_field_for("lmstudio", "local-model"),
            Some("reasoning")
        );
    }

    /// The token estimate and the request builder must never disagree about
    /// whether a stored reasoning block reaches the wire — that disagreement
    /// is what invented ~92k tokens of phantom context once already.
    #[test]
    fn the_token_estimate_agrees_with_what_the_builder_emits() {
        use crate::agent_runtime::api_client::ReasoningReplayMode;
        use crate::api::{reasoning_replay_for, ReasoningReplay};
        const URL: &str = "https://estimate-test.example/v1";
        for (provider, model) in [
            ("openai", "deepseek-v4-flash"),
            ("openai", "gpt-5.6"),
            ("fireworks", "deepseek-v3"),
            ("kenari", "deepseek-v4-pro"),
            ("deepseek", "deepseek-chat"),
            ("custom", "glm-5.2"),
        ] {
            let builder_emits = reasoning_field_for(provider, model)
                .or_else(|| learned_reasoning_field(URL, model))
                .is_some();
            let estimate_charges =
                reasoning_replay_for(provider, model, URL, ReasoningReplayMode::Auto, None)
                    == ReasoningReplay::Text;
            assert_eq!(
                builder_emits, estimate_charges,
                "{provider}/{model}: the estimate and the wire disagree"
            );
        }
    }

    /// The user's `reasoning_replay` custom param is the switch for gateways
    /// that silently ACCEPT replayed reasoning: no automatic signal can find
    /// those, and dropping there costs the model its own earlier plans.
    #[test]
    fn reasoning_replay_directive_overrides_the_table_both_ways() {
        use std::collections::HashMap;
        let params_on: HashMap<String, Value> =
            HashMap::from([("reasoning_replay".to_string(), json!("reasoning_content"))]);
        let params_off: HashMap<String, Value> =
            HashMap::from([("reasoning_replay".to_string(), json!("off"))]);

        // Force ON for a custom gateway the table would drop for.
        assert_eq!(
            resolve_reasoning_field(
                "openai",
                "glm-5.3",
                "https://directive-test.example/v1",
                reasoning_replay_override(Some(&params_on)),
            ),
            Some("reasoning_content")
        );
        // Force OFF for a provider the table would emit for.
        assert_eq!(
            resolve_reasoning_field(
                "glm",
                "glm-4.6",
                "https://directive-test.example/v1",
                reasoning_replay_override(Some(&params_off)),
            ),
            None
        );
        // No directive → table applies untouched.
        assert_eq!(
            resolve_reasoning_field("glm", "glm-4.6", "https://directive-test.example/v1", None),
            Some("reasoning_content")
        );
        // An endpoint's own 400 outranks even an explicit OFF — otherwise
        // the next request just fails the same way again.
        remember_reasoning_requirement(
            "https://demanding-endpoint.example/v1",
            "stubborn-model",
            "reasoning_content",
        );
        assert_eq!(
            resolve_reasoning_field(
                "openai",
                "stubborn-model",
                "https://demanding-endpoint.example/v1",
                reasoning_replay_override(Some(&params_off)),
            ),
            Some("reasoning_content")
        );
        // The estimator follows the directive too — wire and estimate must
        // never disagree about whether stored reasoning is billed.
        use crate::agent_runtime::api_client::ReasoningReplayMode;
        use crate::api::{reasoning_replay_for, ReasoningReplay};
        assert_eq!(
            reasoning_replay_for(
                "openai",
                "glm-5.3",
                "https://directive-test.example/v1",
                ReasoningReplayMode::Auto,
                Some(&params_on)
            ),
            ReasoningReplay::Text
        );
        assert_eq!(
            reasoning_replay_for(
                "glm",
                "glm-4.6",
                "https://directive-test.example/v1",
                ReasoningReplayMode::Auto,
                Some(&params_off)
            ),
            ReasoningReplay::Dropped
        );
    }

    /// The directive steers the builder but must never reach the wire —
    /// strict backends reject unknown body fields with HTTP 400.
    #[test]
    fn reasoning_replay_directive_never_reaches_the_wire() {
        let messages = vec![
            ConversationMessage::user_text("hi", 0),
            ConversationMessage::assistant(
                vec![
                    ContentBlock::Thinking {
                        text: "the plan lives here".into(),
                        signature: None,
                        duration_ms: None,
                    },
                    ContentBlock::Text { text: "ok".into() },
                ],
                1,
            ),
        ];
        let request = ApiRequest {
            messages: &messages,
            system_prompt: None,
            tools: &[],
            tool_choice: Default::default(),
            model: "glm-5.3",
            temperature: None,
            max_output_tokens: 1024,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: None,        };
        let mut config = ProviderConfigSnapshot {
            provider_id: "custom-gw".into(),
            provider_type: Some("openai".into()),
            base_url: "https://directive-wire.example/v1".into(),
            api_key: "k".into(),
            api_keys: None,
            model: "glm-5.3".into(),
            custom_headers: None,
            custom_params: Some(std::collections::HashMap::from([(
                "reasoning_replay".to_string(),
                json!("reasoning_content"),
            )])),
            default_temperature: None,
            default_max_tokens: None,
            supports_thinking: false,
            reasoning: None,
            supports_vision: false,
        };

        let body = build_openai_body(&request, &config);
        // Directive consumed, not forwarded.
        assert!(body.get("reasoning_replay").is_none());
        // And it did its job: the assistant message carries the reasoning.
        assert_eq!(
            body["messages"][1]["reasoning_content"],
            "the plan lives here"
        );

        // Same request with the directive off: reasoning stays home.
        config.custom_params = Some(std::collections::HashMap::from([(
            "reasoning_replay".to_string(),
            json!("off"),
        )]));
        let body = build_openai_body(&request, &config);
        assert!(body.get("reasoning_replay").is_none());
        assert!(body["messages"][1].get("reasoning_content").is_none());
    }

    /// `Some(0)` and `None` are different claims and the UI acts on both.
    ///
    /// A provider that reports `cached_tokens: 0` is saying the cache missed
    /// on this request — worth showing. A provider that omits the field is
    /// saying nothing, and the card must keep displaying the last real
    /// reading instead of blanking. Filtering zeros away made those two
    /// indistinguishable, so a broken cache rendered as an empty gap.
    #[test]
    fn a_reported_zero_is_not_the_same_as_no_report() {
        let reported_zero = OpenAiUsageData {
            prompt_tokens_details: Some(OpenAiPromptTokensDetails {
                cached_tokens: Some(0),
            }),
            ..Default::default()
        };
        assert_eq!(reported_zero.cache_read_tokens(), Some(0));

        let silent = OpenAiUsageData::default();
        assert_eq!(silent.cache_read_tokens(), None);

        // A details object present but with a null member is still silence.
        let null_member = OpenAiUsageData {
            prompt_tokens_details: Some(OpenAiPromptTokensDetails {
                cached_tokens: None,
            }),
            ..Default::default()
        };
        assert_eq!(null_member.cache_read_tokens(), None);
    }

    /// DeepSeek's own field wins over the OpenAI one when both are present,
    /// and a real hit still comes through unchanged.
    #[test]
    fn deepseek_cache_field_outranks_the_openai_one() {
        let both = OpenAiUsageData {
            prompt_cache_hit_tokens: Some(1_024),
            prompt_tokens_details: Some(OpenAiPromptTokensDetails {
                cached_tokens: Some(7),
            }),
            ..Default::default()
        };
        assert_eq!(both.cache_read_tokens(), Some(1_024));
    }

    #[test]
    fn a_modern_claude_gets_adaptive_thinking_and_no_sampling_params() {
        // `budget_tokens` and `temperature` are each a 400 on Opus 4.7+ — this
        // is the shape Aurora used to send to every Anthropic model.
        for model in [
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-opus-4-8",
            "claude-fable-5",
        ] {
            let s = anthropic_surface_for(model);
            assert!(s.adaptive, "{model} must use adaptive thinking");
            assert!(!s.allows_sampling, "{model} rejects sampling parameters");
            assert!(s.summaries_need_opt_in, "{model} needs display: summarized");
        }
    }

    #[test]
    fn fable_cannot_have_thinking_disabled() {
        // An explicit `{"type":"disabled"}` is a 400 at any effort — the
        // parameter has to be omitted instead.
        assert!(!anthropic_surface_for("claude-fable-5").allows_disabled);
        assert!(anthropic_surface_for("claude-opus-5").allows_disabled);
    }

    #[test]
    fn thinking_defaults_differ_between_opus_5_and_opus_4_8() {
        // Omitting `thinking` reasons on Opus 5 and does not on Opus 4.8 —
        // the one silent default change between those generations.
        assert!(anthropic_surface_for("claude-opus-5").thinks_by_default);
        assert!(!anthropic_surface_for("claude-opus-4-8").thinks_by_default);
    }

    #[test]
    fn an_unknown_model_gets_the_legacy_shape() {
        // A provider typed "anthropic" is very often a gateway that speaks the
        // Messages API without being Anthropic. `budget_tokens` is what those
        // universally implement; guessing `adaptive` would break all of them.
        let s = anthropic_surface_for("some-gateway/llama-70b-anthropic-shim");
        assert!(!s.adaptive);
        assert!(s.allows_sampling);
        assert_eq!(s.max_effort, None);
    }

    #[test]
    fn a_bedrock_prefix_and_a_dated_snapshot_resolve_to_the_same_row() {
        assert_eq!(
            anthropic_surface_for("anthropic.claude-opus-5"),
            anthropic_surface_for("claude-opus-5"),
        );
        assert!(anthropic_surface_for("claude-opus-4-5-20251101")
            .max_effort
            .is_some());
    }

    #[test]
    fn xhigh_is_clamped_on_models_that_predate_it() {
        // `xhigh` arrived with Opus 4.7; sending it to 4.6 is a 400.
        assert_eq!(
            anthropic_surface_for("claude-sonnet-4-6").max_effort,
            Some(AnthropicEffort::Max),
        );
        assert!(AnthropicEffort::XHigh < AnthropicEffort::Max);
        assert_eq!(
            AnthropicEffort::parse("x-high"),
            Some(AnthropicEffort::XHigh)
        );
    }

    /// A background process ending must reach the model on EVERY wire.
    ///
    /// It reached Anthropic and nothing else: `collect_text` — the flattener
    /// every OpenAI-compatible provider goes through — dropped the block on its
    /// `_ => None` arm. When the ending was one block among several the loss
    /// was invisible; once a whole turn was started BY an ending, the message
    /// went out empty and the model was left to guess. It guessed, in writing:
    /// "No user content — just an empty message. The background process likely
    /// finished by now."
    #[test]
    fn a_process_ending_reaches_the_openai_wire_too() {
        let blocks = vec![ContentBlock::ProcessEvent {
            summary: "Finished pnpm test · exit 0".into(),
            detail: "The background process \"pnpm test\" (id bg-1) has ended with exit code 0."
                .into(),
            created_at: 7,
        }];

        // The model's copy, not the transcript's one-liner: it carries the id
        // and the log path, which is what makes `shell_read_output` callable.
        assert_eq!(
            collect_text(&blocks),
            "The background process \"pnpm test\" (id bg-1) has ended with exit code 0."
        );

        // And the Anthropic path still sends the same thing, so the two wires
        // cannot drift apart again.
        let content = message_blocks_to_anthropic_content(&blocks, false);
        let arr = content.as_array().expect("array");
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(
            arr[0]["text"],
            "The background process \"pnpm test\" (id bg-1) has ended with exit code 0."
        );
    }

    #[test]
    fn a_redacted_thinking_block_goes_back_as_redacted_thinking() {
        // Anthropic encrypts a reasoning block when its safety systems flag
        // it. The payload is opaque and must be replayed verbatim — re-sending
        // it as a `thinking` block carrying our own JSON wrapper in the
        // signature slot is a signature Anthropic cannot verify, and it
        // rejects the entire request.
        let blocks = vec![ContentBlock::Thinking {
            text: String::new(),
            signature: Some(encode_redacted_thinking("EncRypTeDbLoB==")),
            duration_ms: None,
        }];

        let content = message_blocks_to_anthropic_content(&blocks, false);
        let arr = content.as_array().expect("array");
        assert_eq!(arr[0]["type"], "redacted_thinking");
        assert_eq!(arr[0]["data"], "EncRypTeDbLoB==");
        assert!(arr[0].get("signature").is_none());
        assert!(arr[0].get("thinking").is_none());
    }

    #[test]
    fn an_ordinary_signature_is_left_alone() {
        let blocks = vec![ContentBlock::Thinking {
            text: "step one".into(),
            signature: Some("real-anthropic-signature".into()),
            duration_ms: None,
        }];

        let content = message_blocks_to_anthropic_content(&blocks, false);
        let arr = content.as_array().expect("array");
        assert_eq!(arr[0]["type"], "thinking");
        assert_eq!(arr[0]["thinking"], "step one");
        assert_eq!(arr[0]["signature"], "real-anthropic-signature");
    }

    #[test]
    fn openai_tool_result_moves_images_into_a_following_user_message() {
        let content = "Screenshot captured.\n\
             <aurora_image media_type=\"image/png\">QUJD</aurora_image>";
        let (text, images) = openai_tool_result_split(content);

        assert_eq!(text, "Screenshot captured.");
        assert_eq!(images.len(), 1, "the image must be split out");
        assert_eq!(
            images[0]["image_url"]["url"].as_str().unwrap(),
            "data:image/png;base64,QUJD"
        );
    }

    /// Reading a file that DOCUMENTS the marker syntax must produce text, not an
    /// image part. This is the regression behind the provider 400: a `file_read`
    /// of `.knowledge/knowledge.md` matched the old substring test, and ~2.8 KB
    /// of markdown between the quoted open and close tokens was shipped as
    /// `data:image/png;base64,<markdown>` — rejected as
    /// "invalid base64-encoded value", killing the whole turn.
    #[test]
    fn prose_documenting_the_marker_is_never_split_into_an_image() {
        let content = concat!(
            "{\"success\":true,\"path\":\".knowledge/knowledge.md\",\"content\":\"",
            "FIX: `truncate_tool_content` returns early when `s.contains(\"<aurora_image \")`. ",
            "Downscale bounds the size so this is safe. The MODEL copy keeps the full ",
            "`<aurora_image>` block (vision); reload parses the raw ",
            "`<aurora_image ... src=.. w.. h..>BASE64</aurora_image>` block.",
            "\"}",
        );

        let (text, images) = openai_tool_result_split(content);
        assert!(images.is_empty(), "prose must not become an image part");
        assert_eq!(text, content, "the text must survive intact");

        // Same for the Anthropic and Responses shapes.
        assert_eq!(
            anthropic_tool_result_content(content),
            Value::String(content.to_string()),
        );
        assert!(matches!(
            split_aurora_images(content).as_slice(),
            [AuroraImagePiece::Text(_)],
        ));
    }

    /// A genuine screenshot appearing AFTER prose that quotes the syntax is
    /// still delivered — validation skips bad candidates, it doesn't give up.
    #[test]
    fn a_real_image_after_quoted_prose_is_still_delivered() {
        let content = "docs mention `<aurora_image ...>` loosely.\n\
             <aurora_image media_type=\"image/png\">QUJD</aurora_image>";
        let (_text, images) = openai_tool_result_split(content);
        assert_eq!(images.len(), 1);
        assert_eq!(
            images[0]["image_url"]["url"].as_str().unwrap(),
            "data:image/png;base64,QUJD"
        );
    }

    /// The overwhelming majority of tool results are plain text and must keep
    /// riding on the tool message alone — no stray user message, no note.
    #[test]
    fn openai_tool_result_without_images_stays_a_plain_tool_message() {
        let (text, images) = openai_tool_result_split("wrote 12 lines to main.rs");
        assert_eq!(text, "wrote 12 lines to main.rs");
        assert!(images.is_empty());
    }

    /// End-to-end through the message builder: the tool entry keeps text plus
    /// the hand-off note, and exactly one user message follows carrying the
    /// image part.
    #[test]
    fn openai_messages_emits_tool_text_then_user_image() {
        let messages = vec![ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![ContentBlock::ToolResult {
                tool_use_id: "call_1".into(),
                content: "Screenshot captured.\n\
                    <aurora_image media_type=\"image/png\">QUJD</aurora_image>"
                    .into(),
                is_error: None,
            }],
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        }];
        let request = ApiRequest {
            messages: &messages,
            system_prompt: None,
            tools: &[],
            tool_choice: Default::default(),
            model: "claude-opus-5",
            temperature: None,
            max_output_tokens: 1024,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: None,        };

        let out = openai_messages(&request, true, "openai", "", None);

        assert_eq!(out.len(), 2, "one tool message + one user message");
        assert_eq!(out[0]["role"], "tool");
        let tool_text = out[0]["content"]
            .as_str()
            .expect("tool content is a string");
        assert!(tool_text.contains("Screenshot captured."));
        assert!(
            tool_text.contains(OPENAI_IMAGE_HANDOFF_NOTE),
            "the model must be told the image follows, got: {tool_text}"
        );
        assert!(
            !tool_text.contains("base64"),
            "no image may remain on the tool entry"
        );

        assert_eq!(out[1]["role"], "user");
        let parts = out[1]["content"]
            .as_array()
            .expect("user content is an array");
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"], "image_url");
    }

    /// A mid-turn injected message carrying an `<aurora_image>` marker (a
    /// composer attachment) must reach the model as a real image part in the
    /// trailing user message — the same delivery `browser_screenshot` gets —
    /// not as base64 prose.
    #[test]
    fn openai_messages_expands_injected_image_markers() {
        let messages = vec![ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![
                ContentBlock::ToolResult {
                    tool_use_id: "call_1".into(),
                    content: "lint passed".into(),
                    is_error: None,
                },
                ContentBlock::Text {
                    text: "use this design\n\
                        <aurora_image media_type=\"image/png\">QUJD</aurora_image>"
                        .into(),
                },
            ],
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        }];
        let request = ApiRequest {
            messages: &messages,
            system_prompt: None,
            tools: &[],
            tool_choice: Default::default(),
            model: "claude-opus-5",
            temperature: None,
            max_output_tokens: 1024,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: None,        };

        let out = openai_messages(&request, true, "openai", "", None);
        assert_eq!(out.len(), 2, "one tool message + one user message");
        assert_eq!(out[1]["role"], "user");
        let parts = out[1]["content"].as_array().expect("multimodal array");
        assert!(
            parts.iter().any(|p| p["type"] == "text"
                && p["text"].as_str().unwrap_or("").contains("use this design")),
            "injected text survives as a text part"
        );
        assert!(
            parts.iter().any(|p| p["type"] == "image_url"),
            "the marker becomes a real image part"
        );

        // Non-vision: the marker is stripped to a placeholder, never base64.
        let out = openai_messages(&request, false, "openai", "", None);
        let content = out[1]["content"].as_str().expect("plain string content");
        assert!(content.contains("use this design"));
        assert!(!content.contains("QUJD"), "no raw base64 for non-vision");
    }

    #[test]
    fn frame_buffer_splits_on_double_newline() {
        let mut buf = SseFrameBuffer::new();
        buf.extend(b"data: {\"a\":1}\n\ndata: {\"b\":2}\n\n");
        let frames = buf.take_frames();
        assert_eq!(frames.len(), 2);
        assert!(frames[0].contains("{\"a\":1}"));
        assert!(frames[1].contains("{\"b\":2}"));
        assert_eq!(buf.pending_len(), 0);
    }

    #[test]
    fn frame_buffer_handles_split_mid_frame_then_completes() {
        let mut buf = SseFrameBuffer::new();
        buf.extend(b"data: {\"hel");
        let first = buf.take_frames();
        assert!(first.is_empty(), "no complete frame yet");
        buf.extend(b"lo\":\"world\"}\n\n");
        let frames = buf.take_frames();
        assert_eq!(frames.len(), 1);
        let payloads = frame_payloads(&frames[0]);
        assert_eq!(payloads, vec![r#"{"hello":"world"}"#.to_string()]);
    }

    #[test]
    fn frame_payloads_skips_done_marker() {
        let frame = "data: [DONE]";
        assert!(frame_payloads(frame).is_empty());
    }

    #[test]
    fn map_status_error_classifies_known_codes() {
        assert!(matches!(
            map_status_error(401, "no key".into()),
            ApiError::Unauthorized(_)
        ));
        assert!(matches!(
            map_status_error(429, "slow down".into()),
            ApiError::RateLimit { .. }
        ));
        match map_status_error(503, "boom".into()) {
            ApiError::Provider(msg) => assert!(msg.contains("503")),
            other => panic!("expected Provider, got {other:?}"),
        }
        match map_status_error(400, "bad".into()) {
            ApiError::InvalidRequest(msg) => assert!(msg.contains("400")),
            other => panic!("expected InvalidRequest, got {other:?}"),
        }
    }

    /// A 401 that is not about the key at all.
    ///
    /// OpenCode answers an unrecognised model id with this exact shape. The
    /// body names the real fault; Aurora used to drop it and print "check API
    /// key", which is how a working subscription reads as a broken one.
    #[test]
    fn a_401_that_explains_itself_is_quoted_not_replaced() {
        let body = r#"{"type":"error","error":{"type":"ModelError","message":"Model gpt-5-6-luna is not supported"}}"#;
        match map_status_error(401, body.into()) {
            ApiError::Unauthorized(msg) => {
                assert!(
                    msg.contains("not supported"),
                    "the provider's own reason must survive: {msg}"
                );
                assert!(!msg.contains("check API key"), "guessed a cause: {msg}");
            }
            other => panic!("expected Unauthorized, got {other:?}"),
        }
    }

    /// …and a 401 with nothing to say still says the useful thing.
    #[test]
    fn a_silent_401_still_points_at_the_key() {
        match map_status_error(401, String::new()) {
            ApiError::Unauthorized(msg) => assert_eq!(msg, "check API key"),
            other => panic!("expected Unauthorized, got {other:?}"),
        }
    }

    /// The body that started this: a relay reporting its own dead upstream
    /// with a 400. Aurora surfaced it as "Something Went Wrong" and made the
    /// user press Retry; it is a 503 with the wrong number on it.
    const UPSTREAM_UNAVAILABLE_400: &str = concat!(
        r#"{"error":{"message":"上游服务暂时不可用。 原因：上游服务、网络链路或代理返回异常响应。"#,
        r#" 解决方案：请稍后重试。如当前使用智能路由，请先重试。","type":"upstream_unavailable","#,
        r#""param":"","code":"upstream_unavailable"}}"#,
    );

    #[test]
    fn a_gateway_reporting_its_own_dead_upstream_with_a_400_is_retried() {
        match map_status_error(400, UPSTREAM_UNAVAILABLE_400.into()) {
            ApiError::Provider(msg) => assert!(msg.contains("400")),
            other => panic!("expected Provider (retryable), got {other:?}"),
        }
        assert!(map_status_error(400, UPSTREAM_UNAVAILABLE_400.into()).is_retryable());
    }

    #[test]
    fn transient_4xx_bodies_are_recognised_in_either_language() {
        for body in [
            r#"{"error":{"code":"upstream_unavailable"}}"#,
            r#"{"error":{"message":"no healthy upstream"}}"#,
            r#"{"error":{"message":"Service temporarily unavailable, try again later"}}"#,
            r#"{"error":{"type":"bad_gateway"}}"#,
            r#"{"error":{"message":"All providers are overloaded"}}"#,
            "上游服务暂时不可用",
        ] {
            assert!(
                map_status_error(400, body.into()).is_retryable(),
                "should have been retried: {body}",
            );
        }
    }

    /// The half that protects the user's money and their patience. Each of
    /// these is byte-identical on the next attempt — and the first two are
    /// conditions Aurora repairs itself rather than waits out.
    #[test]
    fn a_400_about_the_request_itself_is_never_retried() {
        for body in [
            // Retry-flavoured prose on a permanent fault — the case that makes
            // the request-fault check have to run first.
            r#"{"error":{"message":"prompt is too long: 412000 tokens. Please try again later."}}"#,
            r#"{"error":{"message":"tool_use ids were found without tool_result blocks"}}"#,
            r#"{"error":{"message":"messages with role 'tool' must be a response to a tool_call"}}"#,
            r#"{"error":{"message":"The model `gpt-9` does not exist"}}"#,
            r#"{"error":{"message":"Unsupported parameter: 'temperature'"}}"#,
            r#"{"error":{"message":"You exceeded your current quota. Please retry later."}}"#,
            r#"{"error":{"message":"insufficient credit"}}"#,
        ] {
            assert!(
                !map_status_error(400, body.into()).is_retryable(),
                "should NOT have been retried: {body}",
            );
        }
    }

    #[test]
    fn an_unremarkable_400_still_surfaces_immediately() {
        assert!(!map_status_error(400, r#"{"error":"bad request"}"#.into()).is_retryable());
        assert!(!map_status_error(404, "not found".into()).is_retryable());
    }

    #[test]
    fn unprefix_model_strips_provider_prefix() {
        assert_eq!(
            unprefix_model("anthropic:claude-3", "anthropic"),
            "claude-3"
        );
        assert_eq!(unprefix_model("claude-3", "anthropic"), "claude-3");
        assert_eq!(unprefix_model("anthropic:claude-3", ""), "claude-3");
    }

    #[test]
    fn thinking_budget_scales_with_effort_tier() {
        // Tiers buy an increasing MULTIPLE of the answer budget — additive, so
        // a higher tier never shrinks the room left to reply in.
        assert_eq!(
            anthropic_thinking_budget(None, Some("low"), 8_192),
            Some(4_096)
        );
        assert_eq!(
            anthropic_thinking_budget(None, Some("medium"), 8_192),
            Some(8_192)
        );
        assert_eq!(
            anthropic_thinking_budget(None, Some("high"), 8_192),
            Some(16_384)
        );
        assert_eq!(
            anthropic_thinking_budget(None, Some("xhigh"), 8_192),
            Some(24_576)
        );
        assert_eq!(
            anthropic_thinking_budget(None, Some("max"), 8_192),
            Some(24_576)
        );
        // A plain toggle (no tier) and an unknown tier both fall back to medium.
        assert_eq!(anthropic_thinking_budget(None, None, 8_192), Some(8_192));
        assert_eq!(
            anthropic_thinking_budget(None, Some("bogus"), 8_192),
            Some(8_192)
        );
    }

    /// The regression this whole change exists for: on the old share-based
    /// math, `xhigh` handed reasoning 90% of the cap and left the model ~10%
    /// to answer in, so a long reasoning pass hit `max_tokens` mid-thought and
    /// the turn ended with no reply at all.
    #[test]
    fn xhigh_thinking_never_eats_the_answer_budget() {
        let answer = 8_192;
        let (budget, total) = anthropic_thinking_plan(None, Some("xhigh"), answer).unwrap();
        assert!(
            total - budget >= answer,
            "answer budget shrank: {total} - {budget} < {answer}"
        );
        assert!(budget < total, "Anthropic requires budget < max_tokens");
    }

    /// Both invariants have to hold at once at every size — `budget < max` AND
    /// `max <= ceiling`. Clamping them independently satisfied one and broke the
    /// other (a 32k answer budget produced max_tokens 96,001, a flat 400).
    #[test]
    fn thinking_plan_holds_both_invariants_at_every_size() {
        for answer in [
            1_025_u32, 2_000, 8_192, 16_384, 32_000, 40_000, 64_000, 100_000,
        ] {
            for effort in [
                None,
                Some("low"),
                Some("medium"),
                Some("high"),
                Some("xhigh"),
            ] {
                let Some((budget, total)) = anthropic_thinking_plan(None, effort, answer) else {
                    continue; // no valid config at this size — caller omits `thinking`
                };
                assert!(
                    budget >= ANTHROPIC_MIN_THINKING_BUDGET,
                    "answer={answer} effort={effort:?}: budget {budget} under floor"
                );
                assert!(
                    budget < total,
                    "answer={answer} effort={effort:?}: budget {budget} >= max_tokens {total}"
                );
                assert!(
                    total <= ANTHROPIC_MAX_TOKENS_CEILING,
                    "answer={answer} effort={effort:?}: max_tokens {total} over ceiling"
                );
            }
        }
    }

    #[test]
    fn thinking_budget_respects_anthropic_bounds() {
        // Never below the 1024 floor, even when the tier multiple would be tiny.
        assert_eq!(
            anthropic_thinking_budget(None, Some("low"), 2_000),
            Some(1_024)
        );
        // The combined cap always leaves `budget < max_tokens`.
        let (budget, total) = anthropic_thinking_plan(None, Some("max"), 1_100).unwrap();
        assert!(
            budget < total,
            "budget {budget} must be < max_tokens {total}"
        );
        assert!(budget >= 1_024, "budget {budget} must be >= 1024");
        // Too small to pair with a valid budget → omit `thinking` entirely.
        assert_eq!(anthropic_thinking_budget(None, Some("high"), 1_024), None);
        assert_eq!(anthropic_thinking_budget(None, None, 500), None);
    }

    #[test]
    fn combined_cap_stays_under_the_anthropic_ceiling() {
        // A 32k answer budget on the top tier wants 96k of thinking = 128k total.
        // Clamp to the ceiling by shrinking THINKING, never the answer share.
        let (budget, total) = anthropic_thinking_plan(None, Some("xhigh"), 32_000).unwrap();
        assert_eq!(total, ANTHROPIC_MAX_TOKENS_CEILING);
        assert_eq!(budget, 32_000, "reasoning absorbs the clamp");
        assert_eq!(total - budget, 32_000, "the answer budget survives intact");
    }

    /// Degenerate case: the answer budget alone fills the ceiling, so there is
    /// no room left to add thinking on top. Split the cap rather than emitting
    /// an invalid body or silently dropping reasoning.
    #[test]
    fn answer_budget_at_the_ceiling_splits_the_cap() {
        let (budget, total) = anthropic_thinking_plan(None, Some("high"), 64_000).unwrap();
        assert_eq!(total, ANTHROPIC_MAX_TOKENS_CEILING);
        assert_eq!(budget, 32_000);
        assert!(budget < total);
    }

    #[test]
    fn explicit_thinking_budget_overrides_the_effort_tier() {
        // The user's own number wins over the tier multiple...
        assert_eq!(
            anthropic_thinking_budget(Some(6_000), Some("max"), 64_000),
            Some(6_000)
        );
        // ...and over the plain-toggle fallback.
        assert_eq!(
            anthropic_thinking_budget(Some(24_000), None, 64_000),
            Some(24_000)
        );
        // An explicit budget no longer competes with the answer budget, so
        // lowering `Max output` leaves it intact instead of clamping it down.
        assert_eq!(
            anthropic_thinking_budget(Some(60_000), None, 8_000),
            Some(60_000)
        );
        assert_eq!(
            anthropic_thinking_budget(Some(200), None, 64_000),
            Some(1_024)
        );
        // Zero is the "no explicit budget" encoding — fall back to the tier
        // (`low` is now half the answer budget, not a quarter of the cap).
        assert_eq!(
            anthropic_thinking_budget(Some(0), Some("low"), 64_000),
            Some(32_000)
        );
    }

    fn thinking_config() -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: "custom".into(),
            provider_type: None,
            base_url: "https://example.invalid/v1".into(),
            api_key: String::new(),
            api_keys: None,
            model: "some-reasoner".into(),
            custom_headers: None,
            custom_params: None,
            default_temperature: None,
            default_max_tokens: None,
            supports_thinking: true,
            reasoning: None,
            supports_vision: false,
        }
    }

    fn caching_request<'a>(
        messages: &'a [ConversationMessage],
        tools: &'a [ToolSchema],
    ) -> ApiRequest<'a> {
        ApiRequest {
            model: "claude-opus-4",
            system_prompt: Some("You are Aurora Agent."),
            messages,
            tools,
            tool_choice: Default::default(),
            temperature: None,
            max_output_tokens: 8_000,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: None,        }
    }

    fn tool_schema(name: &str) -> ToolSchema {
        ToolSchema {
            name: name.into(),
            description: "t".into(),
            input_schema: json!({"type": "object"}),
        }
    }

    /// MiniMax was excluded from prompt caching on caution alone, which cost
    /// 20x on the cached part of every turn ($0.06/M read against $0.30/M
    /// fresh). Measured live 2026-09-09: one breakpoint on a 1,582-token system
    /// prompt wrote the cache on the first call and read all 1,582 back on the
    /// second, with `input_tokens: 0` both times.
    #[test]
    fn minimax_gets_cache_breakpoints_like_anthropic() {
        let mut config = thinking_config();
        config.provider_id = "minimax".into();
        config.provider_type = Some("minimax".into());
        let messages = [ConversationMessage::user_text("hi", 0)];
        let tools = [tool_schema("file_read"), tool_schema("grep")];

        let body = build_anthropic_body(&caching_request(&messages, &tools), &config);
        let serialized = body.to_string();

        assert!(
            serialized.contains("cache_control"),
            "MiniMax accepts cache_control; withholding it pays full price"
        );
        // MiniMax honours only the last four markers on a request and ignores
        // the rest, so exceeding four silently drops the earliest prefix.
        assert!(
            serialized.matches("cache_control").count() <= 4,
            "MiniMax caps a request at four cache breakpoints"
        );
    }

    /// The guard the caution above was protecting: a provider that merely
    /// speaks an Anthropic-shaped wire still 400s on an unknown field.
    #[test]
    fn an_unknown_anthropic_shaped_provider_still_gets_no_cache_control() {
        let mut config = thinking_config();
        config.provider_id = "some-gateway".into();
        config.provider_type = Some("some-gateway".into());
        let messages = [ConversationMessage::user_text("hi", 0)];
        let tools = [tool_schema("file_read")];

        let body = build_anthropic_body(&caching_request(&messages, &tools), &config);
        assert!(!body.to_string().contains("cache_control"));
    }

    #[test]
    fn anthropic_body_sets_all_three_cache_breakpoints() {
        let mut config = thinking_config();
        config.provider_id = "anthropic".into();
        let messages = [ConversationMessage::user_text("hi", 0)];
        let tools = [tool_schema("file_read"), tool_schema("grep")];

        let body = build_anthropic_body(&caching_request(&messages, &tools), &config);

        // Prefix order is tools → system → messages, so a breakpoint on the
        // last tool caches the schema list, one on system caches both, and
        // one on the message tail caches the conversation so far.
        assert_eq!(
            body["tools"][1]["cache_control"],
            json!({"type": "ephemeral"})
        );
        assert!(
            body["tools"][0].get("cache_control").is_none(),
            "only the LAST tool carries the breakpoint"
        );
        assert_eq!(
            body["system"][0]["cache_control"],
            json!({"type": "ephemeral"})
        );
        assert_eq!(body["system"][0]["text"], "You are Aurora Agent.");
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"],
            json!({"type": "ephemeral"})
        );
        // Anthropic permits at most 4 breakpoints; we must stay under it.
        let count = serde_json::to_string(&body)
            .expect("serialize")
            .matches("cache_control")
            .count();
        assert!(count <= 4, "too many cache breakpoints: {count}");
    }

    #[test]
    fn anthropic_tools_can_be_cached_but_disabled_for_internal_calls() {
        let mut config = thinking_config();
        config.provider_id = "anthropic".into();
        let messages = [ConversationMessage::user_text("compact", 0)];
        let tools = [tool_schema("file_read")];
        let mut request = caching_request(&messages, &tools);
        request.tool_choice = crate::agent_runtime::api_client::ToolChoice::None;

        let body = build_anthropic_body(&request, &config);

        assert_eq!(body["tools"].as_array().map(Vec::len), Some(1));
        assert_eq!(body["tool_choice"], json!({ "type": "none" }));
    }

    #[test]
    fn rolling_breakpoint_lands_on_the_last_message() {
        // Every message in a request is already in the transcript exactly
        // as sent, so the last one is stable and the breakpoint belongs on
        // it: the next iteration then reads the whole history from cache and
        // writes only its delta. (The runtime used to end requests with a
        // rebuilt state block, and the breakpoint had to step back over it;
        // there is no such tail any more.)
        let mut config = thinking_config();
        config.provider_id = "anthropic".into();
        let messages = [
            ConversationMessage::user_text("the question", 0),
            ConversationMessage::user_text("a second question", 1),
        ];
        let request = caching_request(&messages, &[]);

        let body = build_anthropic_body(&request, &config);
        assert!(
            body["messages"][0]["content"][0]
                .get("cache_control")
                .is_none(),
            "only the last message carries the rolling breakpoint"
        );
        assert_eq!(
            body["messages"][1]["content"][0]["cache_control"],
            json!({"type": "ephemeral"}),
            "breakpoint anchors on the last message"
        );
    }

    /// `reqwest` sends no `User-Agent` unless one is configured, and a request
    /// with none is refused outright by some gateways before their API ever
    /// sees it. Measured against `messages-beta.api.thegrid.ai` on 2026-08-23:
    /// no header and an empty string both return a bare nginx `403 Forbidden`
    /// HTML page; any non-empty value returns 200.
    ///
    /// That is why the same call worked from curl, PowerShell and Python and
    /// failed only from Aurora — every one of those sends a UA of its own.
    #[test]
    fn every_provider_request_identifies_itself() {
        let mut config = thinking_config();
        config.api_key = "k".into();

        for (label, headers) in [
            (
                "anthropic",
                build_anthropic_headers(&config).expect("headers"),
            ),
            ("openai", build_openai_headers(&config).expect("headers")),
        ] {
            let ua = headers
                .get(reqwest::header::USER_AGENT)
                .unwrap_or_else(|| panic!("{label} sent no User-Agent"))
                .to_str()
                .expect("ascii");
            assert!(!ua.is_empty(), "{label} sent an empty User-Agent");
            assert!(ua.starts_with("Aurora/"), "{label} sent {ua:?}");
        }
    }

    /// OpenCode emailed on 2026-09-03: requests from `Aurora/2.0.0` carried no
    /// `x-opencode-session`, and from 2026-09-06 such requests may error. Every
    /// wire an OpenCode Go model can resolve to must name the conversation, and
    /// the name must be the same on every request of that conversation.
    #[test]
    fn every_opencode_wire_names_its_conversation() {
        for wire in ["opencode-go-chat", "opencode-go-messages", "opencode-go"] {
            let mut config = thinking_config();
            config.provider_type = Some(wire.into());
            config.base_url = "https://opencode.ai/zen/go/v1".into();
            config.api_key = "sk-k".into();

            let mut headers = if wire == "opencode-go-messages" {
                build_anthropic_headers(&config).expect("headers")
            } else {
                build_openai_headers(&config).expect("headers")
            };
            apply_opencode_headers(&mut headers, &config, Some("thread-42")).expect("apply");

            assert_eq!(
                headers
                    .get(OPENCODE_SESSION_HEADER)
                    .and_then(|v| v.to_str().ok()),
                Some("thread-42"),
                "{wire}"
            );
            assert_eq!(
                headers
                    .get(OPENCODE_CLIENT_HEADER)
                    .and_then(|v| v.to_str().ok()),
                Some("aurora"),
                "{wire}"
            );
        }
    }

    /// A row pointed at opencode.ai under a generic type is still their
    /// client, and must still say which conversation it is.
    #[test]
    fn the_opencode_host_is_recognised_under_a_generic_type() {
        let mut config = thinking_config();
        config.provider_type = Some("openai".into());
        config.base_url = "https://opencode.ai/zen/go/v1".into();
        assert!(is_opencode_go(&config));

        let mut headers = build_openai_headers(&config).expect("headers");
        apply_opencode_headers(&mut headers, &config, Some("thread-7")).expect("apply");
        assert!(headers.contains_key(OPENCODE_SESSION_HEADER));
    }

    /// The header is theirs alone: nothing else on an OpenAI-shaped or
    /// Anthropic-shaped wire should start carrying it.
    #[test]
    fn other_providers_do_not_get_opencode_headers() {
        for (wire, base) in [
            ("openai", "https://api.openai.com/v1"),
            ("anthropic", "https://api.anthropic.com/v1"),
            ("kenari-messages", "https://kenari.id/v1"),
            ("custom", "https://example.invalid/v1"),
        ] {
            let mut config = thinking_config();
            config.provider_type = Some(wire.into());
            config.base_url = base.into();
            assert!(!is_opencode_go(&config), "{wire}");

            let mut headers = build_openai_headers(&config).expect("headers");
            apply_opencode_headers(&mut headers, &config, Some("thread-1")).expect("apply");
            assert!(!headers.contains_key(OPENCODE_SESSION_HEADER), "{wire}");
            assert!(!headers.contains_key(OPENCODE_CLIENT_HEADER), "{wire}");
        }
    }

    /// A one-off request (the settings connection test) has no conversation,
    /// and the header must still be present — that is the whole complaint.
    #[test]
    fn a_request_with_no_conversation_still_sends_a_session_id() {
        let mut config = thinking_config();
        config.provider_type = Some("opencode-go-chat".into());

        let mut headers = build_openai_headers(&config).expect("headers");
        apply_opencode_headers(&mut headers, &config, None).expect("apply");
        let value = headers
            .get(OPENCODE_SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
            .expect("session header");
        uuid::Uuid::parse_str(value).expect("a well-formed id");

        // Blank is treated as absent, not sent as an empty header.
        let mut headers = build_openai_headers(&config).expect("headers");
        apply_opencode_headers(&mut headers, &config, Some("   ")).expect("apply");
        assert!(!headers
            .get(OPENCODE_SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .trim()
            .is_empty());
    }

    /// Custom headers keep winning, the same rule as `User-Agent`.
    #[test]
    fn a_custom_opencode_session_header_is_kept() {
        let mut config = thinking_config();
        config.provider_type = Some("opencode-go-chat".into());
        config.custom_headers = Some(
            [(OPENCODE_SESSION_HEADER.to_string(), "mine".to_string())]
                .into_iter()
                .collect(),
        );

        let mut headers = build_openai_headers(&config).expect("headers");
        apply_opencode_headers(&mut headers, &config, Some("thread-1")).expect("apply");
        assert_eq!(
            headers
                .get(OPENCODE_SESSION_HEADER)
                .and_then(|v| v.to_str().ok()),
            Some("mine")
        );
    }

    /// A user who sets their own `User-Agent` must keep it — custom headers are
    /// applied after ours precisely so they win.
    #[test]
    fn a_custom_user_agent_overrides_auroras() {
        let mut config = thinking_config();
        config.api_key = "k".into();
        config.custom_headers = Some(
            [("User-Agent".to_string(), "my-proxy/1.0".to_string())]
                .into_iter()
                .collect(),
        );

        let headers = build_openai_headers(&config).expect("headers");
        assert_eq!(
            headers
                .get(reqwest::header::USER_AGENT)
                .and_then(|v| v.to_str().ok()),
            Some("my-proxy/1.0")
        );
    }

    /// A gateway whose nodes disagree about the output ceiling must not end the
    /// turn on the node that says no.
    ///
    /// Measured against `vectide.cn` on 2026-08-29: eight identical `glm-5.2`
    /// requests at `max_tokens: 131,072` were accepted five times and rejected
    /// three. Classified as `InvalidRequest` the turn stopped after one attempt
    /// (`aurora.log` 07:53:53, "after 1 attempt(s)") on what was a coin flip.
    #[test]
    fn an_output_cap_rejection_is_retried_because_the_answer_is_not_stable() {
        let origin = RequestOrigin {
            url: "https://vectide.cn/v1/chat/completions",
            model: "glm-5.2",
        };
        // Verbatim, including the claim that a positive integer is not one.
        let body = r#"{"error":{"message":"输出长度参数格式错误。max_tokens 或 max_completion_tokens 必须是大于 0 的整数。","type":"invalid_request_error","param":"max_tokens","code":"VectorTide_invalid_max_tokens"}}"#;
        let err = map_status_error_inner(400, body.to_string(), None, origin);
        assert!(
            err.is_retryable(),
            "an unstable output-cap rejection must be re-issued, got {err:?}"
        );

        // The English spelling of the same complaint.
        let english = r#"{"error":{"message":"max_tokens is invalid: must be a positive integer","param":"max_tokens"}}"#;
        assert!(map_status_error_inner(400, english.to_string(), None, origin).is_retryable());
    }

    #[test]
    fn a_generic_parameter_complaint_is_still_a_dead_end() {
        let origin = RequestOrigin {
            url: "https://vectide.cn/v1/chat/completions",
            model: "glm-5.2",
        };
        // The same gateway's OTHER 400 names max_tokens as one suspect among
        // six. That is "something in here is wrong", not a statement about the
        // cap, and re-sending identical bytes cannot make it right.
        let body = r#"{"error":{"message":"请求参数值或格式不受支持。请重点检查 model、temperature、top_p、max_tokens、tools 和 tool_choice；如无法定位，请逐项移除可选参数后重试。","type":"invalid_request_error","param":null,"code":"VectorTide_invalid_request"}}"#;
        let err = map_status_error_inner(400, body.to_string(), None, origin);
        assert!(
            !err.is_retryable(),
            "a scattergun parameter complaint is not an output-cap fault, got {err:?}"
        );
    }

    #[test]
    fn a_context_overflow_that_mentions_the_cap_stays_unretryable() {
        let origin = RequestOrigin {
            url: "https://example.test/v1/chat/completions",
            model: "m-1",
        };
        // `body_names_request_fault` wins outright, as it does for every other
        // branch: an oversized prompt is compaction's job, and three attempts at
        // it is three times the wait for the same dead end.
        let body = r#"{"error":{"message":"This model's maximum context length is 128000 tokens, however you requested 130000 tokens (120000 in the messages, 10000 in max_tokens)","code":"context_length_exceeded"}}"#;
        let err = map_status_error_inner(400, body.to_string(), None, origin);
        assert!(!err.is_retryable(), "got {err:?}");
    }

    #[test]
    fn a_429_keeps_the_wait_the_provider_asked_for() {
        // The one failure where the other side already told us the answer.
        // Discarding it (which is what happened before) means either hammering
        // a provider that asked for a minute, or idling when it asked for two.
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "42".parse().unwrap());

        let origin = RequestOrigin {
            url: "https://example.test/v1/messages",
            model: "some-model",
        };
        match map_status_error_with_headers(429, "slow down".into(), &headers, origin) {
            ApiError::RateLimit { retry_after_secs } => assert_eq!(retry_after_secs, Some(42)),
            other => panic!("expected RateLimit, got {other:?}"),
        }
    }

    #[test]
    fn a_hostile_retry_after_cannot_hang_the_app() {
        // The header is the provider's number, not ours. An app that blocks for
        // an hour because a misconfigured gateway said so looks broken.
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "86400".parse().unwrap());
        assert_eq!(parse_retry_after(&headers), Some(MAX_RETRY_AFTER_SECS));

        // An HTTP-date (RFC 9110's other form) is declined rather than
        // half-parsed — the backoff ladder is a better answer than a wrong one.
        let mut dated = reqwest::header::HeaderMap::new();
        dated.insert(
            reqwest::header::RETRY_AFTER,
            "Wed, 21 Oct 2026 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(parse_retry_after(&dated), None);

        assert_eq!(parse_retry_after(&reqwest::header::HeaderMap::new()), None);
    }

    /// The literal is duplicated in the frontend because the prompt crosses
    /// IPC as an opaque string. If either side is edited alone, the marker
    /// stops matching: Anthropic silently loses its split and every other
    /// provider ships the raw sentinel to the model. Neither fails loudly, so
    /// this test is the only thing standing between them.
    #[test]
    fn the_boundary_literal_matches_the_frontend() {
        let ts = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/apps/agent/services/runtime/agent-prompt.ts"
        ))
        .expect("read agent-prompt.ts");
        assert!(
            ts.contains(&format!(
                "export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = \"{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\""
            )),
            "frontend boundary literal drifted from the Rust one \
             ({SYSTEM_PROMPT_DYNAMIC_BOUNDARY})"
        );
    }

    #[test]
    fn the_cached_system_block_stops_at_the_boundary() {
        let mut config = thinking_config();
        config.provider_id = "anthropic".into();
        let messages = [ConversationMessage::user_text("hi", 0)];
        let tools = [tool_schema("file_read")];
        let prompt = format!(
            "STATIC RULES\n\n{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n# Mode: plan\nMCP: github"
        );
        let mut request = caching_request(&messages, &tools);
        request.system_prompt = Some(&prompt);

        let body = build_anthropic_body(&request, &config);

        // Two blocks, and the breakpoint is on the STATIC one only. A marker
        // at the tail (what this used to do) meant one MCP server connecting
        // re-billed the whole prompt.
        assert_eq!(body["system"][0]["text"], "STATIC RULES");
        assert_eq!(
            body["system"][0]["cache_control"],
            json!({"type": "ephemeral"})
        );
        assert_eq!(body["system"][1]["text"], "# Mode: plan\nMCP: github");
        assert!(
            body["system"][1].get("cache_control").is_none(),
            "the volatile half must never carry a breakpoint"
        );
        // The sentinel is consumed, never shown to the model.
        let serialized = serde_json::to_string(&body).expect("serialize");
        assert!(!serialized.contains(SYSTEM_PROMPT_DYNAMIC_BOUNDARY));
        assert!(
            serialized.matches("cache_control").count() <= 4,
            "Anthropic permits at most 4 breakpoints"
        );
    }

    /// Team prompts, subagent prompts and any caller that builds a prompt by
    /// hand carry no marker. Those must keep the previous single-block shape
    /// rather than losing their breakpoint.
    #[test]
    fn a_prompt_without_the_boundary_still_gets_one_cached_block() {
        let mut config = thinking_config();
        config.provider_id = "anthropic".into();
        let messages = [ConversationMessage::user_text("hi", 0)];
        let tools = [tool_schema("file_read")];

        let body = build_anthropic_body(&caching_request(&messages, &tools), &config);

        assert_eq!(body["system"][0]["text"], "You are Aurora Agent.");
        assert_eq!(
            body["system"][0]["cache_control"],
            json!({"type": "ephemeral"})
        );
        assert!(body["system"].get(1).is_none(), "no second block to emit");
    }

    /// Chat-completions has no breakpoint to place, so the marker is removed.
    /// Leaving it in would put a bare sentinel token in the system message.
    #[test]
    fn chat_completions_strips_the_boundary_instead_of_shipping_it() {
        let prompt = format!("STATIC RULES\n\n{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n# Mode: plan");
        let messages = [ConversationMessage::user_text("hi", 0)];
        let tools: [ToolSchema; 0] = [];
        let mut request = caching_request(&messages, &tools);
        request.system_prompt = Some(&prompt);

        let out = openai_messages(&request, false, "openai", "", None);

        assert_eq!(out[0]["content"], "STATIC RULES\n\n# Mode: plan");
    }

    #[test]
    fn splitting_a_prompt_whose_dynamic_half_is_empty_yields_no_second_block() {
        // `agent-prompt.ts` omits the marker when nothing dynamic exists, but a
        // trailing marker must not produce an empty text block — Anthropic 400s
        // on those.
        let prompt = format!("STATIC RULES\n\n{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n   ");
        let (head, tail) = split_system_boundary(&prompt);
        assert_eq!(head, "STATIC RULES");
        assert!(tail.is_none());
        assert_eq!(strip_system_boundary(&prompt), "STATIC RULES");
    }

    #[test]
    fn non_anthropic_providers_get_no_cache_control_at_all() {
        // MiniMax used to be in this list, on the assumption that it "has never
        // seen `cache_control`". Measured against the live endpoint on
        // 2026-09-09, it has: a write of 1,582 tokens followed by a read of the
        // same 1,582. The assumption was never tested, and it was costing 20x
        // on the cached half of every turn. It now has its own test above.
        //
        // The rule this still guards is real: an unknown field is how Aurora
        // has been 400'd before, so a provider joins the caching list only
        // after somebody watches it cache.
        for provider in ["custom", "glm"] {
            let mut config = thinking_config();
            config.provider_id = provider.into();
            let messages = [ConversationMessage::user_text("hi", 0)];
            let tools = [tool_schema("file_read")];

            let body = build_anthropic_body(&caching_request(&messages, &tools), &config);
            let serialized = serde_json::to_string(&body).expect("serialize");
            assert!(
                !serialized.contains("cache_control"),
                "{provider} must not receive cache_control"
            );
            // …and the system prompt keeps its plain-string shape.
            assert_eq!(body["system"], json!("You are Aurora Agent."));
        }
    }

    #[test]
    fn cache_breakpoint_lands_on_the_last_block_of_a_multi_block_tail() {
        let mut config = thinking_config();
        config.provider_id = "Anthropic".into(); // case-insensitive match
        let messages = [
            ConversationMessage::user_text("first", 0),
            ConversationMessage::assistant(
                vec![ContentBlock::ToolUse {
                    id: "call-1".into(),
                    name: "grep".into(),
                    input: json!({"query": "x"}),
                }],
                1,
            ),
            ConversationMessage {
                role: MessageRole::Tool,
                blocks: vec![
                    ContentBlock::ToolResult {
                        tool_use_id: "call-1".into(),
                        content: "hit".into(),
                        is_error: None,
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "call-2".into(),
                        content: "hit2".into(),
                        is_error: None,
                    },
                ],
                usage: None,
                timestamp: 2,
                attached_selected_elements: None,
                attached_prompt_chips: None,
                aurora_context: None,
                model: None,
            },
        ];

        let body = build_anthropic_body(&caching_request(&messages, &[]), &config);
        let tail = body["messages"]
            .as_array()
            .expect("messages")
            .last()
            .cloned()
            .expect("tail");
        let blocks = tail["content"].as_array().expect("blocks");
        assert!(blocks[0].get("cache_control").is_none());
        assert_eq!(
            blocks[blocks.len() - 1]["cache_control"],
            json!({"type": "ephemeral"}),
            "the breakpoint must sit on the LAST block so the whole tail is cached"
        );
    }

    #[test]
    fn openai_body_carries_budget_only_when_explicitly_set() {
        let config = thinking_config();
        let messages = [ConversationMessage::user_text("hi", 0)];

        let mut request = ApiRequest {
            model: "custom:some-reasoner",
            system_prompt: None,
            messages: &messages,
            tools: &[],
            tool_choice: Default::default(),
            temperature: None,
            max_output_tokens: 32_000,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest {
                enabled: true,
                control: ReasoningControl::Toggle,
                ..crate::agent_runtime::api_client::ReasoningRequest::disabled()
            },
            tool_bridge: None,
            session_key: None,        };
        let body = build_openai_body(&request, &config);
        assert_eq!(body["thinking"], json!({ "type": "enabled" }));

        request.reasoning.budget_tokens = Some(12_000);
        let body = build_openai_body(&request, &config);
        assert_eq!(
            body["thinking"],
            json!({ "type": "enabled", "budget_tokens": 12_000 })
        );

        // Thinking off ⇒ no `thinking` key at all, budget or not.
        request.reasoning.enabled = false;
        let body = build_openai_body(&request, &config);
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn canonical_effort_uses_the_chat_completions_effort_field() {
        let config = thinking_config();
        let messages = [ConversationMessage::user_text("hi", 0)];
        let request = ApiRequest {
            model: "custom:reasoner",
            system_prompt: None,
            messages: &messages,
            tools: &[],
            tool_choice: Default::default(),
            temperature: None,
            max_output_tokens: 32_000,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest {
                enabled: true,
                control: ReasoningControl::Effort,
                effort: Some("xhigh"),
                request_mode: ReasoningRequestMode::OpenaiEffort,
                ..crate::agent_runtime::api_client::ReasoningRequest::disabled()
            },
            tool_bridge: None,
            session_key: None,        };

        let body = build_openai_body(&request, &config);

        assert_eq!(body["reasoning_effort"], "xhigh");
        assert!(
            body.get("thinking").is_none(),
            "one semantic request must not become two competing wire controls"
        );
    }

    /// The chat wire had no way to say "this is the same conversation", so a
    /// gateway was free to route each request to a different cache node and
    /// re-bill the whole thread. Measured on real sessions before the fix:
    /// 26–78% cache reads with mid-turn collapses to zero, against 99% on the
    /// Responses wire, which has always sent this field.
    #[test]
    fn prompt_cache_key_rides_the_chat_wire_for_generic_gateways() {
        let mut config = thinking_config();
        config.provider_type = Some("openai".into());
        let messages = [ConversationMessage::user_text("hi", 0)];
        let mut request = caching_request(&messages, &[]);
        request.model = "glm-5.3";
        request.session_key = Some("7414d198-da34-4ebf-a7b3-2acbdf0c40db");

        let body = build_openai_body(&request, &config);

        assert_eq!(
            body["prompt_cache_key"],
            "7414d198-da34-4ebf-a7b3-2acbdf0c40db"
        );
    }

    /// Three ways it must stay off the wire. An unknown body field is an HTTP
    /// 400 on a strict backend, and an empty key is worse than none — it would
    /// route every conversation in the app onto one node.
    #[test]
    fn prompt_cache_key_is_withheld_where_it_could_break_the_request() {
        let messages = [ConversationMessage::user_text("hi", 0)];

        // 1. A provider type outside the allowlist, even with a key to send.
        let mut strict = thinking_config();
        strict.provider_type = Some("fireworks".into());
        let mut request = caching_request(&messages, &[]);
        request.session_key = Some("thread-1");
        assert!(build_openai_body(&request, &strict)
            .get("prompt_cache_key")
            .is_none());

        // 2. No conversation identity (a one-off request).
        let mut generic = thinking_config();
        generic.provider_type = Some("openai".into());
        let mut anonymous = caching_request(&messages, &[]);
        anonymous.session_key = None;
        assert!(build_openai_body(&anonymous, &generic)
            .get("prompt_cache_key")
            .is_none());

        // 3. An empty key would pool every thread onto one node.
        let mut blank = caching_request(&messages, &[]);
        blank.session_key = Some("");
        assert!(build_openai_body(&blank, &generic)
            .get("prompt_cache_key")
            .is_none());
    }

    /// The endpoint gets the last word, because the provider type cannot have
    /// it: probed 2026-08-30 with Aurora's own body, `us-api.x5m5x.com`
    /// answered 200 with the field on all five models and `vectide.cn`
    /// answered 400 — both rows typed `openai`. Vectide's body is reproduced
    /// verbatim here, and note what it does NOT contain: the name of the field
    /// it is rejecting.
    #[test]
    fn an_endpoint_that_rejects_the_cache_key_teaches_us_once_and_is_retried() {
        const HOST: &str = "https://cache-key-refuser.example/v1";
        const MODEL: &str = "glm-5.3";
        let mut config = thinking_config();
        config.provider_type = Some("openai".into());
        config.base_url = HOST.into();
        let messages = [ConversationMessage::user_text("hi", 0)];
        let mut request = caching_request(&messages, &[]);
        request.model = MODEL;
        request.session_key = Some("thread-1");

        // First request carries it.
        assert_eq!(build_openai_body(&request, &config)["prompt_cache_key"], "thread-1");
        assert!(prompt_cache_key_was_sent(HOST, MODEL));

        // Vectide's actual 400, verbatim — generic, and never names the field.
        let body = r#"{"error":{"message":"请求参数值或格式不受支持。请重点检查 model、temperature、top_p、max_tokens、tools 和 tool_choice；如无法定位，请逐项移除可选参数后重试。","type":"invalid_request_error","param":null,"code":"VectorTide_invalid_request"}}"#;
        let err = map_status_error_inner(
            400,
            body.to_string(),
            None,
            RequestOrigin {
                url: HOST,
                model: MODEL,
            },
        );
        assert!(
            matches!(err, ApiError::PromptCacheKeyRefused),
            "got {err:?} — an unexplained 400 from an endpoint we just sent the field to \
             must become the retryable refusal, not a turn-ending InvalidRequest"
        );
        assert!(
            err.is_retryable(),
            "the rebuilt request differs from the one that failed, so it is worth re-issuing"
        );

        // Learned: the next body for this endpoint goes out clean, and stays
        // clean for the rest of the run.
        let retried = build_openai_body(&request, &config);
        assert!(retried.get("prompt_cache_key").is_none());
        assert!(build_openai_body(&request, &config)
            .get("prompt_cache_key")
            .is_none());
    }

    /// The trigger has to stay narrow in both directions, or it turns real
    /// faults into a wasted extra attempt and hides what actually went wrong.
    #[test]
    fn only_a_parameter_fault_from_a_key_carrying_endpoint_is_blamed_on_the_key() {
        const HOST: &str = "https://cache-key-innocent.example/v1";
        const MODEL: &str = "glm-5.2";
        let mut config = thinking_config();
        config.provider_type = Some("openai".into());
        config.base_url = HOST.into();
        let messages = [ConversationMessage::user_text("hi", 0)];
        let mut request = caching_request(&messages, &[]);
        request.model = MODEL;
        request.session_key = Some("thread-1");
        let _ = build_openai_body(&request, &config);

        // A conversation that outgrew the window is compaction's problem, not
        // the cache key's — blaming the key here would drop it for good AND
        // spend an attempt on an identically oversized body.
        let overflow = map_status_error_inner(
            400,
            r#"{"error":{"message":"This model's maximum context length is 131072 tokens","type":"invalid_request_error"}}"#.to_string(),
            None,
            RequestOrigin { url: HOST, model: MODEL },
        );
        assert!(!matches!(overflow, ApiError::PromptCacheKeyRefused), "{overflow:?}");
        assert!(!prompt_cache_key_refused(HOST, MODEL));

        // And an endpoint that never received the field is never blamed: the
        // retry would be byte-identical, which is the one thing it must not be.
        let elsewhere = map_status_error_inner(
            400,
            r#"{"error":{"message":"Unsupported parameter: top_k"}}"#.to_string(),
            None,
            RequestOrigin {
                url: "https://never-sent-the-key.example/v1",
                model: "m-1",
            },
        );
        assert!(!matches!(elsewhere, ApiError::PromptCacheKeyRefused), "{elsewhere:?}");
    }

    /// The escape hatch has to keep working: `custom_params` is applied after
    /// the affinity key, so a gateway wanting a different value still wins.
    #[test]
    fn custom_params_can_override_the_prompt_cache_key() {
        let mut config = thinking_config();
        config.provider_type = Some("openai".into());
        config.custom_params = Some(std::collections::HashMap::from([(
            "prompt_cache_key".to_string(),
            json!("my-own-routing-key"),
        )]));
        let messages = [ConversationMessage::user_text("hi", 0)];
        let mut request = caching_request(&messages, &[]);
        request.session_key = Some("thread-1");

        let body = build_openai_body(&request, &config);

        assert_eq!(body["prompt_cache_key"], "my-own-routing-key");
    }

    #[test]
    fn explicit_adaptive_mode_handles_an_unrecognised_messages_model() {
        let mut config = thinking_config();
        config.provider_id = "gateway".into();
        let messages = [ConversationMessage::user_text("hi", 0)];
        let mut request = caching_request(&messages, &[]);
        request.model = "gateway:model-without-a-claude-name";
        request.temperature = Some(0.4);
        request.reasoning = crate::agent_runtime::api_client::ReasoningRequest {
            enabled: true,
            control: ReasoningControl::Effort,
            effort: Some("max"),
            request_mode: ReasoningRequestMode::AnthropicAdaptive,
            ..crate::agent_runtime::api_client::ReasoningRequest::disabled()
        };

        let body = build_anthropic_body(&request, &config);

        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["thinking"]["display"], "summarized");
        assert_eq!(body["output_config"]["effort"], "max");
        assert!(body["thinking"].get("budget_tokens").is_none());
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn explicit_budget_mode_handles_an_unrecognised_messages_model() {
        let mut config = thinking_config();
        config.provider_id = "gateway".into();
        let messages = [ConversationMessage::user_text("hi", 0)];
        let mut request = caching_request(&messages, &[]);
        request.model = "gateway:model-without-a-claude-name";
        request.reasoning = crate::agent_runtime::api_client::ReasoningRequest {
            enabled: true,
            control: ReasoningControl::Budget,
            budget_tokens: Some(4_000),
            request_mode: ReasoningRequestMode::AnthropicBudget,
            ..crate::agent_runtime::api_client::ReasoningRequest::disabled()
        };

        let body = build_anthropic_body(&request, &config);

        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 4_000);
        assert!(body.get("output_config").is_none());
    }

    #[test]
    fn parse_tool_input_handles_empty_and_invalid() {
        // A zero-argument call is legitimate and stays an empty object.
        assert_eq!(parse_tool_input(""), json!({}));
        assert_eq!(parse_tool_input("   "), json!({}));
        assert_eq!(parse_tool_input(r#"{"a":1}"#), json!({"a": 1}));
    }

    #[test]
    fn parse_tool_input_preserves_raw_text_when_arguments_do_not_parse() {
        // This used to yield `{}`, which made the executor report a missing
        // field to a model that had sent it. The raw text must survive so
        // the dispatcher can say what actually arrived.
        assert_eq!(parse_tool_input("not json"), json!("not json"));

        // The realistic case: an output cap cutting a call mid-value.
        let cut = r#"{"path":"src/main.rs","content":"fn main() {"#;
        assert_eq!(parse_tool_input(cut), json!(cut));
    }

    /// The exact payloads GLM-5.2 put on the wire on 2026-08-21, thread
    /// `d6899565`, copied out of the session file rather than imagined. Five
    /// `file_read` calls in one turn, every one of them one missing pair of
    /// quotes, and the model never recovered.
    #[test]
    fn parse_tool_input_repairs_the_value_a_model_forgot_to_quote() {
        assert_eq!(
            parse_tool_input(r#"{"path": README.md}"#),
            json!({"path": "README.md"})
        );
        // Same call, with a Windows path: the quotes are missing AND the
        // backslashes are unescaped. Both are fixed in one pass.
        assert_eq!(
            parse_tool_input(r#"{"path": E:\sub2api\README.md}"#),
            json!({"path": "E:\\sub2api\\README.md"})
        );
        // A relative path with backslashes — no drive letter, so the older
        // path pass never saw it.
        assert_eq!(
            parse_tool_input(r#"{"path": .\src\main.rs}"#),
            json!({"path": ".\\src\\main.rs"})
        );
        // Already-escaped backslashes inside a bare token are left alone.
        // Doubling them again would hand back a path that does not exist.
        assert_eq!(
            parse_tool_input(r#"{"path": C:\\ws\\a.rs}"#),
            json!({"path": "C:\\ws\\a.rs"})
        );
        // Other positions a value can sit in.
        assert_eq!(
            parse_tool_input(r#"{"path": [README.md, src/a.ts]}"#),
            json!({"path": ["README.md", "src/a.ts"]})
        );
        assert_eq!(
            parse_tool_input(r#"{"op": definition, "name": run_turn}"#),
            json!({"op": "definition", "name": "run_turn"})
        );
    }

    /// The repair must not invent a type. A bare token is handed to serde on
    /// its own first, so anything that is genuinely a number, a boolean or
    /// null survives as one.
    #[test]
    fn the_repair_never_turns_a_real_scalar_into_a_string() {
        // These parse on their own, so they never reach the repair at all.
        assert_eq!(
            parse_tool_input(r#"{"deep": true, "n": -1.5e3, "x": null}"#),
            json!({"deep": true, "n": -1.5e3, "x": null})
        );
        // …and when something else in the payload forces the repair to run,
        // the real scalars beside it still come through untouched.
        assert_eq!(
            parse_tool_input(r#"{"recursive": true, "limit": 20, "path": src/lib}"#),
            json!({"recursive": true, "limit": 20, "path": "src/lib"})
        );
        // A token that merely STARTS like a literal is not one.
        assert_eq!(
            parse_tool_input(r#"{"mode": truthy}"#),
            json!({"mode": "truthy"})
        );
        assert_eq!(parse_tool_input(r#"{"v": 12abc}"#), json!({"v": "12abc"}));
    }

    /// What the repair must NOT do. Each of these used to be a way for a
    /// recovery pass to turn a broken call into a wrong one, which is worse:
    /// a broken call is reported, a wrong call is executed.
    #[test]
    fn the_repair_declines_the_cases_it_cannot_be_sure_about() {
        // Truncated by the output cap. There is no value to quote, and the
        // error message's "cut off mid-value" advice is the right answer.
        assert_eq!(parse_tool_input(r#"{"path": "#), json!(r#"{"path": "#));
        // A bare token with a comma in it. Guessing where it ends would
        // produce arguments the model never wrote.
        let ambiguous = r#"{"a": hello, world}"#;
        assert_eq!(parse_tool_input(ambiguous), json!(ambiguous));
        // Valid JSON is never rewritten — the repair is not even reached.
        let valid = r#"{"content":"a line\nwith C:\\ws in it"}"#;
        assert_eq!(
            parse_tool_input(valid),
            json!({"content": "a line\nwith C:\\ws in it"})
        );
        // Not JSON at all in any recoverable sense.
        assert_eq!(parse_tool_input("not json"), json!("not json"));
    }

    #[test]
    fn parse_tool_input_rejects_valid_json_that_is_not_an_object() {
        // Parses fine, but no tool schema accepts it — route it through the
        // same malformed path rather than letting an executor misreport it.
        assert_eq!(parse_tool_input("[1,2]"), json!("[1,2]"));
        assert_eq!(parse_tool_input("\"bare\""), json!("\"bare\""));
    }

    #[test]
    fn malformed_tool_input_decodes_what_parse_tool_input_encoded() {
        assert_eq!(malformed_tool_input(&json!({"path": "a.rs"})), None);
        assert_eq!(malformed_tool_input(&json!({})), None);
        assert_eq!(
            malformed_tool_input(&parse_tool_input("not json")),
            Some("not json")
        );
    }

    #[test]
    fn tool_input_for_wire_sanitizes_malformed_input() {
        // History must stay well-formed: providers reject a non-object
        // `tool_use.input` and would fail every subsequent turn, not just
        // the one that was malformed.
        assert_eq!(tool_input_for_wire(&json!("truncated…")), json!({}));
        assert_eq!(
            tool_input_for_wire(&json!({"path": "a.rs"})),
            json!({"path": "a.rs"})
        );
    }

    #[test]
    fn parse_tool_input_repairs_unescaped_windows_path() {
        let raw = r#"{"path":"C:\ws\dev\project\repo\src\main\index.ts"}"#;
        assert_eq!(
            parse_tool_input(raw),
            json!({"path": r"C:\ws\dev\project\repo\src\main\index.ts"})
        );
    }

    #[test]
    fn parse_tool_input_repairs_windows_paths_array() {
        let raw =
            r#"{"paths":["C:\ws\dev\long\repo\src\main\index.ts","E:\rust\new\tests\read.rs"]}"#;
        assert_eq!(
            parse_tool_input(raw),
            json!({
                "paths": [
                    r"C:\ws\dev\long\repo\src\main\index.ts",
                    r"E:\rust\new\tests\read.rs"
                ]
            })
        );
    }

    /// A long text VALUE that merely BEGINS with a drive path is not a path.
    ///
    /// Observed live: a `file_write` whose report started with the absolute
    /// workspace path was rejected as malformed and never executed — twice, and
    /// it would have failed on every retry, because the corruption is
    /// deterministic. The scan matched `"C:\` at the head of `content` and then
    /// treated the whole document as a path, doubling every `\n` and breaking
    /// the string at the first `\"`.
    #[test]
    fn a_text_value_beginning_with_a_drive_path_is_not_mangled() {
        // What the model actually sends: correctly escaped JSON whose `content`
        // opens with a Windows path and later contains an escaped quote.
        let raw = concat!(
            r#"{"path":"REPORT.md","content":"C:\\ws\\repo\n"#,
            r#"\n# Analysis\n\nThe \"type\": \"module\" field matters.\n"}"#
        );

        // Precondition: the payload the model sent is valid JSON.
        serde_json::from_str::<Value>(raw).expect("the model's own payload parses");

        let parsed = parse_tool_input(raw);
        assert!(
            parsed.is_object(),
            "a valid file_write payload must not be reported as malformed: {parsed}"
        );
        assert_eq!(
            parsed["content"],
            "C:\\ws\\repo\n\n# Analysis\n\nThe \"type\": \"module\" field matters.\n",
            "content must survive byte for byte — real newlines, not literal backslash-n"
        );
    }

    /// The same shape, but with the unescaped path the repair pass exists for.
    /// Recovery may fix the `path` field; it must still not walk the multi-line
    /// `content` as though that were a path.
    #[test]
    fn recovery_repairs_a_path_field_without_walking_a_multiline_value() {
        let raw = concat!(
            r#"{"path":"C:\ws\repo\out.md","content":"C:\\ws\\repo\n"#,
            r#"\nsecond line\n"}"#
        );
        let parsed = parse_tool_input(raw);
        assert!(parsed.is_object(), "expected recovery to succeed: {parsed}");
        assert_eq!(parsed["path"], r"C:\ws\repo\out.md");
        assert_eq!(parsed["content"], "C:\\ws\\repo\n\nsecond line\n");
    }

    #[test]
    fn parse_tool_input_preserves_escaped_windows_paths_and_other_escapes() {
        let raw =
            r#"{"paths":["C:\\ws\\dev\\repo\\src\\main\\index.ts"],"content":"first\nsecond"}"#;
        assert_eq!(
            parse_tool_input(raw),
            json!({
                "paths": [r"C:\ws\dev\repo\src\main\index.ts"],
                "content": "first\nsecond"
            })
        );
    }
}
