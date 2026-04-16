//! Context Engine Type Definitions
//!
//! Core data structures for turn-based conversation management.
//! Inspired by VS Code Copilot's Turn/Round architecture.
//!
//! Note: Some methods are kept for API completeness and future use,
//! even if not currently used in the codebase.

// Allow dead code for API methods kept for completeness
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================
// TURN - A single user request + all assistant responses/tool calls
// ============================================================

/// A conversation turn representing one user message and all resulting
/// assistant responses and tool executions.
///
/// This is the core unit of conversation context, similar to Copilot's Turn class.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    /// Unique identifier for this turn
    pub id: String,

    /// Thread this turn belongs to
    pub thread_id: String,

    /// The user's message that started this turn
    pub user_message: String,

    /// IDE context included with first message (open files, project layout, etc.)
    /// Only populated for the first turn in a thread
    pub user_context: Option<String>,

    /// All tool call rounds in this turn
    /// Each round = assistant response + tool calls + tool results
    pub rounds: Vec<ToolCallRound>,

    /// LLM-generated summary of this turn (for older turns)
    /// When set, this is used instead of full content to save tokens
    pub summary: Option<String>,

    /// Cached token count for this turn (full content, not summary)
    pub token_count: Option<u32>,

    /// Index of this turn in the thread (0-based)
    pub turn_index: u32,

    /// Creation timestamp (ISO 8601)
    pub created_at: String,

    /// Last update timestamp (ISO 8601)
    pub updated_at: String,
}

impl Turn {
    /// Create a new turn
    pub fn new(
        thread_id: String,
        user_message: String,
        user_context: Option<String>,
        turn_index: u32,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            thread_id,
            user_message,
            user_context,
            rounds: Vec::new(),
            summary: None,
            token_count: None,
            turn_index,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Check if this turn has been summarized
    pub fn is_summarized(&self) -> bool {
        self.summary.is_some()
    }

    /// Get the final assistant response (from the last round)
    pub fn get_final_response(&self) -> Option<&str> {
        self.rounds.last().map(|r| r.response.as_str())
    }

    /// Add a new round to this turn
    pub fn add_round(&mut self, round: ToolCallRound) {
        self.rounds.push(round);
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

// ============================================================
// TOOL CALL ROUND - One assistant response cycle with tool calls
// ============================================================

/// A single round of tool calling within a turn.
///
/// Each round contains:
/// - The assistant's response text
/// - Any tool calls the assistant made
/// - Results from executing those tool calls
/// - Optional thinking/reasoning content
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRound {
    /// Unique identifier for this round
    pub id: String,

    /// Turn this round belongs to
    pub turn_id: String,

    /// The assistant's response text
    pub response: String,

    /// Tool calls made by the assistant
    pub tool_calls: Vec<ToolCall>,

    /// Results from tool executions (keyed by tool_call_id)
    pub tool_results: HashMap<String, ToolResult>,

    /// Thinking/reasoning content (for models that support it)
    pub thinking: Option<String>,

    /// Summary of this round (for compression)
    pub summary: Option<String>,

    /// Cached token count for this round
    pub token_count: Option<u32>,

    /// Index of this round in the turn (0-based)
    pub round_index: u32,

    /// Creation timestamp (ISO 8601)
    pub created_at: String,
}

impl ToolCallRound {
    /// Create a new tool call round
    pub fn new(turn_id: String, response: String, round_index: u32) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            turn_id,
            response,
            tool_calls: Vec::new(),
            tool_results: HashMap::new(),
            thinking: None,
            summary: None,
            token_count: None,
            round_index,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// Add a tool call to this round
    pub fn add_tool_call(&mut self, tool_call: ToolCall) {
        self.tool_calls.push(tool_call);
    }

    /// Add a tool result
    pub fn add_tool_result(&mut self, tool_call_id: String, result: ToolResult) {
        self.tool_results.insert(tool_call_id, result);
    }

    /// Check if all tool calls have results
    pub fn all_tools_executed(&self) -> bool {
        self.tool_calls
            .iter()
            .all(|tc| self.tool_results.contains_key(&tc.id))
    }
}

// ============================================================
// TOOL CALL - A single tool invocation
// ============================================================

/// A tool call made by the assistant
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    /// Unique identifier for this tool call
    pub id: String,

    /// Name of the tool being called
    pub name: String,

    /// JSON string of arguments passed to the tool
    pub arguments: String,
}

impl ToolCall {
    /// Create a new tool call
    pub fn new(id: String, name: String, arguments: String) -> Self {
        Self {
            id,
            name,
            arguments,
        }
    }
}

// ============================================================
// TOOL RESULT - Result from executing a tool
// ============================================================

/// Result from executing a tool call
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    /// The tool_call_id this result corresponds to
    pub tool_call_id: String,

    /// The content/output of the tool execution
    pub content: String,

    /// Whether this result represents an error
    pub is_error: bool,

    /// Whether the content was truncated due to size
    pub truncated: bool,

    /// Original length before truncation (if truncated)
    pub original_length: Option<usize>,
}

impl ToolResult {
    /// Create a successful tool result
    pub fn success(tool_call_id: String, content: String) -> Self {
        Self {
            tool_call_id,
            content,
            is_error: false,
            truncated: false,
            original_length: None,
        }
    }

