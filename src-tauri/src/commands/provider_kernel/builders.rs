use super::presets::{
    normalize_provider_type, AuthType, ProviderFormat, ProviderPreset, ThinkingMode,
};
use super::types::{
    AuroraMessage, AuroraProviderConfig, AuroraProviderRequest, AuroraToolDefinition,
};
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CACHE_CONTROL, CONNECTION, CONTENT_TYPE,
};
use serde_json::{json, Map, Value};

pub(crate) fn build_headers(
    config: &AuroraProviderConfig,
    preset: &ProviderPreset,
) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    for (key, value) in preset.required_headers {
        insert_header(&mut headers, key, value)?;
    }

    if !config.api_key.is_empty() {
        match preset.auth_type {
            AuthType::Bearer => {
                let auth_value = format!("Bearer {}", config.api_key);
                headers.insert(
                    AUTHORIZATION,
                    HeaderValue::from_str(&auth_value).map_err(|error| error.to_string())?,
                );
            }
            AuthType::XApiKey => {
                insert_header(&mut headers, preset.auth_header, &config.api_key)?;
            }
        }
    }

    if let Some(custom_headers) = &config.custom_headers {
        for (key, value) in custom_headers {
            insert_header(&mut headers, key, value)?;
        }
    }

    Ok(headers)
}

pub(crate) fn build_stream_headers(
    config: &AuroraProviderConfig,
    preset: &ProviderPreset,
) -> Result<HeaderMap, String> {
    let mut headers = build_headers(config, preset)?;
    insert_header(&mut headers, "accept", "text/event-stream")?;
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
    Ok(headers)
}

pub(crate) fn build_request_body(
    request: &AuroraProviderRequest,
    preset: &ProviderPreset,
) -> Result<Value, String> {
    match preset.format {
        ProviderFormat::OpenAi => Ok(build_openai_request_body(request, preset)),
        ProviderFormat::Anthropic => build_anthropic_request_body(request),
    }
}

pub(crate) fn resolve_max_tokens(request: &AuroraProviderRequest) -> u32 {
    request
        .max_tokens
        .or(request.provider.default_max_tokens)
        .unwrap_or(4096)
}

pub(crate) fn resolve_temperature(request: &AuroraProviderRequest) -> f32 {
    request
        .temperature
        .or(request.provider.default_temperature)
        .unwrap_or(1.0)
}

pub(crate) fn value_to_text(content: Option<&Value>) -> String {
    match content {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    block
                        .get("text")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(""),
        Some(other) => other.to_string(),
    }
}

pub(crate) fn value_to_string(content: Option<&Value>) -> String {
    match content {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

fn insert_header(headers: &mut HeaderMap, key: &str, value: &str) -> Result<(), String> {
    let name = HeaderName::from_bytes(key.as_bytes()).map_err(|error| error.to_string())?;
    let header_value = HeaderValue::from_str(value).map_err(|error| error.to_string())?;
    headers.insert(name, header_value);
    Ok(())
}

fn build_openai_request_body(request: &AuroraProviderRequest, preset: &ProviderPreset) -> Value {
    let provider = &request.provider;
    let model = provider.model.to_ascii_lowercase();
    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(provider.model.clone()));
    body.insert(
        "messages".to_string(),
        Value::Array(
            request
                .messages
                .iter()
                .map(|message| convert_openai_message(message, preset))
                .collect(),
        ),
    );
    body.insert("stream".to_string(), Value::Bool(request.stream));
    body.insert(
        "max_tokens".to_string(),
        Value::from(resolve_max_tokens(request)),
    );

    if !should_skip_temperature(preset, &model) {
        body.insert(
            "temperature".to_string(),
            Value::from(resolve_temperature(request)),
        );
    }

    if provider.supports_thinking
        && request.thinking_enabled.unwrap_or(true)
        && !is_deepseek_reasoner(preset, &model)
    {
        apply_openai_thinking_params(&mut body, preset);
    }

    if let Some(tools) = &request.tools {
        if !tools.is_empty() {
            body.insert(
                "tools".to_string(),
                Value::Array(
                    tools
                        .iter()
                        .map(|tool| serde_json::to_value(tool).unwrap_or(Value::Null))
                        .collect(),
                ),
            );
            body.insert("tool_choice".to_string(), Value::String("auto".to_string()));

            if normalize_provider_type(&provider.provider_type, &provider.base_url, &provider.model)
                == "glm"
            {
                body.insert("tool_stream".to_string(), Value::Bool(true));
            }
        }
    }

    if request.stream && preset.include_stream_options {
        body.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );
    }

    for (key, value) in preset.default_params {
        body.entry((*key).to_string())
            .or_insert_with(|| Value::String((*value).to_string()));
    }

    if let Some(custom_params) = &provider.custom_params {
        for (key, value) in custom_params {
            body.insert(key.clone(), value.clone());
        }
    }

    Value::Object(body)
}

