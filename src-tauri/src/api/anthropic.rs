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
    apply_opencode_headers, build_anthropic_body, build_anthropic_headers, build_anthropic_url,
    encode_redacted_thinking,
    finalize_assistant_message, frame_payloads, map_reqwest_error, map_status_error_with_headers,
    merge_usage, unprefix_model, AnthropicStreamEvent, BlockState, OpenAiStreamError,
    RequestOrigin, SseFrameBuffer,
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
        let mut headers = build_anthropic_headers(&self.config)?;
        apply_opencode_headers(&mut headers, &self.config, request.session_key)?;
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
            // Cloned before `text()` consumes the response. On a 429 the
            // `Retry-After` header is the only wait anyone has actually
            // measured; without it the runtime falls back to guessing.
            let headers = response.headers().clone();
            let body = response.text().await.unwrap_or_default();
            return Err(map_status_error_with_headers(
                status.as_u16(),
                body,
                &headers,
                RequestOrigin {
                    url: &url,
                    model: unprefix_model(request.model, &self.config.provider_id),
                },
            ));
        }

        let bytes_stream = response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

        drive_anthropic_stream_with_legacy_eof(
            bytes_stream,
            event_sink,
            cancel_token,
            allows_legacy_eof(
                &url,
                unprefix_model(request.model, &self.config.provider_id),
            ),
        )
        .await
        .map(|outcome| outcome.turn)
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
    drive_anthropic_stream_detailed(bytes_stream, event_sink, cancel_token)
        .await
        .map(|outcome| outcome.turn)
}

/// The turn, plus what the stream said about who produced it.
pub struct AnthropicStreamOutcome {
    pub turn: TurnUsage,
    /// The model `message_start` named. After a refusal fallback this is the
    /// model that took over, which is the only way to notice a "sticky"
    /// request — Anthropic keeps routing a conversation to the fallback model
    /// for a while, and those replies carry no `fallback` block.
    pub served_model: Option<String>,
}

/// [`drive_anthropic_stream`] for callers that need to know which model
/// actually answered — the first-party adapter, which requests refusal
/// fallbacks and must say so when one served the reply.
pub async fn drive_anthropic_stream_detailed<S, B, E>(
    bytes_stream: S,
    event_sink: mpsc::Sender<AssistantEvent>,
    cancel_token: CancellationToken,
) -> Result<AnthropicStreamOutcome, ApiError>
where
    S: Stream<Item = Result<B, E>> + Send,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    drive_anthropic_stream_with_legacy_eof(bytes_stream, event_sink, cancel_token, false).await
}

// AgentRouter's deepseek-v4-flash route was measured omitting both message
// terminators. Keep that compatibility exception on the exact route; a clean
// HTTP EOF alone cannot establish that any other model finished its response.
fn allows_legacy_eof(url: &str, model: &str) -> bool {
    model == "deepseek-v4-flash"
        && reqwest::Url::parse(url)
            .ok()
            .is_some_and(|url| url.host_str() == Some("agentrouter.org"))
}

