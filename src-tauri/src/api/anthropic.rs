//! Anthropic-shape streaming adapter.
//!
//! Used for `provider_id ∈ {"anthropic", "minimax"}`. Wire shape:
//! `POST <base>/v1/messages` with `accept: text/event-stream`, response
//! body is a `data: <json>\n\n` stream of typed events
//! (`message_start`, `content_block_start`, `content_block_delta`,
//! `content_block_stop`, `message_delta`, `message_stop`). See
//! provider_kernel/streaming.rs for the same parsing pattern that landed
//! the Phase-5 SSE bug fixes.
//!
//! The adapter splits the work in two:
//!
//! - [`AnthropicAdapter::stream`] — public trait method. Builds the
//!   request, fires HTTP, maps status / transport errors, then hands
//!   the response's bytes-stream off to [`drive_anthropic_stream`].
//! - [`drive_anthropic_stream`] — the testable core. Takes any
//!   `Stream<Item=Result<Bytes, _>>`, drives the SSE state machine,
//!   emits [`AssistantEvent`]s, returns the aggregated [`TurnUsage`].
//!   Tests inject canned byte streams here without touching reqwest.

#![allow(dead_code)]

use std::collections::HashMap;
use std::pin::Pin;

use async_trait::async_trait;
use futures_util::stream::Stream;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ApiRequest, StreamingApiClient, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::TokenUsage;

use super::client::ProviderConfigSnapshot;
use super::provider_kernel_adapter::{
    build_anthropic_body, build_anthropic_headers, build_anthropic_url, finalize_assistant_message,
    frame_payloads, map_reqwest_error, map_status_error, merge_usage, AnthropicStreamEvent,
    BlockState, SseFrameBuffer,
};

/// Anthropic / MiniMax streaming adapter.
pub struct AnthropicAdapter {
    config: ProviderConfigSnapshot,
    http: reqwest::Client,
}

impl AnthropicAdapter {
    pub fn new(config: ProviderConfigSnapshot) -> Self {
        // `no_*` opt-outs match the kernel's stream client — gzip /
        // brotli / deflate wrappers break SSE chunk timing.
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

    /// Construct an adapter that uses a caller-supplied HTTP client.
    /// Used by the verify crate so tests can swap in a client tuned
    /// for httpmock without changing the adapter's behaviour.
    pub fn with_http_client(config: ProviderConfigSnapshot, http: reqwest::Client) -> Self {
        Self { config, http }
    }

    pub fn config(&self) -> &ProviderConfigSnapshot {
        &self.config
    }
}

#[async_trait]
impl StreamingApiClient for AnthropicAdapter {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        // Pre-cancellation fast path: don't even open a socket.
        if cancel_token.is_cancelled() {
            return Err(ApiError::Cancelled);
        }

        let url = build_anthropic_url(&self.config.base_url);
        let headers = build_anthropic_headers(&self.config)?;
        let body = build_anthropic_body(&request, &self.config);

        // Race the HTTP send against cancellation so a cancel during
        // DNS / connect returns immediately rather than waiting for
        // the connection attempt to time out.
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
            let body = response.text().await.unwrap_or_default();
            return Err(map_status_error(status.as_u16(), body));
        }

        let bytes_stream = response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

        drive_anthropic_stream(bytes_stream, event_sink, cancel_token).await
    }
}

