/**
 * OpenAI-Native Provider using raw HTTP streaming
 *
 * This provides direct integration with OpenAI-compatible APIs (LM Studio, Ollama, etc.)
 * using raw HTTP streaming to support extended fields like reasoning_content that
 * aren't exposed by the async-openai crate.
 */
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tauri::Emitter;

/// Message format from TypeScript
#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    pub tool_calls: Option<Vec<ToolCallInfo>>,
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct ToolCallInfo {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: Option<String>,
    pub function: ToolFunction,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct ToolFunction {
    pub name: String,
    pub arguments: String,
}

/// Tool definition from TypeScript
#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: FunctionDefinition,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct FunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Request payload - now includes extra_body for thinking params
#[derive(Debug, Deserialize)]
pub struct OpenAINativeRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Option<Vec<ToolDefinition>>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub stream: bool,
    /// Extra body parameters (e.g., reasoning_effort for thinking models)
    pub extra_body: Option<HashMap<String, Value>>,
    /// Whether to include stream_options for usage tracking (some providers like Ollama don't support this)
    pub include_stream_options: Option<bool>,
}

/// Stream chunk payload
#[derive(Debug, Serialize, Clone)]
pub struct NativeStreamChunk {
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls: Option<Vec<StreamToolCall>>,
    pub finish_reason: Option<String>,
    pub done: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct StreamToolCall {
    pub index: i32,
    pub id: Option<String>,
    pub function_name: Option<String>,
    pub function_arguments: Option<String>,
}

/// Usage info
#[derive(Debug, Serialize, Clone)]
pub struct UsageInfo {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// SSE Delta structure for parsing streaming responses
/// Supports both `reasoning` (LM Studio local models) and `reasoning_content` (DeepSeek/GLM)
#[derive(Debug, Deserialize)]
struct StreamingDelta {
    content: Option<String>,
    /// DeepSeek/GLM style reasoning
    reasoning_content: Option<String>,
    /// LM Studio / local model style reasoning
    reasoning: Option<String>,
    tool_calls: Option<Vec<StreamingToolCall>>,
}

#[derive(Debug, Deserialize)]
struct StreamingToolCall {
    index: i32,
    id: Option<String>,
    function: Option<StreamingFunction>,
}

#[derive(Debug, Deserialize)]
struct StreamingFunction {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamingChoice {
    delta: StreamingDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamingResponse {
    choices: Vec<StreamingChoice>,
    usage: Option<UsageData>,
}

#[derive(Debug, Deserialize)]
struct UsageData {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

/// Build the request body for OpenAI-compatible API
fn build_request_body(request: &OpenAINativeRequest) -> Value {
    let mut body = serde_json::json!({
        "model": request.model,
        "messages": request.messages,
        "stream": request.stream,
    });

    if let Some(temp) = request.temperature {
        body["temperature"] = serde_json::json!(temp);
    }

    if let Some(max_tokens) = request.max_tokens {
        body["max_tokens"] = serde_json::json!(max_tokens);
    }

    if let Some(tools) = &request.tools {
        if !tools.is_empty() {
            body["tools"] = serde_json::json!(tools);
        }
    }

    // Add extra body parameters (e.g., reasoning_effort)
    if let Some(extra) = &request.extra_body {
        if let Some(obj) = body.as_object_mut() {
            for (key, value) in extra {
                obj.insert(key.clone(), value.clone());
            }
        }
    }

    // Add stream_options for usage tracking (only if provider supports it)
    if request.stream && request.include_stream_options.unwrap_or(true) {
        body["stream_options"] = serde_json::json!({
            "include_usage": true
        });
    }

    body
}

/// Parse an SSE line and return the JSON data if valid
fn parse_sse_line(line: &str) -> Option<Value> {
    let line = line.trim();

    // Skip empty lines and comments
    if line.is_empty() || line.starts_with(':') {
        return None;
    }

    // Handle "data: [DONE]"
    if line == "data: [DONE]" || line == "[DONE]" {
        return None;
    }

    // Extract data from SSE format
    let json_str = if line.starts_with("data: ") {
        &line[6..]
    } else if line.starts_with("data:") {
        &line[5..]
    } else if line.starts_with('{') {
        // Raw JSON line
        line
    } else {
        return None;
    };

    // Parse JSON
    serde_json::from_str(json_str).ok()
}

/// Streaming chat completion using raw HTTP
#[tauri::command]
pub async fn openai_native_stream(
    app: tauri::AppHandle,
    request_id: String,
    request: OpenAINativeRequest,
) -> Result<(), String> {
    // Build URL
    let url = format!(
        "{}/chat/completions",
        request.base_url.trim_end_matches('/')
    );

    // Build headers for SSE streaming
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    // Accept SSE stream
    headers.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("text/event-stream"),
    );
    // Disable caching for real-time streaming
    headers.insert(
        reqwest::header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    // Keep connection alive for streaming
    headers.insert(
        reqwest::header::CONNECTION,
        HeaderValue::from_static("keep-alive"),
    );

    if !request.api_key.is_empty() {
        let auth_value = format!("Bearer {}", request.api_key);
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&auth_value).map_err(|e| e.to_string())?,
        );
    }