fn convert_openai_message(message: &AuroraMessage, preset: &ProviderPreset) -> Value {
    let mut payload = Map::new();
    payload.insert("role".to_string(), Value::String(message.role.clone()));

    if let Some(content) = &message.content {
        match content {
            Value::String(text) if !text.is_empty() => {
                payload.insert("content".to_string(), Value::String(text.clone()));
            }
            Value::Array(values) if !values.is_empty() => {
                payload.insert("content".to_string(), Value::Array(values.clone()));
            }
            Value::Null => {
                payload.insert("content".to_string(), Value::Null);
            }
            _ => {}
        }
    }

    if message.role == "assistant" {
        if let Some(tool_calls) = &message.tool_calls {
            if !tool_calls.is_empty() {
                payload.insert(
                    "tool_calls".to_string(),
                    Value::Array(
                        tool_calls
                            .iter()
                            .map(|tool_call| {
                                json!({
                                    "id": tool_call.id,
                                    "type": tool_call.tool_type,
                                    "function": {
                                        "name": tool_call.function.name,
                                        "arguments": normalize_openai_tool_arguments(&tool_call.function.arguments),
                                    }
                                })
                            })
                            .collect(),
                    ),
                );

                if !payload.contains_key("content") {
                    payload.insert("content".to_string(), Value::Null);
                }
            }
        }

        if let Some(reasoning_content) = &message.reasoning_content {
            if matches!(
                preset.thinking_mode,
                ThinkingMode::OpenAiThinkingEnabled
                    | ThinkingMode::OpenAiThinkingPreserved
                    | ThinkingMode::ReasoningEffortHigh
                    | ThinkingMode::ReasoningEffortMedium
            ) {
                payload.insert(
                    "reasoning_content".to_string(),
                    Value::String(reasoning_content.clone()),
                );
            }
        }
    }

    if message.role == "tool" {
        if let Some(tool_call_id) = &message.tool_call_id {
            payload.insert(
                "tool_call_id".to_string(),
                Value::String(tool_call_id.clone()),
            );
        }

        if !matches!(payload.get("content"), Some(Value::String(_))) {
            payload.insert(
                "content".to_string(),
                Value::String(value_to_string(message.content.as_ref())),
            );
        }
    }

    Value::Object(payload)
}

fn normalize_openai_tool_arguments(arguments: &str) -> String {
    match serde_json::from_str::<Value>(arguments) {
        Ok(Value::Object(object)) => Value::Object(object).to_string(),
        Ok(_) => "{}".to_string(),
        Err(_) => "{}".to_string(),
    }
}

fn build_anthropic_request_body(request: &AuroraProviderRequest) -> Result<Value, String> {
    let provider = &request.provider;
    let (system, messages) = convert_messages_for_anthropic(&request.messages)?;
    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(provider.model.clone()));
    body.insert("messages".to_string(), Value::Array(messages));
    body.insert(
        "max_tokens".to_string(),
        Value::from(resolve_max_tokens(request)),
    );
    body.insert("stream".to_string(), Value::Bool(request.stream));
    body.insert(
        "temperature".to_string(),
        Value::from(resolve_temperature(request)),
    );

    if let Some(system_prompt) = system {
        body.insert("system".to_string(), Value::String(system_prompt));
    }

    if let Some(tools) = &request.tools {
        if !tools.is_empty() {
            body.insert("tools".to_string(), convert_tools_for_anthropic(tools));
        }
    }

    if let Some(custom_params) = &provider.custom_params {
        for (key, value) in custom_params {
            body.insert(key.clone(), value.clone());
        }
    }

    Ok(Value::Object(body))
}

