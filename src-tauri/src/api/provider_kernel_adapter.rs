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

pub use super::sse_shared::{frame_payloads, SseFrameBuffer};

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

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model.to_string()));
    body.insert("messages".to_string(), Value::Array(messages));
    body.insert("max_tokens".to_string(), Value::from(max_tokens));
    body.insert("stream".to_string(), Value::Bool(true));
    body.insert("temperature".to_string(), Value::from(temperature));

    if let Some(system_prompt) = system {
        if !system_prompt.is_empty() {
            body.insert("system".to_string(), Value::String(system_prompt));
        }
    }

    if !request.tools.is_empty() {
        body.insert(
            "tools".to_string(),
            Value::Array(
                request
                    .tools
                    .iter()
                    .map(anthropic_tool_schema)
                    .collect::<Vec<_>>(),
            ),
        );
    }

    if request.thinking_enabled && config.supports_thinking {
        body.insert(
            "thinking".to_string(),
            json!({
                "type": "enabled",
                "budget_tokens": 1024,
            }),
        );
    }

    if let Some(custom) = &config.custom_params {
        for (key, value) in custom {
            body.insert(key.clone(), value.clone());
        }
    }

    Value::Object(body)
}

fn anthropic_tool_schema(schema: &ToolSchema) -> Value {
    json!({
        "name": schema.name,
        "description": schema.description,
        "input_schema": schema.input_schema,
    })
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
                "input": input,
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
fn openai_tool_result_content(content: &str) -> Value {
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
                "image_url": {
                    "url": format!("data:{media_type};base64,{base64}"),
                },
            })),
        })
        .collect();
    Value::Array(blocks)
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
            &config.provider_id,
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
        body.insert("thinking".to_string(), json!({ "type": "enabled" }));
    }

    // Ask the provider to emit `usage` on the final stream chunk.
    // Without this OpenAI / DeepSeek / GLM all skip the closing usage
    // event entirely, which is why pre-Phase-2.2 runs reported zero
    // tokens and never surfaced DeepSeek's `prompt_cache_hit_tokens`.
    // Fireworks, Ollama and "custom" providers can reject unknown body
    // fields with HTTP 400 — gate by provider_id.
    if should_request_stream_usage(&config.provider_id) {
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
pub(crate) fn should_request_stream_usage(provider_id: &str) -> bool {
    matches!(
        provider_id.to_ascii_lowercase().as_str(),
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
fn reasoning_field_for(provider_id: &str) -> Option<&'static str> {
    match provider_id.to_ascii_lowercase().as_str() {
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
    provider_id: &str,
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
                    openai_tool_result_content(&text)
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
                    if let Some(key) = reasoning_field_for(provider_id) {
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
                for block in &message.blocks {
                    match block {
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } => {
                            let content_value = if supports_vision {
                                openai_tool_result_content(content)
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
                if !injected_text.is_empty() {
                    output.push(json!({
                        "role": "user",
                        "content": injected_text,
                    }));
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
                    "arguments": input.to_string(),
                }
            })),
            _ => None,
        })
        .collect()
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

/// Parse an accumulated tool-call argument string. Empty / whitespace
/// → `{}`. Invalid JSON → `{}` (matches provider_kernel's
/// `normalize_openai_tool_arguments` policy: never emit a malformed
/// input that downstream tool dispatchers will choke on).
pub fn parse_tool_input(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    let normalized = normalize_absolute_windows_paths(raw);
    serde_json::from_str(&normalized).unwrap_or_else(|_| json!({}))
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
    fn parse_tool_input_handles_empty_and_invalid() {
        assert_eq!(parse_tool_input(""), json!({}));
        assert_eq!(parse_tool_input("   "), json!({}));
        assert_eq!(parse_tool_input("not json"), json!({}));
        assert_eq!(parse_tool_input(r#"{"a":1}"#), json!({"a": 1}));
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
