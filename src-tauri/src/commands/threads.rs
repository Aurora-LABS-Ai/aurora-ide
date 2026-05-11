//! Thread Tauri commands — agent_v2 Session edition.
//!
//! Every chat-list / thread-load / persistence command in Aurora goes
//! through here. The single source of truth is the
//! [`crate::agent_runtime::session_store::SessionStore`] — there is no
//! other persistence layer. The legacy event-sourced `ThreadEventLog`
//! and SQLite `threads` table have both been retired.
//!
//! ## Wire shape
//!
//! The frontend's `threadService` still consumes `DbThread` /
//! `DbMessage` / `ThreadSummary`. We synthesize those from the
//! canonical [`Session`] so the React layer doesn't have to learn the
//! Anthropic-style content-block model.
//!
//! Mapping:
//!
//! - `Session.thread_id` / `metadata.title` / `metadata.created_at` /
//!   `metadata.updated_at` → top-level `DbThread` fields.
//! - `Vec<ConversationMessage>` → `Vec<Message>` via
//!   [`session_to_db_messages`]: each `User` message becomes a flat
//!   `Message { role: "user", content }`; each `Assistant` message
//!   produces one `Message { role: "assistant" }` whose
//!   `content` is the joined text blocks, `thinking` is the joined
//!   thinking blocks, and `tool_calls` is a `Vec<ToolCall>` populated
//!   from the `ToolUse` blocks. `Tool` messages are folded into the
//!   prior assistant message's `tool_calls[].result` so the UI sees
//!   tool calls as paired with their results, the way the chat
//!   bubbles render.
//!
//! ## Lifecycle
//!
//! 1. Frontend creates a UUID and calls `thread_save({ id, title:
//!    "New Chat" })` — this calls `SessionStore::ensure_thread`,
//!    materialising an empty `<id>.jsonl` + `<id>.meta.json` pair.
//! 2. `agent_chat_v2` runs a turn; `TurnDriver` appends messages to
//!    the JSONL via `Session::save_to_path`, then calls
//!    `SessionStore::touch` and (on the first turn) `set_title` so
//!    the chat list re-orders.
//! 3. Frontend periodically calls `thread_update_usage` after each
//!    turn completes so the modal can render token / context bars.
//! 4. Reload / open: frontend calls `thread_load(id)`; we read the
//!    JSONL + sidecar and synthesise the `DbThread`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::agent_runtime::session_store::{
    ContextUsageMeta, SessionStore, TokenUsageMeta,
};
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};
use crate::commands::agent_v2::AgentRegistry;
use crate::db::{ContextUsage, Message, ThreadState, TokenUsage, ToolCall as DbToolCall};
use crate::services::api_converter::{ApiMessage, ApiToolCall, ApiToolFunction};

// ============================================================================
// Wire-format adapters
// ============================================================================

/// Lightweight summary shipped to the chat list.
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

