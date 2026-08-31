//! OpenAI **Responses API** streaming adapter (`provider_id` =
//! `"openai-responses"`).
//!
//! This is an *additional* wire shape next to the Chat Completions
//! adapter in [`super::openai_compat`] — it does not replace it. Wire
//! shape: `POST <base>/responses` with `accept: text/event-stream`;
//! the response is a stream of **typed semantic events** (`data:`
//! payloads whose JSON carries a `type` field mirroring the SSE event
//! name): `response.output_item.added`, `response.output_text.delta`,
//! `response.reasoning_summary_text.delta`,
//! `response.function_call_arguments.delta`, `response.output_item.done`,
//! `response.completed` / `response.incomplete` / `response.failed`.
//! Unlike Chat Completions there is no `[DONE]` sentinel and no
//! delta-shape guessing — every event says what it is.
//!
//! ## Statelessness
//!
//! Aurora owns its conversation history (JSONL session), so we always
//! send `store: false` and ask for
//! `include: ["reasoning.encrypted_content"]`. Reasoning items come
//! back with an opaque `encrypted_content` blob; we persist it in the
//! existing [`ContentBlock::Thinking`] `signature` field (JSON-encoded
//! with the item id, see [`encode_reasoning_signature`]) and replay it
//! as a `type: "reasoning"` input item on the next call. That is what
//! preserves the model's chain-of-thought across tool-call iterations
//! — the headline benefit of this API for agentic loops. Thinking
//! blocks whose signature is not ours (Anthropic/DeepSeek history) are
//! silently dropped from the replay; the model just re-thinks.
//!
//! ## Sampling knobs
//!
//! OpenAI's reasoning families (`gpt-5*`, `o1/o3/o4*`, `codex*`)
//! reject `temperature` on this endpoint with HTTP 400, so the body
//! builder only emits it for models outside those families. The
//! `reasoning: {summary: "auto"}` block is only sent when the request
//! has thinking enabled AND the provider config declares thinking
//! support — non-reasoning models 400 on an unexpected `reasoning`
//! param. `custom_params` merge last and can override any of this.

#![allow(dead_code)]

use std::collections::HashMap;
use std::pin::Pin;

use async_trait::async_trait;
use futures_util::stream::Stream;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ApiRequest, StreamingApiClient, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::{ContentBlock, MessageRole, TokenUsage};

use super::client::ProviderConfigSnapshot;
use super::provider_kernel_adapter::{
    build_openai_headers, collect_text, finalize_assistant_message, frame_payloads,
    map_reqwest_error, map_status_error, parse_tool_input, split_aurora_images,
    strip_aurora_images_for_text, unprefix_model, AuroraImagePiece, BlockState, SseFrameBuffer,
};

pub struct OpenAIResponsesAdapter {
    config: ProviderConfigSnapshot,
    http: reqwest::Client,
}

impl OpenAIResponsesAdapter {
    pub fn new(config: ProviderConfigSnapshot) -> Self {
        let http = reqwest::Client::builder()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            // Keepalives, not timeouts. A high reasoning effort can leave the
            // socket near-silent for minutes while the model thinks, which is
            // exactly when an idle-connection reaper (NAT, proxy, LB) kills it.
            // These keep the connection demonstrably alive; there is
            // deliberately no request timeout, since a long think is legitimate.
            .tcp_keepalive(std::time::Duration::from_secs(30))
            .http2_keep_alive_interval(std::time::Duration::from_secs(20))
            .http2_keep_alive_timeout(std::time::Duration::from_secs(20))
            .http2_keep_alive_while_idle(true)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { config, http }
    }

    pub fn with_http_client(config: ProviderConfigSnapshot, http: reqwest::Client) -> Self {
        Self { config, http }
    }

    pub fn config(&self) -> &ProviderConfigSnapshot {
        &self.config
    }
}

#[async_trait]
impl StreamingApiClient for OpenAIResponsesAdapter {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        if cancel_token.is_cancelled() {
            return Err(ApiError::Cancelled);
        }

        let url = build_responses_url(&self.config.base_url);
        let headers = build_openai_headers(&self.config)?;
        let body = build_responses_body(&request, &self.config);

        // Opt-in request tracing, same switch the Chat Completions adapter
        // uses: `$env:AURORA_DEBUG_API="1"; pnpm tauri:dev`.
        let debug_api = std::env::var("AURORA_DEBUG_API")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if debug_api {
            eprintln!(
                "[api][responses] POST {url}\nprovider_id={} model={}\nbody={}",
                self.config.provider_id,
                self.config.model,
                serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()),
            );
        }

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
            let error_body = response.text().await.unwrap_or_default();
            // A rejected body is exactly when you need to see the body. The
            // Chat Completions adapter has had `AURORA_DEBUG_API` for this;
            // this one had nothing, so a 400 naming a byte offset was
            // undiagnosable — you cannot look at column 39956 of a request you
            // never printed.
            //
            // Better than a flag: servers that reject a request usually SAY
            // where ("at line 1 column 39956"), so quote that slice of what we
            // sent. That turns "invalid request" into the offending item.
            let sent = serde_json::to_string(&body).unwrap_or_default();
            if debug_api {
                eprintln!(
                    "[api][responses] upstream {} rejected request: {}\nsent body:\n{}",
                    status.as_u16(),
                    error_body,
                    sent
                );
            }
            let detail = describe_rejected_body(&sent, &error_body);
            // `map_status_error` logs the full body+detail to aurora.log.
            return Err(map_status_error(
                status.as_u16(),
                format!("{error_body}{detail}"),
            ));
        }

        let bytes_stream = response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

        drive_responses_stream(bytes_stream, event_sink, cancel_token).await
    }
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/// `<base>/responses`, deduplicating when the user pasted a base URL
/// that already ends with the endpoint.
pub fn build_responses_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/responses") {
        return base.to_string();
    }
    format!("{base}/responses")
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/// Models that reject `temperature` on the Responses endpoint (OpenAI
/// returns HTTP 400 "Unsupported parameter" for its reasoning
/// families). Matched by family prefix so `gpt-5.5` / `o3-mini` /
/// `codex-…` all hit; open-weight lookalikes served locally are the
/// user's own endpoint and can re-add temperature via `custom_params`.
fn model_supports_temperature(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    const REASONING_FAMILIES: [&str; 5] = ["gpt-5", "o1", "o3", "o4", "codex"];
    !REASONING_FAMILIES
        .iter()
        .any(|p| m == *p || m.starts_with(&format!("{p}-")) || m.starts_with(&format!("{p}.")))
}

