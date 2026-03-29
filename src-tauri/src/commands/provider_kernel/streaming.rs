use super::parsers::{anthropic_usage_to_aurora, parse_sse_json_line};
use super::types::{
    AnthropicStreamEvent, AuroraStreamChunk, AuroraStreamToolCall, AuroraToolCall,
    AuroraToolFunction, AuroraUsage, OpenAiStreamingResponse,
};
use futures_util::StreamExt;
use parking_lot::RwLock;
use std::collections::HashMap;
use tauri::Emitter;

lazy_static::lazy_static! {
    static ref ACTIVE_PROVIDER_STREAMS: RwLock<HashMap<String, bool>> = RwLock::new(HashMap::new());
}

pub(crate) fn register_stream(request_id: &str) {
    let mut streams = ACTIVE_PROVIDER_STREAMS.write();
    streams.insert(request_id.to_string(), false);
}

pub(crate) fn cancel_stream(request_id: &str) {
    let mut streams = ACTIVE_PROVIDER_STREAMS.write();
    if streams.contains_key(request_id) {
        streams.insert(request_id.to_string(), true);
    }
}

pub(crate) fn cleanup_stream(request_id: &str) {
    let mut streams = ACTIVE_PROVIDER_STREAMS.write();
    streams.remove(request_id);
}

pub(crate) async fn stream_openai_compatible(
    app: tauri::AppHandle,
    request_id: &str,
    response: reqwest::Response,
) -> Result<(), String> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut tool_calls: HashMap<i32, AuroraToolCall> = HashMap::new();
    let mut finish_reason = None;

    while let Some(chunk_result) = stream.next().await {
        if is_stream_cancelled(request_id) {
            emit_done(&app, request_id, None);
            return Ok(());
        }

        let chunk = match chunk_result {
            Ok(chunk) => chunk,
            Err(error) => {
                let message = format!("stream error: {error}");
                emit_error(&app, request_id, &message);
                return Err(message);
            }
        };

        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            let Some(json_payload) = parse_sse_json_line(&line) else {
                continue;
            };

            let parsed: OpenAiStreamingResponse = match serde_json::from_value(json_payload) {
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
                        let entry = tool_calls.entry(delta_tool_call.index).or_insert_with(|| {
                            AuroraToolCall {
                                function: AuroraToolFunction {
                                    arguments: String::new(),
                                    name: String::new(),
                                },
                                id: delta_tool_call
                                    .id
                                    .clone()
                                    .unwrap_or_else(|| format!("tool_{}", delta_tool_call.index)),
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

    emit_done(&app, request_id, finish_reason);
    Ok(())
}

pub(crate) async fn stream_anthropic_compatible(
    app: tauri::AppHandle,
    request_id: &str,
    response: reqwest::Response,
) -> Result<(), String> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut tool_calls: HashMap<i32, AuroraToolCall> = HashMap::new();

    while let Some(chunk_result) = stream.next().await {
        if is_stream_cancelled(request_id) {
            emit_done(&app, request_id, None);
            return Ok(());
        }

        let chunk = match chunk_result {
            Ok(chunk) => chunk,
            Err(error) => {
                let message = format!("stream error: {error}");
                emit_error(&app, request_id, &message);
                return Err(message);
            }
        };

        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            let Some(json_payload) = parse_sse_json_line(&line) else {
                continue;
            };

            let event: AnthropicStreamEvent = match serde_json::from_value(json_payload) {
                Ok(event) => event,
                Err(_) => continue,
            };

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
                    let Some(index) = event.index else {
                        continue;
                    };

                    if let Some(content_block) = event.content_block {
                        if content_block.block_type == "tool_use" {
                            let tool_call = AuroraToolCall {
                                function: AuroraToolFunction {
                                    arguments: String::new(),
                                    name: content_block.name.unwrap_or_default(),
                                },
                                id: content_block
                                    .id
                                    .unwrap_or_else(|| format!("tool_{index}")),
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
                    }
                }
                "content_block_delta" => {
                    let Some(index) = event.index else {
                        continue;
                    };
                    let Some(delta) = event.delta else {
                        continue;
                    };

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
    }

    emit_done(&app, request_id, Some("end_turn".to_string()));
    Ok(())
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

fn is_stream_cancelled(request_id: &str) -> bool {
    let streams = ACTIVE_PROVIDER_STREAMS.read();
    streams.get(request_id).copied().unwrap_or(false)
}
