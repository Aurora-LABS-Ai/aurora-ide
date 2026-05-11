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
    let (system, messages) = anthropic_split_system_and_messages(request);

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

fn anthropic_split_system_and_messages(request: &ApiRequest<'_>) -> (Option<String>, Vec<Value>) {
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
                    "content": message_blocks_to_anthropic_content(&message.blocks),
                }));
            }
            MessageRole::Assistant => {
                output.push(json!({
                    "role": "assistant",
                    "content": message_blocks_to_anthropic_content(&message.blocks),
                }));
            }
            MessageRole::Tool => {
                output.push(json!({
                    "role": "user",
                    "content": message_blocks_to_anthropic_content(&message.blocks),
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

fn message_blocks_to_anthropic_content(blocks: &[ContentBlock]) -> Value {
    if blocks.is_empty() {
        return Value::String(String::new());
    }
    let arr: Vec<Value> = blocks
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => json!({
                "type": "text",
                "text": text,
            }),
            ContentBlock::Thinking { text, signature } => {
                let mut obj = json!({
                    "type": "thinking",
                    "thinking": text,
                });
                if let Some(sig) = signature {
                    obj["signature"] = Value::String(sig.clone());
                }
                obj
            }
            ContentBlock::ToolUse { id, name, input } => json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input,
            }),
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let mut obj = json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                });
                if let Some(err) = is_error {
                    obj["is_error"] = Value::Bool(*err);
                }
                obj
            }
        })
        .collect();
    Value::Array(arr)
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
        Value::Array(openai_messages(request)),
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
        body.insert(
            "thinking".to_string(),
            json!({ "type": "enabled" }),
        );
    }

    if let Some(custom) = &config.custom_params {
        for (key, value) in custom {
            body.insert(key.clone(), value.clone());
        }
    }

    Value::Object(body)
}

fn openai_messages(request: &ApiRequest<'_>) -> Vec<Value> {
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
                let text = collect_text(&message.blocks);
                output.push(json!({"role":"user","content":text}));
            }
            MessageRole::Assistant => {
                let text = collect_text(&message.blocks);
                let tool_calls = openai_tool_calls(&message.blocks);
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
                output.push(Value::Object(payload));
            }
            MessageRole::Tool => {
                for block in &message.blocks {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        ..
                    } = block
                    {
                        output.push(json!({
                            "role": "tool",
                            "tool_call_id": tool_use_id,
                            "content": content,
                        }));
                    }
                }
            }
        }
    }

    output
}

fn collect_text(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.clone()),
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
pub fn merge_usage(current: &mut crate::agent_runtime::types::TokenUsage, wire: &AnthropicUsageWire) {
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
    serde_json::from_str(raw).unwrap_or_else(|_| json!({}))
}

/// Build a final assistant [`ConversationMessage`] from accumulated
/// [`BlockState`]s, attaching usage metadata.
pub fn finalize_assistant_message(
    blocks: Vec<BlockState>,
    usage: crate::agent_runtime::types::TokenUsage,
) -> ConversationMessage {
    let final_blocks: Vec<ContentBlock> =
        blocks.into_iter().map(BlockState::into_content_block).collect();
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
}