    /// Create an error tool result
    pub fn error(tool_call_id: String, error_message: String) -> Self {
        Self {
            tool_call_id,
            content: error_message,
            is_error: true,
            truncated: false,
            original_length: None,
        }
    }

    /// Create a truncated tool result
    pub fn truncated(tool_call_id: String, content: String, original_length: usize) -> Self {
        Self {
            tool_call_id,
            content,
            is_error: false,
            truncated: true,
            original_length: Some(original_length),
        }
    }
}

// ============================================================
// CONTEXT STATE - Current state of the context window
// ============================================================

/// Current state of the context window for a thread
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextState {
    /// Thread ID
    pub thread_id: String,

    /// Total number of turns in the thread
    pub total_turns: usize,

    /// Number of turns that have been summarized
    pub summarized_turns: usize,

    /// Estimated tokens used by current context
    pub used_tokens: u32,

    /// Maximum context window size (from provider config)
    pub context_window: u32,

    /// Maximum output tokens (from provider config)
    pub max_output: u32,

    /// Percentage of context window used (0-100)
    pub usage_percentage: f32,

    /// Whether summarization is needed (usage > threshold)
    pub needs_summarization: bool,

    /// Number of recent turns that will get full content (not summarized)
    pub recent_turns_count: usize,
}

impl ContextState {
    /// Create a new context state
    pub fn new(thread_id: String, context_window: u32, max_output: u32) -> Self {
        Self {
            thread_id,
            total_turns: 0,
            summarized_turns: 0,
            used_tokens: 0,
            context_window,
            max_output,
            usage_percentage: 0.0,
            needs_summarization: false,
            recent_turns_count: 2, // Default: last 2 turns get full content
        }
    }

    /// Update usage statistics
    pub fn update_usage(&mut self, used_tokens: u32) {
        self.used_tokens = used_tokens;
        // Available = context_window - max_output (reserve space for response)
        let available = self.context_window.saturating_sub(self.max_output);
        self.usage_percentage = if available > 0 {
            (used_tokens as f32 / available as f32) * 100.0
        } else {
            100.0
        };
        // Trigger summarization at 80% usage
        self.needs_summarization = self.usage_percentage >= 80.0;
    }
}

// ============================================================
// API MESSAGE - Messages sent to the LLM API
// ============================================================

/// Message format for sending to LLM APIs
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum ApiMessage {
    /// System prompt message
    System { content: String },

    /// User message
    User { content: String },

    /// Assistant message (with optional tool calls and reasoning)
    Assistant {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning_content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<ApiToolCall>>,
    },

    /// Tool result message
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

/// Tool function details
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiToolFunction {
    pub name: String,
    pub arguments: String,
}

impl From<&ToolCall> for ApiToolCall {
    fn from(tc: &ToolCall) -> Self {
        Self {
            id: tc.id.clone(),
            call_type: "function".to_string(),
            function: ApiToolFunction {
                name: tc.name.clone(),
                arguments: tc.arguments.clone(),
            },
        }
    }
}

// ============================================================
// SUMMARIZATION REQUEST - For LLM-based summarization
// ============================================================

/// Request to summarize a turn
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizationRequest {
    /// Turn ID to summarize
    pub turn_id: String,

    /// The turn content to summarize
    pub turn_content: String,

    /// Provider configuration for making the summarization call
    pub provider_config: Option<serde_json::Value>,
}

/// Result of summarization
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizationResult {
    /// Turn ID that was summarized
    pub turn_id: String,

    /// The generated summary
    pub summary: String,

    /// Tokens used for summarization
    pub tokens_used: Option<u32>,
}

// ============================================================
// CONSTANTS
// ============================================================

/// Maximum length for tool results before truncation (characters)
pub const MAX_TOOL_RESULT_LENGTH: usize = 4000;

/// Number of recent turns to include with full content (not summarized)
pub const RECENT_TURNS_FULL_CONTENT: usize = 2;

/// Threshold percentage for triggering summarization
pub const SUMMARIZATION_THRESHOLD: f32 = 80.0;

/// Maximum summary length (characters)
pub const MAX_SUMMARY_LENGTH: usize = 500;
