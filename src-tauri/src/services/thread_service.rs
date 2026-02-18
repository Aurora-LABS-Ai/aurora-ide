//! Thread Management Service
//!
//! Provides per-message persistence, crash recovery, and multi-window sync
//! through Tauri events. This is the single source of truth for thread state.
//!
//! Key features:
//! - Messages saved immediately (not after streaming ends)
//! - No data loss on crash
//! - Multi-window synchronization via Tauri events
//! - Thread history preserved forever

// Allow dead code for StreamState fields kept for debugging/future use
#![allow(dead_code)]

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::db::{ContextUsage, Message, ThreadState, TokenUsage};
use crate::db::Database;
use crate::services::api_converter::{ApiConverter, ApiMessage, UiMessage};

/// Thread event types for Tauri event emission
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadEvent {
    /// Thread created
    #[serde(rename = "thread-created")]
    Created { thread: ThreadSummary },

    /// Thread loaded
    #[serde(rename = "thread-loaded")]
    Loaded { thread: ThreadState },

    /// Thread deleted
    #[serde(rename = "thread-deleted")]
    Deleted { thread_id: String },

    /// Message added to thread
    #[serde(rename = "thread-message-added")]
    MessageAdded {
        thread_id: String,
        message: Message,
    },

    /// Message updated in thread
    #[serde(rename = "thread-message-updated")]
    MessageUpdated {
        thread_id: String,
        message_id: String,
        updates: Value,
    },

    /// Token received during streaming
    #[serde(rename = "thread-token-received")]
    TokenReceived {
        thread_id: String,
        stream_id: String,
        token: String,
    },

    /// Thinking content received
    #[serde(rename = "thread-thinking-received")]
    ThinkingReceived {
        thread_id: String,
        stream_id: String,
        thinking: String,
    },

    /// Tool call added to response
    #[serde(rename = "thread-tool-added")]
    ToolAdded {
        thread_id: String,
        stream_id: String,
        tool_call: Value,
    },

    /// Tool execution completed
    #[serde(rename = "thread-tool-completed")]
    ToolCompleted {
        thread_id: String,
        stream_id: String,
        tool_id: String,
        result: String,
    },

    /// Usage updated
    #[serde(rename = "thread-usage-updated")]
    UsageUpdated {
        thread_id: String,
        token_usage: TokenUsage,
        context_usage: ContextUsage,
    },
}

/// Thread summary for listing (without full messages)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub message_count: usize,
    pub preview: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<&ThreadState> for ThreadSummary {
    fn from(thread: &ThreadState) -> Self {
        let preview = thread
            .messages
            .last()
            .map(|m| m.content.chars().take(100).collect())
            .unwrap_or_default();

        Self {
            id: thread.id.clone(),
            title: thread.title.clone(),
            message_count: thread.messages.len(),
            preview,
            created_at: thread.created_at.clone(),
            updated_at: thread.updated_at.clone(),
        }
    }
}

/// Active streaming response state
#[derive(Debug, Clone)]
pub struct StreamState {
    pub thread_id: String,
    pub message_id: String,
    pub content: String,
    pub thinking: String,
    pub tool_calls: Vec<Value>,
    pub timeline: Vec<Value>,
    pub started_at: i64,
}

/// Thread Service - manages all thread operations
pub struct ThreadService {
    /// Active streaming responses by stream_id
    active_streams: Arc<RwLock<HashMap<String, StreamState>>>,
}

