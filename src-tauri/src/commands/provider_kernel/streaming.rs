//! Streaming SSE plumbing for `aurora_provider_stream`.
//!
//! Phase-5 hardening (see `docs/plan/rust-agent-migration.md`) replaces the
//! original line-oriented, lossy-UTF-8 parser and bool-flag cancellation with:
//!
//! * a byte-level frame splitter (`SseFrameBuffer`) that preserves multi-byte
//!   UTF-8 sequences across `Bytes` chunk boundaries and splits on the proper
//!   SSE frame terminator (`\n\n` / `\r\n\r\n`),
//! * `tokio_util::sync::CancellationToken` so cancellation interrupts the
//!   stream future inside a single `tokio::select!` instead of waiting for
//!   the next chunk,
//! * Anthropic `signature_delta` accumulation, emitted on
//!   `aurora-provider-thinking-signature-{request_id}` so the frontend can
//!   echo the signature back on the next turn.

use super::parsers::anthropic_usage_to_aurora;
use super::types::{
    AnthropicStreamEvent, AuroraStreamChunk, AuroraStreamToolCall, AuroraThinkingSignature,
    AuroraToolCall, AuroraToolFunction, AuroraUsage, OpenAiStreamingResponse,
};
use futures_util::StreamExt;
use parking_lot::RwLock;
use std::collections::HashMap;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

lazy_static::lazy_static! {
    static ref ACTIVE_PROVIDER_STREAMS: RwLock<HashMap<String, CancellationToken>> =
        RwLock::new(HashMap::new());
}

/// Register a new in-flight stream and return the cancellation token tied to
/// its `request_id`. The caller hands the token to the streaming function and
/// keeps a copy in the registry so `cancel_aurora_provider_stream` can
/// `.cancel()` it from the IPC layer.
pub(crate) fn register_stream(request_id: &str) -> CancellationToken {
    let token = CancellationToken::new();
    let mut streams = ACTIVE_PROVIDER_STREAMS.write();
    streams.insert(request_id.to_string(), token.clone());
    token
}

/// Cancel the stream registered under `request_id`. The streaming loop
/// observes this through its `tokio::select!` arm and returns immediately
/// instead of waiting for the next chunk.
pub(crate) fn cancel_stream(request_id: &str) {
    let streams = ACTIVE_PROVIDER_STREAMS.read();
    if let Some(token) = streams.get(request_id) {
        token.cancel();
    }
}

pub(crate) fn cleanup_stream(request_id: &str) {
    let mut streams = ACTIVE_PROVIDER_STREAMS.write();
    streams.remove(request_id);
}

/// Byte-level SSE frame buffer.
///
/// Owns a `Vec<u8>` that accumulates raw `Bytes` chunks pulled from the
/// `reqwest` response stream. `take_frames` drains all complete frames
/// terminated by `\n\n` or `\r\n\r\n`, returning each as a `String`. Bytes
/// past the last terminator stay in the buffer for the next chunk so
/// multi-byte UTF-8 codepoints split across two chunks reassemble cleanly.
pub(crate) struct SseFrameBuffer {
    buffer: Vec<u8>,
}

impl SseFrameBuffer {
    pub(crate) fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub(crate) fn extend(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// Drain all complete frames currently sitting in the buffer.
    pub(crate) fn take_frames(&mut self) -> Vec<String> {
        let mut frames = Vec::new();
        loop {
            let separator = self
                .buffer
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|position| (position, 2))
                .or_else(|| {
                    self.buffer
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|position| (position, 4))
                });

            let Some((position, separator_len)) = separator else {
                break;
            };

            let frame_bytes: Vec<u8> = self.buffer.drain(..position + separator_len).collect();
            let frame_len = frame_bytes.len().saturating_sub(separator_len);
            // SSE frames are always UTF-8 in practice. `from_utf8_lossy` keeps
            // us robust to badly-behaved providers without panicking.
            let frame = String::from_utf8_lossy(&frame_bytes[..frame_len]).into_owned();
            frames.push(frame);
        }
        frames
    }

    #[cfg(test)]
    pub(crate) fn pending_len(&self) -> usize {
        self.buffer.len()
    }
}