/// Build the JSON body for a `POST /responses` streaming call.
pub fn build_responses_body(request: &ApiRequest<'_>, config: &ProviderConfigSnapshot) -> Value {
    let model = unprefix_model(request.model, &config.provider_id);
    let (instructions, input) = responses_instructions_and_input(request, config.supports_vision);

    // The Responses API enforces a floor of 16 output tokens.
    let max_tokens = request.max_output_tokens.max(16);

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model.to_string()));
    body.insert("input".to_string(), Value::Array(input));
    body.insert("stream".to_string(), Value::Bool(true));
    // Aurora owns conversation state; never let the provider store it.
    body.insert("store".to_string(), Value::Bool(false));
    body.insert("max_output_tokens".to_string(), Value::from(max_tokens));
    // Stateless reasoning persistence across tool-call iterations.
    // Harmless for non-reasoning models (they emit no reasoning items).
    body.insert(
        "include".to_string(),
        json!(["reasoning.encrypted_content"]),
    );
    // Cache-routing affinity: requests carrying the same key land on the
    // same cache node, so the conversation's prefix actually gets read
    // instead of depending on routing luck. Spec-blessed on the Responses
    // API (opencode sends it on every request, Codex backend included);
    // absent for one-off requests with no conversation identity.
    if let Some(session_key) = request.session_key {
        if !session_key.is_empty() {
            body.insert(
                "prompt_cache_key".to_string(),
                Value::String(session_key.to_string()),
            );
        }
    }

    if let Some(instructions) = instructions {
        if !instructions.is_empty() {
            body.insert("instructions".to_string(), Value::String(instructions));
        }
    }

    if !request.tools.is_empty() {
        // Responses tools are FLAT (no `function` wrapper). `strict`
        // is pinned to false because Aurora tool schemas are not
        // strict-mode compliant (optional properties, no
        // `additionalProperties: false`).
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                    "strict": false,
                })
            })
            .collect();
        body.insert("tools".to_string(), Value::Array(tools));
        body.insert("tool_choice".to_string(), Value::String("auto".to_string()));
    }

    if model_supports_temperature(model) {
        if let Some(temperature) = request.temperature.or(config.default_temperature) {
            body.insert("temperature".to_string(), Value::from(temperature));
        }
    }

    if request.reasoning.enabled && config.supports_thinking {
        // Responses owns one nested reasoning object. Build it from the
        // canonical request rather than folding an OpenAI Chat field back out
        // of custom params after the fact.
        let mut reasoning = json!({ "summary": "auto" });
        if let Some(effort) = request.reasoning.effort {
            reasoning["effort"] = Value::String(effort.to_string());
        }
        body.insert("reasoning".to_string(), reasoning);
    }

    if let Some(custom) = &config.custom_params {
        for (key, value) in custom {
            // Aurora directive for the OpenAI-compat path; the Responses API
            // replays reasoning natively (encrypted items), so it must not
            // reach the wire here either.
            if key == "reasoning_replay" {
                continue;
            }
            body.insert(key.clone(), value.clone());
        }
    }

    // Backward compatibility for a saved/manual pre-cutover flat field. New
    // requests arrive through `request.reasoning.effort` above.
    if let Some(effort) = body.remove("reasoning_effort") {
        let reasoning = body
            .entry("reasoning".to_string())
            .or_insert_with(|| json!({}));
        if let Some(obj) = reasoning.as_object_mut() {
            obj.entry("effort".to_string()).or_insert(effort);
            // Effort models stream their reasoning as summaries.
            if config.supports_thinking {
                obj.entry("summary".to_string())
                    .or_insert_with(|| Value::String("auto".to_string()));
            }
        }
    }

    Value::Object(body)
}

/// Split conversation history into `instructions` (system prompt +
/// system messages) and the typed `input` item list.
fn responses_instructions_and_input(
    request: &ApiRequest<'_>,
    supports_vision: bool,
) -> (Option<String>, Vec<Value>) {
    let mut system_chunks: Vec<String> = Vec::new();
    if let Some(prompt) = request.system_prompt {
        if !prompt.is_empty() {
            // `instructions` is one opaque string with no breakpoint to place,
            // so the boundary marker is removed before it can reach the model.
            system_chunks.push(
                crate::api::provider_kernel_adapter::strip_system_boundary(prompt).into_owned(),
            );
        }
    }

    let mut items: Vec<Value> = Vec::new();
    for message in request.messages {
        match message.role {
            MessageRole::System => {
                let text = collect_text(&message.blocks);
                if !text.is_empty() {
                    system_chunks.push(text);
                }
            }
            MessageRole::User => {
                let text = collect_text(&message.blocks);
                // `type` is stated explicitly on every message item. OpenAI
                // INFERS it when absent, so this was invisible against the
                // reference API — but the Responses shape is now reimplemented
                // by several gateways, and a strict deserializer has to match
                // an untagged union by its discriminator. Without it those
                // servers reject the whole request with a byte offset and no
                // explanation. Stating it is spec-valid everywhere and costs
                // one field.
                items.push(json!({
                    "type": "message",
                    "role": "user",
                    "content": responses_user_content(&text, supports_vision),
                }));
            }
            MessageRole::Assistant => {
                // Block-by-block so emission order is preserved:
                // reasoning items must precede the function_call they
                // justified.
                for block in &message.blocks {
                    match block {
                        ContentBlock::Text { text } => {
                            if !text.is_empty() {
                                items.push(json!({
                                    "type": "message",
                                    "role": "assistant",
                                    "content": [{ "type": "output_text", "text": text }],
                                }));
                            }
                        }
                        ContentBlock::Thinking {
                            text, signature, ..
                        } => {
                            if let Some(item) = reasoning_replay_item(text, signature.as_deref()) {
                                items.push(item);
                            }
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            items.push(json!({
                                "type": "function_call",
                                "call_id": id,
                                "name": name,
                                "arguments": input.to_string(),
                            }));
                        }
                        ContentBlock::ToolResult { .. }
                        | ContentBlock::Compaction { .. }
                        | ContentBlock::Notice { .. } => {}
                    }
                }
            }
            MessageRole::Tool => {
                // One function_call_output per tool_result. Screenshots
                // can't ride inside `output` (string-only for maximum
                // compatibility), so vision images are collected and
                // appended as a trailing user item — same position the
                // mid-turn queued user text lands in.
                let mut trailing_parts: Vec<Value> = Vec::new();
                let mut injected_text = String::new();
                for block in &message.blocks {
                    match block {
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } => {
                            let (output, images) = responses_tool_output(content, supports_vision);
                            items.push(json!({
                                "type": "function_call_output",
                                "call_id": tool_use_id,
                                "output": output,
                            }));
                            trailing_parts.extend(images);
                        }
                        ContentBlock::Text { text } => {
                            if !injected_text.is_empty() {
                                injected_text.push_str("\n\n");
                            }
                            injected_text.push_str(text);
                        }
                        _ => {
                            // ToolUse / Thinking inside a Tool message
                            // would be a runtime bug — drop silently.
                        }
                    }
                }
                if !injected_text.is_empty() {
                    // The injected mid-turn text can carry `<aurora_image>`
                    // markers (composer attachments) — expand them through
                    // the SAME splitter user messages use, so a mid-turn
                    // image reaches the model exactly like a screenshot
                    // does instead of shipping as base64 prose.
                    match responses_user_content(&injected_text, supports_vision) {
                        Value::Array(parts) => trailing_parts.extend(parts),
                        other => trailing_parts.push(other),
                    }
                }
                if !trailing_parts.is_empty() {
                    items.push(json!({
                        "type": "message",
                        "role": "user",
                        "content": trailing_parts,
                    }));
                }
            }
        }
    }

    let instructions = if system_chunks.is_empty() {
        None
    } else {
        Some(system_chunks.join("\n\n"))
    };
    (instructions, items)
}

/// User message text → Responses content parts, expanding
/// `<aurora_image>` markers to `input_image` parts for vision models.
fn responses_user_content(text: &str, supports_vision: bool) -> Value {
    if !crate::api::aurora_image::has_marker(text) {
        return json!([{ "type": "input_text", "text": text }]);
    }
    if !supports_vision {
        return json!([{
            "type": "input_text",
            "text": strip_aurora_images_for_text(text),
        }]);
    }
    let parts: Vec<Value> = split_aurora_images(text)
        .into_iter()
        .filter_map(|p| match p {
            AuroraImagePiece::Text(t) if t.trim().is_empty() => None,
            AuroraImagePiece::Text(t) => Some(json!({ "type": "input_text", "text": t })),
            AuroraImagePiece::Image { media_type, base64 } => Some(json!({
                "type": "input_image",
                "image_url": format!("data:{media_type};base64,{base64}"),
            })),
        })
        .collect();
    Value::Array(parts)
}

/// Tool-result content → (`output` string, trailing `input_image`
/// parts). Non-vision models get the placeholder-stripped text and no
/// images.
fn responses_tool_output(content: &str, supports_vision: bool) -> (String, Vec<Value>) {
    if !supports_vision {
        return (strip_aurora_images_for_text(content), Vec::new());
    }
    if !crate::api::aurora_image::has_marker(content) {
        return (content.to_string(), Vec::new());
    }
    let mut text = String::new();
    let mut images: Vec<Value> = Vec::new();
    for piece in split_aurora_images(content) {
        match piece {
            AuroraImagePiece::Text(t) => {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&t);
            }
            AuroraImagePiece::Image { media_type, base64 } => images.push(json!({
                "type": "input_image",
                "image_url": format!("data:{media_type};base64,{base64}"),
            })),
        }
    }
    if text.trim().is_empty() && !images.is_empty() {
        text = "[screenshot attached in the next message]".to_string();
    }
    (text, images)
}

