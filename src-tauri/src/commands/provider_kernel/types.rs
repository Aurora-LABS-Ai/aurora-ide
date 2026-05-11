use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuroraProviderConfig {
    pub api_key: String,
    pub base_url: String,
    pub custom_headers: Option<HashMap<String, String>>,
    pub custom_params: Option<HashMap<String, Value>>,
    pub default_max_tokens: Option<u32>,
    pub default_temperature: Option<f32>,
    pub model: String,
    pub provider_type: String,
    pub supports_thinking: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuroraProviderRequest {
    pub max_tokens: Option<u32>,
    pub messages: Vec<AuroraMessage>,
    pub provider: AuroraProviderConfig,
    pub stream: bool,
    pub temperature: Option<f32>,
    pub thinking_enabled: Option<bool>,
    pub tools: Option<Vec<AuroraToolDefinition>>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuroraMessage {
    pub content: Option<Value>,
    pub reasoning_content: Option<String>,
    pub role: String,
    pub tool_call_id: Option<String>,
    pub tool_calls: Option<Vec<AuroraToolCall>>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuroraToolCall {
    pub function: AuroraToolFunction,
    pub id: String,
    #[serde(rename = "type")]
    pub tool_type: String,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct AuroraToolFunction {
    pub arguments: String,
    pub name: String,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuroraToolDefinition {
    pub function: AuroraToolDefinitionFunction,
    #[serde(rename = "type")]
    pub tool_type: String,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct AuroraToolDefinitionFunction {
    pub description: String,
    pub name: String,
    pub parameters: Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuroraProviderResponse {
    pub message: AuroraAssistantMessage,
    pub stop_reason: Option<String>,
    pub usage: Option<AuroraUsage>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuroraAssistantMessage {
    pub content: String,
    pub reasoning_content: Option<String>,
    pub role: String,
    pub tool_calls: Option<Vec<AuroraToolCall>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuroraUsage {
    pub cache_read_tokens: Option<u32>,
    pub cache_write_tokens: Option<u32>,
    pub completion_tokens: u32,
    pub prompt_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuroraStreamChunk {
    pub content: Option<String>,
    pub done: bool,
    pub finish_reason: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls: Option<Vec<AuroraStreamToolCall>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuroraStreamToolCall {
    pub function_arguments: Option<String>,
    pub function_name: Option<String>,
    pub id: Option<String>,
    pub index: i32,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OpenAiStreamingResponse {
    pub(crate) choices: Vec<OpenAiStreamingChoice>,
    pub(crate) usage: Option<OpenAiUsageData>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OpenAiStreamingChoice {
    pub(crate) delta: OpenAiStreamingDelta,
    pub(crate) finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OpenAiStreamingDelta {
    pub(crate) content: Option<String>,
    pub(crate) reasoning: Option<String>,
    pub(crate) reasoning_content: Option<String>,
    pub(crate) tool_calls: Option<Vec<OpenAiStreamingToolCall>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OpenAiStreamingToolCall {
    pub(crate) function: Option<OpenAiStreamingFunction>,
    pub(crate) id: Option<String>,
    pub(crate) index: i32,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OpenAiStreamingFunction {
    pub(crate) arguments: Option<String>,
    pub(crate) name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OpenAiUsageData {
    pub(crate) completion_tokens: u32,
    pub(crate) prompt_tokens: u32,
    pub(crate) total_tokens: u32,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AnthropicStreamEvent {
    pub(crate) content_block: Option<AnthropicContentBlock>,
    pub(crate) delta: Option<AnthropicDelta>,
    pub(crate) index: Option<i32>,
    pub(crate) message: Option<AnthropicMessageEnvelope>,
    #[serde(rename = "type")]
    pub(crate) event_type: String,
    pub(crate) usage: Option<AnthropicUsage>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AnthropicMessageEnvelope {
    pub(crate) usage: Option<AnthropicUsage>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AnthropicUsage {
    pub(crate) cache_creation_input_tokens: Option<u32>,
    pub(crate) cache_read_input_tokens: Option<u32>,
    pub(crate) input_tokens: Option<u32>,
    pub(crate) output_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AnthropicContentBlock {
    pub(crate) id: Option<String>,
    pub(crate) name: Option<String>,
    #[serde(rename = "type")]
    pub(crate) block_type: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AnthropicDelta {
    pub(crate) partial_json: Option<String>,
    pub(crate) signature: Option<String>,
    pub(crate) text: Option<String>,
    pub(crate) thinking: Option<String>,
    #[serde(rename = "type")]
    pub(crate) delta_type: String,
}

/// Per-block thinking signature payload emitted on
/// `aurora-provider-thinking-signature-{request_id}`.
///
/// Anthropic emits `signature_delta` events inside a `thinking` content block
/// as the model finalizes its private chain of thought. The accumulated
/// signature must be echoed back on the next turn or the API rejects the
/// request with HTTP 400. This payload exposes the running signature for the
/// active block index so the frontend can persist it alongside the message.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuroraThinkingSignature {
    pub index: i32,
    pub signature: String,
}