/// Convert a stored `Vec<ConversationMessage>` into the flat
/// `Vec<Message>` shape the React layer renders. `Tool` messages are
/// folded back into the prior assistant message's `tool_calls[].result`
/// so the UI sees tool calls paired with their results.
fn session_to_db_messages(messages: &[ConversationMessage]) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::with_capacity(messages.len());

    for msg in messages {
        let timestamp = millis_to_rfc3339(msg.timestamp);
        match msg.role {
            MessageRole::System => continue,
            MessageRole::User => {
                let content = collect_text_blocks(&msg.blocks);
                out.push(Message {
                    id: synthetic_message_id("user", msg.timestamp, out.len()),
                    role: "user".to_string(),
                    // The Rust runtime stores user-typed text only —
                    // IDE-context enrichment (`<execution_mode_context>`,
                    // attachments, …) is wrapped around the API view of
                    // the message inside `RuntimeConfig::ide_context`,
                    // never appended to the JSONL. So whatever we read
                    // back is already display-clean.
                    content,
                    timestamp,
                    tool_calls: None,
                    thinking: None,
                    is_thinking: None,
                    tools: None,
                    timeline: None,
                    tool_proposal: None,
                });
            }
            MessageRole::Assistant => {
                let mut content = String::new();
                let mut thinking = String::new();
                let mut tool_calls: Vec<DbToolCall> = Vec::new();
                for block in &msg.blocks {
                    match block {
                        ContentBlock::Text { text } => {
                            push_with_newline(&mut content, text);
                        }
                        ContentBlock::Thinking { text, .. } => {
                            push_with_newline(&mut thinking, text);
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            let arguments = serde_json::to_string(input)
                                .unwrap_or_else(|_| "{}".to_string());
                            tool_calls.push(DbToolCall {
                                id: id.clone(),
                                name: name.clone(),
                                arguments,
                                result: None,
                            });
                        }
                        ContentBlock::ToolResult { .. } => {
                            // Defensive — tool results live on Tool
                            // messages, not Assistant. Ignore.
                        }
                    }
                }
                let thinking_opt = if thinking.is_empty() { None } else { Some(thinking) };
                out.push(Message {
                    id: synthetic_message_id("assistant", msg.timestamp, out.len()),
                    role: "assistant".to_string(),
                    content,
                    timestamp,
                    tool_calls: if tool_calls.is_empty() {
                        None
                    } else {
                        Some(tool_calls)
                    },
                    thinking: thinking_opt,
                    is_thinking: Some(false),
                    tools: None,
                    timeline: None,
                    tool_proposal: None,
                });
            }
            MessageRole::Tool => {
                // Fold every ToolResult block into the prior
                // assistant message's matching tool_call entry.
                if let Some(prev) = out.iter_mut().rev().find(|m| m.role == "assistant") {
                    if let Some(calls) = prev.tool_calls.as_mut() {
                        for block in &msg.blocks {
                            if let ContentBlock::ToolResult {
                                tool_use_id,
                                content,
                                is_error,
                            } = block
                            {
                                if let Some(call) =
                                    calls.iter_mut().find(|c| c.id == *tool_use_id)
                                {
                                    let formatted = if is_error.unwrap_or(false) {
                                        format!("[error] {content}")
                                    } else {
                                        content.clone()
                                    };
                                    call.result = Some(formatted);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    out
}

/// Convert the canonical `Vec<ConversationMessage>` directly into the
/// `Vec<ApiMessage>` shape the LLM-request builder consumes. This is
/// what `thread_get_api_history` returns when the frontend asks for
/// the rebuild-context view of a thread.
fn session_to_api_messages(messages: &[ConversationMessage]) -> Vec<ApiMessage> {
    let mut out: Vec<ApiMessage> = Vec::with_capacity(messages.len());
    for msg in messages {
        match msg.role {
            MessageRole::System => {
                let content = collect_text_blocks(&msg.blocks);
                if !content.is_empty() {
                    out.push(ApiMessage::System { content });
                }
            }
            MessageRole::User => {
                let content = collect_text_blocks(&msg.blocks);
                if !content.is_empty() {
                    out.push(ApiMessage::User { content });
                }
            }
            MessageRole::Assistant => {
                let mut content = String::new();
                let mut reasoning = String::new();
                let mut tool_calls: Vec<ApiToolCall> = Vec::new();
                for block in &msg.blocks {
                    match block {
                        ContentBlock::Text { text } => push_with_newline(&mut content, text),
                        ContentBlock::Thinking { text, .. } => {
                            push_with_newline(&mut reasoning, text);
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            let arguments = serde_json::to_string(input)
                                .unwrap_or_else(|_| "{}".to_string());
                            tool_calls.push(ApiToolCall {
                                id: id.clone(),
                                call_type: "function".to_string(),
                                function: ApiToolFunction {
                                    name: name.clone(),
                                    arguments,
                                },
                            });
                        }
                        ContentBlock::ToolResult { .. } => {}
                    }
                }
                let content_opt = if content.is_empty() { None } else { Some(content) };
                let reasoning_opt = if reasoning.is_empty() {
                    None
                } else {
                    Some(reasoning)
                };
                let tool_calls_opt = if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls)
                };
                // Skip empty assistant messages entirely.
                if content_opt.is_some() || tool_calls_opt.is_some() {
                    out.push(ApiMessage::Assistant {
                        content: content_opt,
                        reasoning_content: reasoning_opt,
                        tool_calls: tool_calls_opt,
                    });
                }
            }
            MessageRole::Tool => {
                for block in &msg.blocks {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        ..
                    } = block
                    {
                        out.push(ApiMessage::Tool {
                            tool_call_id: tool_use_id.clone(),
                            content: content.clone(),
                        });
                    }
                }
            }
        }
    }
    out
}

fn collect_text_blocks(blocks: &[ContentBlock]) -> String {
    let mut out = String::new();
    for block in blocks {
        if let ContentBlock::Text { text } = block {
            push_with_newline(&mut out, text);
        }
    }
    out
}

fn push_with_newline(out: &mut String, s: &str) {
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(s);
}

fn millis_to_rfc3339(millis: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

/// Synthesise a stable id for a message reconstructed from the
/// `ConversationMessage` stream. The runtime doesn't carry per-message
/// ids (tool_use ids exist, regular messages don't) — the React layer
/// only needs a unique key for `<List>` rendering, so a deterministic
/// composite is fine.
fn synthetic_message_id(role: &str, timestamp_millis: i64, ordinal: usize) -> String {
    format!("{role}-{timestamp_millis}-{ordinal}")
}

// ============================================================================
// Token / context usage adapters (db ↔ session_store)
// ============================================================================

fn db_token_to_meta(usage: &TokenUsage) -> TokenUsageMeta {
    TokenUsageMeta {
        prompt_tokens: usage.prompt_tokens.max(0) as u32,
        completion_tokens: usage.completion_tokens.max(0) as u32,
        total_tokens: usage.total_tokens.max(0) as u32,
        cache_read_tokens: None,
        cache_write_tokens: None,
    }
}

fn db_context_to_meta(usage: &ContextUsage) -> ContextUsageMeta {
    ContextUsageMeta {
        used_tokens: usage.used_tokens.max(0) as u32,
        context_window: usage.context_window.max(0) as u32,
        percentage: usage.percentage,
    }
}

fn meta_to_db_token(meta: &TokenUsageMeta) -> TokenUsage {
    TokenUsage {
        prompt_tokens: i64::from(meta.prompt_tokens),
        completion_tokens: i64::from(meta.completion_tokens),
        total_tokens: i64::from(meta.total_tokens),
    }
}

fn meta_to_db_context(meta: &ContextUsageMeta) -> ContextUsage {
    ContextUsage {
        used_tokens: i64::from(meta.used_tokens),
        context_window: i64::from(meta.context_window),
        percentage: meta.percentage,
    }
}

// ============================================================================
// Tauri events — same wire channels the legacy code shipped so the
// React layer doesn't need a migration.
// ============================================================================

fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: &S) {
    if let Err(e) = app.emit(event, payload) {
        eprintln!("[threads] failed to emit {event}: {e}");
    }
}

#[derive(Serialize, Clone)]
struct ThreadCreatedPayload {
    thread: ThreadSummary,
}
#[derive(Serialize, Clone)]
struct ThreadLoadedPayload {
    thread: ThreadState,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThreadDeletedPayload {
    thread_id: String,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThreadUsageUpdatedPayload {
    thread_id: String,
    token_usage: TokenUsage,
    context_usage: ContextUsage,
}

// ============================================================================
// Helpers — shared between commands
// ============================================================================

fn store_from_state(registry: &Arc<AgentRegistry>) -> Arc<SessionStore> {
    registry.store().clone()
}

fn build_thread_state(
    store: &SessionStore,
    thread_id: &str,
) -> Result<Option<ThreadState>, String> {
    let loaded = store
        .load(thread_id)
        .map_err(|e| format!("Failed to load thread {thread_id}: {e}"))?;
    let Some(loaded) = loaded else {
        return Ok(None);
    };
    let messages = session_to_db_messages(loaded.session.messages());
    Ok(Some(ThreadState {
        id: thread_id.to_string(),
        title: loaded.metadata.title,
        summary: None,
        messages,
        token_usage: loaded.metadata.token_usage.as_ref().map(meta_to_db_token),
        context_usage: loaded
            .metadata
            .context_usage
            .as_ref()
            .map(meta_to_db_context),
        created_at: loaded.metadata.created_at,
        updated_at: loaded.metadata.updated_at,
    }))
}

fn build_thread_summary(
    summary: crate::agent_runtime::session_store::SessionSummary,
) -> ThreadSummary {
    ThreadSummary {
        id: summary.id,
        title: summary.title,
        message_count: summary.message_count,
        preview: summary.preview,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
    }
}

// ============================================================================
// Commands
// ============================================================================

/// Upsert thread metadata. Frontend calls this immediately after
/// generating a UUID for a new chat (optimistic create) and again
/// whenever a stored `Thread` is mutated client-side. Only the
/// `title` field is persisted — message history is owned exclusively
/// by the agent runtime.
#[tauri::command]
pub fn thread_save(
    thread: ThreadState,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    let store = store_from_state(registry.inner());
    store
        .ensure_thread(&thread.id, Some(thread.title.clone()))
        .map_err(|e| format!("Failed to ensure thread {}: {e}", thread.id))?;
    if !thread.title.is_empty() {
        store
            .set_title(&thread.id, thread.title.clone())
            .map_err(|e| format!("Failed to update title: {e}"))?;
    }

    if let Some(state) = build_thread_state(&store, &thread.id)? {
        emit(
            &app,
            "thread-loaded",
            &ThreadLoadedPayload { thread: state },
        );
    }
    Ok(())
}

/// Materialise an empty thread and return the freshly-bootstrapped
/// `ThreadState`. The frontend currently generates UUIDs itself and
/// uses `thread_save` to upsert, so this command is rarely called —
/// kept for symmetry with the historic API surface.
#[tauri::command]
pub fn thread_create(
    title: Option<String>,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<ThreadState, String> {
    let store = store_from_state(registry.inner());
    let thread_id = uuid::Uuid::new_v4().to_string();
    let meta = store
        .ensure_thread(&thread_id, title)
        .map_err(|e| format!("Failed to create thread: {e}"))?;

    let state = ThreadState {
        id: thread_id,
        title: meta.title,
        summary: None,
        messages: Vec::new(),
        token_usage: None,
        context_usage: None,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
    };
    emit(
        &app,
        "thread-created",
        &ThreadCreatedPayload {
            thread: ThreadSummary {
                id: state.id.clone(),
                title: state.title.clone(),
                message_count: 0,
                preview: String::new(),
                created_at: state.created_at.clone(),
                updated_at: state.updated_at.clone(),
            },
        },
    );
    Ok(state)
}

/// Read a full thread (metadata + transcript) for the chat panel.
#[tauri::command]
pub fn thread_load(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<Option<ThreadState>, String> {
    let store = store_from_state(registry.inner());
    let state = build_thread_state(&store, &thread_id)?;
    if let Some(s) = state.as_ref() {
        emit(
            &app,
            "thread-loaded",
            &ThreadLoadedPayload { thread: s.clone() },
        );
    }
    Ok(state)
}

/// Drop both files and clear any in-memory context for the thread.
#[tauri::command]
pub fn thread_delete(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    let store = store_from_state(registry.inner());
    store
        .delete(&thread_id)
        .map_err(|e| format!("Failed to delete thread {thread_id}: {e}"))?;
    // Best-effort: drop any in-memory context engine state so a
    // recreated thread with the same id starts fresh.
    crate::context::manager::remove_context(&thread_id);
    emit(
        &app,
        "thread-deleted",
        &ThreadDeletedPayload {
            thread_id: thread_id.clone(),
        },
    );
    Ok(())
}

/// List every thread, newest first.
#[tauri::command]
pub fn thread_list_summaries(
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<Vec<ThreadSummary>, String> {
    let store = store_from_state(registry.inner());
    let entries = store
        .list_summaries()
        .map_err(|e| format!("Failed to list threads: {e}"))?;
    Ok(entries.into_iter().map(build_thread_summary).collect())
}

/// Update the user-facing title without touching message history.
#[tauri::command]
pub fn thread_update_title(
    thread_id: String,
    title: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<(), String> {
    let store = store_from_state(registry.inner());
    store
        .set_title(&thread_id, title)
        .map(|_| ())
        .map_err(|e| format!("Failed to update title: {e}"))
}

/// Persist usage metadata after a turn so the chat list can show
/// token + context bars.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUsageRequest {
    pub thread_id: String,
    pub token_usage: TokenUsage,
    pub context_usage: ContextUsage,
}

#[tauri::command]
pub fn thread_update_usage(
    request: UpdateUsageRequest,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    let store = store_from_state(registry.inner());
    store
        .set_usage(
            &request.thread_id,
            Some(db_token_to_meta(&request.token_usage)),
            Some(db_context_to_meta(&request.context_usage)),
        )
        .map_err(|e| format!("Failed to persist usage: {e}"))?;
    emit(
        &app,
        "thread-usage-updated",
        &ThreadUsageUpdatedPayload {
            thread_id: request.thread_id,
            token_usage: request.token_usage,
            context_usage: request.context_usage,
        },
    );
    Ok(())
}

/// Rebuild the API-shaped message list for a thread. Used by the
/// frontend when reseeding the in-memory context engine on
/// thread-switch.
#[tauri::command]
pub fn thread_get_api_history(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<Vec<ApiMessage>, String> {
    let store = store_from_state(registry.inner());
    let loaded = store
        .load(&thread_id)
        .map_err(|e| format!("Failed to load thread {thread_id}: {e}"))?;
    let Some(loaded) = loaded else {
        return Ok(Vec::new());
    };
    Ok(session_to_api_messages(loaded.session.messages()))
}

/// Cancel any in-flight turn on a thread. The new agent runtime owns
/// turn lifecycle through `agent_cancel(turn_id)` — this command
/// keeps the frontend's existing "Stop" button working by clearing
/// the thread's in-memory context manager so the next request starts
/// from the persisted JSONL only.
///
/// Returns `Some("session")` when context was cleared, `None` when
/// the thread had no live state. The exact return shape doesn't
/// matter; the frontend treats it as a fire-and-forget.
#[tauri::command]
pub fn thread_cancel_current_turn(
    thread_id: String,
    _reason: Option<String>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    crate::context::manager::remove_context(&thread_id);
    emit(
        &app,
        "thread-cancelled",
        &serde_json::json!({
            "threadId": thread_id,
            "reason": "user_stop",
        }),
    );
    Ok(Some("session".to_string()))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::types::TokenUsage as RuntimeTokenUsage;

    fn user_msg(text: &str, ts: i64) -> ConversationMessage {
        ConversationMessage::user_text(text, ts)
    }

    fn assistant_text(text: &str, ts: i64) -> ConversationMessage {
        ConversationMessage::assistant(
            vec![ContentBlock::Text {
                text: text.to_string(),
            }],
            ts,
        )
    }

    fn assistant_with_tool(tool_id: &str, name: &str, input: serde_json::Value, ts: i64) -> ConversationMessage {
        ConversationMessage::assistant(
            vec![
                ContentBlock::Text {
                    text: "running tool".into(),
                },
                ContentBlock::ToolUse {
                    id: tool_id.to_string(),
                    name: name.to_string(),
                    input,
                },
            ],
            ts,
        )
    }

    fn tool_result(tool_id: &str, content: &str, ts: i64) -> ConversationMessage {
        ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![ContentBlock::ToolResult {
                tool_use_id: tool_id.to_string(),
                content: content.to_string(),
                is_error: None,
            }],
            usage: None,
            timestamp: ts,
        }
    }

    #[test]
    fn user_message_round_trips_text_only() {
        let messages = vec![user_msg("hello", 1)];
        let db = session_to_db_messages(&messages);
        assert_eq!(db.len(), 1);
        assert_eq!(db[0].role, "user");
        assert_eq!(db[0].content, "hello");
        assert!(db[0].tool_calls.is_none());
    }

    #[test]
    fn assistant_message_collapses_text_and_thinking() {
        let assistant = ConversationMessage::assistant(
            vec![
                ContentBlock::Thinking {
                    text: "reasoning step".into(),
                    signature: None,
                },
                ContentBlock::Text {
                    text: "answer".into(),
                },
            ],
            10,
        );
        let db = session_to_db_messages(&[assistant]);
        assert_eq!(db[0].role, "assistant");
        assert_eq!(db[0].content, "answer");
        assert_eq!(db[0].thinking.as_deref(), Some("reasoning step"));
    }

    #[test]
    fn tool_result_folds_into_prior_assistant_tool_call() {
        let messages = vec![
            user_msg("ls", 1),
            assistant_with_tool("call-1", "list_dir", serde_json::json!({"path": "."}), 2),
            tool_result("call-1", "FILES: a.rs b.rs", 3),
        ];
        let db = session_to_db_messages(&messages);
        // user + assistant only — Tool messages are folded.
        assert_eq!(db.len(), 2);
        let assistant = &db[1];
        let calls = assistant.tool_calls.as_ref().expect("tool_calls present");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call-1");
        assert_eq!(calls[0].name, "list_dir");
        assert_eq!(calls[0].result.as_deref(), Some("FILES: a.rs b.rs"));
    }

    #[test]
    fn tool_result_error_is_prefixed_in_db_shape() {
        let messages = vec![
            assistant_with_tool("c", "x", serde_json::json!({}), 1),
            ConversationMessage {
                role: MessageRole::Tool,
                blocks: vec![ContentBlock::ToolResult {
                    tool_use_id: "c".into(),
                    content: "boom".into(),
                    is_error: Some(true),
                }],
                usage: None,
                timestamp: 2,
            },
        ];
        let db = session_to_db_messages(&messages);
        let assistant = &db[0];
        let calls = assistant.tool_calls.as_ref().unwrap();
        assert_eq!(calls[0].result.as_deref(), Some("[error] boom"));
    }

    #[test]
    fn api_history_emits_role_tagged_messages() {
        let messages = vec![
            user_msg("hi", 1),
            assistant_text("hello", 2),
            assistant_with_tool("c", "ping", serde_json::json!({}), 3),
            tool_result("c", "pong", 4),
        ];
        let api = session_to_api_messages(&messages);
        assert_eq!(api.len(), 4, "user / assistant text / assistant tool_use / tool result");
        match &api[0] {
            ApiMessage::User { content } => assert_eq!(content, "hi"),
            other => panic!("expected user, got {other:?}"),
        }
        match &api[3] {
            ApiMessage::Tool {
                tool_call_id,
                content,
            } => {
                assert_eq!(tool_call_id, "c");
                assert_eq!(content, "pong");
            }
            other => panic!("expected tool, got {other:?}"),
        }
    }

    #[test]
    fn api_history_skips_empty_assistant_messages() {
        let messages = vec![ConversationMessage::assistant(vec![], 1)];
        let api = session_to_api_messages(&messages);
        assert!(api.is_empty(), "empty assistant blocks should be skipped");
    }

    #[test]
    fn token_meta_round_trips_through_db_shape() {
        let original = TokenUsage {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
        };
        let meta = db_token_to_meta(&original);
        let back = meta_to_db_token(&meta);
        assert_eq!(back.prompt_tokens, 100);
        assert_eq!(back.completion_tokens, 50);
        assert_eq!(back.total_tokens, 150);

        // Use the runtime-side TokenUsage just to make sure the
        // metadata layer doesn't accidentally collide with it.
        let _ = RuntimeTokenUsage::default();
    }

    #[test]
    fn synthetic_message_id_is_deterministic() {
        let id1 = synthetic_message_id("user", 42, 0);
        let id2 = synthetic_message_id("user", 42, 0);
        assert_eq!(id1, id2);
        assert_ne!(synthetic_message_id("user", 42, 1), id1);
    }
}