// ---------------------------------------------------------------------------
// Reasoning persistence (signature <-> reasoning item)
// ---------------------------------------------------------------------------

/// Pack a reasoning item's id + `encrypted_content` into the existing
/// `Thinking.signature` slot. JSON-tagged with the provider so replay
/// never confuses it with an Anthropic signature.
pub(crate) fn encode_reasoning_signature(item_id: &str, encrypted_content: &str) -> String {
    json!({
        "provider": "openai-responses",
        "id": item_id,
        "encrypted_content": encrypted_content,
    })
    .to_string()
}

fn decode_reasoning_signature(signature: &str) -> Option<(String, String)> {
    let value: Value = serde_json::from_str(signature).ok()?;
    if value.get("provider")?.as_str()? != "openai-responses" {
        return None;
    }
    Some((
        value.get("id")?.as_str()?.to_string(),
        value.get("encrypted_content")?.as_str()?.to_string(),
    ))
}

/// A persisted Thinking block → `type: "reasoning"` input item, or
/// `None` when the block didn't come from this adapter (no valid
/// encoded signature) and therefore cannot be replayed.
/// Pull a byte offset out of a serde-style rejection ("at line 1 column 39956").
///
/// Only line 1 is honoured: the request is serialized as one line, so a
/// reported line above 1 means the server is describing something other than
/// what we sent and the offset would point at the wrong place.
fn parse_error_column(error_body: &str) -> Option<usize> {
    let at = error_body.find("column ")?;
    let digits: String = error_body[at + "column ".len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if digits.is_empty() {
        return None;
    }
    if let Some(line_at) = error_body.find("line ") {
        let line: String = error_body[line_at + "line ".len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if !line.is_empty() && line != "1" {
            return None;
        }
    }
    digits.parse().ok()
}

/// Byte spans of each top-level element of the `input` array in `sent`.
///
/// Walks the serialized text rather than re-serializing, so the offsets line
/// up with the ones the server is quoting. String-aware: a brace inside a tool
/// result's JSON payload must not be counted as structure, and file paths in
/// this app are full of escaped backslashes.
fn input_item_spans(sent: &str) -> Vec<(usize, usize)> {
    let bytes = sent.as_bytes();
    let Some(key) = sent.find("\"input\":[") else {
        return Vec::new();
    };
    let mut i = key + "\"input\":[".len();
    let mut spans = Vec::new();
    let mut depth = 0usize;
    let mut start = i;
    let mut in_string = false;
    let mut escaped = false;

    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => in_string = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                if depth == 0 {
                    // Closing bracket of `input` itself.
                    if start < i {
                        spans.push((start, i));
                    }
                    return spans;
                }
                depth -= 1;
            }
            b',' if depth == 0 => {
                spans.push((start, i));
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    spans
}

/// Identify which `input` item the server's offset lands in, and describe its
/// shape.
///
/// A byte window tells you what the bytes were; this tells you which ITEM the
/// server refused and what fields it carried, which is the thing that actually
/// points at the bug. Field VALUES are never echoed — a tool result can be
/// megabytes and can contain file contents — only names and sizes.
fn describe_rejected_item(sent: &str, column: usize) -> Option<String> {
    let spans = input_item_spans(sent);
    if spans.is_empty() {
        return None;
    }
    let total = spans.len();
    // `<= end` rather than `< end`: serde's untagged enums buffer the whole
    // value before giving up, so the reported offset usually sits at the END
    // of the item that failed rather than at its start.
    let (index, (start, end)) = spans
        .iter()
        .enumerate()
        .find(|(_, (s, e))| column >= *s && column <= *e)
        .map(|(i, span)| (i, *span))?;

    let text = sent.get(start..end)?.trim();
    let parsed: Value = serde_json::from_str(text).ok()?;
    let kind = parsed
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("(no `type` field — this is almost certainly the problem)");
    let role = parsed
        .get("role")
        .and_then(Value::as_str)
        .map(|r| format!(" role={r}"))
        .unwrap_or_default();
    let fields = parsed
        .as_object()
        .map(|o| {
            o.iter()
                .map(|(k, v)| {
                    let size = serde_json::to_string(v).map(|s| s.len()).unwrap_or(0);
                    format!("{k} ({size} B)")
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "(item is not an object)".to_string());

    Some(format!(
        "\n\nThe provider refused input item {} of {total} (bytes {start}-{end}):\n  \
         type={kind}{role}\n  fields: {fields}",
        index + 1
    ))
}

/// Pull the most specific human-readable message out of a provider error
/// payload (an SSE `error` event, or the `response` object of a
/// `response.failed` event).
///
/// Relays differ: OpenAI puts `message` at the top level of the stream
/// `error` event, Anthropic-style proxies nest it under `error.message`,
/// some gateways send only a `code`, and some send a bare string under
/// `error`. The old code read only the top-level `message` and fell back to
/// the constant `"stream error"` — which is exactly what a real incident
/// surfaced as, with the actual reason discarded. The last resort here is
/// the raw payload itself, truncated: an ugly error beats a vanished one.
fn stream_error_message(event: &Value) -> String {
    fn non_empty(v: Option<&Value>) -> Option<&str> {
        v.and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
    if let Some(m) = non_empty(event.get("message")) {
        return m.to_string();
    }
    if let Some(err) = event.get("error") {
        if let Some(m) = non_empty(err.get("message")) {
            return m.to_string();
        }
        if let Some(m) = non_empty(Some(err)) {
            return m.to_string();
        }
        if let Some(code) = non_empty(err.get("code")) {
            return format!("provider error code: {code}");
        }
    }
    if let Some(code) = non_empty(event.get("code")) {
        return format!("provider error code: {code}");
    }
    // Bound the raw fallback: this string reaches the UI banner and the
    // session history. The unbounded copy already went to the log file.
    let raw = event.to_string();
    let mut cut = raw.len().min(600);
    while cut > 0 && !raw.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("provider error event: {}", &raw[..cut])
}

/// Quote the slice of the request we sent that the server pointed at.
///
/// Providers reject bodies with a byte offset and no content, which is useless
/// on its own — the whole point of this is to make the next one a five-second
/// diagnosis instead of a bisect. A window, never the whole body: a request
/// carrying a screenshot is megabytes of base64 and dumping it would bury the
/// answer it is supposed to reveal.
fn describe_rejected_body(sent: &str, error_body: &str) -> String {
    const WINDOW: usize = 220;
    let Some(column) = parse_error_column(error_body) else {
        return String::new();
    };
    if sent.is_empty() || column > sent.len() {
        return String::new();
    }
    // Char-boundary safe: the body is UTF-8 and the offset is a byte count, so
    // slicing naively can panic mid-codepoint.
    let floor = |mut i: usize| {
        while i > 0 && !sent.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    let start = floor(column.saturating_sub(WINDOW));
    let end = floor((column + WINDOW).min(sent.len()));
    // Name the ITEM first — that is what points at the bug. The raw window
    // follows as corroboration for anything the summary cannot express.
    let item = describe_rejected_item(sent, column).unwrap_or_default();
    format!(
        "\n\nAurora sent {} bytes; the provider rejected byte {column}.{item}\n\nWhat we sent \
         around there:\n…{}…\n(set AURORA_DEBUG_API=1 to print the whole request body)",
        sent.len(),
        &sent[start..end],
    )
}

fn reasoning_replay_item(text: &str, signature: Option<&str>) -> Option<Value> {
    let (id, encrypted_content) = decode_reasoning_signature(signature?)?;
    let summary: Vec<Value> = if text.is_empty() {
        Vec::new()
    } else {
        vec![json!({ "type": "summary_text", "text": text })]
    };
    Some(json!({
        "type": "reasoning",
        "id": id,
        "summary": summary,
        "encrypted_content": encrypted_content,
    }))
}

// ---------------------------------------------------------------------------
// Stream driver
// ---------------------------------------------------------------------------

/// Drive a Responses API SSE stream.
///
/// Bytes → [`SseFrameBuffer`] → typed event JSON → [`AssistantEvent`]s.
/// Every `data:` payload carries a `type` field that mirrors the SSE
/// `event:` name, so the driver switches on that and ignores `event:`
/// lines entirely (which [`frame_payloads`] already drops).
///
/// Generic over the chunk type so tests can drive it with `Vec<u8>`
/// chunks; production passes `bytes::Bytes`.
pub async fn drive_responses_stream<S, B, E>(
    bytes_stream: S,
    event_sink: mpsc::Sender<AssistantEvent>,
    cancel_token: CancellationToken,
) -> Result<TurnUsage, ApiError>
where
    S: Stream<Item = Result<B, E>> + Send,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    let mut bytes_stream: Pin<Box<S>> = Box::pin(bytes_stream);
    let mut sse = SseFrameBuffer::new();

    // Blocks accumulate in item-arrival order. Unlike Chat Completions
    // there is no delta-kind guessing: every delta names its item via
    // `item_id`, so the position map is keyed by item id.
    let mut blocks: Vec<BlockState> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut emitted_tool_use: Vec<bool> = Vec::new();

    let mut usage = TokenUsage::default();
    let mut saw_tool_call = false;
    let mut stop_reason: Option<String> = None;

    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => return Err(ApiError::Cancelled),
            next = bytes_stream.next() => match next {
                Some(Ok(c)) => c,
                Some(Err(e)) => return Err(ApiError::Network(format!("stream error: {e}"))),
                None => break,
            }
        };

        sse.extend(chunk.as_ref());
        for frame in sse.take_frames() {
            for payload in frame_payloads(&frame) {
                let event: Value = match serde_json::from_str(&payload) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");

                match event_type {
                    "response.output_item.added" => {
                        let Some(item) = event.get("item") else {
                            continue;
                        };
                        let item_key = item_key_of(item);
                        match item.get("type").and_then(Value::as_str) {
                            Some("function_call") => {
                                let call_id = item
                                    .get("call_id")
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or(&item_key)
                                    .to_string();
                                let name = item
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                let raw_input = item
                                    .get("arguments")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                positions.insert(item_key, blocks.len());
                                emitted_tool_use.resize(blocks.len() + 1, false);
                                if !name.is_empty() {
                                    let _ = event_sink
                                        .send(AssistantEvent::ToolUseDelta {
                                            id: call_id.clone(),
                                            name: name.clone(),
                                            arguments: raw_input.clone(),
                                        })
                                        .await;
                                }
                                blocks.push(BlockState::ToolUse {
                                    id: call_id,
                                    name,
                                    raw_input,
                                });
                            }
                            Some("reasoning") => {
                                positions.insert(item_key, blocks.len());
                                blocks.push(BlockState::new_thinking(String::new(), None));
                            }
                            // "message" opens lazily on the first text
                            // delta so an empty message never leaves a
                            // stray blank block.
                            _ => {}
                        }
                    }

                    "response.output_text.delta" | "response.refusal.delta" => {
                        let Some(delta) = event.get("delta").and_then(Value::as_str) else {
                            continue;
                        };
                        if delta.is_empty() {
                            continue;
                        }
                        let key = event_item_key(&event);
                        append_text_for_item(&mut blocks, &mut positions, &key, delta);
                        let _ = event_sink
                            .send(AssistantEvent::TextDelta {
                                delta: delta.to_string(),
                            })
                            .await;
                    }

                    "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                        let Some(delta) = event.get("delta").and_then(Value::as_str) else {
                            continue;
                        };
                        if delta.is_empty() {
                            continue;
                        }
                        let key = event_item_key(&event);
                        append_thinking_for_item(&mut blocks, &mut positions, &key, delta);
                        let _ = event_sink
                            .send(AssistantEvent::Thinking {
                                text: delta.to_string(),
                                signature: None,
                            })
                            .await;
                    }

                    // A reasoning item can carry several summary parts;
                    // separate them so the thinking pane doesn't render
                    // them glued together.
                    "response.reasoning_summary_part.added" => {
                        let index = event
                            .get("summary_index")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        if index == 0 {
                            continue;
                        }
                        let key = event_item_key(&event);
                        append_thinking_for_item(&mut blocks, &mut positions, &key, "\n\n");
                        let _ = event_sink
                            .send(AssistantEvent::Thinking {
                                text: "\n\n".to_string(),
                                signature: None,
                            })
                            .await;
                    }

                    "response.function_call_arguments.delta" => {
                        let Some(delta) = event.get("delta").and_then(Value::as_str) else {
                            continue;
                        };
                        let key = event_item_key(&event);
                        let Some(&pos) = positions.get(&key) else {
                            continue;
                        };
                        if let Some(BlockState::ToolUse {
                            id,
                            name,
                            raw_input,
                        }) = blocks.get_mut(pos)
                        {
                            raw_input.push_str(delta);
                            if !name.is_empty() {
                                let _ = event_sink
                                    .send(AssistantEvent::ToolUseDelta {
                                        id: id.clone(),
                                        name: name.clone(),
                                        arguments: raw_input.clone(),
                                    })
                                    .await;
                            }
                        }
                    }

                    "response.output_item.done" => {
                        let Some(item) = event.get("item") else {
                            continue;
                        };
                        let item_key = item_key_of(item);
                        match item.get("type").and_then(Value::as_str) {
                            Some("function_call") => {
                                saw_tool_call = true;
                                let Some(&pos) = positions.get(&item_key) else {
                                    continue;
                                };
                                if let Some(BlockState::ToolUse {
                                    id,
                                    name,
                                    raw_input,
                                }) = blocks.get_mut(pos)
                                {
                                    // The done item is authoritative —
                                    // overwrite the accumulated buffers.
                                    if let Some(call_id) =
                                        item.get("call_id").and_then(Value::as_str)
                                    {
                                        if !call_id.is_empty() {
                                            *id = call_id.to_string();
                                        }
                                    }
                                    if let Some(n) = item.get("name").and_then(Value::as_str) {
                                        if !n.is_empty() {
                                            *name = n.to_string();
                                        }
                                    }
                                    if let Some(args) =
                                        item.get("arguments").and_then(Value::as_str)
                                    {
                                        if !args.is_empty() {
                                            *raw_input = args.to_string();
                                        }
                                    }
                                    let _ = event_sink
                                        .send(AssistantEvent::ToolUse {
                                            id: id.clone(),
                                            name: name.clone(),
                                            input: parse_tool_input(raw_input),
                                        })
                                        .await;
                                    if let Some(flag) = emitted_tool_use.get_mut(pos) {
                                        *flag = true;
                                    }
                                }
                            }
                            Some("reasoning") => {
                                let encrypted = item
                                    .get("encrypted_content")
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.is_empty());
                                let item_id = item.get("id").and_then(Value::as_str).unwrap_or("");
                                let summary_text = reasoning_summary_text(item);
                                let pos = positions.get(&item_key).copied();
                                match pos {
                                    Some(pos) => {
                                        if let Some(BlockState::Thinking {
                                            text, signature, ..
                                        }) = blocks.get_mut(pos)
                                        {
                                            if text.is_empty() && !summary_text.is_empty() {
                                                *text = summary_text;
                                            }
                                            if let Some(enc) = encrypted {
                                                *signature =
                                                    Some(encode_reasoning_signature(item_id, enc));
                                            }
                                        }
                                    }
                                    None => {
                                        // Reasoning item that never got an
                                        // `added` event — still persist it so
                                        // replay keeps working.
                                        blocks.push(BlockState::new_thinking(
                                            summary_text,
                                            encrypted.map(|enc| {
                                                encode_reasoning_signature(item_id, enc)
                                            }),
                                        ));
                                    }
                                }
                            }
                            _ => {}
                        }
                    }

                    "response.completed" | "response.incomplete" => {
                        let response = event.get("response").unwrap_or(&Value::Null);
                        if let Some(u) = response.get("usage") {
                            apply_responses_usage(u, &mut usage);
                            let _ = event_sink.send(AssistantEvent::Usage(usage.clone())).await;
                        }
                        stop_reason = Some(if event_type == "response.incomplete" {
                            let reason = response
                                .get("incomplete_details")
                                .and_then(|d| d.get("reason"))
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if reason == "max_output_tokens" {
                                "max_tokens".to_string()
                            } else if saw_tool_call {
                                "tool_use".to_string()
                            } else {
                                "end_turn".to_string()
                            }
                        } else if saw_tool_call {
                            "tool_use".to_string()
                        } else {
                            "end_turn".to_string()
                        });
                    }

                    "response.failed" => {
                        // The full event goes to the log BEFORE any
                        // extraction — whatever shape the relay used, the
                        // payload survives on disk even if the message
                        // below comes out generic.
                        crate::logging::log_error(
                            "api.responses",
                            &format!("response.failed event: {event}"),
                        );
                        let message = event
                            .get("response")
                            .map(stream_error_message)
                            .unwrap_or_else(|| stream_error_message(&event));
                        return Err(ApiError::Provider(message));
                    }

                    "error" => {
                        crate::logging::log_error(
                            "api.responses",
                            &format!("provider SSE error event: {event}"),
                        );
                        return Err(ApiError::Provider(stream_error_message(&event)));
                    }

                    _ => {}
                }
            }
        }
    }

    // Safety sweep: a disconnect after arguments finished but before
    // `output_item.done` must still surface the tool call to the UI.
    for (pos, block) in blocks.iter().enumerate() {
        if let BlockState::ToolUse {
            id,
            name,
            raw_input,
        } = block
        {
            if emitted_tool_use.get(pos).copied().unwrap_or(false) || name.is_empty() {
                continue;
            }
            saw_tool_call = true;
            let _ = event_sink
                .send(AssistantEvent::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: parse_tool_input(raw_input),
                })
                .await;
        }
    }

    // `stop_reason` is only ever set by `response.completed` / `response.incomplete`
    // (and `response.failed` / `error` return early), so an empty one at EOF means
    // no terminal event ever arrived — the connection dropped mid-reply. Surface it
    // instead of inventing `end_turn` and presenting a truncated answer as complete.
    if stop_reason.is_none() {
        return Err(ApiError::Network(
            "the response stream ended before the model finished — the connection dropped              mid-reply. Retry to run the turn again."
                .to_string(),
        ));
    }

    let final_stop = stop_reason.unwrap_or_else(|| {
        if saw_tool_call {
            "tool_use".to_string()
        } else {
            "end_turn".to_string()
        }
    });
    let _ = event_sink
        .send(AssistantEvent::MessageStop {
            stop_reason: final_stop.clone(),
        })
        .await;

    let assistant_message = finalize_assistant_message(blocks, usage.clone());

    Ok(TurnUsage {
        usage,
        stop_reason: final_stop,
        assistant_message,
    })
}

