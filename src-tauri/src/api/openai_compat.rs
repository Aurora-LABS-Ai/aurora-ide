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
//! "Terminated" is looser in practice than that sentence suggests. Three
//! things count as the provider saying goodbye, and some providers send only
//! one of them: a `finish_reason`, the `[DONE]` sentinel, or a choice-less
//! usage frame. Anything else at EOF is a dropped connection.
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
    frame_has_done_marker, frame_payloads, map_reqwest_error, map_status_error, parse_tool_input,
    BlockState, OpenAiStreamError, OpenAiStreamingResponse, SseFrameBuffer,
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

        // Opt-in request tracing. Set AURORA_DEBUG_API=1 before launching
        // (`$env:AURORA_DEBUG_API="1"; pnpm tauri:dev`) to print the exact
        // outgoing body and any non-2xx response body to the dev console.
        let debug_api = std::env::var("AURORA_DEBUG_API")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if debug_api {
            eprintln!(
                "[api][openai_compat] POST {url}\nprovider_id={} model={}\nbody={}",
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
            let body = response.text().await.unwrap_or_default();
            if debug_api {
                eprintln!(
                    "[api][openai_compat] upstream {} rejected request: {}",
                    status.as_u16(),
                    body
                );
            }
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
    let mut tool_positions: std::collections::HashMap<i32, usize> =
        std::collections::HashMap::new();

    let mut usage = TokenUsage::default();
    let mut finish_reason: Option<String> = None;
    // Did the provider actually close the stream, or did the connection just
    // die? A `finish_reason`, the `[DONE]` sentinel, or a final usage frame
    // means goodbye was said. Without one, EOF is a TRUNCATED stream — see the
    // check after the loop.
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
            if frame_has_done_marker(&frame) {
                saw_terminator = true;
            }
            for payload in frame_payloads(&frame) {
                let parsed: OpenAiStreamingResponse = match serde_json::from_str(&payload) {
                    Ok(p) => p,
                    Err(_) => continue,
                };

                // An in-band error ends the turn, whatever the HTTP status
                // said. Checked BEFORE the choices so a frame carrying both
                // an error and an empty delta cannot be mistaken for content.
                //
                // Returning here (rather than noting it and continuing) is
                // deliberate: the provider has stopped generating, and any
                // `[DONE]` that follows would otherwise mark the stream as a
                // clean finish and bury the reason.
                if let Some(err) = parsed.error.filter(OpenAiStreamError::is_populated) {
                    // The raw frame goes to the log — `render()` keeps only
                    // the fields our struct modelled, and gateway error
                    // shapes drift.
                    crate::logging::log_error(
                        "api.openai_compat",
                        &format!("provider in-band error frame: {payload}"),
                    );
                    return Err(ApiError::Provider(err.render()));
                }

                if let Some(u) = parsed.usage {
                    // A usage frame carrying no choices is the standard
                    // end-of-stream accounting — the shape every OpenAI-compat
                    // provider sends last, and the one `include_usage` asks
                    // for. It is also a goodbye: a server only reports what a
                    // turn cost once it has finished generating it, so a
                    // connection that genuinely dropped mid-reply cannot have
                    // delivered this.
                    //
                    // Measured need, not a hypothetical: OpenCode Go's
                    // `muse-spark-1.2-contributor` streams `finish_reason:
                    // null` on every chunk (in its non-streaming replies too)
                    // and never sends `[DONE]` — it closes after this frame.
                    // Without this the model was unusable: three retries, three
                    // billed requests, and "the connection dropped" on a
                    // stream that had already delivered the whole reply.
                    //
                    // Deliberately narrowed to choice-less frames. A provider
                    // that attaches running usage to content chunks is still
                    // mid-reply, and treating that as a farewell would hand
                    // back a truncated answer as a finished turn — the exact
                    // failure the terminator check exists to prevent.
                    if parsed.choices.is_empty() {
                        saw_terminator = true;
                    }
                    usage.input_tokens = u.prompt_tokens;
                    usage.output_tokens = u.completion_tokens;
                    // Context caching: the cached-read count is a SUBSET of
                    // `prompt_tokens` — DeepSeek reports it as
                    // `prompt_cache_hit_tokens`, standard OpenAI (and routers
                    // like AgentRouter) as `prompt_tokens_details.cached_tokens`.
                    // `cache_read_tokens()` picks whichever is present. Aurora's
                    // UI math (`useContextStore.updateUsage`) follows Anthropic
                    // semantics where the cache-read field is ADDITIVE to
                    // `input_tokens`, so we subtract the hit count here to keep
                    // the addition correct across providers. The original
                    // prompt_tokens stays implicitly available as
                    // `input_tokens + cache_read_input_tokens`.
                    if let Some(hit) = u.cache_read_tokens() {
                        usage.cache_read_input_tokens = Some(hit);
                        usage.input_tokens = usage.input_tokens.saturating_sub(hit);
                    }
                    // What the provider says this request cost. Outranks any
                    // rate Aurora multiplies out — see `TokenUsage::cost_usd`.
                    // A negative or non-finite value is rejected rather than
                    // shown: it cannot be a charge, and a nonsense number in a
                    // money field is worse than falling back to the catalog.
                    usage.cost_usd = u.cost.filter(|c| c.is_finite() && *c >= 0.0);
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
                            // A delta that carries a DIFFERENT id at an index we
                            // already hold is a new tool call, not a
                            // continuation of the old one — some gateways
                            // restart the index per call instead of numbering
                            // across the message.
                            //
                            // Keying on the index alone appended the second
                            // call's arguments to the first, producing
                            // `{"path":"config.json"}{"path":"proxy.txt"}`: two
                            // valid objects concatenated into invalid JSON, so
                            // BOTH calls were lost to a malformed-input error.
                            // Found once in 3,534 recorded calls — rare, and
                            // silent when it happens.
                            //
                            // Argument-only deltas carry no id, so they still
                            // land on the block their index points at.
                            let starts_new_call = match tool_positions.get(&tc.index) {
                                Some(&p) => match (&tc.id, &blocks[p]) {
                                    (Some(new_id), BlockState::ToolUse { id, .. }) => {
                                        !new_id.is_empty() && !id.is_empty() && new_id != id
                                    }
                                    _ => false,
                                },
                                None => true,
                            };
                            let pos = if starts_new_call {
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
                            } else {
                                tool_positions[&tc.index]
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
                        saw_terminator = true;
                    }
                }
            }
        }
    }

    // The stream hit EOF without a `finish_reason` or `[DONE]`. The provider
    // never said it was finished, so this is a dropped connection — report it
    // as the recoverable network failure it is. Falling through would fabricate
    // a `stop` reason and hand back a truncated reply as a completed turn,
    // which reads to the user as the agent stopping for no reason.
    if !saw_terminator {
        return Err(ApiError::Network(
            "the response stream ended before the model finished — the connection dropped              mid-reply. Retry to run the turn again."
                .to_string(),
        ));
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
        if let Some(block) = blocks.last_mut() {
            if block.push_thinking(chunk) {
                return;
            }
        }
    }
    blocks.push(BlockState::new_thinking(chunk.to_string(), None));
    *last = Some(DeltaKind::Thinking);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive the SSE driver over a canned body, returning its result.
    async fn drive(body: &str) -> Result<TurnUsage, ApiError> {
        let chunks: Vec<Result<Vec<u8>, std::io::Error>> = vec![Ok(body.as_bytes().to_vec())];
        let (tx, _rx) = mpsc::channel(256);
        drive_openai_stream(
            futures_util::stream::iter(chunks),
            tx,
            CancellationToken::new(),
        )
        .await
    }

    /// Some gateways restart `tool_calls[].index` at 0 for each call instead
    /// of numbering across the message. Keying only on the index appended the
    /// second call's arguments to the first — two valid JSON objects
    /// concatenated into invalid JSON, losing BOTH calls to a malformed-input
    /// error. A changed `id` at a known index means a new call.
    #[tokio::test]
    async fn two_tool_calls_reusing_index_zero_stay_separate() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",",
            "\"function\":{\"name\":\"file_read\",\"arguments\":\"{\\\"path\\\":\\\"a.json\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_b\",",
            "\"function\":{\"name\":\"file_read\",\"arguments\":\"{\\\"path\\\":\\\"b.json\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let turn = drive(body).await.expect("stream completes");
        let calls: Vec<_> = turn
            .assistant_message
            .blocks
            .iter()
            .filter_map(|b| match b {
                crate::agent_runtime::types::ContentBlock::ToolUse { id, input, .. } => {
                    Some((id.clone(), input.clone()))
                }
                _ => None,
            })
            .collect();

        assert_eq!(calls.len(), 2, "two ids means two calls, got {calls:?}");
        assert_eq!(calls[0].0, "call_a");
        assert_eq!(calls[1].0, "call_b");
        // Each keeps its OWN arguments — the concatenation bug produced one
        // block whose input was the two objects glued together.
        assert_eq!(calls[0].1["path"], "a.json");
        assert_eq!(calls[1].1["path"], "b.json");
    }

    /// Argument-only deltas carry no id, so they must keep landing on the
    /// block their index already points at — the normal streaming shape.
    #[tokio::test]
    async fn argument_deltas_without_an_id_keep_accumulating() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",",
            "\"function\":{\"name\":\"file_read\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,",
            "\"function\":{\"arguments\":\"\\\"a.json\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let turn = drive(body).await.expect("stream completes");
        let calls: Vec<_> = turn
            .assistant_message
            .blocks
            .iter()
            .filter_map(|b| match b {
                crate::agent_runtime::types::ContentBlock::ToolUse { input, .. } => {
                    Some(input.clone())
                }
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), 1, "one call, streamed in two deltas");
        assert_eq!(calls[0]["path"], "a.json");
    }

    /// THE root cause of "the agent stopped mid-task in silence".
    ///
    /// Proxies and providers answer HTTP 200, stream a few deltas, then emit
    /// an error object in-band and close with `[DONE]`. That frame used to
    /// deserialize cleanly into `{choices: [], usage: None}` — the message
    /// was discarded, `[DONE]` marked the stream healthy, and the turn ended
    /// as an empty assistant message with no explanation anywhere.
    #[tokio::test]
    async fn in_band_error_frame_fails_the_turn_with_the_provider_message() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Let me check\"},\"finish_reason\":null}]}\n\n",
            "data: {\"error\":{\"message\":\"upstream request timeout\",\"type\":\"server_error\",\"code\":504}}\n\n",
            "data: [DONE]\n\n",
        );
        match drive(body).await {
            Err(ApiError::Provider(msg)) => {
                assert!(
                    msg.contains("upstream request timeout"),
                    "must surface the provider's own words, got: {msg}"
                );
            }
            other => panic!("an in-band error must fail the turn, got {other:?}"),
        }
    }

    /// The same envelope with no `message` still has to say something.
    #[tokio::test]
    async fn in_band_error_without_a_message_still_reports() {
        let body = concat!(
            "data: {\"error\":{\"type\":\"rate_limit_error\"}}\n\n",
            "data: [DONE]\n\n",
        );
        match drive(body).await {
            Err(ApiError::Provider(msg)) => assert!(msg.contains("rate_limit_error"), "got {msg}"),
            other => panic!("expected a Provider error, got {other:?}"),
        }
    }

    /// Guard against over-triggering: backends that put `"error": null` (or an
    /// empty object) on ordinary chunks must not have healthy turns aborted.
    #[tokio::test]
    async fn null_or_empty_error_field_does_not_abort_a_healthy_stream() {
        let body = concat!(
            "data: {\"error\":null,\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n",
            "data: {\"error\":{},\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let usage = drive(body)
            .await
            .expect("healthy stream must not be aborted");
        assert_eq!(usage.stop_reason, "stop");
    }

    /// The regression: a connection that dies mid-reply reaches EOF with no
    /// `finish_reason` and no `[DONE]`. That used to fall through as a
    /// perfectly normal turn with a fabricated `stop`, so the agent appeared
    /// to stop for no reason. It must be an error.
    #[tokio::test]
    async fn truncated_stream_is_an_error_not_a_finished_turn() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"half a sen\"}}]}\n\n";
        match drive(body).await {
            Err(ApiError::Network(msg)) => {
                assert!(msg.contains("ended before"), "unexpected message: {msg}");
            }
            other => panic!("expected a Network error for a truncated stream, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn done_sentinel_closes_the_stream_cleanly() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n";
        let turn = drive(body).await.expect("[DONE] should complete the turn");
        assert_eq!(turn.stop_reason, "stop");
    }

    #[tokio::test]
    async fn finish_reason_alone_closes_the_stream_cleanly() {
        // Providers that never send `[DONE]` still say goodbye via finish_reason.
        let body =
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n";
        let turn = drive(body)
            .await
            .expect("finish_reason should complete the turn");
        assert_eq!(turn.stop_reason, "stop");
    }

    /// OpenCode Go's `muse-spark-1.2-contributor`, byte for byte off the wire:
    /// `finish_reason` is `null` on every chunk, there is no `[DONE]`, and the
    /// stream closes after a choice-less usage frame and a cost footer. The
    /// whole reply had already arrived; Aurora called it a dropped connection
    /// and burned three billed retries on it.
    #[tokio::test]
    async fn a_final_usage_frame_closes_a_stream_that_never_says_done() {
        let body = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello there friend\"},\
             \"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":15,\"completion_tokens\":806,\
             \"total_tokens\":821}}\n\n",
            "data: {\"choices\":[],\"cost\":\"0\"}\n\n",
        );
        let turn = drive(body)
            .await
            .expect("a reported usage total means the turn finished");
        // No `finish_reason` anywhere on this wire, so the default stands.
        assert_eq!(turn.stop_reason, "stop");
        assert_eq!(turn.usage.output_tokens, 806);
    }

    /// The narrowing that keeps the fix above from swallowing the bug the
    /// terminator check exists for. Usage attached to a content chunk is a
    /// running total, not a farewell — a provider that streams it and then
    /// dies is still a truncated reply.
    #[tokio::test]
    async fn usage_on_a_content_chunk_is_not_a_goodbye() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"half a sen\"}}],\
                    \"usage\":{\"prompt_tokens\":15,\"completion_tokens\":3}}\n\n";
        match drive(body).await {
            Err(ApiError::Network(msg)) => {
                assert!(msg.contains("ended before"), "unexpected message: {msg}");
            }
            other => panic!("expected a Network error for a truncated stream, got {other:?}"),
        }
    }

    /// The exact shape of the reported bug: the model spent its whole output
    /// budget reasoning and was cut off at the cap. That is a REAL terminator
    /// (`length`), so the turn completes — and `length` is what tells the
    /// runtime to warn the user the reply is truncated.
    #[tokio::test]
    async fn length_stop_completes_the_turn_and_is_reported_verbatim() {
        let body = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking…\"},\
                    \"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n";
        let turn = drive(body).await.expect("a capped turn still completes");
        assert_eq!(turn.stop_reason, "length");
    }
}
