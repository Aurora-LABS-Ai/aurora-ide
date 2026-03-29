use super::types::{
    AnthropicUsage, AuroraAssistantMessage, AuroraProviderResponse, AuroraToolCall,
    AuroraToolFunction, AuroraUsage,
};
use serde_json::{json, Value};

pub(crate) fn parse_sse_json_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return None;
    }
    if trimmed == "data: [DONE]" || trimmed == "[DONE]" {
        return None;
    }

    let json_str = if let Some(rest) = trimmed.strip_prefix("data: ") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("data:") {
        rest.trim()
    } else if trimmed.starts_with('{') {
        trimmed
    } else {
        return None;
    };

    serde_json::from_str(json_str).ok()
}

pub(crate) fn parse_openai_response(json: &Value) -> AuroraProviderResponse {
    let message = json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .cloned()
        .unwrap_or(Value::Null);

    let content = message
        .get("content")
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();

    let reasoning_content = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|tool_calls| parse_tool_calls(tool_calls))
        .filter(|tool_calls| !tool_calls.is_empty());

    let stop_reason = json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let usage = json.get("usage").map(parse_openai_usage);

    AuroraProviderResponse {
        message: AuroraAssistantMessage {
            content,
            reasoning_content,
            role: "assistant".to_string(),
            tool_calls,
        },
        stop_reason,
        usage,
    }
}

pub(crate) fn parse_anthropic_response(json: &Value) -> AuroraProviderResponse {
    let mut content = String::new();
    let mut reasoning_content = String::new();
    let mut tool_calls = Vec::new();

    if let Some(blocks) = json.get("content").and_then(Value::as_array) {
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        content.push_str(text);
                    }
                }
                Some("thinking") => {
                    if let Some(thinking) = block.get("thinking").and_then(Value::as_str) {
                        reasoning_content.push_str(thinking);
                    }
                }
                Some("tool_use") => {
                    let arguments = block
                        .get("input")
                        .cloned()
                        .unwrap_or_else(|| json!({}))
                        .to_string();
                    tool_calls.push(AuroraToolCall {
                        function: AuroraToolFunction {
                            arguments,
                            name: block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        },
                        id: block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        tool_type: "function".to_string(),
                    });
                }
                _ => {}
            }
        }
    }

    let usage = json.get("usage").and_then(|usage| {
        serde_json::from_value::<AnthropicUsage>(usage.clone())
            .ok()
            .map(|usage| anthropic_usage_to_aurora(&usage))
    });

    AuroraProviderResponse {
        message: AuroraAssistantMessage {
            content,
            reasoning_content: if reasoning_content.is_empty() {
                None
            } else {
                Some(reasoning_content)
            },
            role: "assistant".to_string(),
            tool_calls: if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
        },
        stop_reason: json
            .get("stop_reason")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        usage,
    }
}

pub(crate) fn parse_openai_usage(usage: &Value) -> AuroraUsage {
    AuroraUsage {
        cache_read_tokens: None,
        cache_write_tokens: None,
        completion_tokens: usage
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
        prompt_tokens: usage
            .get("prompt_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
        total_tokens: usage
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
    }
}

pub(crate) fn anthropic_usage_to_aurora(usage: &AnthropicUsage) -> AuroraUsage {
    let prompt_tokens = usage.input_tokens.unwrap_or_default();
    let completion_tokens = usage.output_tokens.unwrap_or_default();
    AuroraUsage {
        cache_read_tokens: usage.cache_read_input_tokens,
        cache_write_tokens: usage.cache_creation_input_tokens,
        completion_tokens,
        prompt_tokens,
        total_tokens: prompt_tokens + completion_tokens,
    }
}

fn parse_tool_calls(tool_calls: &[Value]) -> Vec<AuroraToolCall> {
    tool_calls
        .iter()
        .filter_map(|tool_call| {
            let function = tool_call.get("function")?;
            Some(AuroraToolCall {
                function: AuroraToolFunction {
                    arguments: function
                        .get("arguments")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    name: function
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                },
                id: tool_call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                tool_type: tool_call
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("function")
                    .to_string(),
            })
        })
        .collect()
}