impl Default for SseFrameBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-frame `data:` payload extractor.
///
/// Walks the lines of a single SSE frame, ignores comments and `event:`
/// lines, and returns the parsed JSON payload from each `data:` line. SSE
/// allows multiple `data:` lines per frame; we surface them as separate
/// payloads to preserve the historical line-oriented behavior of Aurora's
/// provider kernel — providers like OpenAI and Anthropic emit at most one
/// `data:` per frame, so this is never observable in practice.
pub(crate) fn frame_payloads(frame: &str) -> Vec<String> {
    let mut payloads = Vec::new();
    for line in frame.split('\n') {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.is_empty() || trimmed.starts_with(':') {
            continue;
        }

        let payload = if let Some(rest) = trimmed.strip_prefix("data: ") {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("data:") {
            rest.trim_start()
        } else {
            continue;
        };

        if payload == "[DONE]" {
            continue;
        }

        payloads.push(payload.to_string());
    }
    payloads
}

pub(crate) async fn stream_openai_compatible(
    app: tauri::AppHandle,
    request_id: &str,
    response: reqwest::Response,
    cancel_token: CancellationToken,
) -> Result<(), String> {
    let mut stream = response.bytes_stream();
    let mut frames = SseFrameBuffer::new();
    let mut tool_calls: HashMap<i32, AuroraToolCall> = HashMap::new();
    let mut finish_reason = None;

    loop {
        let chunk_result = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                return Err("Request cancelled".to_string());
            }
            next = stream.next() => match next {
                Some(result) => result,
                None => break,
            }
        };

        let chunk = match chunk_result {
            Ok(chunk) => chunk,
            Err(error) => {
                let message = format!("stream error: {error}");
                emit_error(&app, request_id, &message);
                return Err(message);
            }
        };

        frames.extend(&chunk);

        for frame in frames.take_frames() {
            for payload in frame_payloads(&frame) {
                let parsed: OpenAiStreamingResponse = match serde_json::from_str(&payload) {
                    Ok(parsed) => parsed,
                    Err(_) => continue,
                };

                if let Some(usage) = parsed.usage {
                    let _ = app.emit(
                        &format!("aurora-provider-usage-{request_id}"),
                        AuroraUsage {
                            cache_read_tokens: None,
                            cache_write_tokens: None,
                            completion_tokens: usage.completion_tokens,
                            prompt_tokens: usage.prompt_tokens,
                            total_tokens: usage.total_tokens,
                        },
                    );
                }

                for choice in parsed.choices {
                    let delta = choice.delta;
                    let reasoning_content = delta.reasoning.or(delta.reasoning_content);
                    let content = delta.content;
                    let mut emitted_tool_calls = Vec::new();

                    if let Some(delta_tool_calls) = delta.tool_calls {
                        for delta_tool_call in delta_tool_calls {
                            let entry =
                                tool_calls.entry(delta_tool_call.index).or_insert_with(|| {
                                    AuroraToolCall {
                                        function: AuroraToolFunction {
                                            arguments: String::new(),
                                            name: String::new(),
                                        },
                                        id: delta_tool_call.id.clone().unwrap_or_else(|| {
                                            format!("tool_{}", delta_tool_call.index)
                                        }),
                                        tool_type: "function".to_string(),
                                    }
                                });

                            if let Some(id) = delta_tool_call.id {
                                entry.id = id;
                            }

                            if let Some(function) = delta_tool_call.function {
                                if let Some(name) = function.name {
                                    entry.function.name = name.clone();
                                }
                                if let Some(arguments) = function.arguments {
                                    entry.function.arguments.push_str(&arguments);
                                    emitted_tool_calls.push(AuroraStreamToolCall {
                                        function_arguments: Some(arguments),
                                        function_name: if entry.function.name.is_empty() {
                                            None
                                        } else {
                                            Some(entry.function.name.clone())
                                        },
                                        id: Some(entry.id.clone()),
                                        index: delta_tool_call.index,
                                    });
                                } else {
                                    emitted_tool_calls.push(AuroraStreamToolCall {
                                        function_arguments: None,
                                        function_name: if entry.function.name.is_empty() {
                                            None
                                        } else {
                                            Some(entry.function.name.clone())
                                        },
                                        id: Some(entry.id.clone()),
                                        index: delta_tool_call.index,
                                    });
                                }
                            }
                        }
                    }

                    if choice.finish_reason.is_some() {
                        finish_reason = choice.finish_reason.clone();
                    }

                    let _ = app.emit(
                        &format!("aurora-provider-chunk-{request_id}"),
                        AuroraStreamChunk {
                            content,
                            done: false,
                            finish_reason: choice.finish_reason,
                            reasoning_content,
                            tool_calls: if emitted_tool_calls.is_empty() {
                                None
                            } else {
                                Some(emitted_tool_calls)
                            },
                        },
                    );
                }
            }
        }
    }

    emit_done(&app, request_id, finish_reason);
    Ok(())
}

