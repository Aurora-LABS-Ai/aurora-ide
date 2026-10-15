//! Antigravity's SSE reply → Aurora events and the finished assistant message.
//!
//! Each `data:` line is `{response, traceId, metadata}` where `response` is a
//! Gemini `GenerateContentResponse`. What arrives in `candidates[0].content.parts`:
//!
//! - `{thought: true, text}`: reasoning (Claude models stream it; Gemini sends
//!   it when asked and when it has any),
//! - `{text}`: the answer,
//! - `{functionCall: {id, name, args}}`: a whole tool call in one part,
//! - `thoughtSignature` on any of those, or on an otherwise empty part.
//!
//! A signature on a tool call, or one that arrived just before it, is stored
//! in a [`BlockState::Thinking`] right before the call (see
//! [`super::wire`] for why). A signature on an empty answer part is the
//! end-of-turn marker Gemini adds; replay does not need it and it is dropped.
//!
//! Both model families finish with `STOP` even after a tool call, so the stop
//! reason is decided from what the reply contains.

use std::pin::Pin;

use futures_util::{Stream, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ToolSchema, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::TokenUsage;
use crate::api::provider_kernel_adapter::{finalize_assistant_message, BlockState};
use crate::api::sse_shared::{frame_has_done_marker, frame_payloads, SseFrameBuffer};

use super::wire::{encode_signature, sanitize_function_name};

/// Finish reasons that mean Google withheld the reply, worded for the person.
fn withheld_notice(reason: &str) -> Option<String> {
    let why = match reason {
        "SAFETY" | "IMAGE_SAFETY" => "its safety filter",
        "RECITATION" => "a recitation check (the reply quoted protected text)",
        "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" => "a content policy",
        "MALFORMED_FUNCTION_CALL" => {
            return Some(
                "The model wrote a tool call Google could not read, so the reply stopped. Ask it to try again."
                    .to_string(),
            )
        }
        _ => return None,
    };
    Some(format!("Google stopped this reply because of {why}."))
}

/// The tool name Aurora declared, for a name the wire may have sanitized.
fn declared_name(wire_name: &str, tools: &[ToolSchema]) -> String {
    tools
        .iter()
        .find(|t| t.name == wire_name)
        .or_else(|| {
            tools
                .iter()
                .find(|t| sanitize_function_name(&t.name) == wire_name)
        })
        .map_or_else(|| wire_name.to_string(), |t| t.name.clone())
}

fn usage_from(meta: &Value) -> TokenUsage {
    let n = |key: &str| {
        meta.get(key)
            .and_then(Value::as_u64)
            .map_or(0, |v| u32::try_from(v).unwrap_or(u32::MAX))
    };
    let cached = n("cachedContentTokenCount");
    TokenUsage {
        // Aurora's arithmetic follows Anthropic: cache reads are reported
        // BESIDE input, not inside it.
        input_tokens: n("promptTokenCount").saturating_sub(cached),
        output_tokens: n("candidatesTokenCount").saturating_add(n("thoughtsTokenCount")),
        cache_read_input_tokens: (cached > 0).then_some(cached),
        ..TokenUsage::default()
    }
}

fn error_message(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    match error.get("status").and_then(Value::as_str) {
        Some(status) => format!("{status}: {message}"),
        None => message.to_string(),
    }
}

/// Drive one streamed reply. `tools` is the request's catalogue, used only to
/// restore declared names.
pub async fn drive_antigravity_stream<S, B, E>(
    bytes_stream: S,
    event_sink: mpsc::Sender<AssistantEvent>,
    cancel_token: CancellationToken,
    tools: &[ToolSchema],
) -> Result<TurnUsage, ApiError>
where
    S: Stream<Item = Result<B, E>> + Send,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    let mut bytes_stream: Pin<Box<S>> = Box::pin(bytes_stream);
    let mut sse = SseFrameBuffer::new();
    let mut blocks: Vec<BlockState> = Vec::new();
    let mut usage = TokenUsage::default();
    let mut finish: Option<String> = None;
    let mut pending_signature: Option<String> = None;
    let mut generated_ids = 0usize;

    'stream: loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => return Err(ApiError::Cancelled),
            next = bytes_stream.next() => match next {
                Some(Ok(c)) => c,
                Some(Err(_)) if finish.is_some() => break,
                Some(Err(e)) => return Err(ApiError::Network(format!("stream error: {e}"))),
                None => break,
            }
        };
        sse.extend(chunk.as_ref());
        for frame in sse.take_frames() {
            if frame_has_done_marker(&frame) {
                break 'stream;
            }
            for payload in frame_payloads(&frame) {
                if payload.trim().is_empty() {
                    continue;
                }
                let event: Value = serde_json::from_str(&payload).map_err(|err| {
                    ApiError::Network(format!("invalid Antigravity stream event: {err}"))
                })?;
                if let Some(error) = event.get("error") {
                    crate::logging::log_error(
                        "api.antigravity",
                        &format!("in-band error frame: {payload}"),
                    );
                    return Err(ApiError::Provider(error_message(error)));
                }
                let response = event.get("response").unwrap_or(&event);
                if let Some(meta) = response.get("usageMetadata") {
                    usage = usage_from(meta);
                }
                if let Some(reason) = response
                    .pointer("/promptFeedback/blockReason")
                    .and_then(Value::as_str)
                {
                    return Err(ApiError::InvalidRequest(format!(
                        "Google refused the request ({reason})."
                    )));
                }
                let Some(candidate) = response.pointer("/candidates/0") else {
                    continue;
                };
                for part in candidate
                    .pointer("/content/parts")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    handle_part(
                        part,
                        &mut blocks,
                        &mut pending_signature,
                        &mut generated_ids,
                        tools,
                        &event_sink,
                    )
                    .await;
                }
                if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
                    finish = Some(reason.to_string());
                }
            }
        }
    }

    let Some(finish) = finish else {
        return Err(ApiError::Network(
            "the response stream ended before the model finished — the connection dropped mid-reply. Retry to run the turn again."
                .to_string(),
        ));
    };

    for block in &blocks {
        if let BlockState::ToolUse {
            id,
            name,
            raw_input,
        } = block
        {
            let _ = event_sink
                .send(AssistantEvent::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: crate::api::provider_kernel_adapter::parse_tool_input(raw_input),
                })
                .await;
        }
    }

    let called_tools = blocks
        .iter()
        .any(|b| matches!(b, BlockState::ToolUse { .. }));
    let mut notices = Vec::new();
    let stop_reason = match finish.as_str() {
        "MAX_TOKENS" => "max_tokens".to_string(),
        _ if called_tools => "tool_use".to_string(),
        "STOP" | "FINISH_REASON_UNSPECIFIED" | "OTHER" => "end_turn".to_string(),
        other => {
            if let Some(notice) = withheld_notice(other) {
                notices.push(notice);
            }
            "end_turn".to_string()
        }
    };

    let _ = event_sink.send(AssistantEvent::Usage(usage.clone())).await;
    let _ = event_sink
        .send(AssistantEvent::MessageStop {
            stop_reason: stop_reason.clone(),
        })
        .await;
    let assistant_message = finalize_assistant_message(blocks, usage.clone());
    Ok(TurnUsage {
        usage,
        stop_reason,
        assistant_message,
        notices,
    })
}