async fn drive_anthropic_stream_with_legacy_eof<S, B, E>(
    bytes_stream: S,
    event_sink: mpsc::Sender<AssistantEvent>,
    cancel_token: CancellationToken,
    allow_legacy_eof: bool,
) -> Result<AnthropicStreamOutcome, ApiError>
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
    let mut facts = StreamFacts::default();
    // Anthropic closes a healthy stream with `message_stop` (and carries the
    // real stop reason on the preceding `message_delta`). Reaching EOF without
    // either means the connection dropped mid-reply — see the check below.
    let mut saw_terminator = false;

    'stream: loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => return Err(ApiError::Cancelled),
            next = bytes_stream.next() => match next {
                Some(Ok(c)) => c,
                // The model already finished; losing the transport trailer
                // cannot invalidate its answer or justify another generation.
                Some(Err(_)) if stop_reason.is_some() => break,
                Some(Err(e)) => return Err(ApiError::Network(format!("stream error: {e}"))),
                None => break,
            }
        };

        sse.extend(chunk.as_ref());
        for frame in sse.take_frames() {
            for payload in frame_payloads(&frame) {
                if payload.trim().is_empty() {
                    continue;
                }
                let event: AnthropicStreamEvent = serde_json::from_str(&payload).map_err(|err| {
                    ApiError::Network(format!("invalid Anthropic stream event: {err}"))
                })?;

                // An `error` event ends the turn with the provider's own
                // reason. Handled here rather than in the event match
                // because that match returns `()` and cannot fail the
                // stream — which is exactly how this used to fall through
                // to `_ => {}` and vanish.
                if event.event_type == "error" {
                    // Log the raw payload before rendering: when the error
                    // shape doesn't match our struct, `render` has nothing
                    // and the generic message below is all the UI gets —
                    // the file copy is then the only record of the reason.
                    crate::logging::log_error(
                        "api.anthropic",
                        &format!("provider SSE error event: {payload}"),
                    );
                    let message = event
                        .error
                        .as_ref()
                        .filter(|e| e.is_populated())
                        .map_or_else(
                            || "the provider reported an error but gave no detail".to_string(),
                            OpenAiStreamError::render,
                        );
                    return Err(ApiError::Provider(message));
                }

                if event.event_type == "message_stop" {
                    saw_terminator = true;
                }

                handle_anthropic_event(
                    event,
                    &mut blocks,
                    &mut block_order,
                    &mut usage,
                    &mut stop_reason,
                    &mut facts,
                    &event_sink,
                )
                .await;
                if saw_terminator {
                    break 'stream;
                }
            }
        }

        // Cancellation may also arrive between frames — the next
        // iteration will pick it up via `biased; cancelled()`.
    }

    // A proxy can close HTTP cleanly after losing its upstream. Only a model
    // completion event proves completion, regardless of SSE frame alignment.
    if !saw_terminator && stop_reason.is_none() {
        let ended_on_a_frame_boundary = sse.pending_len() == 0;
        let delivered_content = block_order
            .iter()
            .filter_map(|index| blocks.get(index))
            .any(BlockState::has_content);

        if !allow_legacy_eof || !ended_on_a_frame_boundary || !delivered_content {
            return Err(ApiError::Network(format!(
                "the response stream stopped early — {}. Retry to run the turn again.",
                if !ended_on_a_frame_boundary {
                    "it was cut off partway through an event"
                } else if !delivered_content {
                    "it closed before any content arrived"
                } else {
                    "no message completion event arrived"
                }
            )));
        }

        crate::logging::log_warn(
            "api.anthropic",
            "AgentRouter deepseek-v4-flash closed without a message completion event; \
             accepted under the measured legacy route exception. Completion and final \
             token usage cannot be verified on this route.",
        );
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
    let mut ordered: Vec<BlockState> = block_order
        .into_iter()
        .filter_map(|idx| blocks.remove(&idx))
        .collect();

    if final_stop == "refusal" {
        // A declined reply is not one to act on. Any tool call it had already
        // streamed was part of the work that got declined, and the runtime
        // runs whatever tool calls the final message holds — so they go.
        // The text stays: it is what the person watched arrive, and the
        // notice below says where it was cut.
        let had_text = ordered
            .iter()
            .any(|b| matches!(b, BlockState::Text { text } if !text.trim().is_empty()));
        let dropped_calls = ordered
            .iter()
            .filter(|b| matches!(b, BlockState::ToolUse { .. }))
            .count();
        ordered.retain(|b| !matches!(b, BlockState::ToolUse { .. }));
        if dropped_calls > 0 {
            crate::logging::log_warn(
                "api.anthropic",
                &format!("refusal: discarded {dropped_calls} tool call(s) from the declined reply"),
            );
        }
        facts
            .notices
            .push(refusal_notice(facts.stop_details.as_ref(), had_text));
    }

    let assistant_message = finalize_assistant_message(coalesce_text(ordered), usage.clone());

    Ok(AnthropicStreamOutcome {
        turn: TurnUsage {
            usage,
            stop_reason: final_stop,
            assistant_message,
            notices: facts.notices,
        },
        served_model: facts.served_model,
    })
}

/// What the stream reported about the reply beyond its content.
#[derive(Default)]
struct StreamFacts {
    /// `message_start`'s model. See [`AnthropicStreamOutcome::served_model`].
    served_model: Option<String>,
    /// The `stop_details` that accompany a refusal.
    stop_details: Option<Value>,
    notices: Vec<String>,
}