fn convert_messages_for_anthropic(
    messages: &[AuroraMessage],
) -> Result<(Option<String>, Vec<Value>), String> {
    let mut system = None;
    let mut output = Vec::with_capacity(messages.len());

    for message in messages {
        match message.role.as_str() {
            "system" => {
                system = Some(value_to_text(message.content.as_ref()));
            }
            "tool" => {
                output.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": message.tool_call_id.clone().unwrap_or_default(),
                        "content": value_to_string(message.content.as_ref()),
                    }]
                }));
            }
            "assistant" => {
                let mut content_blocks = anthropic_content_blocks(message.content.as_ref())?;
                inject_reasoning_block(&mut content_blocks, message.reasoning_content.as_deref());

                if let Some(tool_calls) = &message.tool_calls {
                    for tool_call in tool_calls {
                        let parsed_arguments =
                            serde_json::from_str::<Value>(&tool_call.function.arguments)
                                .unwrap_or_else(|_| json!({}));
                        content_blocks.push(json!({
                            "type": "tool_use",
                            "id": tool_call.id,
                            "name": tool_call.function.name,
                            "input": parsed_arguments,
                        }));
                    }
                }

                output.push(json!({
                    "role": "assistant",
                    "content": if content_blocks.is_empty() {
                        Value::String(String::new())
                    } else {
                        Value::Array(content_blocks)
                    }
                }));
            }
            "user" => {
                let content = anthropic_content_value(message.content.as_ref())?;
                output.push(json!({
                    "role": "user",
                    "content": content,
                }));
            }
            other => {
                return Err(format!("unsupported message role for anthropic: {other}"));
            }
        }
    }

    Ok((system, output))
}

fn anthropic_content_value(content: Option<&Value>) -> Result<Value, String> {
    match content {
        None | Some(Value::Null) => Ok(Value::String(String::new())),
        Some(Value::String(text)) => Ok(Value::String(text.clone())),
        Some(Value::Array(_)) => Ok(Value::Array(anthropic_content_blocks(content)?)),
        Some(other) => Ok(Value::String(other.to_string())),
    }
}

fn anthropic_content_blocks(content: Option<&Value>) -> Result<Vec<Value>, String> {
    let Some(content) = content else {
        return Ok(Vec::new());
    };

    let Value::Array(blocks) = content else {
        return Ok(match content {
            Value::String(text) if !text.is_empty() => {
                vec![json!({ "type": "text", "text": text })]
            }
            _ => Vec::new(),
        });
    };

    let mut output = Vec::with_capacity(blocks.len());
    for block in blocks {
        let Some(block_type) = block.get("type").and_then(Value::as_str) else {
            continue;
        };

        match block_type {
            "text" => {
                output.push(json!({
                    "type": "text",
                    "text": block.get("text").and_then(Value::as_str).unwrap_or_default(),
                }));
            }
            "thinking" => {
                output.push(json!({
                    "type": "thinking",
                    "thinking": block.get("thinking").and_then(Value::as_str).unwrap_or_default(),
                    "signature": block.get("signature").cloned().unwrap_or(Value::Null),
                }));
            }
            "image" => {
                output.push(json!({
                    "type": "image",
                    "source": block.get("source").cloned().unwrap_or(Value::Null),
                }));
            }
            "tool_use" => {
                output.push(json!({
                    "type": "tool_use",
                    "id": block.get("id").cloned().unwrap_or(Value::Null),
                    "name": block.get("name").cloned().unwrap_or(Value::Null),
                    "input": block.get("input").cloned().unwrap_or_else(|| json!({})),
                }));
            }
            "tool_result" => {
                output.push(json!({
                    "type": "tool_result",
                    "tool_use_id": block.get("tool_use_id").cloned().unwrap_or(Value::Null),
                    "content": block
                        .get("content")
                        .cloned()
                        .unwrap_or_else(|| Value::String(String::new())),
                }));
            }
            _ => {}
        }
    }

    Ok(output)
}

