//! OpenAI-compatible streaming adapter.
//!
//! Used for every `provider_id` other than `anthropic` / `minimax`
//! (`deepseek`, `glm`, `fireworks`, `openai`, `lmstudio`, `ollama`,
//! `custom`, …). Wire shape: `POST <base>/chat/completions` with
//! `accept: text/event-stream`, response is a `data: <json>\n\n` stream
//! of `chat.completion.chunk` objects with `choices[0].delta.{content,
//! tool_calls, reasoning_content, …}` deltas, terminated by `data:
//! [DONE]`.
//!
//! Tool calls accumulate by `index` across deltas — `function.arguments`
//! is a string built up chunk by chunk. We emit one
//! [`AssistantEvent::ToolUse`] per accumulated tool call at end of
//! stream, parsing the accumulated string as JSON (falling back to `{}`
//! for invalid arguments — same policy as
//! `provider_kernel::parsers::normalize_openai_tool_arguments`).
//!
//! `reasoning_content` (DeepSeek, GLM) and `reasoning` (LM Studio
//! local models) both surface as [`AssistantEvent::Thinking`] with
//! `signature: None`. OpenAI-compat has no per-block signature concept.

#![allow(dead_code)]

use std::pin::Pin;

use async_trait::async_trait;
use futures_util::stream::Stream;
use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ApiRequest, StreamingApiClient, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::TokenUsage;

use super::client::ProviderConfigSnapshot;
use super::provider_kernel_adapter::{
    build_openai_body, build_openai_headers, build_openai_url, finalize_assistant_message,
    frame_payloads, map_reqwest_error, map_status_error, parse_tool_input, BlockState,
    OpenAiStreamingResponse, SseFrameBuffer,
};

pub struct OpenAICompatAdapter {
    config: ProviderConfigSnapshot,
    http: reqwest::Client,
}

