use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::RwLock;
use tauri::Emitter;

// Global registry of active stream requests that can be cancelled
lazy_static::lazy_static! {
    static ref ACTIVE_STREAMS: Arc<RwLock<HashMap<String, bool>>> = Arc::new(RwLock::new(HashMap::new()));
}

#[derive(Debug, Deserialize)]
pub struct LlmRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    #[allow(dead_code)]
    pub stream: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct LlmResponse {
    pub status: u16,
    pub body: String,
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct StreamChunk {
    pub data: String,
    pub done: bool,
}

/// Make an LLM API request (bypasses CORS)
#[tauri::command]
pub async fn llm_request(request: LlmRequest) -> Result<LlmResponse, String> {
    let client = reqwest::Client::new();

    let mut req_builder = match request.method.to_uppercase().as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        "PUT" => client.put(&request.url),
        "DELETE" => client.delete(&request.url),
        _ => return Err(format!("Unsupported method: {}", request.method)),
    };

    // Add headers
    for (key, value) in &request.headers {
        req_builder = req_builder.header(key, value);
    }

    // Add body if present
    if let Some(body) = request.body {
        req_builder = req_builder.body(body);
    }

    // Send request
    let response = req_builder
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status().as_u16();

    // Collect headers
    let mut headers = HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(v) = value.to_str() {
            headers.insert(key.to_string(), v.to_string());
        }
    }

    // Get body
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(LlmResponse {
        status,
        body,
        headers,
    })
}

/// Cancel an active LLM stream request
#[tauri::command]
pub fn cancel_llm_stream(request_id: String) -> Result<(), String> {
    let mut streams = ACTIVE_STREAMS.write();
    if streams.contains_key(&request_id) {
        streams.insert(request_id.clone(), true); // Mark as cancelled
        Ok(())
    } else {
        // Stream might have already completed, that's fine
        Ok(())
    }
}

/// Check if a stream has been cancelled
fn is_stream_cancelled(request_id: &str) -> bool {
    let streams = ACTIVE_STREAMS.read();
    streams.get(request_id).copied().unwrap_or(false)
}

/// Remove stream from active registry
fn cleanup_stream(request_id: &str) {
    let mut streams = ACTIVE_STREAMS.write();
    streams.remove(request_id);
}

/// Make a streaming LLM API request (emits chunks via events)
/// Supports cancellation via cancel_llm_stream command
#[tauri::command]
pub async fn llm_stream_request(
    app: tauri::AppHandle,
    request_id: String,
    request: LlmRequest,
) -> Result<(), String> {
    use futures_util::StreamExt;

    // Register this stream as active (not cancelled)
    {
        let mut streams = ACTIVE_STREAMS.write();
        streams.insert(request_id.clone(), false);
    }

    let client = reqwest::Client::new();

    let mut req_builder = match request.method.to_uppercase().as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        _ => {
            cleanup_stream(&request_id);
            return Err(format!("Unsupported method for streaming: {}", request.method));
        }
    };

    // Add headers
    for (key, value) in &request.headers {
        req_builder = req_builder.header(key, value);
    }

    // Add body if present
    if let Some(body) = request.body {
        req_builder = req_builder.body(body);
    }

    // Send request
    let response = match req_builder.send().await {
        Ok(r) => r,
        Err(e) => {
            cleanup_stream(&request_id);
            return Err(format!("Request failed: {}", e));
        }
    };

    let status = response.status().as_u16();

    if status >= 400 {
        let body = response.text().await.unwrap_or_default();
        let _ = app.emit(&format!("llm-stream-error-{}", request_id), body);
        cleanup_stream(&request_id);
        return Err(format!("HTTP {}: {}", status, "Request failed"));
    }

    // Stream the response
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        // Check for cancellation before processing each chunk
        if is_stream_cancelled(&request_id) {
            // Signal that stream was cancelled (with done=true so frontend knows to stop)
            let _ = app.emit(
                &format!("llm-stream-{}", request_id),
                StreamChunk {
                    data: String::new(),
                    done: true,
                },
            );
            cleanup_stream(&request_id);
            // Return Ok - cancellation is not an error, it's expected behavior
            return Ok(());
        }

        match chunk {
            Ok(bytes) => {
                let data = String::from_utf8_lossy(&bytes).to_string();
                let _ = app.emit(
                    &format!("llm-stream-{}", request_id),
                    StreamChunk { data, done: false },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    &format!("llm-stream-error-{}", request_id),
                    format!("Stream error: {}", e),
                );
                cleanup_stream(&request_id);
                return Err(format!("Stream error: {}", e));
            }
        }
    }

    // Signal completion
    let _ = app.emit(
        &format!("llm-stream-{}", request_id),
        StreamChunk {
            data: String::new(),
            done: true,
        },
    );

    cleanup_stream(&request_id);
    Ok(())
}
