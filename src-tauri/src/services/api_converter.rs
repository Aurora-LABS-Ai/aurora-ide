//! API Message Converter
//!
//! Converts UI thread messages to LLM API format.
//! This is the Rust equivalent of thread-converter.ts
//!
//! UI Message Format:
//! - id, sender ('user'|'assistant'), content, timestamp, timeline[]
//! - timeline contains: thinking events, tool events, content events
//!
//! API Message Format:
//! - role ('user'|'assistant'|'tool'), content, tool_calls?, reasoning_content?

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// API message for LLM requests (OpenAI/Anthropic compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum ApiMessage {
    #[serde(rename = "system")]
    System { content: String },

    #[serde(rename = "user")]
    User { content: String },

    #[serde(rename = "assistant")]
    Assistant {
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning_content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<ApiToolCall>>,
    },

    #[serde(rename = "tool")]
    Tool {
        tool_call_id: String,
        content: String,
    },
}

/// Tool call in API format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: ApiToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiToolFunction {
    pub name: String,
    pub arguments: String,
}

/// Timeline event from UI message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub id: Option<String>,
    pub timestamp: Option<i64>,
    pub content: Option<String>,
    pub thinking: Option<String>,
    #[serde(rename = "isThinking")]
    pub is_thinking: Option<bool>,
    pub tool: Option<TimelineTool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineTool {
    pub id: String,
    pub name: String,
    pub status: String,
    pub args: Option<Value>,
    #[serde(rename = "rawArgs")]
    pub raw_args: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
}

/// UI Message format (from thread store)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiMessage {
    pub id: String,
    #[serde(alias = "role")]
    pub sender: String,
    pub content: String,
    pub timestamp: Value, // Can be string or number
    pub timeline: Option<Vec<TimelineEvent>>,
}

/// Extracted content from timeline events
struct ExtractedTimeline {
    content: String,
    reasoning: String,
    tool_calls: Vec<ApiToolCall>,
    tool_results: Vec<ToolResult>,
}

struct ToolResult {
    id: String,
    result: String,
}

/// API Converter - converts UI messages to API format
pub struct ApiConverter;