/// Drive an Anthropic SSE stream.
///
/// Pulls byte chunks from `bytes_stream`, runs them through an
/// [`SseFrameBuffer`], and translates each frame's events into
/// [`AssistantEvent`]s emitted on `event_sink`. Returns the aggregated
/// [`TurnUsage`] when the stream ends. `cancel_token` interrupts the
/// stream within one `tokio::select!` iteration.
///
/// Generic over the chunk type so the verify crate can drive this with
/// `Vec<u8>` chunks while production drives it with `bytes::Bytes`
/// (transitively re-exported through `reqwest::Response::bytes_stream`).
pub async fn drive_anthropic_stream<S, B, E>(
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

    // Aggregated message state, indexed by Anthropic block index so
    // events with `index = N` route to the right block. `block_order`
    // is the emission order; converted to `Vec<ContentBlock>` at the
    // end.
    let mut blocks: HashMap<i32, BlockState> = HashMap::new();
    let mut block_order: Vec<i32> = Vec::new();

    let mut usage = TokenUsage::default();
    let mut stop_reason: Option<String> = None;
    // Anthropic closes a healthy stream with `message_stop` (and carries the
    // real stop reason on the preceding `message_delta`). Reaching EOF without
    // either means the connection dropped mid-reply — see the check below.
    let mut saw_terminator = false;

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
                let event: AnthropicStreamEvent = match serde_json::from_str(&payload) {
                    Ok(e) => e,
                    Err(_) => continue, // tolerate malformed events (kernel parity)
                };

                if event.event_type == "message_stop" {
                    saw_terminator = true;
                }

                handle_anthropic_event(
                    event,
                    &mut blocks,
                    &mut block_order,
                    &mut usage,
                    &mut stop_reason,
                    &event_sink,
                )
                .await;
            }
        }

        // Cancellation may also arrive between frames — the next
        // iteration will pick it up via `biased; cancelled()`.
    }

    // No `message_stop` and no stop reason: Anthropic never signalled the end,
    // so the socket died mid-reply. Reporting it as a recoverable network error
    // beats fabricating `end_turn` and passing a truncated answer off as a
    // finished one — the user would see the agent stop for no visible reason.
    if !saw_terminator && stop_reason.is_none() {
        return Err(ApiError::Network(
            "the response stream ended before the model finished — the connection dropped              mid-reply. Retry to run the turn again."
                .to_string(),
        ));
    }

    let final_stop = stop_reason
        .clone()
        .unwrap_or_else(|| "end_turn".to_string());

    // Emit `MessageStop` once at end-of-stream.
    let _ = event_sink
        .send(AssistantEvent::MessageStop {
            stop_reason: final_stop.clone(),
        })
        .await;

    // Build the aggregated assistant message in upstream block order.
    let ordered: Vec<BlockState> = block_order
        .into_iter()
        .filter_map(|idx| blocks.remove(&idx))
        .collect();

    let assistant_message = finalize_assistant_message(ordered, usage.clone());

    Ok(TurnUsage {
        usage,
        stop_reason: final_stop,
        assistant_message,
    })
}