    // Build request body
    let body = build_request_body(&request);

    // Create HTTP client configured for streaming
    // Disable automatic decompression which can cause buffering
    let client = reqwest::Client::builder()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(&url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            let error_msg = format!("Failed to connect: {}", e);
            let _ = app.emit(&format!("openai-native-error-{}", request_id), &error_msg);
            error_msg
        })?;

    // Check response status
    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        let error_msg = format!("HTTP {}: {}", status, error_body);
        let _ = app.emit(&format!("openai-native-error-{}", request_id), &error_msg);
        return Err(error_msg);
    }

    // Track accumulated tool call data
    let mut tool_calls_data: HashMap<i32, (String, String, String)> = HashMap::new();

    // Track content for debugging
    let mut total_content = String::new();
    let mut total_reasoning = String::new();
    let mut chunk_count = 0u32;

    // Buffer for incomplete SSE lines
    let mut buffer = String::new();

    // Process the byte stream
    let mut stream = response.bytes_stream();
    let mut http_chunk_count = 0u32;

    println!("[openai_native] Starting stream processing...");

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                let error_msg = format!("Stream error: {}", e);
                let _ = app.emit(&format!("openai-native-error-{}", request_id), &error_msg);
                continue;
            }
        };

        http_chunk_count += 1;
        // Log first few HTTP chunks to debug buffering
        if http_chunk_count <= 5 {
            println!(
                "[openai_native] HTTP chunk {}: {} bytes",
                http_chunk_count,
                chunk.len()
            );
        }

        // Convert bytes to string and add to buffer
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        // Process complete lines
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            // Parse SSE line
            if let Some(json_data) = parse_sse_line(&line) {
                // Try to parse as streaming response
                if let Ok(response) = serde_json::from_value::<StreamingResponse>(json_data.clone())
                {
                    for choice in &response.choices {
                        let delta = &choice.delta;

                        // Extract content
                        let content = delta.content.clone();
                        if let Some(ref c) = content {
                            total_content.push_str(c);
                            chunk_count += 1;
                        }

                        // Extract reasoning - support both field names:
                        // - `reasoning` (LM Studio / local models like gpt-oss-20b)
                        // - `reasoning_content` (DeepSeek, GLM)
                        let reasoning_content = delta
                            .reasoning
                            .clone()
                            .or_else(|| delta.reasoning_content.clone());
                        if let Some(ref r) = reasoning_content {
                            total_reasoning.push_str(r);
                        }

                        // Extract tool calls
                        let tool_calls: Option<Vec<StreamToolCall>> =
                            delta.tool_calls.as_ref().map(|tcs| {
                                tcs.iter()
                                    .map(|tc| {
                                        let index = tc.index;

                                        // Initialize or update tool call data
                                        let entry =
                                            tool_calls_data.entry(index).or_insert_with(|| {
                                                (String::new(), String::new(), String::new())
                                            });

                                        if let Some(id) = &tc.id {
                                            entry.0 = id.clone();
                                        }
                                        if let Some(func) = &tc.function {
                                            if let Some(name) = &func.name {
                                                entry.1 = name.clone();
                                            }
                                            if let Some(args) = &func.arguments {
                                                entry.2.push_str(args);
                                            }
                                        }

                                        StreamToolCall {
                                            index,
                                            id: tc.id.clone(),
                                            function_name: tc
                                                .function
                                                .as_ref()
                                                .and_then(|f| f.name.clone()),
                                            function_arguments: tc
                                                .function
                                                .as_ref()
                                                .and_then(|f| f.arguments.clone()),
                                        }
                                    })
                                    .collect()
                            });

                        // Emit chunk immediately for real-time streaming
                        let chunk = NativeStreamChunk {
                            content,
                            reasoning_content,
                            tool_calls,
                            finish_reason: choice.finish_reason.clone(),
                            done: false,
                        };

                        let _ = app.emit(&format!("openai-native-chunk-{}", request_id), chunk);
                    }

                    // Send usage if available
                    if let Some(usage) = &response.usage {
                        let usage_info = UsageInfo {
                            prompt_tokens: usage.prompt_tokens,
                            completion_tokens: usage.completion_tokens,
                            total_tokens: usage.total_tokens,
                        };
                        let _ =
                            app.emit(&format!("openai-native-usage-{}", request_id), usage_info);
                    }
                }
            }
        }
    }

    // Process any remaining data in buffer
    if !buffer.trim().is_empty() {
        if let Some(json_data) = parse_sse_line(&buffer) {
            if let Ok(response) = serde_json::from_value::<StreamingResponse>(json_data) {
                for choice in &response.choices {
                    let delta = &choice.delta;

                    if let Some(ref c) = delta.content {
                        total_content.push_str(c);
                        // Support both reasoning field names
                        let reasoning = delta
                            .reasoning
                            .clone()
                            .or_else(|| delta.reasoning_content.clone());
                        let chunk = NativeStreamChunk {
                            content: Some(c.clone()),
                            reasoning_content: reasoning,
                            tool_calls: None,
                            finish_reason: choice.finish_reason.clone(),
                            done: false,
                        };
                        let _ = app.emit(&format!("openai-native-chunk-{}", request_id), chunk);
                    }
                }
            }
        }
    }

    // Log final stats
    println!(
        "[openai_native] Stream complete: {} chunks, {} content chars, {} reasoning chars",
        chunk_count,
        total_content.len(),
        total_reasoning.len()
    );

    // Send final chunk with accumulated tool calls
    let final_tool_calls: Option<Vec<StreamToolCall>> = if !tool_calls_data.is_empty() {
        Some(
            tool_calls_data
                .iter()
                .map(|(index, (id, name, args))| StreamToolCall {
                    index: *index,
                    id: Some(id.clone()),
                    function_name: Some(name.clone()),
                    function_arguments: Some(args.clone()),
                })
                .collect(),
        )
    } else {
        None
    };

    let done_chunk = NativeStreamChunk {
        content: None,
        reasoning_content: None,
        tool_calls: final_tool_calls,
        finish_reason: Some("stop".to_string()),
        done: true,
    };
    let _ = app.emit(&format!("openai-native-chunk-{}", request_id), done_chunk);

    Ok(())
}

/// Non-streaming chat completion using raw HTTP
#[tauri::command]
pub async fn openai_native_chat(request: OpenAINativeRequest) -> Result<Value, String> {
    // Build URL
    let url = format!(
        "{}/chat/completions",
        request.base_url.trim_end_matches('/')
    );

    // Build headers
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    if !request.api_key.is_empty() {
        let auth_value = format!("Bearer {}", request.api_key);
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&auth_value).map_err(|e| e.to_string())?,
        );
    }

    // Build request body (non-streaming)
    let mut body = build_request_body(&request);
    body["stream"] = serde_json::json!(false);

    // Create HTTP client and send request
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    // Check response status
    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, error_body));
    }

    // Parse JSON response
    let json_response: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(json_response)
}