impl ThreadService {
    pub fn new() -> Self {
        Self {
            active_streams: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Emit a thread event to all windows
    fn emit_event(app: &AppHandle, event: &ThreadEvent) {
        let event_name = match event {
            ThreadEvent::Created { .. } => "thread-created",
            ThreadEvent::Loaded { .. } => "thread-loaded",
            ThreadEvent::Deleted { .. } => "thread-deleted",
            ThreadEvent::MessageAdded { .. } => "thread-message-added",
            ThreadEvent::MessageUpdated { .. } => "thread-message-updated",
            ThreadEvent::TokenReceived { .. } => "thread-token-received",
            ThreadEvent::ThinkingReceived { .. } => "thread-thinking-received",
            ThreadEvent::ToolAdded { .. } => "thread-tool-added",
            ThreadEvent::ToolCompleted { .. } => "thread-tool-completed",
            ThreadEvent::UsageUpdated { .. } => "thread-usage-updated",
        };

        if let Err(e) = app.emit(event_name, event) {
            eprintln!("[ThreadService] Failed to emit event {}: {}", event_name, e);
        }
    }

    /// Create a new thread
    pub fn create_thread(
        &self,
        db: &Database,
        app: &AppHandle,
        title: Option<String>,
    ) -> Result<ThreadState, String> {
        let thread_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let thread = ThreadState {
            id: thread_id,
            title: title.unwrap_or_else(|| "New Chat".to_string()),
            summary: None,
            messages: Vec::new(),
            token_usage: None,
            context_usage: None,
            created_at: now.clone(),
            updated_at: now,
        };

        // Persist immediately
        db.threads()
            .save(&thread)
            .map_err(|e| format!("Failed to save thread: {}", e))?;

        // Emit event for UI sync
        Self::emit_event(
            app,
            &ThreadEvent::Created {
                thread: ThreadSummary::from(&thread),
            },
        );

        Ok(thread)
    }

    /// Load a thread by ID
    pub fn load_thread(
        &self,
        db: &Database,
        app: &AppHandle,
        thread_id: &str,
    ) -> Result<Option<ThreadState>, String> {
        let thread = db
            .threads()
            .get(thread_id)
            .map_err(|e| format!("Failed to load thread: {}", e))?;

        if let Some(ref t) = thread {
            Self::emit_event(app, &ThreadEvent::Loaded { thread: t.clone() });
        }

        Ok(thread)
    }

    /// Delete a thread
    pub fn delete_thread(
        &self,
        db: &Database,
        app: &AppHandle,
        thread_id: &str,
    ) -> Result<(), String> {
        db.threads()
            .delete(thread_id)
            .map_err(|e| format!("Failed to delete thread: {}", e))?;

        Self::emit_event(
            app,
            &ThreadEvent::Deleted {
                thread_id: thread_id.to_string(),
            },
        );

        Ok(())
    }

    /// List all threads (summaries only for performance)
    pub fn list_threads(&self, db: &Database) -> Result<Vec<ThreadSummary>, String> {
        let threads = db
            .threads()
            .list()
            .map_err(|e| format!("Failed to list threads: {}", e))?;

        Ok(threads.iter().map(ThreadSummary::from).collect())
    }

    /// Add a user message to a thread (persists immediately)
    pub fn add_user_message(
        &self,
        db: &Database,
        app: &AppHandle,
        thread_id: &str,
        content: &str,
        attachments: Option<Vec<Value>>,
    ) -> Result<Message, String> {
        let mut thread = db
            .threads()
            .get(thread_id)
            .map_err(|e| format!("Failed to get thread: {}", e))?
            .ok_or_else(|| format!("Thread not found: {}", thread_id))?;

        let message_id = generate_id();
        let now = chrono::Utc::now().timestamp_millis();

        let message = Message {
            id: message_id.clone(),
            role: "user".to_string(),
            content: content.to_string(),
            timestamp: now.to_string(),
            tool_calls: None,
            thinking: None,
            is_thinking: None,
            tools: attachments,
            timeline: None,
            tool_proposal: None,
        };

        // Update thread title from first user message
        if thread.messages.is_empty() {
            let title = content.chars().take(50).collect::<String>();
            thread.title = if title.len() < content.len() {
                format!("{}...", title)
            } else {
                title
            };
        }

        thread.messages.push(message.clone());
        thread.updated_at = chrono::Utc::now().to_rfc3339();

        // Persist immediately
        db.threads()
            .save(&thread)
            .map_err(|e| format!("Failed to save thread: {}", e))?;

        // Emit event
        Self::emit_event(
            app,
            &ThreadEvent::MessageAdded {
                thread_id: thread_id.to_string(),
                message: message.clone(),
            },
        );

        Ok(message)
    }

    /// Start an assistant response (returns stream_id for subsequent updates)
    pub fn start_assistant_response(
        &self,
        _app: &AppHandle,
        thread_id: &str,
    ) -> Result<String, String> {
        let stream_id = Uuid::new_v4().to_string();
        let message_id = generate_id();

        let stream_state = StreamState {
            thread_id: thread_id.to_string(),
            message_id,
            content: String::new(),
            thinking: String::new(),
            tool_calls: Vec::new(),
            timeline: Vec::new(),
            started_at: chrono::Utc::now().timestamp_millis(),
        };

        {
            let mut streams = self.active_streams.write();
            streams.insert(stream_id.clone(), stream_state);
        }

        // Log for debugging
        println!(
            "[ThreadService] Started assistant response: stream_id={}, thread_id={}",
            stream_id, thread_id
        );

        Ok(stream_id)
    }

    /// Append token to streaming response
    pub fn append_token(
        &self,
        app: &AppHandle,
        stream_id: &str,
        token: &str,
    ) -> Result<(), String> {
        let thread_id = {
            let mut streams = self.active_streams.write();
            let stream = streams
                .get_mut(stream_id)
                .ok_or_else(|| format!("Stream not found: {}", stream_id))?;

            stream.content.push_str(token);
            stream.thread_id.clone()
        };

        // Emit event for real-time UI update
        Self::emit_event(
            app,
            &ThreadEvent::TokenReceived {
                thread_id,
                stream_id: stream_id.to_string(),
                token: token.to_string(),
            },
        );

        Ok(())
    }

    /// Append thinking content to streaming response
    pub fn append_thinking(
        &self,
        app: &AppHandle,
        stream_id: &str,
        thinking: &str,
    ) -> Result<(), String> {
        let thread_id = {
            let mut streams = self.active_streams.write();
            let stream = streams
                .get_mut(stream_id)
                .ok_or_else(|| format!("Stream not found: {}", stream_id))?;

            stream.thinking.push_str(thinking);
            stream.thread_id.clone()
        };

        Self::emit_event(
            app,
            &ThreadEvent::ThinkingReceived {
                thread_id,
                stream_id: stream_id.to_string(),
                thinking: thinking.to_string(),
            },
        );

        Ok(())
    }

    /// Add tool call to streaming response
    pub fn add_tool_call(
        &self,
        app: &AppHandle,
        stream_id: &str,
        tool_call: Value,
    ) -> Result<(), String> {
        let thread_id = {
            let mut streams = self.active_streams.write();
            let stream = streams
                .get_mut(stream_id)
                .ok_or_else(|| format!("Stream not found: {}", stream_id))?;

            stream.tool_calls.push(tool_call.clone());
            stream.thread_id.clone()
        };

        Self::emit_event(
            app,
            &ThreadEvent::ToolAdded {
                thread_id,
                stream_id: stream_id.to_string(),
                tool_call,
            },
        );

        Ok(())
    }

    /// Finalize assistant response and persist to database
    pub fn finalize_response(
        &self,
        db: &Database,
        app: &AppHandle,
        stream_id: &str,
        timeline: Option<Value>,
    ) -> Result<Message, String> {
        let stream_state = {
            let mut streams = self.active_streams.write();
            streams
                .remove(stream_id)
                .ok_or_else(|| format!("Stream not found: {}", stream_id))?
        };

        let mut thread = db
            .threads()
            .get(&stream_state.thread_id)
            .map_err(|e| format!("Failed to get thread: {}", e))?
            .ok_or_else(|| format!("Thread not found: {}", stream_state.thread_id))?;

        let message = Message {
            id: stream_state.message_id.clone(),
            role: "assistant".to_string(),
            content: stream_state.content.clone(),
            timestamp: chrono::Utc::now().timestamp_millis().to_string(),
            tool_calls: None,
            thinking: if stream_state.thinking.is_empty() {
                None
            } else {
                Some(stream_state.thinking)
            },
            is_thinking: Some(false),
            tools: None,
            timeline,
            tool_proposal: None,
        };

        thread.messages.push(message.clone());
        thread.updated_at = chrono::Utc::now().to_rfc3339();

        // Persist
        db.threads()
            .save(&thread)
            .map_err(|e| format!("Failed to save thread: {}", e))?;

        // Emit event
        Self::emit_event(
            app,
            &ThreadEvent::MessageAdded {
                thread_id: stream_state.thread_id,
                message: message.clone(),
            },
        );

        Ok(message)
    }

    /// Update thread usage statistics
    pub fn update_usage(
        &self,
        db: &Database,
        app: &AppHandle,
        thread_id: &str,
        token_usage: TokenUsage,
        context_usage: ContextUsage,
    ) -> Result<(), String> {
        let mut thread = db
            .threads()
            .get(thread_id)
            .map_err(|e| format!("Failed to get thread: {}", e))?
            .ok_or_else(|| format!("Thread not found: {}", thread_id))?;

        thread.token_usage = Some(token_usage.clone());
        thread.context_usage = Some(context_usage.clone());
        thread.updated_at = chrono::Utc::now().to_rfc3339();

        db.threads()
            .save(&thread)
            .map_err(|e| format!("Failed to save thread: {}", e))?;

        Self::emit_event(
            app,
            &ThreadEvent::UsageUpdated {
                thread_id: thread_id.to_string(),
                token_usage,
                context_usage,
            },
        );

        Ok(())
    }

    /// Get API-formatted history for a thread (for LLM requests)
    pub fn get_api_history(&self, db: &Database, thread_id: &str) -> Result<Vec<ApiMessage>, String> {
        let thread = db
            .threads()
            .get(thread_id)
            .map_err(|e| format!("Failed to get thread: {}", e))?
            .ok_or_else(|| format!("Thread not found: {}", thread_id))?;

        // Convert messages to UiMessage format
        let ui_messages: Vec<UiMessage> = thread
            .messages
            .iter()
            .map(|m| {
                let timeline = m.timeline.clone().and_then(|t| {
                    serde_json::from_value::<Vec<crate::services::api_converter::TimelineEvent>>(t).ok()
                });

                UiMessage {
                    id: m.id.clone(),
                    sender: m.role.clone(),
                    content: m.content.clone(),
                    timestamp: serde_json::json!(m.timestamp.parse::<i64>().unwrap_or(0)),
                    timeline,
                }
            })
            .collect();

        Ok(ApiConverter::convert_thread_to_api_history(&ui_messages))
    }

    /// Update thread title
    pub fn update_title(
        &self,
        db: &Database,
        _app: &AppHandle,
        thread_id: &str,
        title: &str,
    ) -> Result<(), String> {
        let mut thread = db
            .threads()
            .get(thread_id)
            .map_err(|e| format!("Failed to get thread: {}", e))?
            .ok_or_else(|| format!("Thread not found: {}", thread_id))?;

        thread.title = title.to_string();
        thread.updated_at = chrono::Utc::now().to_rfc3339();

        db.threads()
            .save(&thread)
            .map_err(|e| format!("Failed to save thread: {}", e))?;

        Ok(())
    }
}

impl Default for ThreadService {
    fn default() -> Self {
        Self::new()
    }
}

/// Generate a short unique ID (like nanoid)
fn generate_id() -> String {
    let chars: Vec<char> = "abcdefghijklmnopqrstuvwxyz0123456789"
        .chars()
        .collect();
    let mut id = String::with_capacity(9);
    for _ in 0..9 {
        let idx = rand_index(chars.len());
        id.push(chars[idx]);
    }
    id
}

/// Simple random index (no external rand crate needed)
fn rand_index(max: usize) -> usize {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .subsec_nanos() as usize;
    nanos % max
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_id() {
        let id1 = generate_id();
        let id2 = generate_id();
        assert_eq!(id1.len(), 9);
        assert_eq!(id2.len(), 9);
        // IDs should be different (unless generated in same nanosecond)
    }
}