/// Key used to correlate an item's delta events with its block: the
/// item id when present, else the output index (local servers have
/// been seen omitting ids).
fn item_key_of(item: &Value) -> String {
    if let Some(id) = item.get("id").and_then(Value::as_str) {
        if !id.is_empty() {
            return id.to_string();
        }
    }
    String::from("item_anon")
}

fn event_item_key(event: &Value) -> String {
    if let Some(id) = event.get("item_id").and_then(Value::as_str) {
        if !id.is_empty() {
            return id.to_string();
        }
    }
    String::from("item_anon")
}

fn append_text_for_item(
    blocks: &mut Vec<BlockState>,
    positions: &mut HashMap<String, usize>,
    key: &str,
    delta: &str,
) {
    if let Some(&pos) = positions.get(key) {
        if let Some(BlockState::Text { text }) = blocks.get_mut(pos) {
            text.push_str(delta);
            return;
        }
    }
    positions.insert(key.to_string(), blocks.len());
    blocks.push(BlockState::Text {
        text: delta.to_string(),
    });
}

fn append_thinking_for_item(
    blocks: &mut Vec<BlockState>,
    positions: &mut HashMap<String, usize>,
    key: &str,
    delta: &str,
) {
    if let Some(&pos) = positions.get(key) {
        if let Some(block) = blocks.get_mut(pos) {
            if block.push_thinking(delta) {
                return;
            }
        }
    }
    positions.insert(key.to_string(), blocks.len());
    blocks.push(BlockState::new_thinking(delta.to_string(), None));
}