pub(crate) async fn stream_anthropic_compatible(
    app: tauri::AppHandle,
    request_id: &str,
    response: reqwest::Response,
    cancel_token: CancellationToken,
) -> Result<(), String> {
    let mut stream = response.bytes_stream();
    let mut frames = SseFrameBuffer::new();
    let mut tool_calls: HashMap<i32, AuroraToolCall> = HashMap::new();
    let mut thinking_signatures: HashMap<i32, String> = HashMap::new();

    loop {
        let chunk_result = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                return Err("Request cancelled".to_string());
            }
            next = stream.next() => match next {
                Some(result) => result,
                None => break,
            }
        };

        let chunk = match chunk_result {
            Ok(chunk) => chunk,
            Err(error) => {
                let message = format!("stream error: {error}");
                emit_error(&app, request_id, &message);
                return Err(message);
            }
        };

        frames.extend(&chunk);

        for frame in frames.take_frames() {
            for payload in frame_payloads(&frame) {
                let event: AnthropicStreamEvent = match serde_json::from_str(&payload) {
                    Ok(event) => event,
                    Err(_) => continue,
                };

                handle_anthropic_event(
                    &app,
                    request_id,
                    event,
                    &mut tool_calls,
                    &mut thinking_signatures,
                );
            }
        }
    }

    emit_done(&app, request_id, Some("end_turn".to_string()));
    Ok(())
}

