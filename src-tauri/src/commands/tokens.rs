//! Token Counting Commands
//!
//! Tauri commands for accurate token counting using tiktoken-rs

use serde::{Deserialize, Serialize};

use crate::services::token_service::{ChatMessage, EncodingType, TokenCount, TokenService};

/// Count tokens request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountTokensRequest {
    pub text: String,
    pub model: Option<String>,
    pub encoding: Option<String>,
}

/// Count tokens for text
#[tauri::command]
pub fn count_tokens(request: CountTokensRequest) -> Result<TokenCount, String> {
    if let Some(model) = request.model {
        TokenService::count_tokens_for_model(&request.text, &model)
    } else {
        let encoding = request
            .encoding
            .as_deref()
            .map(parse_encoding)
            .unwrap_or(EncodingType::Default);
        TokenService::count_tokens(&request.text, encoding)
    }
}

/// Count chat tokens request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountChatTokensRequest {
    pub role: String,
    pub content: String,
    pub model: String,
}

/// Count tokens for a single chat message
#[tauri::command]
pub fn count_chat_tokens(request: CountChatTokensRequest) -> Result<TokenCount, String> {
    TokenService::count_chat_tokens(&request.role, &request.content, &request.model)
}

/// Count messages tokens request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountMessagesTokensRequest {
    pub messages: Vec<ChatMessage>,
    pub model: String,
}

/// Count tokens for a list of messages (conversation history)
#[tauri::command]
pub fn count_messages_tokens(request: CountMessagesTokensRequest) -> Result<TokenCount, String> {
    TokenService::count_messages_tokens(&request.messages, &request.model)
}

/// Detect encoding for a model
#[tauri::command]
pub fn detect_model_encoding(model: String) -> String {
    format!("{:?}", TokenService::detect_encoding(&model)).to_lowercase()
}

/// Quick estimate without loading tokenizer (fast fallback)
#[tauri::command]
pub fn estimate_tokens_quick(text: String) -> usize {
    TokenService::estimate_tokens_quick(&text)
}

/// Truncate text request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncateTextRequest {
    pub text: String,
    pub max_tokens: usize,
    pub model: Option<String>,
}

/// Truncate text to fit within token limit
#[tauri::command]
pub fn truncate_to_tokens(request: TruncateTextRequest) -> Result<String, String> {
    let encoding = request
        .model
        .as_deref()
        .map(TokenService::detect_encoding)
        .unwrap_or(EncodingType::Default);
    TokenService::truncate_to_tokens(&request.text, request.max_tokens, encoding)
}

/// Parse encoding string to EncodingType
fn parse_encoding(s: &str) -> EncodingType {
    match s.to_lowercase().as_str() {
        "cl100k" | "cl100k_base" => EncodingType::Cl100k,
        "o200k" | "o200k_base" => EncodingType::O200k,
        _ => EncodingType::Default,
    }
}