/// The `model` out of a `fallback` block's `from` / `to` object.
fn fallback_model(side: Option<&Value>) -> String {
    side.and_then(|v| v.get("model"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| "another model".to_string())
}

/// A refusal, said in words a person can act on.
///
/// Branches on nothing but the stop reason having been `refusal` — the
/// details are informational and may be `null`, and an unknown category is
/// shown as Anthropic named it rather than guessed at.
pub(crate) fn refusal_notice(details: Option<&Value>, had_text: bool) -> String {
    let category = details
        .and_then(|d| d.get("category"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let topic = category.map(|c| match c {
        "cyber" => "cybersecurity".to_string(),
        "bio" => "biology".to_string(),
        "reasoning_extraction" => "a request for the model's hidden reasoning".to_string(),
        "frontier_llm" => "building frontier AI models".to_string(),
        "general_harms" => "potential harm".to_string(),
        other => other.replace('_', " "),
    });

    let mut notice = match topic {
        Some(topic) => format!("Claude declined this request. Anthropic's safety check flagged it as {topic}."),
        None => "Claude declined this request.".to_string(),
    };
    if had_text {
        notice.push_str(" The reply above stops where it was declined.");
    }
    // Anthropic's explanation ends with advice for the developer ("API
    // integrators: … configure a fallback model"), measured live 2026-10-08.
    // Aurora already does that, and the person reading the notice can do
    // nothing with it, so only the part addressed to them is kept.
    if let Some(explanation) = details
        .and_then(|d| d.get("explanation"))
        .and_then(Value::as_str)
        .map(|e| e.split("API integrators:").next().unwrap_or(e).trim())
        .filter(|e| !e.is_empty())
    {
        notice.push(' ');
        notice.push_str(explanation);
        if !explanation.ends_with('.') {
            notice.push('.');
        }
    }
    if let Some(model) = details
        .and_then(|d| d.get("recommended_model"))
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
    {
        notice.push_str(&format!(" Anthropic suggests retrying with {model}."));
    } else {
        notice.push_str(" Nothing it started was run. Rephrase the request, or switch model and retry.");
    }
    notice
}

/// Join runs of consecutive text blocks into one.
///
/// This adapter is the only one that takes its block structure from the wire:
/// `openai_compat` and `responses` both append each chunk into the open text
/// block, so neither can produce a run of them. Here every
/// `content_block_start` opens a block, which is right for Anthropic itself —
/// it sends one text block per stretch of prose — and wrong for a proxy that
/// re-opens a block per token.
///
/// A proxy that does opens one block per token, and the reply is stored as a
/// hundred one-word blocks. It still LOOKS correct while it streams, because
/// the composer coalesces the deltas it renders, so the damage only appears
/// when the thread is reopened: the reload path joins adjacent text blocks
/// with a newline, and the reply comes back one word per line, split
/// mid-word wherever the tokenizer split it ("order" / "-creation").
///
/// Joined with nothing between them, which is what the pieces were: the
/// deltas that built them were concatenated with no separator on the way to
/// the screen, so this reproduces exactly what the user watched arrive.
/// Genuinely separate text blocks are left alone — a run only forms when
/// nothing else sits between them, which the real API never does.
fn coalesce_text(blocks: Vec<BlockState>) -> Vec<BlockState> {
    let mut out: Vec<BlockState> = Vec::with_capacity(blocks.len());
    for block in blocks {
        match (out.last_mut(), block) {
            (Some(BlockState::Text { text: prev }), BlockState::Text { text }) => {
                prev.push_str(&text);
            }
            (_, block) => out.push(block),
        }
    }
    out
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
    facts: &mut StreamFacts,
    event_sink: &mpsc::Sender<AssistantEvent>,
) {
    match event.event_type.as_str() {
        "message_start" => {
            if let Some(envelope) = event.message {
                if let Some(model) = envelope.model.filter(|m| !m.is_empty()) {
                    facts.served_model = Some(model);
                }
                // Logged, not shown. A dropped thinking block costs the model
                // that turn's earlier reasoning, which is invisible from the
                // reply alone; the log is the only place the cause survives.
                if let Some(changes) = envelope.input_transformations.filter(|t| !t.is_empty()) {
                    crate::logging::log_warn(
                        "api.anthropic",
                        &format!(
                            "the API altered this request's history before the model saw it: {}",
                            Value::Array(changes)
                        ),
                    );
                }
                if let Some(wire) = envelope.usage {
                    // Merged, NOT emitted. Anthropic reports the input and
                    // cache counts here and the final output count again on
                    // `message_delta`, and `merge_usage` keeps the earlier
                    // fields — so both events carry the full input. The cost
                    // card ADDS every usage event it receives into the running
                    // turn, which made one Anthropic request count its input
                    // and cache-read tokens twice and register as two
                    // requests. One request must produce exactly one usage
                    // event; `message_delta` is the one that is complete.
                    //
                    // The counts are not lost — they live in `usage` and ride
                    // out on that event. The only cost is that the context ring
                    // updates when the reply finishes rather than when it
                    // starts, which is already how every other provider here
                    // behaves.
                    merge_usage(usage, &wire);
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
                "thinking" => Some(BlockState::new_thinking(String::new(), None)),
                // Anthropic encrypts a reasoning block when its safety systems
                // flag the content. It is normal, intermittent, and arrives
                // with `data` instead of `thinking`. Dropping it — which is
                // what `_ => None` used to do — cost the whole response
                // whenever the model emitted nothing else: no block was
                // inserted, so every delta and the stop event that followed
                // found nothing at their index and bailed too. The turn then
                // ended with output tokens billed and zero blocks, and the
                // user was told "the provider returned an empty reply". It did
                // not; we discarded it.
                //
                // The payload is opaque and MUST be replayed verbatim on the
                // next request, exactly like a signature — so it rides in the
                // signature slot under a provider tag, the same trick the
                // Responses adapter uses for encrypted reasoning items.
                "redacted_thinking" => Some(BlockState::new_thinking(
                    String::new(),
                    meta.data.as_deref().map(encode_redacted_thinking),
                )),
                "tool_use" => Some(BlockState::ToolUse {
                    id: meta.id.unwrap_or_else(|| format!("tool_{index}")),
                    name: meta.name.unwrap_or_default(),
                    raw_input: String::new(),
                }),
                // A refusal fallback's switch point: the model before it
                // declined and the one after it carries on, on the same
                // stream. Anthropic's rule for what came before it: the text
                // stays (the new model was given it as context), but thinking
                // and tool calls must not be sent back — and a tool call the
                // declining model started must not run, since the runtime runs
                // every call the final message holds. The block itself is only
                // an audit marker, so it is not kept either.
                "fallback" => {
                    let from = fallback_model(meta.from.as_ref());
                    let to = fallback_model(meta.to.as_ref());
                    block_order.retain(|i| {
                        matches!(blocks.get(i), Some(BlockState::Text { .. }))
                    });
                    blocks.retain(|_, b| matches!(b, BlockState::Text { .. }));
                    crate::logging::log_warn(
                        "api.anthropic",
                        &format!("refusal fallback: {from} declined, {to} continued"),
                    );
                    // After a MID-reply decline `message_start` still named the
                    // requested model; only this block says who took over.
                    facts.served_model = Some(to.clone());
                    facts.notices.push(format!(
                        "{from} declined this request, so Anthropic handed it to {to}, which \
                         wrote the reply. Anthropic may keep using {to} for this conversation \
                         for about an hour."
                    ));
                    None
                }
                // Never silently again. An unrecognized block is a response we
                // are throwing away, and the only thing worse than not
                // supporting it is not knowing that we don't: this failure was
                // invisible from inside the app and had to be reconstructed
                // from the session JSONL. Naming it turns the next one into a
                // one-line diagnosis.
                other => {
                    eprintln!(
                        "anthropic: unsupported content block type {other:?} at index {index} \
                         — its content will be missing from this turn. \
                         If replies look empty, this is why."
                    );
                    None
                }
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
                // A delta for a block that was never opened is CONTENT THAT
                // VANISHES, and it used to vanish without a trace. That silence
                // is why "did the gateway send the closing brace, or did we
                // drop it?" (thread `e186eb4b`, 2026-09-16) could not be
                // answered from anything on disk and needed the adapter read
                // line by line. One warning makes the same question a log
                // lookup next time.
                crate::logging::log_warn(
                    "api.anthropic",
                    &format!(
                        "dropped a {} delta for block index {index}: no content_block_start \
                         opened it. Content from this block is lost.",
                        delta.delta_type.as_deref().unwrap_or("unknown"),
                    ),
                );
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
                        state.push_thinking(&thinking);
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
                if let Some(details) = d.stop_details.filter(|v| !v.is_null()) {
                    facts.stop_details = Some(details);
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
    use crate::agent_runtime::types::ContentBlock;

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

    /// Anthropic streams `event: error` after HTTP 200 too (`overloaded_error`
    /// is the common one). It used to hit the event match's `_ => {}` and
    /// vanish, leaving the turn to end with no content and no reason.
    #[tokio::test]
    async fn in_band_error_event_fails_the_turn_with_the_provider_message() {
        let body = "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\
                    \"message\":\"Overloaded\"}}\n\n";
        match drive(body).await {
            Err(ApiError::Provider(msg)) => {
                assert!(msg.contains("Overloaded"), "unexpected message: {msg}");
            }
            other => panic!("an in-band error must fail the turn, got {other:?}"),
        }
    }

    /// A stream cut off PARTWAY THROUGH a frame really is truncated: the
    /// bytes stop mid-event, so whatever was being sent never arrived whole.
    /// Fabricating `end_turn` there passes a broken reply off as a complete
    /// one.
    #[tokio::test]
    async fn a_stream_cut_off_mid_event_is_an_error() {
        // Content delivered, then a frame that never closes.
        let body = "data: {\"type\":\"content_block_start\",\"index\":0,\
                    \"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
                    data: {\"type\":\"content_block_delta\",\"index\":0,\
                    \"delta\":{\"type\":\"text_delta\",\"text\":\"half a \"}}\n\n\
                    data: {\"type\":\"content_block_delta\",\"index\":0,\
                    \"delta\":{\"type\":\"text_delta\",\"text\":\"sen";
        match drive(body).await {
            Err(ApiError::Network(msg)) => {
                assert!(msg.contains("cut off partway"), "unexpected message: {msg}");
            }
            other => panic!("expected a Network error, got {other:?}"),
        }
    }

    /// EOF before the model said anything at all is an error whatever else is
    /// true — there is no reply to accept.
    #[tokio::test]
    async fn a_stream_that_delivers_nothing_is_an_error() {
        let body = "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m\"}}\n\n";
        match drive(body).await {
            Err(ApiError::Network(msg)) => {
                assert!(
                    msg.contains("before any content arrived"),
                    "unexpected message: {msg}"
                );
            }
            other => panic!("expected a Network error, got {other:?}"),
        }
    }

    /// A gateway that simply never terminates its streams.
    ///
    /// Measured against AgentRouter's `/v1/messages` with `deepseek-v4-flash`
    /// on 2026-08-25: 10 of 10 requests — plain, thinking, with tools, and a
    /// 50-second 568 KB generation — ended after the last
    /// `content_block_delta` with no `message_delta` and no `message_stop`,
    /// closing cleanly on a frame boundary with nothing left in the buffer.
    ///
    /// This compatibility exception is confined to that measured route. A
    /// clean HTTP ending cannot prove its upstream generation was complete.
    #[tokio::test]
    async fn a_gateway_that_never_sends_message_stop_is_still_a_finished_turn() {
        let body = "data: {\"type\":\"content_block_start\",\"index\":0,\
                    \"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
                    data: {\"type\":\"content_block_delta\",\"index\":0,\
                    \"delta\":{\"type\":\"text_delta\",\"text\":\"a whole answer\"}}\n\n";
        let (tx, _rx) = mpsc::channel(64);
        let turn = drive_anthropic_stream_with_legacy_eof(
            futures_util::stream::iter([Ok::<_, std::io::Error>(body.as_bytes().to_vec())]),
            tx,
            CancellationToken::new(),
            true,
        )
        .await
        .map(|outcome| outcome.turn)
        .expect("the measured legacy route must remain usable");
        assert_eq!(turn.stop_reason, "end_turn");
        match turn.assistant_message.blocks.as_slice() {
            [ContentBlock::Text { text }] => assert_eq!(text, "a whole answer"),
            other => panic!("expected the delivered text, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn message_stop_closes_the_stream_cleanly() {
        let body = "data: {\"type\":\"content_block_delta\",\"index\":0,\
                    \"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n\
                    data: {\"type\":\"message_stop\"}\n\n";
        let turn = drive(body)
            .await
            .expect("message_stop should complete the turn");
        assert_eq!(turn.stop_reason, "end_turn");
    }

    #[test]
    fn legacy_eof_is_confined_to_the_measured_route() {
        assert!(allows_legacy_eof(
            "https://agentrouter.org/v1/messages", "deepseek-v4-flash"
        ));
        assert!(!allows_legacy_eof(
            "https://agentrouter.org/v1/messages", "claude-opus-5"
        ));
        assert!(!allows_legacy_eof(
            "https://inference.us-west.modal.direct/v1/messages", "deepseek-v4-flash"
        ));
        assert!(!allows_legacy_eof(
            "https://agentrouter.org.example/v1/messages", "deepseek-v4-flash"
        ));
    }

    /// Hitting the output cap is a real ending, not a truncation — the turn
    /// completes and carries `max_tokens`, which is what drives the
    /// "this reply is cut off" notice.
    #[tokio::test]
    async fn max_tokens_stop_completes_the_turn_and_is_reported_verbatim() {
        let body =
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\n\
                    data: {\"type\":\"message_stop\"}\n\n";
        let turn = drive(body).await.expect("a capped turn still completes");
        assert_eq!(turn.stop_reason, "max_tokens");
    }

    /// A refused reply must not run anything it started. The runtime runs every
    /// tool call the final message holds, so a call streamed before the
    /// classifier declined would otherwise execute.
    #[tokio::test]
    async fn a_refusal_keeps_the_text_drops_tool_calls_and_says_why() {
        let mut body = text_block(0, "Here is the scan");
        body.push_str(
            "data: {\"type\":\"content_block_start\",\"index\":1,\
             \"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"shell_execute\"}}\n\n\
             data: {\"type\":\"content_block_stop\",\"index\":1}\n\n\
             data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\",\
             \"stop_details\":{\"type\":\"refusal\",\"category\":\"cyber\",\"explanation\":null}}}\n\n\
             data: {\"type\":\"message_stop\"}\n\n",
        );

        let turn = drive(&body).await.expect("a refusal is a finished response");
        assert_eq!(turn.stop_reason, "refusal");
        assert!(
            !turn
                .assistant_message
                .blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. })),
            "a declined reply's tool call must not reach the runtime"
        );
        assert!(turn
            .assistant_message
            .blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Text { text } if text == "Here is the scan")));
        assert_eq!(turn.notices.len(), 1);
        assert!(turn.notices[0].contains("cybersecurity"), "{}", turn.notices[0]);
        assert!(turn.notices[0].contains("stops where it was declined"), "{}", turn.notices[0]);
    }

    /// Anthropic's rule for a mid-stream fallback: thinking and tool calls
    /// before the switch are not sent back (and a call there must not run);
    /// text before it stays, and everything after it is the new model's reply.
    #[tokio::test]
    async fn a_fallback_switch_drops_the_declined_models_thinking_and_calls() {
        let body = "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5-5\",\
                    \"input_transformations\":[]}}\n\n\
                    data: {\"type\":\"content_block_start\",\"index\":0,\
                    \"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n\
                    data: {\"type\":\"content_block_delta\",\"index\":0,\
                    \"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"plan\"}}\n\n\
                    data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
                    data: {\"type\":\"content_block_start\",\"index\":1,\
                    \"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
                    data: {\"type\":\"content_block_delta\",\"index\":1,\
                    \"delta\":{\"type\":\"text_delta\",\"text\":\"Start. \"}}\n\n\
                    data: {\"type\":\"content_block_stop\",\"index\":1}\n\n\
                    data: {\"type\":\"content_block_start\",\"index\":2,\
                    \"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"grep\"}}\n\n\
                    data: {\"type\":\"content_block_stop\",\"index\":2}\n\n\
                    data: {\"type\":\"content_block_start\",\"index\":3,\
                    \"content_block\":{\"type\":\"fallback\",\"from\":{\"model\":\"claude-opus-5-5\"},\
                    \"to\":{\"model\":\"claude-opus-4-8\"}}}\n\n\
                    data: {\"type\":\"content_block_stop\",\"index\":3}\n\n\
                    data: {\"type\":\"content_block_start\",\"index\":4,\
                    \"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
                    data: {\"type\":\"content_block_delta\",\"index\":4,\
                    \"delta\":{\"type\":\"text_delta\",\"text\":\"Finished.\"}}\n\n\
                    data: {\"type\":\"content_block_stop\",\"index\":4}\n\n\
                    data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n\
                    data: {\"type\":\"message_stop\"}\n\n";

        let (tx, _rx) = mpsc::channel(256);
        let outcome = drive_anthropic_stream_detailed(
            futures_util::stream::iter([Ok::<_, std::io::Error>(body.as_bytes().to_vec())]),
            tx,
            CancellationToken::new(),
        )
        .await
        .expect("turn completes");
        let blocks = &outcome.turn.assistant_message.blocks;

        assert!(!blocks.iter().any(|b| matches!(b, ContentBlock::ToolUse { .. })));
        assert!(!blocks.iter().any(|b| matches!(b, ContentBlock::Thinking { .. })));
        let text: String = blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Start. Finished.");
        // `message_start` named the requested model; the switch is what counts.
        assert_eq!(outcome.served_model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(outcome.turn.notices.len(), 1);
        assert!(outcome.turn.notices[0].contains("claude-opus-4-8"));
    }

    /// The `stop_details` Opus 5.5 actually returned on 2026-10-08 for a
    /// request to reproduce its hidden reasoning (pre-output refusal, with
    /// `fallbacks: "default"` sent — this category was not routed to one).
    #[test]
    fn a_live_refusal_reads_without_the_developer_advice() {
        let details = serde_json::json!({
            "type": "refusal",
            "category": "reasoning_extraction",
            "explanation": "This request was blocked as it seems to violate Anthropic's Terms of \
                Service restrictions on reverse engineering or duplicating model outputs. To learn \
                more, visit https://www.anthropic.com/legal/commercial-terms. API integrators: you \
                can reduce refusals for your users by configuring a fallback model — see \
                https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback",
            "recommended_model": null,
        });
        let notice = refusal_notice(Some(&details), false);
        assert!(notice.contains("hidden reasoning"), "{notice}");
        assert!(notice.contains("Terms of Service"), "{notice}");
        assert!(!notice.contains("API integrators"), "{notice}");
        assert!(notice.ends_with("switch model and retry."), "{notice}");
    }

    #[test]
    fn a_refusal_with_no_details_still_reads_as_a_sentence() {
        let notice = refusal_notice(None, false);
        assert!(notice.starts_with("Claude declined this request."), "{notice}");
        assert!(!notice.contains("flagged"), "no category was given: {notice}");

        let suggested = refusal_notice(
            Some(&serde_json::json!({"category": null, "recommended_model": "claude-opus-4-8"})),
            false,
        );
        assert!(suggested.contains("retrying with claude-opus-4-8"), "{suggested}");
    }

    /// Build the SSE for one text block: start, one delta, stop.
    fn text_block(index: usize, text: &str) -> String {
        format!(
            "data: {{\"type\":\"content_block_start\",\"index\":{index},\
             \"content_block\":{{\"type\":\"text\"}}}}\n\n\
             data: {{\"type\":\"content_block_delta\",\"index\":{index},\
             \"delta\":{{\"type\":\"text_delta\",\"text\":\"{text}\"}}}}\n\n\
             data: {{\"type\":\"content_block_stop\",\"index\":{index}}}\n\n"
        )
    }

    /// A proxy that opens a content block per token — observed on Kimi K3
    /// served over the Anthropic wire format — used to be stored verbatim as
    /// one block per token. It streamed correctly and then came back one word
    /// per line when the thread was reopened, broken mid-word wherever the
    /// tokenizer had split it.
    #[tokio::test]
    async fn a_block_opened_per_token_is_stored_as_one_piece_of_prose() {
        let mut body = String::new();
        // The split that gave it away: "order-creation" arrived in two pieces.
        for (i, token) in ["Check", " the", " order", "-creation", " flow"]
            .iter()
            .enumerate()
        {
            body.push_str(&text_block(i, token));
        }
        body.push_str("data: {\"type\":\"message_stop\"}\n\n");

        let turn = drive(&body).await.expect("turn completes");
        let texts: Vec<&str> = turn
            .assistant_message
            .blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec!["Check the order-creation flow"],
            "per-token blocks must rejoin into the prose that was streamed"
        );
    }

    /// Text on either side of a tool call is two separate thoughts and must
    /// stay two blocks — the merge only closes runs, and a tool call breaks
    /// the run.
    #[tokio::test]
    async fn text_around_a_tool_call_stays_separate() {
        let mut body = text_block(0, "before");
        body.push_str(
            "data: {\"type\":\"content_block_start\",\"index\":1,\
             \"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"grep\"}}\n\n\
             data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
        );
        body.push_str(&text_block(2, "after"));
        body.push_str("data: {\"type\":\"message_stop\"}\n\n");

        let turn = drive(&body).await.expect("turn completes");
        let texts: Vec<&str> = turn
            .assistant_message
            .blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["before", "after"]);
    }
}