/// Process a single decoded Anthropic stream event and emit any frontend
/// notifications it implies. Pure-ish helper that operates on the streaming
/// state `HashMap`s — separated from the I/O loop so the signature accumulator
/// is easy to drive from unit tests.
fn handle_anthropic_event(
    app: &tauri::AppHandle,
    request_id: &str,
    event: AnthropicStreamEvent,
    tool_calls: &mut HashMap<i32, AuroraToolCall>,
    thinking_signatures: &mut HashMap<i32, String>,
) {
    match event.event_type.as_str() {
        "message_start" => {
            if let Some(usage) = event.message.and_then(|message| message.usage) {
                let _ = app.emit(
                    &format!("aurora-provider-usage-{request_id}"),
                    anthropic_usage_to_aurora(&usage),
                );
            }
        }
        "content_block_start" => {
            let Some(index) = event.index else { return };
            if let Some(content_block) = event.content_block {
                if content_block.block_type == "tool_use" {
                    let tool_call = AuroraToolCall {
                        function: AuroraToolFunction {
                            arguments: String::new(),
                            name: content_block.name.unwrap_or_default(),
                        },
                        id: content_block.id.unwrap_or_else(|| format!("tool_{index}")),
                        tool_type: "function".to_string(),
                    };
                    tool_calls.insert(index, tool_call.clone());
                    let _ = app.emit(
                        &format!("aurora-provider-chunk-{request_id}"),
                        AuroraStreamChunk {
                            content: None,
                            done: false,
                            finish_reason: None,
                            reasoning_content: None,
                            tool_calls: Some(vec![AuroraStreamToolCall {
                                function_arguments: None,
                                function_name: Some(tool_call.function.name),
                                id: Some(tool_call.id),
                                index,
                            }]),
                        },
                    );
                }
                if content_block.block_type == "thinking" {
                    // Reset accumulator for this block; signature_delta values
                    // arrive next.
                    thinking_signatures.entry(index).or_default().clear();
                }
            }
        }
        "content_block_delta" => {
            let Some(index) = event.index else { return };
            let Some(delta) = event.delta else { return };

            match delta.delta_type.as_str() {
                "text_delta" => {
                    if let Some(text) = delta.text {
                        let _ = app.emit(
                            &format!("aurora-provider-chunk-{request_id}"),
                            AuroraStreamChunk {
                                content: Some(text),
                                done: false,
                                finish_reason: None,
                                reasoning_content: None,
                                tool_calls: None,
                            },
                        );
                    }
                }
                "thinking_delta" => {
                    if let Some(thinking) = delta.thinking {
                        let _ = app.emit(
                            &format!("aurora-provider-chunk-{request_id}"),
                            AuroraStreamChunk {
                                content: None,
                                done: false,
                                finish_reason: None,
                                reasoning_content: Some(thinking),
                                tool_calls: None,
                            },
                        );
                    }
                }
                "signature_delta" => {
                    if let Some(signature_chunk) = delta.signature {
                        let entry = thinking_signatures.entry(index).or_default();
                        entry.push_str(&signature_chunk);
                        let _ = app.emit(
                            &format!("aurora-provider-thinking-signature-{request_id}"),
                            AuroraThinkingSignature {
                                index,
                                signature: entry.clone(),
                            },
                        );
                    }
                }
                "input_json_delta" => {
                    if let Some(partial_json) = delta.partial_json {
                        if let Some(tool_call) = tool_calls.get_mut(&index) {
                            tool_call.function.arguments.push_str(&partial_json);
                            let _ = app.emit(
                                &format!("aurora-provider-chunk-{request_id}"),
                                AuroraStreamChunk {
                                    content: None,
                                    done: false,
                                    finish_reason: None,
                                    reasoning_content: None,
                                    tool_calls: Some(vec![AuroraStreamToolCall {
                                        function_arguments: Some(partial_json),
                                        function_name: Some(tool_call.function.name.clone()),
                                        id: Some(tool_call.id.clone()),
                                        index,
                                    }]),
                                },
                            );
                        }
                    }
                }
                _ => {}
            }
        }
        "message_delta" => {
            if let Some(usage) = event.usage {
                let _ = app.emit(
                    &format!("aurora-provider-usage-{request_id}"),
                    anthropic_usage_to_aurora(&usage),
                );
            }
        }
        _ => {}
    }
}

pub(crate) fn emit_error(app: &tauri::AppHandle, request_id: &str, message: &str) {
    let _ = app.emit(
        &format!("aurora-provider-error-{request_id}"),
        message.to_string(),
    );
}