async fn handle_part(
    part: &Value,
    blocks: &mut Vec<BlockState>,
    pending_signature: &mut Option<String>,
    generated_ids: &mut usize,
    tools: &[ToolSchema],
    event_sink: &mpsc::Sender<AssistantEvent>,
) {
    let signature = part
        .get("thoughtSignature")
        .or_else(|| part.get("thought_signature"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let text = part.get("text").and_then(Value::as_str).unwrap_or("");
    let is_thought = part.get("thought").and_then(Value::as_bool) == Some(true);

    if is_thought {
        if !text.is_empty() {
            let appended = blocks.last_mut().is_some_and(|b| b.push_thinking(text));
            if !appended {
                blocks.push(BlockState::new_thinking(text.to_string(), None));
            }
            let _ = event_sink
                .send(AssistantEvent::Thinking {
                    text: text.to_string(),
                    signature: None,
                })
                .await;
        }
        if let Some(sig) = signature {
            // Claude closes its reasoning with an empty thought part that
            // carries the signature.
            match blocks.last_mut() {
                Some(BlockState::Thinking {
                    signature: slot, ..
                }) if slot.is_none() => {
                    *slot = Some(encode_signature(&sig));
                }
                _ => *pending_signature = Some(sig),
            }
        }
        return;
    }

    if let Some(call) = part.get("functionCall") {
        if let Some(sig) = signature.or_else(|| pending_signature.take()) {
            match blocks.last_mut() {
                Some(BlockState::Thinking {
                    signature: slot, ..
                }) if slot.is_none() => {
                    *slot = Some(encode_signature(&sig));
                }
                _ => blocks.push(BlockState::new_thinking(
                    String::new(),
                    Some(encode_signature(&sig)),
                )),
            }
        }
        let wire_name = call.get("name").and_then(Value::as_str).unwrap_or("");
        let name = declared_name(wire_name, tools);
        let id = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                *generated_ids += 1;
                format!(
                    "call_{}_{}",
                    chrono::Utc::now().timestamp_millis(),
                    generated_ids
                )
            });
        let args = call
            .get("args")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let raw_input = args.to_string();
        let _ = event_sink
            .send(AssistantEvent::ToolUseDelta {
                id: id.clone(),
                name: name.clone(),
                arguments: raw_input.clone(),
            })
            .await;
        blocks.push(BlockState::ToolUse {
            id,
            name,
            raw_input,
        });
        return;
    }

    if !text.is_empty() {
        match blocks.last_mut() {
            Some(BlockState::Text { text: existing }) => existing.push_str(text),
            _ => blocks.push(BlockState::Text {
                text: text.to_string(),
            }),
        }
        let _ = event_sink
            .send(AssistantEvent::TextDelta {
                delta: text.to_string(),
            })
            .await;
    } else if let Some(sig) = signature {
        // A signature alone, before a call that has not arrived yet. On an
        // empty part after the answer it is Gemini's end-of-turn marker and
        // nothing will claim it.
        *pending_signature = Some(sig);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::types::ContentBlock;
    use crate::api::antigravity::wire::decode_signature;
    use serde_json::json;

    fn sse(events: &[Value]) -> Vec<Result<Vec<u8>, std::io::Error>> {
        events
            .iter()
            .map(|e| {
                Ok(
                    format!("data: {}\r\n\r\n", json!({ "response": e, "traceId": "t" }))
                        .into_bytes(),
                )
            })
            .collect()
    }

    async fn run(
        events: &[Value],
        tools: &[ToolSchema],
    ) -> (Result<TurnUsage, ApiError>, Vec<AssistantEvent>) {
        let (tx, mut rx) = mpsc::channel(256);
        let result = drive_antigravity_stream(
            futures_util::stream::iter(sse(events)),
            tx,
            CancellationToken::new(),
            tools,
        )
        .await;
        let mut seen = Vec::new();
        while let Ok(e) = rx.try_recv() {
            seen.push(e);
        }
        (result, seen)
    }

    fn usage(prompt: u64, out: u64) -> Value {
        json!({ "promptTokenCount": prompt, "candidatesTokenCount": out, "totalTokenCount": prompt + out })
    }

    /// The probe's Gemini 3.8 Flash reply: signature and call in one part,
    /// then an empty STOP part.
    #[tokio::test]
    async fn a_gemini_tool_call_keeps_its_signature_before_the_call() {
        let events = [
            json!({ "candidates": [{ "content": { "role": "model", "parts": [
                { "thoughtSignature": "SIG", "functionCall": { "name": "file_read", "args": { "path": "README.md" }, "id": "call_1" } }
            ] } }], "usageMetadata": usage(67, 18) }),
            json!({ "candidates": [{ "content": { "role": "model", "parts": [{ "text": "" }] }, "finishReason": "STOP" }],
                    "usageMetadata": { "promptTokenCount": 67, "candidatesTokenCount": 18, "thoughtsTokenCount": 52 } }),
        ];
        let (result, seen) = run(&events, &[]).await;
        let turn = result.expect("ok");
        assert_eq!(
            turn.stop_reason, "tool_use",
            "STOP after a call is a tool stop"
        );
        assert_eq!(turn.usage.input_tokens, 67);
        assert_eq!(
            turn.usage.output_tokens, 70,
            "thinking tokens count as output"
        );
        let blocks = &turn.assistant_message.blocks;
        assert_eq!(blocks.len(), 2);
        match &blocks[0] {
            ContentBlock::Thinking {
                text, signature, ..
            } => {
                assert!(text.is_empty());
                assert_eq!(
                    signature.as_deref().and_then(decode_signature).as_deref(),
                    Some("SIG")
                );
            }
            other => panic!("expected the signature block, got {other:?}"),
        }
        assert!(
            matches!(&blocks[1], ContentBlock::ToolUse { id, input, .. } if id == "call_1" && input["path"] == "README.md")
        );
        assert!(seen
            .iter()
            .any(|e| matches!(e, AssistantEvent::ToolUseDelta { .. })));
        assert!(seen
            .iter()
            .any(|e| matches!(e, AssistantEvent::ToolUse { .. })));
    }

    /// The probe's Claude Sonnet 4.6 reply with thinking on: streamed thought
    /// text closed by a signed empty thought part, then text, then the call.
    #[tokio::test]
    async fn claude_thinking_text_and_signature_land_in_one_block() {
        let events = [
            json!({ "candidates": [{ "content": { "parts": [{ "thought": true, "text": "The user wants" }] } }] }),
            json!({ "candidates": [{ "content": { "parts": [{ "thought": true, "text": " README" }] } }] }),
            json!({ "candidates": [{ "content": { "parts": [{ "thought": true, "text": "", "thoughtSignature": "CSIG" }] } }] }),
            json!({ "candidates": [{ "content": { "parts": [{ "text": "Sure" }, { "text": "!" }] } }] }),
            json!({ "candidates": [{ "content": { "parts": [{ "functionCall": { "name": "file_read", "args": {}, "id": "toolu_vrtx_1" } }] } }] }),
            json!({ "candidates": [{ "content": { "parts": [{ "text": "" }] }, "finishReason": "STOP" }], "usageMetadata": usage(612, 91) }),
        ];
        let (result, _) = run(&events, &[]).await;
        let blocks = result.expect("ok").assistant_message.blocks;
        assert_eq!(blocks.len(), 3);
        match &blocks[0] {
            ContentBlock::Thinking {
                text, signature, ..
            } => {
                assert_eq!(text, "The user wants README");
                assert_eq!(
                    signature.as_deref().and_then(decode_signature).as_deref(),
                    Some("CSIG")
                );
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            blocks[1],
            ContentBlock::Text {
                text: "Sure!".into()
            }
        );
        assert!(matches!(&blocks[2], ContentBlock::ToolUse { .. }));
    }

    #[tokio::test]
    async fn gemini_end_of_turn_signature_is_dropped() {
        let events = [
            json!({ "candidates": [{ "content": { "parts": [{ "text": "The first word is Aurora." }] } }] }),
            json!({ "candidates": [{ "content": { "parts": [{ "text": "", "thoughtSignature": "END" }] }, "finishReason": "STOP" }] }),
        ];
        let (result, _) = run(&events, &[]).await;
        let turn = result.expect("ok");
        assert_eq!(turn.stop_reason, "end_turn");
        assert_eq!(
            turn.assistant_message.blocks,
            vec![ContentBlock::Text {
                text: "The first word is Aurora.".into()
            }]
        );
    }

    #[tokio::test]
    async fn a_sanitized_name_comes_back_as_the_declared_one() {
        let tools = vec![ToolSchema {
            name: "mcp_my server_do it".into(),
            description: String::new(),
            input_schema: json!({}),
        }];
        let events = [json!({ "candidates": [{ "content": { "parts": [
            { "functionCall": { "name": "mcp_my_server_do_it", "args": {} } }
        ] }, "finishReason": "STOP" }] })];
        let (result, _) = run(&events, &tools).await;
        let blocks = result.expect("ok").assistant_message.blocks;
        assert!(
            matches!(&blocks[0], ContentBlock::ToolUse { name, id, .. } if name == "mcp_my server_do it" && !id.is_empty())
        );
    }

    #[tokio::test]
    async fn max_tokens_and_withheld_replies_are_reported() {
        let cut = [
            json!({ "candidates": [{ "content": { "parts": [{ "text": "half" }] }, "finishReason": "MAX_TOKENS" }] }),
        ];
        assert_eq!(
            run(&cut, &[]).await.0.expect("ok").stop_reason,
            "max_tokens"
        );

        let safety =
            [json!({ "candidates": [{ "content": { "parts": [] }, "finishReason": "SAFETY" }] })];
        let turn = run(&safety, &[]).await.0.expect("ok");
        assert_eq!(turn.notices.len(), 1);
        assert!(turn.notices[0].contains("safety"));
    }

    #[tokio::test]
    async fn a_stream_without_a_finish_reason_is_a_dropped_connection() {
        let events = [json!({ "candidates": [{ "content": { "parts": [{ "text": "hal" }] } }] })];
        assert!(matches!(
            run(&events, &[]).await.0,
            Err(ApiError::Network(_))
        ));
    }

    #[tokio::test]
    async fn an_in_band_error_ends_the_turn_with_its_message() {
        let (tx, _rx) = mpsc::channel(8);
        let body = "data: {\"error\":{\"code\":429,\"message\":\"Resource has been exhausted\",\"status\":\"RESOURCE_EXHAUSTED\"}}\r\n\r\n";
        let result = drive_antigravity_stream(
            futures_util::stream::iter(vec![Ok::<_, std::io::Error>(body.as_bytes().to_vec())]),
            tx,
            CancellationToken::new(),
            &[],
        )
        .await;
        assert!(matches!(result, Err(ApiError::Provider(m)) if m.contains("RESOURCE_EXHAUSTED")));
    }
}