fn inject_reasoning_block(content_blocks: &mut Vec<Value>, reasoning_content: Option<&str>) {
    let Some(reasoning_content) = reasoning_content.map(str::trim) else {
        return;
    };

    if reasoning_content.is_empty() {
        return;
    }

    let already_has_thinking = content_blocks
        .iter()
        .any(|block| block.get("type").and_then(Value::as_str) == Some("thinking"));

    if already_has_thinking {
        return;
    }

    content_blocks.insert(
        0,
        json!({
            "type": "thinking",
            "thinking": reasoning_content,
        }),
    );
}

fn convert_tools_for_anthropic(tools: &[AuroraToolDefinition]) -> Value {
    Value::Array(
        tools.iter()
            .map(|tool| {
                json!({
                    "name": tool.function.name,
                    "description": tool.function.description,
                    "input_schema": {
                        "type": "object",
                        "properties": tool.function.parameters.get("properties").cloned().unwrap_or_else(|| json!({})),
                        "required": tool.function.parameters.get("required").cloned().unwrap_or(Value::Null),
                    }
                })
            })
            .collect(),
    )
}

fn should_skip_temperature(preset: &ProviderPreset, model: &str) -> bool {
    matches!(normalize_provider_type("", "", model).as_str(), "deepseek")
        && model.contains("reasoner")
        && matches!(preset.format, ProviderFormat::OpenAi)
}

fn is_deepseek_reasoner(preset: &ProviderPreset, model: &str) -> bool {
    matches!(preset.format, ProviderFormat::OpenAi)
        && normalize_provider_type("", "", model) == "deepseek"
        && model.contains("reasoner")
}

fn apply_openai_thinking_params(body: &mut Map<String, Value>, preset: &ProviderPreset) {
    match preset.thinking_mode {
        ThinkingMode::OpenAiThinkingEnabled => {
            body.insert("thinking".to_string(), json!({ "type": "enabled" }));
        }
        ThinkingMode::OpenAiThinkingPreserved => {
            body.insert(
                "thinking".to_string(),
                json!({ "type": "enabled", "clear_thinking": false }),
            );
        }
        ThinkingMode::ReasoningEffortHigh => {
            body.insert(
                "reasoning_effort".to_string(),
                Value::String("high".to_string()),
            );
        }
        ThinkingMode::ReasoningEffortMedium => {
            body.insert(
                "reasoning_effort".to_string(),
                Value::String("medium".to_string()),
            );
        }
        ThinkingMode::None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{inject_reasoning_block, normalize_openai_tool_arguments};
    use serde_json::{json, Value};

    #[test]
    fn keeps_valid_object_arguments() {
        let normalized = normalize_openai_tool_arguments(r#"{"path":"src/app.ts","content":"hi"}"#);
        assert_eq!(
            serde_json::from_str::<Value>(&normalized).unwrap(),
            json!({"path":"src/app.ts","content":"hi"})
        );
    }

    #[test]
    fn replaces_invalid_arguments_with_empty_object() {
        assert_eq!(normalize_openai_tool_arguments("{"), "{}");
        assert_eq!(normalize_openai_tool_arguments(r#""not-object""#), "{}");
    }

    #[test]
    fn injects_reasoning_block_at_start_for_anthropic_history() {
        let mut blocks = vec![json!({ "type": "text", "text": "hello" })];

        inject_reasoning_block(&mut blocks, Some("step by step"));

        assert_eq!(
            blocks,
            vec![
                json!({ "type": "thinking", "thinking": "step by step" }),
                json!({ "type": "text", "text": "hello" }),
            ]
        );
    }

    #[test]
    fn does_not_duplicate_existing_reasoning_blocks() {
        let mut blocks = vec![json!({ "type": "thinking", "thinking": "existing" })];

        inject_reasoning_block(&mut blocks, Some("new"));

        assert_eq!(
            blocks,
            vec![json!({ "type": "thinking", "thinking": "existing" })]
        );
    }
}