impl OpenAICompatAdapter {
    pub fn new(config: ProviderConfigSnapshot) -> Self {
        let http = reqwest::Client::builder()
            .no_gzip()
            .no_brotli()
            .no_deflate()
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
impl StreamingApiClient for OpenAICompatAdapter {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        if cancel_token.is_cancelled() {
            return Err(ApiError::Cancelled);
        }

        let url = build_openai_url(&self.config.base_url);
        let headers = build_openai_headers(&self.config)?;
        let body = build_openai_body(&request, &self.config);

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

        drive_openai_stream(bytes_stream, event_sink, cancel_token).await
    }
}

/// Drive an OpenAI-compatible SSE stream.
///
/// Bytes → [`SseFrameBuffer`] → JSON deltas → [`AssistantEvent`]s. Tool
/// calls accumulate across deltas keyed by `index`; we emit one
/// [`AssistantEvent::ToolUse`] per accumulated tool call after the
/// stream ends, parsing the accumulated `function.arguments` string
/// (which arrives as JSON-encoded text in OpenAI's wire shape).
///
/// Generic over the chunk type for the same testing reason as the
/// Anthropic variant — production passes `bytes::Bytes` chunks; tests
/// drive it with `Vec<u8>`.
pub async fn drive_openai_stream<S, B, E>(
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

    // Block-emission state. Unlike Anthropic, OpenAI delta order isn't
    // explicitly indexed — content / reasoning_content arrive as raw
    // deltas, tool_calls have their own index space. We aggregate
    // them into a flat `Vec<BlockState>` in arrival order, with a
    // tool_calls index → blocks-position map for fan-in.
    let mut blocks: Vec<BlockState> = Vec::new();
    let mut last_kind: Option<DeltaKind> = None;
    // Map tool_call index → position in `blocks`.
    let mut tool_positions: std::collections::HashMap<i32, usize> = std::collections::HashMap::new();

    let mut usage = TokenUsage::default();
    let mut finish_reason: Option<String> = None;

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
                let parsed: OpenAiStreamingResponse = match serde_json::from_str(&payload) {
                    Ok(p) => p,
                    Err(_) => continue,
                };

                if let Some(u) = parsed.usage {
                    usage.input_tokens = u.prompt_tokens;
                    usage.output_tokens = u.completion_tokens;
                    let _ = event_sink.send(AssistantEvent::Usage(usage.clone())).await;
                }

                for choice in parsed.choices {
                    let delta = choice.delta;

                    // Reasoning first — DeepSeek-r1 emits reasoning
                    // before the visible answer, so latching it ahead
                    // of `content` keeps the UI ordering natural.
                    let reasoning = delta.reasoning.or(delta.reasoning_content);
                    if let Some(text) = reasoning {
                        if !text.is_empty() {
                            append_or_open_thinking(&mut blocks, &mut last_kind, &text);
                            let _ = event_sink
                                .send(AssistantEvent::Thinking {
                                    text,
                                    signature: None,
                                })
                                .await;
                        }
                    }

                    if let Some(content) = delta.content {
                        if !content.is_empty() {
                            append_or_open_text(&mut blocks, &mut last_kind, &content);
                            let _ = event_sink
                                .send(AssistantEvent::TextDelta { delta: content })
                                .await;
                        }
                    }

                    if let Some(tool_calls) = delta.tool_calls {
                        for tc in tool_calls {
                            let pos = match tool_positions.get(&tc.index) {
                                Some(&p) => p,
                                None => {
                                    let p = blocks.len();
                                    blocks.push(BlockState::ToolUse {
                                        id: tc
                                            .id
                                            .clone()
                                            .unwrap_or_else(|| format!("tool_{}", tc.index)),
                                        name: String::new(),
                                        raw_input: String::new(),
                                    });
                                    tool_positions.insert(tc.index, p);
                                    last_kind = Some(DeltaKind::Tool);
                                    p
                                }
                            };

                            if let BlockState::ToolUse {
                                id,
                                name,
                                raw_input,
                            } = &mut blocks[pos]
                            {
                                if let Some(new_id) = tc.id {
                                    if !new_id.is_empty() {
                                        *id = new_id;
                                    }
                                }
                                if let Some(func) = tc.function {
                                    if let Some(n) = func.name {
                                        if !n.is_empty() {
                                            *name = n;
                                        }
                                    }
                                    if let Some(args) = func.arguments {
                                        raw_input.push_str(&args);
                                    }
                                }

                                // Stream the tool card / live-preview
                                // hint as soon as we know the name.
                                // The first emit (just after the model
                                // commits the function name) gives the
                                // chat UI a chance to render the tool
                                // card before any arguments arrive;
                                // subsequent emits power live file
                                // preview while the model is still
                                // typing the JSON body. Sending the
                                // FULL accumulated buffer (not the
                                // per-chunk delta) means the consumer
                                // doesn't have to track state.
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

                    if let Some(reason) = choice.finish_reason {
                        finish_reason = Some(reason);
                    }
                }
            }
        }
    }

    // Emit one ToolUse event per accumulated tool call now that the
    // arguments are fully assembled.
    for block in &blocks {
        if let BlockState::ToolUse {
            id,
            name,
            raw_input,
        } = block
        {
            let input = parse_tool_input(raw_input);
            let _ = event_sink
                .send(AssistantEvent::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input,
                })
                .await;
        }
    }

    let final_stop = finish_reason.unwrap_or_else(|| "stop".to_string());
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeltaKind {
    Text,
    Thinking,
    Tool,
}

fn append_or_open_text(blocks: &mut Vec<BlockState>, last: &mut Option<DeltaKind>, chunk: &str) {
    if matches!(last, Some(DeltaKind::Text)) {
        if let Some(BlockState::Text { text }) = blocks.last_mut() {
            text.push_str(chunk);
            return;
        }
    }
    blocks.push(BlockState::Text {
        text: chunk.to_string(),
    });
    *last = Some(DeltaKind::Text);
}

fn append_or_open_thinking(
    blocks: &mut Vec<BlockState>,
    last: &mut Option<DeltaKind>,
    chunk: &str,
) {
    if matches!(last, Some(DeltaKind::Thinking)) {
        if let Some(BlockState::Thinking { text, .. }) = blocks.last_mut() {
            text.push_str(chunk);
            return;
        }
    }
    blocks.push(BlockState::Thinking {
        text: chunk.to_string(),
        signature: None,
    });
    *last = Some(DeltaKind::Thinking);
}
