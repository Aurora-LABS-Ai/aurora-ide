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

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::agent_runtime::api_client::{ApiError, ApiRequest, ToolSchema};
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
pub fn map_status_error(status: u16, body: String) -> ApiError {
    let summary = summarize_body(&body);
    let message = if summary.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {summary}")
    };
    match status {
        401 => ApiError::Unauthorized,
        429 => ApiError::RateLimit,
        500..=599 => ApiError::Provider(message),
        _ => ApiError::InvalidRequest(message),
    }
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
        if let Some(msg) = self.message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
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
        self.message.as_deref().is_some_and(|m| !m.trim().is_empty())
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

#[derive(Debug, Deserialize)]
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
    /// correct. Returns `None` (not `Some(0)`) when there is no cache hit.
    #[must_use]
    pub fn cache_read_tokens(&self) -> Option<u32> {
        self.prompt_cache_hit_tokens
            .or_else(|| {
                self.prompt_tokens_details
                    .as_ref()
                    .and_then(|d| d.cached_tokens)
            })
            .filter(|&n| n > 0)
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
    let temperature = request
        .temperature
        .or(config.default_temperature)
        .unwrap_or(1.0);

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
    body.insert("temperature".to_string(), Value::from(temperature));

    if let Some(system_prompt) = system {
        if !system_prompt.is_empty() {
            // Caching needs the block form; the plain-string form has
            // nowhere to hang `cache_control`.
            body.insert(
                "system".to_string(),
                if caching {
                    json!([{
                        "type": "text",
                        "text": system_prompt,
                        "cache_control": { "type": "ephemeral" },
                    }])
                } else {
                    Value::String(system_prompt)
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
    }

    // Reasoning. Two frontend paths land here and BOTH must produce a `thinking`
    // block, because Anthropic's `/v1/messages` has no `reasoning_effort` field:
    //
    //  * toggle/budget models  → `request.thinking_enabled`
    //  * effort models         → the frontend sets `thinking_enabled = false` and
    //    injects an OpenAI-shaped `reasoning_effort` into `custom_params` instead
    //    (see `useAgentWindowSend`). Forwarding that key verbatim to Anthropic is
    //    a silent no-op — the request succeeds and simply returns no reasoning.
    //    Translate it into a real thinking budget and drop the foreign key.
    let effort = config
        .custom_params
        .as_ref()
        .and_then(|p| p.get("reasoning_effort"))
        .and_then(|v| v.as_str())
        .map(str::to_ascii_lowercase);

    let wants_thinking = (request.thinking_enabled && config.supports_thinking) || effort.is_some();

    let thinking_on = if wants_thinking {
        match anthropic_thinking_plan(
            request.thinking_budget_tokens,
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
    };

    // Extended thinking requires `temperature = 1`; any other value is a 400 on
    // Anthropic proper. Drop it rather than fight the user's provider default.
    if thinking_on {
        body.remove("temperature");
    }

    if let Some(custom) = &config.custom_params {
        for (key, value) in custom {
            // Never forward `reasoning_effort` — it is not an Anthropic field and
            // was already translated into `thinking` above.
            if key.eq_ignore_ascii_case("reasoning_effort") {
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

/// Whether this provider understands Anthropic's `cache_control` markers.
///
/// Deliberately narrow. `cache_control` is an unknown field to everything
/// that merely speaks an Anthropic-shaped wire format, and an unknown field
/// is how Aurora has been bitten before (the `oneOf` 400s on xAI, the
/// `budget_tokens` handling on compat proxies). MiniMax rides the same
/// adapter and is NOT on this list.
///
/// The cost of a false negative is the status quo — full price, no cache.
/// The cost of a false positive is every request failing with HTTP 400, so
/// this errs hard toward off.
fn supports_prompt_caching(config: &ProviderConfigSnapshot) -> bool {
    config
        .effective_provider_type()
        .eq_ignore_ascii_case("anthropic")
}

/// Attach an ephemeral `cache_control` marker to a JSON object in place.
/// Non-objects are left alone rather than silently coerced.
fn set_cache_control(block: &mut Value) {
    if let Some(obj) = block.as_object_mut() {
        obj.insert("cache_control".to_string(), json!({ "type": "ephemeral" }));
    }
}

/// Put a cache breakpoint on the final content block of the final message.
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
            ContentBlock::Thinking { text, signature } => {
                let mut obj = json!({
                    "type": "thinking",
                    "thinking": text,
                });
                if let Some(sig) = signature {
                    obj["signature"] = Value::String(sig.clone());
                }
                arr.push(obj);
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
                // `browser_screenshot`) and rewrite the tool_result
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
        }
    }
    Value::Array(arr)
}

/// Aurora's `browser_screenshot` tool returns its base64 PNG inside an
/// `<aurora_image media_type="image/png">BASE64</aurora_image>` marker.
/// For Anthropic the marker is split out into a real `image` content
/// block so the model literally sees the screenshot; the surrounding
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
/// Markers without a valid `media_type` attribute or with an empty
/// payload are kept as plain text — defensive against malformed
/// output. Capped at 8 images per result.
pub(crate) fn split_aurora_images(content: &str) -> Vec<AuroraImagePiece> {
    const MAX_IMAGES: usize = 8;
    let mut pieces: Vec<AuroraImagePiece> = Vec::new();
    let mut images_emitted = 0usize;
    let mut cursor = 0usize;

    while cursor < content.len() && images_emitted < MAX_IMAGES {
        let rest = &content[cursor..];
        let Some(open) = rest.find("<aurora_image ") else {
            break;
        };
        let absolute_open = cursor + open;
        let Some(close_attr) = content[absolute_open..].find('>') else {
            break;
        };
        let header_end = absolute_open + close_attr + 1;
        let header = &content[absolute_open..header_end];
        let Some(end_tag) = content[header_end..].find("</aurora_image>") else {
            break;
        };
        let payload_end = header_end + end_tag;
        let body = &content[header_end..payload_end];

        let media_type = extract_attr(header, "media_type").unwrap_or_else(|| "image/png".into());
        if absolute_open > cursor {
            let leading = content[cursor..absolute_open].trim_matches(['\n', '\r']);
            if !leading.is_empty() {
                pieces.push(AuroraImagePiece::Text(leading.to_string()));
            }
        }
        if !body.trim().is_empty() {
            // Inline base64 (legacy threads, or a capture whose on-disk save
            // failed so the body carries the bytes directly).
            pieces.push(AuroraImagePiece::Image {
                media_type,
                base64: body.trim().to_string(),
            });
            images_emitted += 1;
        } else if let Some(base64) = rehydrate_image_from_src(header) {
            // Lean marker: the base64 was stripped from history to keep the JSONL
            // small; the PNG lives on disk (referenced by `src`). Re-read it now.
            pieces.push(AuroraImagePiece::Image { media_type, base64 });
            images_emitted += 1;
        }
        // else: empty body + unreadable/absent `src` (e.g. pruned screenshot) →
        // drop the image; the caption text is still emitted so context stays
        // coherent and the model isn't handed a broken reference.
        cursor = payload_end + "</aurora_image>".len();
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

/// Rehydrate a screenshot's base64 from the on-disk PNG referenced by the
/// `<aurora_image src="…">` header. The persisted/model-history copy stores the
/// path, not the bytes (small JSONL, no re-uploading base64 every turn); this
/// reads the file back at request-build time. Returns `None` when there's no
/// `src` or the file can't be read (e.g. it was pruned) — the caller then keeps
/// only the caption text.
fn rehydrate_image_from_src(header: &str) -> Option<String> {
    use base64::Engine;
    let src = extract_attr(header, "src")?;
    // The value was minimally XML-escaped when written into the attribute.
    let path = src.replace("&quot;", "\"").replace("&amp;", "&");
    let bytes = std::fs::read(&path).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Find `name="value"` in an open tag. Whitespace-tolerant; returns
/// the value without quotes. Only matches double-quoted values to
/// keep the parser dumb (the tool always emits double quotes).
fn extract_attr(header: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let start = header.find(&needle)? + needle.len();
    let rest = &header[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
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
                out.push_str(&format!(
                    "[Screenshot omitted: {media_type} image — current provider does not accept images in tool results]"
                ));
            }
        }
    }
    out
}

/// Build the JSON body for an OpenAI-compatible `/chat/completions`
/// streaming call.
pub fn build_openai_body(request: &ApiRequest<'_>, config: &ProviderConfigSnapshot) -> Value {
    let model = unprefix_model(request.model, &config.provider_id);
    let max_tokens = request.max_output_tokens.max(1);
    let temperature = request
        .temperature
        .or(config.default_temperature)
        .unwrap_or(1.0);

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model.to_string()));
    body.insert(
        "messages".to_string(),
        Value::Array(openai_messages(
            request,
            config.supports_vision,
            config.effective_provider_type(),
        )),
    );
    body.insert("stream".to_string(), Value::Bool(true));
    body.insert("max_tokens".to_string(), Value::from(max_tokens));
    body.insert("temperature".to_string(), Value::from(temperature));

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
        body.insert("tool_choice".to_string(), Value::String("auto".to_string()));
    }

    if request.thinking_enabled && config.supports_thinking {
        // `budget_tokens` rides along ONLY when the user explicitly picked one.
        // Anthropic-behind-an-OpenAI-compat-proxy honours it; most other compat
        // backends have never seen the key and some reject unknown fields with
        // HTTP 400, so the default stays the bare enable flag we've always sent.
        match request.thinking_budget_tokens.filter(|b| *b > 0) {
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

    if let Some(custom) = &config.custom_params {
        for (key, value) in custom {
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

/// Which key (if any) a given provider expects for replayed
/// reasoning. OpenAI-compat is a tribe, not a spec — Fireworks
/// rejects unknown fields with HTTP 400, so we cannot just spray
/// both keys at every backend.
///
/// Returns `Some("reasoning_content")`, `Some("reasoning")`, or
/// `None` (= drop reasoning entirely from outgoing messages).
fn reasoning_field_for(provider_type: &str) -> Option<&'static str> {
    match provider_type.to_ascii_lowercase().as_str() {
        // DeepSeek + GLM thinking-mode models *require* the original
        // `reasoning_content` to be replayed or the API returns 400.
        "deepseek" | "glm" | "zhipu" | "z-ai" | "zai" => Some("reasoning_content"),
        // OpenRouter and LM Studio surface the legacy `reasoning` key.
        // Including it is safe; omitting it is also safe (the model
        // just re-thinks). Match real behaviour and emit it.
        "openrouter" | "lmstudio" | "lm-studio" => Some("reasoning"),
        // Fireworks, OpenAI proper, MiniMax, Ollama, "custom" and
        // everyone else: NEVER include reasoning fields. Fireworks in
        // particular validates schema strictly and rejects the request
        // with "Extra inputs are not permitted, field: …".
        _ => None,
    }
}

fn openai_messages(
    request: &ApiRequest<'_>,
    supports_vision: bool,
    provider_type: &str,
) -> Vec<Value> {
    let mut output: Vec<Value> = Vec::new();

    if let Some(prompt) = request.system_prompt {
        if !prompt.is_empty() {
            output.push(json!({
                "role": "system",
                "content": prompt,
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
                    if let Some(key) = reasoning_field_for(provider_type) {
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
                // text the human queued.
                if pending_images.is_empty() {
                    if !injected_text.is_empty() {
                        output.push(json!({ "role": "user", "content": injected_text }));
                    }
                } else {
                    let mut parts = pending_images;
                    if !injected_text.is_empty() {
                        parts.push(json!({ "type": "text", "text": injected_text }));
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

pub fn build_anthropic_headers(
    config: &ProviderConfigSnapshot,
) -> Result<reqwest::header::HeaderMap, ApiError> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    insert_header(&mut headers, "anthropic-version", "2023-06-01")?;
    if !config.api_key.is_empty() {
        insert_header(&mut headers, "x-api-key", &config.api_key)?;
    }
    if let Some(custom) = &config.custom_headers {
        for (key, value) in custom {
            insert_header_owned(&mut headers, key, value)?;
        }
    }
    let _ = HeaderName::from_static("accept"); // satisfy dead_code lint variants
    Ok(headers)
}

pub fn build_openai_headers(
    config: &ProviderConfigSnapshot,
) -> Result<reqwest::header::HeaderMap, ApiError> {
    use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
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
    },
    ToolUse {
        id: String,
        name: String,
        raw_input: String,
    },
}

impl BlockState {
    pub fn into_content_block(self) -> ContentBlock {
        match self {
            BlockState::Text { text } => ContentBlock::Text { text },
            BlockState::Thinking { text, signature } => ContentBlock::Thinking { text, signature },
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
    let normalized = normalize_absolute_windows_paths(raw);
    match serde_json::from_str::<Value>(&normalized) {
        Ok(value) if value.is_object() => value,
        // A parsed-but-not-object payload (a bare array, a quoted string)
        // is just as unusable as a parse failure — carry the raw text
        // through the same path rather than handing an executor a shape
        // it will misreport.
        _ => Value::String(raw.to_string()),
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
            && bytes[index + 3] == b'\\';

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

    /// A tool result carrying a screenshot must move the image off the
    /// `role: "tool"` entry, because whether that entry delivers an image is
    /// provider-specific and fails silently. Measured: a6api dropped it for
    /// both `claude-opus-5` and `gpt-5.6-luna` (model replied `NO_IMAGE`,
    /// prompt_tokens showed the image never entered the prompt), while a
    /// vLLM-family endpoint read it fine. The user-message placement is the
    /// only one all three accepted.
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
        }];
        let request = ApiRequest {
            messages: &messages,
            system_prompt: None,
            tools: &[],
            model: "claude-opus-5",
            temperature: None,
            max_output_tokens: 1024,
            thinking_enabled: false,
            thinking_budget_tokens: None,
        };

        let out = openai_messages(&request, true, "openai");

        assert_eq!(out.len(), 2, "one tool message + one user message");
        assert_eq!(out[0]["role"], "tool");
        let tool_text = out[0]["content"].as_str().expect("tool content is a string");
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
        let parts = out[1]["content"].as_array().expect("user content is an array");
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"], "image_url");
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
            ApiError::Unauthorized
        ));
        assert!(matches!(
            map_status_error(429, "slow down".into()),
            ApiError::RateLimit
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
            for effort in [None, Some("low"), Some("medium"), Some("high"), Some("xhigh")] {
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
        assert!(budget < total, "budget {budget} must be < max_tokens {total}");
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
            temperature: None,
            max_output_tokens: 8_000,
            thinking_enabled: false,
            thinking_budget_tokens: None,
        }
    }

    fn tool_schema(name: &str) -> ToolSchema {
        ToolSchema {
            name: name.into(),
            description: "t".into(),
            input_schema: json!({"type": "object"}),
        }
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
    fn non_anthropic_providers_get_no_cache_control_at_all() {
        // MiniMax rides the same adapter but has never seen `cache_control`.
        // An unknown field is how Aurora has been 400'd before.
        for provider in ["minimax", "custom", "glm"] {
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
            temperature: None,
            max_output_tokens: 32_000,
            thinking_enabled: true,
            thinking_budget_tokens: None,
        };
        let body = build_openai_body(&request, &config);
        assert_eq!(body["thinking"], json!({ "type": "enabled" }));

        request.thinking_budget_tokens = Some(12_000);
        let body = build_openai_body(&request, &config);
        assert_eq!(
            body["thinking"],
            json!({ "type": "enabled", "budget_tokens": 12_000 })
        );

        // Thinking off ⇒ no `thinking` key at all, budget or not.
        request.thinking_enabled = false;
        let body = build_openai_body(&request, &config);
        assert!(body.get("thinking").is_none());
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
        let raw = r#"{"path":"C:\Users\Alvan\project\repo\src\main\index.ts"}"#;
        assert_eq!(
            parse_tool_input(raw),
            json!({"path": r"C:\Users\Alvan\project\repo\src\main\index.ts"})
        );
    }

    #[test]
    fn parse_tool_input_repairs_windows_paths_array() {
        let raw = r#"{"paths":["C:\Users\Alvan\long\repo\src\main\index.ts","E:\rust\new\tests\read.rs"]}"#;
        assert_eq!(
            parse_tool_input(raw),
            json!({
                "paths": [
                    r"C:\Users\Alvan\long\repo\src\main\index.ts",
                    r"E:\rust\new\tests\read.rs"
                ]
            })
        );
    }

    #[test]
    fn parse_tool_input_preserves_escaped_windows_paths_and_other_escapes() {
        let raw = r#"{"paths":["C:\\Users\\Alvan\\repo\\src\\main\\index.ts"],"content":"first\nsecond"}"#;
        assert_eq!(
            parse_tool_input(raw),
            json!({
                "paths": [r"C:\Users\Alvan\repo\src\main\index.ts"],
                "content": "first\nsecond"
            })
        );
    }
}