/// Process one decoded Anthropic SSE event.
///
/// Held out of [`drive_anthropic_stream`] so the per-event state
/// machine is easy to follow and so tests can drive it on hand-rolled
/// fixtures.
async fn handle_anthropic_event(
    event: AnthropicStreamEvent,
    blocks: &mut HashMap<i32, BlockState>,
    block_order: &mut Vec<i32>,
    usage: &mut TokenUsage,
    stop_reason: &mut Option<String>,
    event_sink: &mpsc::Sender<AssistantEvent>,
) {
    match event.event_type.as_str() {
        "message_start" => {
            if let Some(envelope) = event.message {
                if let Some(wire) = envelope.usage {
                    merge_usage(usage, &wire);
                    let _ = event_sink.send(AssistantEvent::Usage(usage.clone())).await;
                }
            }
        }

        "content_block_start" => {
            let Some(index) = event.index else { return };
            let Some(meta) = event.content_block else {
                return;
            };
            let new_state = match meta.block_type.as_str() {
                "text" => Some(BlockState::Text {
                    text: String::new(),
                }),
                "thinking" => Some(BlockState::Thinking {
                    text: String::new(),
                    signature: None,
                }),
                "tool_use" => Some(BlockState::ToolUse {
                    id: meta.id.unwrap_or_else(|| format!("tool_{index}")),
                    name: meta.name.unwrap_or_default(),
                    raw_input: String::new(),
                }),
                _ => None,
            };
            if let Some(state) = new_state {
                // Fire the streaming-tool-card hint immediately for
                // tool_use blocks. Anthropic always sends `name` in the
                // `content_block_start`, so the chat UI can render the
                // tool card right away and the live-preview service
                // can prepare the editor tab before any
                // `input_json_delta` arrives.
                if let BlockState::ToolUse { id, name, .. } = &state {
                    if !name.is_empty() {
                        let _ = event_sink
                            .send(AssistantEvent::ToolUseDelta {
                                id: id.clone(),
                                name: name.clone(),
                                arguments: String::new(),
                            })
                            .await;
                    }
                }
                blocks.insert(index, state);
                if !block_order.contains(&index) {
                    block_order.push(index);
                }
            }
        }

        "content_block_delta" => {
            let Some(index) = event.index else { return };
            let Some(delta) = event.delta else { return };
            let Some(state) = blocks.get_mut(&index) else {
                return;
            };
            let delta_type = delta.delta_type.as_deref().unwrap_or("");
            match delta_type {
                "text_delta" => {
                    if let Some(text) = delta.text {
                        if let BlockState::Text { text: t } = state {
                            t.push_str(&text);
                        }
                        let _ = event_sink
                            .send(AssistantEvent::TextDelta { delta: text })
                            .await;
                    }
                }
                "thinking_delta" => {
                    if let Some(thinking) = delta.thinking {
                        if let BlockState::Thinking { text, .. } = state {
                            text.push_str(&thinking);
                        }
                        // Skip zero-length deltas. Some providers open a thinking
                        // block with an empty `"thinking":""` delta; forwarding it
                        // makes the UI open a reasoning segment with no text, which
                        // renders as a bare "…" placeholder in the transcript
                        // (AgentThinkingBlock's `content || "…"` fallback). Mirrors
                        // the same guard the OpenAI-compat adapter already applies.
                        if !thinking.is_empty() {
                            let _ = event_sink
                                .send(AssistantEvent::Thinking {
                                    text: thinking,
                                    signature: None,
                                })
                                .await;
                        }
                    }
                }
                "signature_delta" => {
                    if let Some(sig_chunk) = delta.signature {
                        if let BlockState::Thinking { signature, .. } = state {
                            let acc = signature.get_or_insert_with(String::new);
                            acc.push_str(&sig_chunk);
                        }
                    }
                }
                "input_json_delta" => {
                    if let Some(partial) = delta.partial_json {
                        if let BlockState::ToolUse {
                            id,
                            name,
                            raw_input,
                        } = state
                        {
                            raw_input.push_str(&partial);
                            // Surface the streaming JSON to the UI so
                            // the live file preview / streaming tool
                            // card can decode `path` + `content` (or
                            // any other partial-friendly args) as the
                            // model types them. We send the FULL
                            // accumulated buffer so consumers don't
                            // have to track per-id deltas.
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
                }
                _ => {}
            }
        }

        "content_block_stop" => {
            let Some(index) = event.index else { return };
            let Some(state) = blocks.get(&index) else {
                return;
            };
            match state {
                BlockState::Thinking {
                    signature: Some(sig),
                    ..
                } if !sig.is_empty() => {
                    let _ = event_sink
                        .send(AssistantEvent::Thinking {
                            text: String::new(),
                            signature: Some(sig.clone()),
                        })
                        .await;
                }
                BlockState::ToolUse {
                    id,
                    name,
                    raw_input,
                } => {
                    // Shared with the OpenAI-compat and Responses paths:
                    // repairs unescaped Windows paths, and preserves the raw
                    // text when the arguments never parsed instead of
                    // fabricating an empty object.
                    let input: Value =
                        crate::api::provider_kernel_adapter::parse_tool_input(raw_input);
                    let _ = event_sink
                        .send(AssistantEvent::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input,
                        })
                        .await;
                }
                _ => {}
            }
        }

        "message_delta" => {
            // Anthropic's `message_delta` ships the final stop_reason
            // and the running output_tokens count.
            if let Some(d) = event.delta {
                if let Some(reason) = d.stop_reason {
                    *stop_reason = Some(reason);
                }
            }
            if let Some(wire) = event.usage {
                merge_usage(usage, &wire);
                let _ = event_sink.send(AssistantEvent::Usage(usage.clone())).await;
            }
        }

        "message_stop" => {
            // Stream-level terminator. We emit `MessageStop` ourselves
            // at end-of-stream so we always emit exactly one even if
            // the upstream omits this event.
        }

        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn drive(body: &str) -> Result<TurnUsage, ApiError> {
        let chunks: Vec<Result<Vec<u8>, std::io::Error>> = vec![Ok(body.as_bytes().to_vec())];
        let (tx, _rx) = mpsc::channel(256);
        drive_anthropic_stream(
            futures_util::stream::iter(chunks),
            tx,
            CancellationToken::new(),
        )
        .await
    }

    /// A dropped connection reaches EOF with neither `message_stop` nor a
    /// stop reason. Fabricating `end_turn` there presented a truncated reply
    /// as a complete one; it must surface as an error instead.
    #[tokio::test]
    async fn truncated_stream_is_an_error_not_a_finished_turn() {
        let body = "data: {\"type\":\"content_block_delta\",\"index\":0,\
                    \"delta\":{\"type\":\"text_delta\",\"text\":\"half a sen\"}}\n\n";
        match drive(body).await {
            Err(ApiError::Network(msg)) => {
                assert!(msg.contains("ended before"), "unexpected message: {msg}");
            }
            other => panic!("expected a Network error for a truncated stream, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn message_stop_closes_the_stream_cleanly() {
        let body = "data: {\"type\":\"content_block_delta\",\"index\":0,\
                    \"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n\
                    data: {\"type\":\"message_stop\"}\n\n";
        let turn = drive(body).await.expect("message_stop should complete the turn");
        assert_eq!(turn.stop_reason, "end_turn");
    }

    /// Hitting the output cap is a real ending, not a truncation — the turn
    /// completes and carries `max_tokens`, which is what drives the
    /// "this reply is cut off" notice.
    #[tokio::test]
    async fn max_tokens_stop_completes_the_turn_and_is_reported_verbatim() {
        let body = "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\n\
                    data: {\"type\":\"message_stop\"}\n\n";
        let turn = drive(body).await.expect("a capped turn still completes");
        assert_eq!(turn.stop_reason, "max_tokens");
    }
}