impl ApiConverter {
    /// Extract content, reasoning, tool calls, and tool results from timeline events
    fn extract_from_timeline(timeline: &[TimelineEvent]) -> ExtractedTimeline {
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut tool_calls = Vec::new();
        let mut tool_results = Vec::new();

        for event in timeline {
            match event.event_type.as_str() {
                "content" => {
                    if let Some(c) = &event.content {
                        content.push_str(c);
                    }
                }
                "thinking" => {
                    if let Some(t) = &event.thinking {
                        reasoning.push_str(t);
                    }
                }
                "tool" => {
                    if let Some(tool) = &event.tool {
                        // Only include tool calls that have a result (complete, failed, or rejected)
                        // Skip pending/executing tools - they were interrupted
                        let has_result = matches!(
                            tool.status.as_str(),
                            "complete" | "failed" | "rejected"
                        );

                        if has_result {
                            // Add tool call request
                            let arguments = tool
                                .raw_args
                                .clone()
                                .or_else(|| tool.args.as_ref().map(|a| a.to_string()))
                                .unwrap_or_else(|| "{}".to_string());

                            tool_calls.push(ApiToolCall {
                                id: tool.id.clone(),
                                call_type: "function".to_string(),
                                function: ApiToolFunction {
                                    name: tool.name.clone(),
                                    arguments,
                                },
                            });

                            // Add tool result
                            let result = match tool.status.as_str() {
                                "complete" => tool.result.clone().unwrap_or_default(),
                                "failed" => {
                                    let error = tool.error.clone().unwrap_or_default();
                                    format!(r#"{{"error": "{}"}}"#, error)
                                }
                                "rejected" => {
                                    r#"{"error": "Tool execution rejected by user"}"#.to_string()
                                }
                                _ => "{}".to_string(),
                            };

                            tool_results.push(ToolResult {
                                id: tool.id.clone(),
                                result,
                            });
                        }
                    }
                }
                _ => {}
            }
        }

        ExtractedTimeline {
            content,
            reasoning,
            tool_calls,
            tool_results,
        }
    }

    /// Convert UI thread messages to API conversation history format
    /// This enables the agent to have context when resuming a thread
    pub fn convert_thread_to_api_history(ui_messages: &[UiMessage]) -> Vec<ApiMessage> {
        let mut api_messages = Vec::new();

        for msg in ui_messages {
            match msg.sender.as_str() {
                "user" => {
                    api_messages.push(ApiMessage::User {
                        content: msg.content.clone(),
                    });
                }
                "assistant" => {
                    // Assistant messages need to be reconstructed from timeline events
                    let extracted = if let Some(timeline) = &msg.timeline {
                        Self::extract_from_timeline(timeline)
                    } else {
                        // Fallback to direct content if no timeline
                        ExtractedTimeline {
                            content: msg.content.clone(),
                            reasoning: String::new(),
                            tool_calls: Vec::new(),
                            tool_results: Vec::new(),
                        }
                    };

                    // Only add if there's actual content or tool calls
                    if !extracted.content.is_empty()
                        || !extracted.tool_calls.is_empty()
                        || !extracted.reasoning.is_empty()
                    {
                        let assistant_msg = ApiMessage::Assistant {
                            content: if extracted.content.is_empty() {
                                None
                            } else {
                                Some(extracted.content)
                            },
                            reasoning_content: if extracted.reasoning.is_empty() {
                                None
                            } else {
                                Some(extracted.reasoning)
                            },
                            tool_calls: if extracted.tool_calls.is_empty() {
                                None
                            } else {
                                Some(extracted.tool_calls)
                            },
                        };

                        api_messages.push(assistant_msg);

                        // Add tool results as separate tool messages
                        for result in extracted.tool_results {
                            api_messages.push(ApiMessage::Tool {
                                tool_call_id: result.id,
                                content: result.result,
                            });
                        }
                    }
                }
                "system" => {
                    api_messages.push(ApiMessage::System {
                        content: msg.content.clone(),
                    });
                }
                _ => {}
            }
        }

        api_messages
    }

    /// Count valid conversation turns (for logging/debugging)
    pub fn count_valid_turns(api_messages: &[ApiMessage]) -> (usize, usize, usize) {
        let mut user = 0;
        let mut assistant = 0;
        let mut tool = 0;

        for msg in api_messages {
            match msg {
                ApiMessage::User { .. } => user += 1,
                ApiMessage::Assistant { .. } => assistant += 1,
                ApiMessage::Tool { .. } => tool += 1,
                ApiMessage::System { .. } => {}
            }
        }

        (user, assistant, tool)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_convert_user_message() {
        let messages = vec![UiMessage {
            id: "1".to_string(),
            sender: "user".to_string(),
            content: "Hello".to_string(),
            timestamp: serde_json::json!(1234567890),
            timeline: None,
        }];

        let api = ApiConverter::convert_thread_to_api_history(&messages);
        assert_eq!(api.len(), 1);

        if let ApiMessage::User { content } = &api[0] {
            assert_eq!(content, "Hello");
        } else {
            panic!("Expected User message");
        }
    }

    #[test]
    fn test_extract_content_from_timeline() {
        let timeline = vec![
            TimelineEvent {
                event_type: "content".to_string(),
                id: Some("1".to_string()),
                timestamp: None,
                content: Some("Hello ".to_string()),
                thinking: None,
                is_thinking: None,
                tool: None,
            },
            TimelineEvent {
                event_type: "content".to_string(),
                id: Some("2".to_string()),
                timestamp: None,
                content: Some("world!".to_string()),
                thinking: None,
                is_thinking: None,
                tool: None,
            },
        ];

        let extracted = ApiConverter::extract_from_timeline(&timeline);
        assert_eq!(extracted.content, "Hello world!");
    }
}