fn emit_done(app: &tauri::AppHandle, request_id: &str, finish_reason: Option<String>) {
    let _ = app.emit(
        &format!("aurora-provider-chunk-{request_id}"),
        AuroraStreamChunk {
            content: None,
            done: true,
            finish_reason,
            reasoning_content: None,
            tool_calls: None,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::Duration;

    // -----------------------------------------------------------------------
    // Bug 1 — frame splitting / UTF-8 chunk boundaries
    // -----------------------------------------------------------------------

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
        // First chunk: half a frame, no terminator.
        let mut buf = SseFrameBuffer::new();
        buf.extend(b"data: {\"hel");
        let first = buf.take_frames();
        assert!(first.is_empty(), "no complete frame yet");
        assert!(buf.pending_len() > 0);

        // Second chunk completes the frame.
        buf.extend(b"lo\":\"world\"}\n\n");
        let frames = buf.take_frames();
        assert_eq!(frames.len(), 1);
        let payloads = frame_payloads(&frames[0]);
        assert_eq!(payloads, vec![r#"{"hello":"world"}"#.to_string()]);
    }

    #[test]
    fn frame_buffer_handles_crlf_terminator() {
        let mut buf = SseFrameBuffer::new();
        buf.extend(b"data: {\"a\":1}\r\n\r\n");
        let frames = buf.take_frames();
        assert_eq!(frames.len(), 1);
        let payloads = frame_payloads(&frames[0]);
        assert_eq!(payloads, vec![r#"{"a":1}"#.to_string()]);
    }

    #[test]
    fn frame_buffer_handles_multi_data_frame() {
        // SSE allows multiple data: lines per frame. We surface each one as
        // its own payload so the streaming loop processes them independently.
        let mut buf = SseFrameBuffer::new();
        buf.extend(b"data: {\"a\":1}\ndata: {\"b\":2}\n\n");
        let frames = buf.take_frames();
        assert_eq!(frames.len(), 1);
        let payloads = frame_payloads(&frames[0]);
        assert_eq!(
            payloads,
            vec![r#"{"a":1}"#.to_string(), r#"{"b":2}"#.to_string()]
        );
    }

    #[test]
    fn frame_buffer_reassembles_multibyte_emoji_split_across_chunks() {
        // 🚀 = U+1F680 = `F0 9F 9A 80` in UTF-8 (4 bytes).
        // Split it across two arrivals; the buffer must keep the leading
        // bytes around until the trailing bytes turn up, then decode the
        // codepoint cleanly. A `from_utf8_lossy` on the raw chunk would
        // emit a replacement char here.
        let emoji = "🚀";
        let bytes = emoji.as_bytes();
        assert_eq!(bytes.len(), 4);

        let mut buf = SseFrameBuffer::new();
        let mut first = Vec::new();
        first.extend_from_slice(b"data: \"");
        first.extend_from_slice(&bytes[..2]); // half the emoji
        buf.extend(&first);
        // No frame yet: no terminator and trailing bytes still missing.
        assert!(buf.take_frames().is_empty());

        let mut second = Vec::new();
        second.extend_from_slice(&bytes[2..]); // remaining half
        second.extend_from_slice(b"\"\n\n");
        buf.extend(&second);

        let frames = buf.take_frames();
        assert_eq!(frames.len(), 1);
        let payloads = frame_payloads(&frames[0]);
        assert_eq!(payloads.len(), 1);
        let parsed: Value = serde_json::from_str(&payloads[0]).expect("valid JSON string");
        assert_eq!(parsed.as_str(), Some("🚀"));
    }

    #[test]
    fn frame_payloads_skips_done_marker() {
        let frame = "data: [DONE]";
        assert!(frame_payloads(frame).is_empty());
    }

    #[test]
    fn frame_payloads_skips_event_and_comment_lines() {
        let frame = ":keepalive\nevent: message_delta\ndata: {\"x\":1}\n";
        assert_eq!(frame_payloads(frame), vec![r#"{"x":1}"#.to_string()]);
    }

    // -----------------------------------------------------------------------
    // Bug 2 — cancellation token returns within one iteration
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn cancellation_token_unblocks_select_immediately() {
        // Surrogate for the streaming loop: a `tokio::select!` between a
        // cancellation token and a future that never resolves. After we
        // call `.cancel()`, the select must complete inside the test
        // timeout regardless of how long the "stream" would have taken.
        let token = CancellationToken::new();
        let token_for_canceller = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            token_for_canceller.cancel();
        });

        let result = tokio::time::timeout(Duration::from_secs(2), async move {
            tokio::select! {
                biased;
                _ = token.cancelled() => "cancelled",
                _ = std::future::pending::<()>() => "pending",
            }
        })
        .await;

        let outcome = result.expect("select did not return within timeout");
        assert_eq!(outcome, "cancelled");
    }

    #[tokio::test]
    async fn register_and_cancel_stream_round_trip() {
        // Verifies the public registry surface: register a stream, cancel
        // by id, and observe the token cancellation status flip.
        let token = register_stream("test-cancel-1");
        assert!(!token.is_cancelled());
        cancel_stream("test-cancel-1");
        // Wait one scheduler tick for `cancel()` to propagate.
        tokio::task::yield_now().await;
        assert!(token.is_cancelled());
        cleanup_stream("test-cancel-1");
    }

    // -----------------------------------------------------------------------
    // Bug 3 — Anthropic signature_delta accumulation
    // -----------------------------------------------------------------------

    /// Hand-crafted Anthropic SSE stream containing a `thinking` content
    /// block whose signature is delivered via two `signature_delta` events.
    /// Real captures from claw-code's fixtures directory are not present in
    /// this checkout, so the constant below stands in.
    const ANTHROPIC_SIGNATURE_STREAM: &str = "\
event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":5,\"output_tokens\":0}}}\n\
\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"step 1\"}}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig_a\"}}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig_b\"}}\n\
\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\
\n\
data: [DONE]\n\
\n";

    /// Drive the parser end-to-end on the fixture stream and accumulate the
    /// signature exactly the way `handle_anthropic_event` would, but without
    /// emitting Tauri events (no `AppHandle` is available in unit tests).
    /// Returns the accumulated signature buffer.
    fn collect_signatures(stream: &str) -> HashMap<i32, String> {
        let mut buf = SseFrameBuffer::new();
        buf.extend(stream.as_bytes());
        let frames = buf.take_frames();

        let mut signatures: HashMap<i32, String> = HashMap::new();

        for frame in frames {
            for payload in frame_payloads(&frame) {
                let event: AnthropicStreamEvent = match serde_json::from_str(&payload) {
                    Ok(event) => event,
                    Err(_) => continue,
                };

                match event.event_type.as_str() {
                    "content_block_start" => {
                        if let (Some(index), Some(block)) = (event.index, event.content_block) {
                            if block.block_type == "thinking" {
                                signatures.entry(index).or_default().clear();
                            }
                        }
                    }
                    "content_block_delta" => {
                        let Some(index) = event.index else { continue };
                        let Some(delta) = event.delta else { continue };
                        if delta.delta_type == "signature_delta" {
                            if let Some(chunk) = delta.signature {
                                signatures.entry(index).or_default().push_str(&chunk);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        signatures
    }

    #[test]
    fn signature_delta_events_accumulate_into_active_thinking_block() {
        let signatures = collect_signatures(ANTHROPIC_SIGNATURE_STREAM);
        assert_eq!(
            signatures.get(&0).map(String::as_str),
            Some("sig_asig_b"),
            "expected the two signature_delta chunks to concatenate"
        );
    }

    #[test]
    fn signature_delta_field_round_trips_through_anthropic_delta() {
        // Sanity check that the `signature` field on `AnthropicDelta` is in
        // fact deserialized — without this, the parsing arm above would
        // silently see `delta.signature == None` and the accumulator stays
        // empty, which is exactly the bug we're fixing.
        let payload =
            r#"{"type":"signature_delta","signature":"sig_xyz","thinking":null,"text":null,"partial_json":null}"#;
        let delta: super::super::types::AnthropicDelta =
            serde_json::from_str(payload).expect("delta should parse");
        assert_eq!(delta.delta_type, "signature_delta");
        assert_eq!(delta.signature.as_deref(), Some("sig_xyz"));
    }
}