/// Join a done reasoning item's `summary[].text` parts (fallback when
/// no summary deltas streamed).
fn reasoning_summary_text(item: &Value) -> String {
    item.get("summary")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

/// Responses usage → Aurora [`TokenUsage`]. Like DeepSeek (and unlike
/// Anthropic), `input_tokens_details.cached_tokens` is a SUBSET of
/// `input_tokens`; Aurora's context math treats cache reads as
/// ADDITIVE, so the cached portion is subtracted out of
/// `input_tokens` before emitting.
fn apply_responses_usage(u: &Value, usage: &mut TokenUsage) {
    if let Some(input) = u.get("input_tokens").and_then(Value::as_u64) {
        usage.input_tokens = input as u32;
    }
    if let Some(output) = u.get("output_tokens").and_then(Value::as_u64) {
        usage.output_tokens = output as u32;
    }
    let cached = u
        .get("input_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    if cached > 0 {
        usage.cache_read_input_tokens = Some(cached);
        usage.input_tokens = usage.input_tokens.saturating_sub(cached);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::api_client::ToolSchema;
    use crate::agent_runtime::types::ConversationMessage;
    use futures_util::stream;

    fn config() -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: "openai-responses".into(),
            provider_type: None,
            base_url: "https://api.openai.com/v1".into(),
            api_key: "sk-test".into(),
            api_keys: None,
            model: "gpt-5".into(),
            custom_headers: None,
            custom_params: None,
            default_temperature: Some(0.7),
            default_max_tokens: None,
            supports_thinking: true,
            reasoning: None,
            supports_vision: false,
        }
    }

    fn request<'a>(messages: &'a [ConversationMessage], tools: &'a [ToolSchema]) -> ApiRequest<'a> {
        ApiRequest {
            model: "openai-responses:gpt-5",
            system_prompt: Some("You are Aurora."),
            messages,
            tools,
            temperature: None,
            max_output_tokens: 4096,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest {
                enabled: true,
                control: crate::agent_runtime::api_client::ReasoningControl::Toggle,
                ..crate::agent_runtime::api_client::ReasoningRequest::disabled()
            },
            tool_bridge: None,
            session_key: None,
            volatile_tail_messages: 0,
        }
    }

    #[test]
    fn url_appends_and_dedupes_responses_endpoint() {
        assert_eq!(
            build_responses_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            build_responses_url("https://api.openai.com/v1/responses/"),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn body_is_stateless_streaming_with_flat_tools() {
        let messages = vec![ConversationMessage::user_text("hi", 0)];
        let tools = vec![ToolSchema {
            name: "file_read".into(),
            description: "Read a file".into(),
            input_schema: json!({"type":"object","properties":{}}),
        }];
        let req = request(&messages, &tools);
        let body = build_responses_body(&req, &config());

        assert_eq!(body["model"], "gpt-5");
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], false);
        assert_eq!(body["include"][0], "reasoning.encrypted_content");
        assert_eq!(body["instructions"], "You are Aurora.");
        assert_eq!(body["max_output_tokens"], 4096);
        // Flat tool shape — no `function` wrapper.
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["name"], "file_read");
        assert_eq!(body["tools"][0]["strict"], false);
        assert!(body["tools"][0].get("function").is_none());
        assert_eq!(body["tool_choice"], "auto");
        // Thinking enabled + supported → reasoning summaries on.
        assert_eq!(body["reasoning"]["summary"], "auto");
        // gpt-5 is a reasoning family → temperature must be omitted.
        assert!(body.get("temperature").is_none());
        // No conversation identity on this request → no cache key.
        assert!(body.get("prompt_cache_key").is_none());
    }

    #[test]
    fn conversation_identity_becomes_the_prompt_cache_key() {
        // Same key on every request of a thread → the provider routes them
        // to the same cache node. Without it, long conversations kept
        // reading only the system-prompt-and-tools region from cache.
        let messages = vec![ConversationMessage::user_text("hi", 0)];
        let mut req = request(&messages, &[]);
        req.session_key = Some("thread-abc-123");
        let body = build_responses_body(&req, &config());
        assert_eq!(body["prompt_cache_key"], "thread-abc-123");

        // An empty key is no key.
        req.session_key = Some("");
        let body = build_responses_body(&req, &config());
        assert!(body.get("prompt_cache_key").is_none());
    }

    #[test]
    fn flat_reasoning_effort_param_folds_into_nested_reasoning() {
        // A pre-cutover saved row may still carry a flat Chat-Completions
        // field. Responses must nest it and request summaries.
        let messages = vec![ConversationMessage::user_text("hi", 0)];
        let mut cfg = config();
        cfg.custom_params = Some(std::collections::HashMap::from([(
            "reasoning_effort".to_string(),
            json!("xhigh"),
        )]));
        let mut req = request(&messages, &[]);
        req.reasoning = crate::agent_runtime::api_client::ReasoningRequest::disabled();

        let body = build_responses_body(&req, &cfg);
        assert!(body.get("reasoning_effort").is_none());
        assert_eq!(body["reasoning"]["effort"], "xhigh");
        assert_eq!(body["reasoning"]["summary"], "auto");
    }

    #[test]
    fn canonical_effort_becomes_the_responses_reasoning_object() {
        let messages = vec![ConversationMessage::user_text("hi", 0)];
        let mut req = request(&messages, &[]);
        req.reasoning = crate::agent_runtime::api_client::ReasoningRequest {
            enabled: true,
            control: crate::agent_runtime::api_client::ReasoningControl::Effort,
            effort: Some("high"),
            request_mode: crate::agent_runtime::api_client::ReasoningRequestMode::OpenaiEffort,
            ..crate::agent_runtime::api_client::ReasoningRequest::disabled()
        };

        let body = build_responses_body(&req, &config());

        assert!(body.get("reasoning_effort").is_none());
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["reasoning"]["summary"], "auto");
    }

    #[test]
    fn explicit_reasoning_object_wins_over_picker_effort() {
        // A user-supplied `reasoning` extra-body field keeps its own keys;
        // the picker's flat param only fills what's missing.
        let messages = vec![ConversationMessage::user_text("hi", 0)];
        let mut cfg = config();
        cfg.custom_params = Some(std::collections::HashMap::from([
            ("reasoning_effort".to_string(), json!("low")),
            ("reasoning".to_string(), json!({ "effort": "high" })),
        ]));
        let mut req = request(&messages, &[]);
        req.reasoning = crate::agent_runtime::api_client::ReasoningRequest::disabled();

        let body = build_responses_body(&req, &cfg);
        assert!(body.get("reasoning_effort").is_none());
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["reasoning"]["summary"], "auto");
    }

    #[test]
    fn temperature_emitted_only_for_non_reasoning_models() {
        assert!(model_supports_temperature("gpt-4o"));
        assert!(model_supports_temperature("gpt-4.1-mini"));
        assert!(!model_supports_temperature("gpt-5"));
        assert!(!model_supports_temperature("gpt-5.5"));
        assert!(!model_supports_temperature("o3-mini"));
        assert!(!model_supports_temperature("codex-mini-latest"));
        // "o" prefixes must not swallow unrelated names.
        assert!(model_supports_temperature("olmo-2"));

        let messages = vec![ConversationMessage::user_text("hi", 0)];
        let mut cfg = config();
        cfg.model = "gpt-4o".into();
        let mut req = request(&messages, &[]);
        req.model = "openai-responses:gpt-4o";
        let body = build_responses_body(&req, &cfg);
        // f32 → JSON number; compare with tolerance.
        let temp = body["temperature"].as_f64().expect("temperature present");
        assert!((temp - 0.7).abs() < 1e-6, "got {temp}");
    }

    #[test]
    fn history_maps_to_typed_input_items() {
        let messages = vec![
            ConversationMessage::user_text("run it", 0),
            ConversationMessage::assistant(
                vec![
                    ContentBlock::Thinking {
                        text: "plan".into(),
                        signature: Some(encode_reasoning_signature("rs_1", "ENC")),
                        duration_ms: None,
                    },
                    ContentBlock::ToolUse {
                        id: "call_1".into(),
                        name: "shell_execute".into(),
                        input: json!({"command":"ls"}),
                    },
                ],
                1,
            ),
            ConversationMessage {
                role: MessageRole::Tool,
                blocks: vec![
                    ContentBlock::ToolResult {
                        tool_use_id: "call_1".into(),
                        content: "ok".into(),
                        is_error: None,
                    },
                    ContentBlock::Text {
                        text: "also do X".into(),
                    },
                ],
                usage: None,
                timestamp: 2,
                attached_selected_elements: None,
                attached_prompt_chips: None,
                model: None,
            },
        ];
        let req = request(&messages, &[]);
        let body = build_responses_body(&req, &config());
        let input = body["input"].as_array().expect("input array");

        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"][0]["type"], "input_text");
        // Reasoning replay precedes the function_call it justified.
        assert_eq!(input[1]["type"], "reasoning");
        assert_eq!(input[1]["id"], "rs_1");
        assert_eq!(input[1]["encrypted_content"], "ENC");
        assert_eq!(input[1]["summary"][0]["text"], "plan");
        assert_eq!(input[2]["type"], "function_call");
        assert_eq!(input[2]["call_id"], "call_1");
        assert_eq!(input[2]["name"], "shell_execute");
        assert_eq!(input[3]["type"], "function_call_output");
        assert_eq!(input[3]["call_id"], "call_1");
        assert_eq!(input[3]["output"], "ok");
        // Mid-turn queued user text rides in after the tool outputs.
        assert_eq!(input[4]["role"], "user");
        assert_eq!(input[4]["content"][0]["text"], "also do X");
    }

    #[test]
    fn foreign_thinking_signatures_are_dropped_from_replay() {
        let messages = vec![ConversationMessage::assistant(
            vec![ContentBlock::Thinking {
                text: "anthropic thought".into(),
                signature: Some("EqQBCkgIBRABGAI=".into()),
                duration_ms: None,
            }],
            0,
        )];
        let req = request(&messages, &[]);
        let body = build_responses_body(&req, &config());
        assert_eq!(body["input"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn reasoning_signature_roundtrips() {
        let sig = encode_reasoning_signature("rs_abc", "opaque==");
        let (id, enc) = decode_reasoning_signature(&sig).expect("decode");
        assert_eq!(id, "rs_abc");
        assert_eq!(enc, "opaque==");
        assert!(decode_reasoning_signature("not json").is_none());
    }

    fn sse(events: &[Value]) -> Vec<Result<Vec<u8>, std::io::Error>> {
        events
            .iter()
            .map(|e| {
                let name = e["type"].as_str().unwrap_or("");
                Ok(format!("event: {name}\ndata: {e}\n\n").into_bytes())
            })
            .collect()
    }

    #[tokio::test]
    async fn drives_text_reasoning_and_tool_call_stream() {
        let events = vec![
            json!({"type":"response.created","response":{"id":"resp_1"}}),
            json!({"type":"response.output_item.added","output_index":0,
                   "item":{"type":"reasoning","id":"rs_1","summary":[]}}),
            json!({"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"thinking…"}),
            json!({"type":"response.output_item.done","output_index":0,
                   "item":{"type":"reasoning","id":"rs_1",
                           "summary":[{"type":"summary_text","text":"thinking…"}],
                           "encrypted_content":"ENC"}}),
            json!({"type":"response.output_item.added","output_index":1,
                   "item":{"type":"message","id":"msg_1","role":"assistant"}}),
            json!({"type":"response.output_text.delta","item_id":"msg_1","delta":"Hel"}),
            json!({"type":"response.output_text.delta","item_id":"msg_1","delta":"lo"}),
            json!({"type":"response.output_item.added","output_index":2,
                   "item":{"type":"function_call","id":"fc_1","call_id":"call_9",
                           "name":"file_read","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"path\":"}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\"a.rs\"}"}),
            json!({"type":"response.output_item.done","output_index":2,
                   "item":{"type":"function_call","id":"fc_1","call_id":"call_9",
                           "name":"file_read","arguments":"{\"path\":\"a.rs\"}"}}),
            json!({"type":"response.completed",
                   "response":{"status":"completed",
                               "usage":{"input_tokens":100,"output_tokens":25,
                                        "input_tokens_details":{"cached_tokens":40}}}}),
        ];

        let (tx, mut rx) = mpsc::channel::<AssistantEvent>(64);
        let result =
            drive_responses_stream(stream::iter(sse(&events)), tx, CancellationToken::new())
                .await
                .expect("stream drives cleanly");

        assert_eq!(result.stop_reason, "tool_use");
        // Cached tokens are a subset → subtracted from input.
        assert_eq!(result.usage.input_tokens, 60);
        assert_eq!(result.usage.output_tokens, 25);
        assert_eq!(result.usage.cache_read_input_tokens, Some(40));

        let blocks = &result.assistant_message.blocks;
        assert_eq!(
            blocks.len(),
            3,
            "thinking + text + tool_use, got {blocks:?}"
        );
        match &blocks[0] {
            ContentBlock::Thinking {
                text, signature, ..
            } => {
                assert_eq!(text, "thinking…");
                let sig = signature.as_deref().expect("encrypted signature persisted");
                let (id, enc) = decode_reasoning_signature(sig).expect("our format");
                assert_eq!(id, "rs_1");
                assert_eq!(enc, "ENC");
            }
            other => panic!("expected thinking, got {other:?}"),
        }
        assert_eq!(
            blocks[1],
            ContentBlock::Text {
                text: "Hello".into()
            }
        );
        match &blocks[2] {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "call_9");
                assert_eq!(name, "file_read");
                assert_eq!(input, &json!({"path":"a.rs"}));
            }
            other => panic!("expected tool_use, got {other:?}"),
        }

        // Event ordering: thinking → text deltas → tool delta/use → usage → stop.
        let mut saw_thinking = false;
        let mut saw_text = false;
        let mut saw_tool_use = false;
        let mut saw_stop = false;
        while let Some(ev) = rx.recv().await {
            match ev {
                AssistantEvent::Thinking { .. } => saw_thinking = true,
                AssistantEvent::TextDelta { .. } => saw_text = true,
                AssistantEvent::ToolUse { ref name, .. } => {
                    assert_eq!(name, "file_read");
                    saw_tool_use = true;
                }
                AssistantEvent::MessageStop { ref stop_reason } => {
                    assert_eq!(stop_reason, "tool_use");
                    saw_stop = true;
                }
                _ => {}
            }
        }
        assert!(saw_thinking && saw_text && saw_tool_use && saw_stop);
    }

    #[tokio::test]
    async fn incomplete_response_maps_to_max_tokens() {
        let events = vec![
            json!({"type":"response.output_item.added","output_index":0,
                   "item":{"type":"message","id":"msg_1","role":"assistant"}}),
            json!({"type":"response.output_text.delta","item_id":"msg_1","delta":"truncat"}),
            json!({"type":"response.incomplete",
                   "response":{"status":"incomplete",
                               "incomplete_details":{"reason":"max_output_tokens"},
                               "usage":{"input_tokens":10,"output_tokens":5}}}),
        ];
        let (tx, _rx) = mpsc::channel::<AssistantEvent>(64);
        let result =
            drive_responses_stream(stream::iter(sse(&events)), tx, CancellationToken::new())
                .await
                .expect("stream drives cleanly");
        assert_eq!(result.stop_reason, "max_tokens");
    }

    #[tokio::test]
    async fn failed_response_surfaces_provider_error() {
        let events = vec![json!({
            "type":"response.failed",
            "response":{"status":"failed","error":{"code":"server_error","message":"boom"}}
        })];
        let (tx, _rx) = mpsc::channel::<AssistantEvent>(64);
        let err = drive_responses_stream(stream::iter(sse(&events)), tx, CancellationToken::new())
            .await
            .expect_err("must fail");
        match err {
            ApiError::Provider(msg) => assert!(msg.contains("boom")),
            other => panic!("expected Provider error, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod stream_error_tests {
    use super::*;
    use serde_json::json;

    /// OpenAI's documented shape: `message` at the top level of the event.
    #[test]
    fn reads_top_level_message() {
        let ev =
            json!({"type": "error", "code": "server_error", "message": "The model is overloaded"});
        assert_eq!(stream_error_message(&ev), "The model is overloaded");
    }

    /// The shape that produced the bare "stream error" incident: a relay
    /// nesting the detail under `error.message` (Anthropic-proxy style).
    /// The old top-level-only extraction discarded it.
    #[test]
    fn reads_nested_error_message() {
        let ev = json!({"type": "error", "error": {"message": "upstream timeout after 60s", "code": "504"}});
        assert_eq!(stream_error_message(&ev), "upstream timeout after 60s");
    }

    /// Some gateways send `error` as a bare string.
    #[test]
    fn reads_bare_string_error() {
        let ev = json!({"type": "error", "error": "quota exceeded"});
        assert_eq!(stream_error_message(&ev), "quota exceeded");
    }

    /// Only a code, no prose — still better than a constant.
    #[test]
    fn falls_back_to_code() {
        let ev = json!({"type": "error", "error": {"code": "rate_limited"}});
        assert_eq!(
            stream_error_message(&ev),
            "provider error code: rate_limited"
        );
    }

    /// Nothing recognisable → the raw event itself, never a bare constant.
    /// This is the arm that replaces the old `unwrap_or("stream error")`.
    #[test]
    fn unknown_shape_carries_the_raw_event() {
        let ev = json!({"type": "error", "detail": {"reason": "backend exploded"}});
        let msg = stream_error_message(&ev);
        assert!(msg.starts_with("provider error event: "));
        assert!(msg.contains("backend exploded"));
    }

    /// `response.failed` extraction goes through the same helper, rooted at
    /// the `response` object.
    #[test]
    fn response_failed_shape_resolves_via_response_object() {
        let ev = json!({"type": "response.failed", "response": {"error": {"message": "content policy"}}});
        let msg = ev
            .get("response")
            .map(stream_error_message)
            .unwrap_or_else(|| stream_error_message(&ev));
        assert_eq!(msg, "content policy");
    }

    /// Whitespace-only messages don't count as detail.
    #[test]
    fn blank_message_is_skipped() {
        let ev = json!({"type": "error", "message": "  ", "error": {"message": "real reason"}});
        assert_eq!(stream_error_message(&ev), "real reason");
    }
}

#[cfg(test)]
mod rejection_tests {
    use super::*;
    use crate::agent_runtime::types::ConversationMessage;

    /// A provider that rejects a body with a byte offset gives us nothing to
    /// act on unless we quote what we sent there. This is the whole point of
    /// the diagnostic.
    #[test]
    fn a_rejection_quotes_the_body_at_the_reported_offset() {
        let sent = format!("{}NEEDLE_AT_THE_OFFSET{}", "x".repeat(500), "y".repeat(500));
        let error = "did not match any variant of untagged enum ResponseInput at line 1 column 505";
        let detail = describe_rejected_body(&sent, error);
        assert!(detail.contains("NEEDLE_AT_THE_OFFSET"), "got: {detail}");
        assert!(detail.contains("rejected byte 505"));
    }

    /// A window, never the whole body: one screenshot makes the request
    /// megabytes of base64 and dumping it buries the answer.
    #[test]
    fn the_quoted_window_stays_small() {
        let sent = "z".repeat(2_000_000);
        let detail = describe_rejected_body(&sent, "bad input at line 1 column 1000000");
        assert!(detail.len() < 1_000, "window was {} chars", detail.len());
    }

    /// Multi-byte characters must not panic the slice.
    #[test]
    fn a_multibyte_body_does_not_panic() {
        let sent = "é".repeat(500); // 1000 bytes, 500 chars
        let detail = describe_rejected_body(&sent, "bad at line 1 column 501");
        assert!(!detail.is_empty());
    }

    /// No offset, an offset past the end, or an offset on another line: say
    /// nothing rather than point somewhere misleading.
    #[test]
    fn an_unusable_offset_adds_nothing() {
        assert_eq!(describe_rejected_body("abc", "some other failure"), "");
        assert_eq!(describe_rejected_body("abc", "at line 1 column 9999"), "");
        assert_eq!(
            describe_rejected_body("abc", "at line 4 column 2"),
            "",
            "an offset on another line is not describing what we sent"
        );
    }

    #[test]
    fn parse_error_column_reads_the_offset() {
        assert_eq!(parse_error_column("… at line 1 column 39956"), Some(39956));
        assert_eq!(parse_error_column("no offset here"), None);
        assert_eq!(parse_error_column("column "), None);
    }

    /// OpenAI infers `type` on a message item; strict reimplementations of the
    /// Responses shape match an untagged union by its discriminator and reject
    /// the whole request without it.
    #[test]
    fn every_message_item_states_its_type() {
        let messages = vec![
            ConversationMessage::user_text("hello", 0),
            ConversationMessage::assistant(
                vec![ContentBlock::Text {
                    text: "hi back".into(),
                }],
                1,
            ),
        ];
        let request = ApiRequest {
            model: "m",
            messages: &messages,
            system_prompt: None,
            tools: &[],
            temperature: None,
            max_output_tokens: 1024,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: None,
            volatile_tail_messages: 0,
        };
        let (_, items) = responses_instructions_and_input(&request, false);
        assert!(!items.is_empty());
        for item in &items {
            let kind = item.get("type").and_then(Value::as_str);
            assert!(
                kind.is_some(),
                "every input item needs a discriminator, got {item}"
            );
            if item.get("role").is_some() {
                assert_eq!(kind, Some("message"), "message items must say so: {item}");
            }
        }
    }

    /// A mid-turn injected message with an `<aurora_image>` marker must land
    /// in the trailing user item as a real `input_image` part (screenshot
    /// parity), never as base64 inside `input_text`.
    #[test]
    fn injected_image_marker_becomes_input_image_part() {
        let messages = vec![ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![
                ContentBlock::ToolResult {
                    tool_use_id: "call_1".into(),
                    content: "lint passed".into(),
                    is_error: None,
                },
                ContentBlock::Text {
                    text: "match this mockup\n\
                        <aurora_image media_type=\"image/png\">QUJD</aurora_image>"
                        .into(),
                },
            ],
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            model: None,
        }];
        let request = ApiRequest {
            model: "m",
            messages: &messages,
            system_prompt: None,
            tools: &[],
            temperature: None,
            max_output_tokens: 1024,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: None,
            volatile_tail_messages: 0,
        };

        let (_, items) = responses_instructions_and_input(&request, true);
        let trailing = items.last().expect("trailing user item");
        assert_eq!(trailing["role"], "user");
        let parts = trailing["content"].as_array().expect("content parts");
        assert!(
            parts.iter().any(|p| p["type"] == "input_text"
                && p["text"]
                    .as_str()
                    .unwrap_or("")
                    .contains("match this mockup")),
            "typed text survives as input_text"
        );
        assert!(
            parts.iter().any(|p| p["type"] == "input_image"),
            "the marker becomes input_image, got {parts:?}"
        );

        // Non-vision: placeholder, never raw base64.
        let (_, items) = responses_instructions_and_input(&request, false);
        let trailing = items.last().expect("trailing user item");
        let text = trailing["content"].as_array().expect("parts")[0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        assert!(!text.contains("QUJD"), "no raw base64 for non-vision");
    }
}

#[cfg(test)]
mod locator_tests {
    use super::*;

    fn body(items: &[&str]) -> String {
        format!(
            "{{\"model\":\"m\",\"input\":[{}],\"stream\":true}}",
            items.join(",")
        )
    }

    #[test]
    fn it_names_the_item_the_offset_lands_in() {
        let sent = body(&[
            r#"{"type":"message","role":"user","content":[]}"#,
            r#"{"type":"function_call","call_id":"c1","name":"file_read","arguments":"{}"}"#,
            r#"{"type":"function_call_output","call_id":"c1","output":"NEEDLE"}"#,
        ]);
        let column = sent.find("NEEDLE").expect("needle present");
        let detail = describe_rejected_item(&sent, column).expect("located");
        assert!(detail.contains("item 3 of 3"), "got: {detail}");
        assert!(
            detail.contains("type=function_call_output"),
            "got: {detail}"
        );
        assert!(detail.contains("call_id"), "fields listed: {detail}");
    }

    /// The single most useful thing it can report: an item with no `type`,
    /// which is exactly what a strict untagged union rejects.
    #[test]
    fn an_item_missing_its_type_says_so_loudly() {
        let sent = body(&[r#"{"role":"user","content":[{"type":"input_text","text":"hi"}]}"#]);
        let column = sent.find("input_text").expect("present");
        let detail = describe_rejected_item(&sent, column).expect("located");
        assert!(detail.contains("no `type` field"), "got: {detail}");
    }

    /// serde's untagged enums buffer the whole value before failing, so the
    /// reported offset usually sits at the END of the offending item.
    #[test]
    fn an_offset_at_an_item_boundary_resolves_to_that_item() {
        let sent = body(&[
            r#"{"type":"function_call","call_id":"c1","name":"n","arguments":"{}"}"#,
            r#"{"type":"function_call_output","call_id":"c1","output":"x"}"#,
        ]);
        let spans = input_item_spans(&sent);
        assert_eq!(spans.len(), 2);
        let detail = describe_rejected_item(&sent, spans[0].1).expect("located");
        assert!(detail.contains("item 1 of 2"), "got: {detail}");
    }

    /// Braces and quotes inside a tool result's JSON payload are DATA. A naive
    /// depth counter would split items in the middle of a file path — and this
    /// app's payloads are full of escaped Windows backslashes.
    #[test]
    fn json_and_escapes_inside_a_tool_output_do_not_split_items() {
        // Built with `to_string` rather than hand-escaped: the fixture is then
        // a genuinely-escaped payload instead of one I typed and got wrong.
        // This is the real shape — a file tool's result is JSON inside the
        // `output` STRING, full of braces, quotes and Windows backslashes.
        let payload = json!({
            "fullPath": "E:\\repo\\README.md",
            "items": [1, 2],
        })
        .to_string();
        let output_item = json!({
            "type": "function_call_output",
            "call_id": "c1",
            "output": payload,
        })
        .to_string();
        let sent = body(&[
            &output_item,
            r#"{"type":"message","role":"user","content":[]}"#,
        ]);
        let spans = input_item_spans(&sent);
        assert_eq!(spans.len(), 2, "payload braces must not create items");
        let column = sent.find("README").expect("present");
        let detail = describe_rejected_item(&sent, column).expect("located");
        assert!(detail.contains("item 1 of 2"), "got: {detail}");
    }

    /// Field VALUES are never echoed — a tool result can carry file contents.
    #[test]
    fn it_reports_field_sizes_never_field_values() {
        let secret = "SUPER_SECRET_FILE_CONTENTS";
        let sent = body(&[&format!(
            r#"{{"type":"function_call_output","call_id":"c1","output":"{secret}"}}"#
        )]);
        let column = sent.find(secret).expect("present");
        let detail = describe_rejected_item(&sent, column).expect("located");
        assert!(!detail.contains(secret), "must not echo values: {detail}");
        assert!(
            detail.contains("output ("),
            "must report the size: {detail}"
        );
    }

    #[test]
    fn an_offset_outside_every_item_reports_nothing() {
        let sent = body(&[r#"{"type":"message","role":"user","content":[]}"#]);
        assert!(describe_rejected_item(&sent, sent.len() - 1).is_none());
        assert!(describe_rejected_item("not json at all", 3).is_none());
    }
}
