//! Thread Tauri commands — JSONL event-sourced edition.
//!
//! All persistence is delegated to [`crate::threads::ThreadEventLog`]; the
//! SQLite `threads` table has been retired (see schema v13).
//!
//! Wire format compatibility: the frontend still consumes `DbThread` /
//! `DbMessage` / `ThreadSummary` shapes and the legacy `thread-*` Tauri
//! events. We synthesize those shapes from a [`ProjectedThread`] so the
//! React layer can be migrated to the richer event stream incrementally.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::context::types::Turn;
use crate::db::{ContextUsage, Message, ThreadState, TokenUsage, ToolCall as DbToolCall};
use crate::services::api_converter::{ApiConverter, ApiMessage, UiMessage};
use crate::threads::events::{CancelReason, EventToolCall};
use crate::threads::projector::ProjectedThread;
use crate::threads::store::ThreadEventLog;

// ============================================================
// Wire-format adapters
// ============================================================

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

/// Strip leaked IDE-context enrichment from a stored user message before
/// handing it to the chat UI.
///
/// The clean architecture stores the user-typed text in `Turn::user_message`
/// and the enrichment (execution_mode, user_info, project_rules, project_layout,
/// agent_skills, open_files, attached_context, …) in `Turn::user_context`.
/// However, threads written before that fix landed (and any future bug that
/// re-pollutes `user_message`) carry the entire XML blob inside
/// `user_message`, which would render the giant enrichment as a user bubble.
///
/// This function defensively repairs the display:
/// 1. If the message contains a `<user_query>...</user_query>` block, return
///    the inner text (still trimmed of common nested wrappers like
///    `<attached_context>` so the bubble shows what the user actually typed).
/// 2. Otherwise return the original content as-is.
///
/// Persistence stays untouched — only the projection-to-UI adapter calls this.
fn sanitize_user_message_for_display(content: &str) -> String {
    const OPEN: &str = "<user_query>";
    const CLOSE: &str = "</user_query>";

    let inner = if let (Some(start), Some(end)) = (content.find(OPEN), content.rfind(CLOSE)) {
        if start + OPEN.len() <= end {
            &content[start + OPEN.len()..end]
        } else {
            content
        }
    } else {
        content
    };

    // Strip a leading `<attached_context>...</attached_context>` block so the
    // bubble only shows the user-typed body. Attached skills/rules are
    // surfaced via dedicated UI affordances, not free text.
    let stripped = strip_leading_attached_context(inner);
    stripped.trim().to_string()
}

fn strip_leading_attached_context(s: &str) -> &str {
    let trimmed = s.trim_start();
    const OPEN: &str = "<attached_context";
    if !trimmed.starts_with(OPEN) {
        return s;
    }
    const CLOSE: &str = "</attached_context>";
    if let Some(end) = trimmed.find(CLOSE) {
        let after = &trimmed[end + CLOSE.len()..];
        return after;
    }
    s
}

fn projection_to_thread_state(projection: &ProjectedThread) -> ThreadState {
    let messages = projection_to_messages(projection);
    ThreadState {
        id: projection.thread_id.clone(),
        title: projection.title.clone(),
        summary: None,
        messages,
        token_usage: projection.token_usage.clone(),
        context_usage: projection.context_usage.clone(),
        created_at: projection.created_at.clone(),
        updated_at: projection.updated_at.clone(),
    }
}

/// Flatten the projected turns (and the in-progress turn, if any) into the
/// flat `Vec<Message>` shape the React layer currently consumes.
fn projection_to_messages(projection: &ProjectedThread) -> Vec<Message> {
    let mut out = Vec::with_capacity(projection.turns.len() * 2);
    for turn in &projection.turns {
        push_turn_messages(turn, &mut out);
    }
    if let Some(current) = projection.current_turn.as_ref() {
        push_turn_messages(current, &mut out);
    }
    out
}

fn push_turn_messages(turn: &Turn, out: &mut Vec<Message>) {
    out.push(Message {
        id: turn.id.clone(),
        role: "user".to_string(),
        // Always sanitise for display. The Rust message builder still uses
        // `turn.user_message` + `turn.user_context` verbatim when constructing
        // API messages for the LLM, so this only affects what the React chat
        // bubble renders.
        content: sanitize_user_message_for_display(&turn.user_message),
        timestamp: turn.created_at.clone(),
        tool_calls: None,
        thinking: None,
        is_thinking: None,
        tools: None,
        timeline: None,
        tool_proposal: None,
    });

    for round in &turn.rounds {
        let mut tool_calls: Vec<DbToolCall> = Vec::new();
        for tc in &round.tool_calls {
            let result = round
                .tool_results
                .get(&tc.id)
                .map(|r| {
                    if r.is_error {
                        format!("[error] {}", r.content)
                    } else {
                        r.content.clone()
                    }
                });
            tool_calls.push(DbToolCall {
                id: tc.id.clone(),
                name: tc.name.clone(),
                arguments: tc.arguments.clone(),
                result,
            });
        }

        out.push(Message {
            id: round.id.clone(),
            role: "assistant".to_string(),
            content: round.response.clone(),
            timestamp: round.created_at.clone(),
            tool_calls: if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
            thinking: round.thinking.clone(),
            is_thinking: Some(false),
            tools: None,
            timeline: None,
            tool_proposal: None,
        });
    }
}

fn projection_to_summary(projection: &ProjectedThread) -> ThreadSummary {
    ThreadSummary {
        id: projection.thread_id.clone(),
        title: projection.title.clone(),
        message_count: projection.turn_count(),
        preview: projection.preview(),
        created_at: projection.created_at.clone(),
        updated_at: projection.updated_at.clone(),
    }
}

// ============================================================
// Active streaming state (transient, in-memory)
// ============================================================

/// Aggregates streaming output until [`thread_finalize_response`] commits it
/// to the persistent log. Pure UI buffer — discarded when the stream ends.
///
/// `message_id` and `started_at_ms` are populated for diagnostics (we surface
/// them in trace logs when a stream is orphaned) even if no command currently
/// reads them on the happy path.
#[derive(Debug, Default, Clone)]
struct StreamState {
    thread_id: String,
    #[allow(dead_code)]
    message_id: String,
    content: String,
    thinking: String,
    tool_calls: Vec<EventToolCall>,
    #[allow(dead_code)]
    started_at_ms: i64,
}

/// Tauri-managed map of active streams. One mutex per process (cheap, all
/// access is short-lived).
#[derive(Default)]
pub struct ActiveStreams(RwLock<HashMap<String, StreamState>>);

impl ActiveStreams {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

// ============================================================
// Legacy event helpers (kept until the UI migrates to thread-event-appended)
// ============================================================

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
struct ThreadMessageAddedPayload {
    thread_id: String,
    message: Message,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThreadTokenReceivedPayload {
    thread_id: String,
    stream_id: String,
    token: String,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThreadThinkingReceivedPayload {
    thread_id: String,
    stream_id: String,
    thinking: String,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThreadToolAddedPayload {
    thread_id: String,
    stream_id: String,
    tool_call: Value,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThreadUsageUpdatedPayload {
    thread_id: String,
    token_usage: TokenUsage,
    context_usage: ContextUsage,
}

// ============================================================
// Thread CRUD
// ============================================================

#[tauri::command]
pub fn thread_save(
    thread: ThreadState,
    log: State<'_, Arc<ThreadEventLog>>,
    app: AppHandle,
) -> Result<(), String> {
    // Upsert semantics for the JSONL world. The frontend generates UUIDs
    // optimistically and may call `thread_save` before any other event has
    // been appended (e.g. immediately after the user clicks "New Chat").
    //
    // Only metadata that lives outside the event-stream invariant is
    // persisted — currently just the title. Messages/thinking/tool-calls
    // are owned by the live append commands and intentionally ignored here.
    let existing = log.project_thread(&thread.id);
    let projection = match existing {
        Ok(p) => p,
        Err(crate::threads::store::StoreError::ThreadNotFound(_)) => log
            .create_thread_with_id(thread.id.clone(), Some(thread.title.clone()))
            .map_err(|e| format!("Failed to create thread {}: {e}", thread.id))?,
        Err(e) => return Err(format!("Failed to load thread {}: {e}", thread.id)),
    };

    // Append a TitleChanged event only when the title actually drifted —
    // otherwise we'd accumulate a no-op event on every save during streaming.
    if projection.title != thread.title {
        log.append_title_changed(&thread.id, thread.title.clone())
            .map_err(|e| format!("Failed to update thread title: {e}"))?;
    }

    let projection = log
        .project_thread(&thread.id)
        .map_err(|e| format!("Failed to project thread {}: {e}", thread.id))?;
    emit(
        &app,
        "thread-loaded",
        &ThreadLoadedPayload {
            thread: projection_to_thread_state(&projection),
        },
    );
    Ok(())
}

#[tauri::command]
pub fn thread_create(
    title: Option<String>,
    log: State<'_, Arc<ThreadEventLog>>,
    app: AppHandle,
) -> Result<ThreadState, String> {
    let projection = log
        .create_thread(title)
        .map_err(|e| format!("Failed to create thread: {e}"))?;

    let state = projection_to_thread_state(&projection);
    emit(
        &app,
        "thread-created",
        &ThreadCreatedPayload {
            thread: projection_to_summary(&projection),
        },
    );
    Ok(state)
}

#[tauri::command]
pub fn thread_load(
    thread_id: String,
    log: State<'_, Arc<ThreadEventLog>>,
    app: AppHandle,
) -> Result<Option<ThreadState>, String> {
    match log.project_thread(&thread_id) {
        Ok(projection) => {
            let state = projection_to_thread_state(&projection);
            emit(
                &app,
                "thread-loaded",
                &ThreadLoadedPayload {
                    thread: state.clone(),
                },
            );
            Ok(Some(state))
        }
        Err(crate::threads::store::StoreError::ThreadNotFound(_)) => Ok(None),
        Err(e) => Err(format!("Failed to load thread {thread_id}: {e}")),
    }
}

#[tauri::command]
pub fn thread_delete(
    thread_id: String,
    log: State<'_, Arc<ThreadEventLog>>,
    app: AppHandle,
) -> Result<(), String> {
    log.delete_thread(&thread_id)
        .map_err(|e| format!("Failed to delete thread {thread_id}: {e}"))?;

    emit(
        &app,
        "thread-deleted",
        &ThreadDeletedPayload {
            thread_id: thread_id.clone(),
        },
    );
    // Drop the in-memory context as well so the next session starts clean.
    crate::context::manager::remove_context(&thread_id);
    Ok(())
}

#[tauri::command]
pub fn thread_list_summaries(
    log: State<'_, Arc<ThreadEventLog>>,
) -> Result<Vec<ThreadSummary>, String> {
    let entries = log
        .list_summaries()
        .map_err(|e| format!("Failed to list threads: {e}"))?;

    Ok(entries
        .into_iter()
        .map(|e| ThreadSummary {
            id: e.id,
            title: e.title,
            message_count: e.message_count,
            preview: e.preview,
            created_at: e.created_at,
            updated_at: e.updated_at,
        })
        .collect())
}

// ============================================================
// User messages (persisted immediately)
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddUserMessageRequest {
    pub thread_id: String,
    /// The clean, user-typed text. This is what we render in the chat bubble
    /// when the thread is reloaded — never the giant XML enrichment blob.
    pub content: String,
    /// Optional IDE/runtime context (execution mode, user info, project rules,
    /// project layout, agent skills, open files, attached_context, …) attached
    /// to *this* user message. Combined with `content` only when building API
    /// messages for the LLM — never shown in the UI.
    pub ide_context: Option<String>,
    pub attachments: Option<Vec<Value>>,
}

#[tauri::command]
pub fn thread_add_user_message(
    request: AddUserMessageRequest,
    log: State<'_, Arc<ThreadEventLog>>,
    app: AppHandle,
) -> Result<Message, String> {
    // Bootstrap the thread if it doesn't exist yet (matches `thread_save`'s
    // upsert semantics — keeps optimistic UI flows from racing against the
    // backend).
    let projection = match log.project_thread(&request.thread_id) {
        Ok(p) => p,
        Err(crate::threads::store::StoreError::ThreadNotFound(_)) => log
            .create_thread_with_id(request.thread_id.clone(), None)
            .map_err(|e| format!("Failed to create thread: {e}"))?,
        Err(e) => return Err(format!("Failed to project thread: {e}")),
    };

    // Auto-title from the first user message: derive a clean, human-readable
    // label by stripping markdown fences, JSON blobs, and decorative noise.
    // Single source of truth for the title — the frontend's optimistic
    // preview is overwritten by this via `thread-event-appended` events.
    if projection.is_empty() && projection.title == "New Chat" {
        let derived = crate::threads::title::derive_thread_title(&request.content);
        if !derived.is_empty() && derived != "New Chat" {
            let _ = log.append_title_changed(&request.thread_id, derived);
        }
    }

    let event_id = log
        .append_user_message(
            &request.thread_id,
            request.content.clone(),
            request.ide_context.clone(),
            request.attachments.clone(),
        )
        .map_err(|e| format!("Failed to append user message: {e}"))?;

    let now = chrono::Utc::now().to_rfc3339();
    let message = Message {
        id: event_id,
        role: "user".to_string(),
        content: request.content,
        timestamp: now,
        tool_calls: None,
        thinking: None,
        is_thinking: None,
        tools: request.attachments,
        timeline: None,
        tool_proposal: None,
    };

    emit(
        &app,
        "thread-message-added",
        &ThreadMessageAddedPayload {
            thread_id: request.thread_id,
            message: message.clone(),
        },
    );
    Ok(message)
}

// ============================================================
// Streaming assistant response
// ============================================================

#[tauri::command]
pub fn thread_start_response(
    thread_id: String,
    streams: State<'_, Arc<ActiveStreams>>,
) -> Result<String, String> {
    let stream_id = Uuid::new_v4().to_string();
    let message_id = Uuid::new_v4().to_string();
    let mut map = streams.0.write();
    map.insert(
        stream_id.clone(),
        StreamState {
            thread_id,
            message_id,
            started_at_ms: chrono::Utc::now().timestamp_millis(),
            ..Default::default()
        },
    );
    Ok(stream_id)
}

#[tauri::command]
pub fn thread_append_token(
    stream_id: String,
    token: String,
    streams: State<'_, Arc<ActiveStreams>>,
    app: AppHandle,
) -> Result<(), String> {
    let thread_id = {
        let mut map = streams.0.write();
        let s = map
            .get_mut(&stream_id)
            .ok_or_else(|| format!("stream not found: {stream_id}"))?;
        s.content.push_str(&token);
        s.thread_id.clone()
    };
    emit(
        &app,
        "thread-token-received",
        &ThreadTokenReceivedPayload {
            thread_id,
            stream_id,
            token,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn thread_append_thinking(
    stream_id: String,
    thinking: String,
    streams: State<'_, Arc<ActiveStreams>>,
    app: AppHandle,
) -> Result<(), String> {
    let thread_id = {
        let mut map = streams.0.write();
        let s = map
            .get_mut(&stream_id)
            .ok_or_else(|| format!("stream not found: {stream_id}"))?;
        s.thinking.push_str(&thinking);
        s.thread_id.clone()
    };
    emit(
        &app,
        "thread-thinking-received",
        &ThreadThinkingReceivedPayload {
            thread_id,
            stream_id,
            thinking,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn thread_add_tool_call(
    stream_id: String,
    tool_call: Value,
    streams: State<'_, Arc<ActiveStreams>>,
    app: AppHandle,
) -> Result<(), String> {
    // Adapt the loose JSON shape coming from the frontend to our typed
    // EventToolCall. Required fields: id, name, arguments. The frontend may
    // send arguments as a plain object — re-serialize to a string in that
    // case so we round-trip exactly the model's wire format.
    let id = tool_call
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("tool_call.id missing")?
        .to_string();
    let name = tool_call
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| {
            tool_call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
        })
        .ok_or("tool_call.name missing")?
        .to_string();
    let arguments = match tool_call.get("arguments") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
        None => match tool_call.get("function").and_then(|f| f.get("arguments")) {
            Some(Value::String(s)) => s.clone(),
            Some(other) => serde_json::to_string(other).unwrap_or_default(),
            None => "{}".to_string(),
        },
    };

    let thread_id = {
        let mut map = streams.0.write();
        let s = map
            .get_mut(&stream_id)
            .ok_or_else(|| format!("stream not found: {stream_id}"))?;
        s.tool_calls.push(EventToolCall {
            id,
            name,
            arguments,
        });
        s.thread_id.clone()
    };
    emit(
        &app,
        "thread-tool-added",
        &ThreadToolAddedPayload {
            thread_id,
            stream_id,
            tool_call,
        },
    );
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeResponseRequest {
    pub stream_id: String,
    pub timeline: Option<Value>,
}

#[tauri::command]
pub fn thread_finalize_response(
    request: FinalizeResponseRequest,
    log: State<'_, Arc<ThreadEventLog>>,
    streams: State<'_, Arc<ActiveStreams>>,
    app: AppHandle,
) -> Result<Message, String> {
    let stream = {
        let mut map = streams.0.write();
        map.remove(&request.stream_id)
            .ok_or_else(|| format!("stream not found: {}", request.stream_id))?
    };

    let StreamState {
        thread_id,
        content,
        thinking,
        tool_calls,
        ..
    } = stream;

    let thinking_opt = if thinking.is_empty() {
        None
    } else {
        Some(thinking)
    };

    let event_id = log
        .append_assistant_message(
            &thread_id,
            content.clone(),
            thinking_opt.clone(),
            tool_calls.clone(),
        )
        .map_err(|e| format!("Failed to append assistant message: {e}"))?;

    // Flat-message shape for the legacy bus.
    let db_tool_calls: Vec<DbToolCall> = tool_calls
        .iter()
        .map(|tc| DbToolCall {
            id: tc.id.clone(),
            name: tc.name.clone(),
            arguments: tc.arguments.clone(),
            result: None,
        })
        .collect();

    let message = Message {
        id: event_id,
        role: "assistant".to_string(),
        content,
        timestamp: chrono::Utc::now().to_rfc3339(),
        tool_calls: if db_tool_calls.is_empty() {
            None
        } else {
            Some(db_tool_calls)
        },
        thinking: thinking_opt,
        is_thinking: Some(false),
        tools: None,
        timeline: request.timeline,
        tool_proposal: None,
    };

    emit(
        &app,
        "thread-message-added",
        &ThreadMessageAddedPayload {
            thread_id,
            message: message.clone(),
        },
    );
    Ok(message)
}

// ============================================================
// Usage / metadata
// ============================================================

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
    log: State<'_, Arc<ThreadEventLog>>,
    app: AppHandle,
) -> Result<(), String> {
    // Find the most recently finalized turn id so we can attach the usage
    // event to a real turn. If none exists yet (e.g. the very first message
    // is still streaming), no-op rather than fabricate one.
    let projection = log
        .project_thread(&request.thread_id)
        .map_err(|e| format!("Failed to project thread: {e}"))?;
    let turn_id = projection
        .current_turn
        .as_ref()
        .map(|t| t.id.clone())
        .or_else(|| projection.turns.last().map(|t| t.id.clone()));

    if let Some(turn_id) = turn_id {
        let _ = log.append_turn_finalized(
            &request.thread_id,
            &turn_id,
            crate::threads::events::TurnOutcome::Completed,
            Some(request.token_usage.clone()),
            Some(request.context_usage.clone()),
        );
    }

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

#[tauri::command]
pub fn thread_get_api_history(
    thread_id: String,
    log: State<'_, Arc<ThreadEventLog>>,
) -> Result<Vec<ApiMessage>, String> {
    let projection = log
        .project_thread(&thread_id)
        .map_err(|e| format!("Failed to project thread {thread_id}: {e}"))?;

    // Project → flat UI messages → API messages. Re-using the existing
    // ApiConverter keeps tool-call pairing logic in one place.
    let flat = projection_to_messages(&projection);
    let ui: Vec<UiMessage> = flat
        .into_iter()
        .map(|m| UiMessage {
            id: m.id,
            sender: m.role,
            content: m.content,
            timestamp: serde_json::json!(m.timestamp),
            timeline: None,
        })
        .collect();
    Ok(ApiConverter::convert_thread_to_api_history(&ui))
}

#[tauri::command]
pub fn thread_update_title(
    thread_id: String,
    title: String,
    log: State<'_, Arc<ThreadEventLog>>,
) -> Result<(), String> {
    log.append_title_changed(&thread_id, title)
        .map(|_| ())
        .map_err(|e| format!("Failed to update title: {e}"))
}

// ============================================================
// Single-shot append API (preferred for the agent loop)
//
// The streaming API (`thread_start_response` / `thread_append_token` / ...)
// exists for future real-time persistence. For now the agent service writes
// each fully-formed assistant message and tool result in one shot — these
// commands skip the in-memory stream buffer entirely.
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendAssistantMessageRequest {
    pub thread_id: String,
    pub content: String,
    pub thinking: Option<String>,
    /// Tool calls embedded in this assistant turn. Use the LLM-supplied id,
    /// name, and JSON-encoded arguments — these chain to the matching
    /// `thread_append_tool_result` calls.
    pub tool_calls: Option<Vec<EventToolCall>>,
}

#[tauri::command]
pub fn thread_append_assistant_message(
    request: AppendAssistantMessageRequest,
    log: State<'_, Arc<ThreadEventLog>>,
    app: AppHandle,
) -> Result<Message, String> {
    let tool_calls = request.tool_calls.unwrap_or_default();
    let event_id = log
        .append_assistant_message(
            &request.thread_id,
            request.content.clone(),
            request.thinking.clone(),
            tool_calls.clone(),
        )
        .map_err(|e| format!("Failed to append assistant message: {e}"))?;

    let db_tool_calls: Vec<DbToolCall> = tool_calls
        .iter()
        .map(|tc| DbToolCall {
            id: tc.id.clone(),
            name: tc.name.clone(),
            arguments: tc.arguments.clone(),
            result: None,
        })
        .collect();

    let message = Message {
        id: event_id,
        role: "assistant".to_string(),
        content: request.content,
        timestamp: chrono::Utc::now().to_rfc3339(),
        tool_calls: if db_tool_calls.is_empty() {
            None
        } else {
            Some(db_tool_calls)
        },
        thinking: request.thinking,
        is_thinking: Some(false),
        tools: None,
        timeline: None,
        tool_proposal: None,
    };

    emit(
        &app,
        "thread-message-added",
        &ThreadMessageAddedPayload {
            thread_id: request.thread_id,
            message: message.clone(),
        },
    );
    Ok(message)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendToolResultRequest {
    pub thread_id: String,
    pub tool_call_id: String,
    /// Tool name — required for replay/debugging even though it's redundant
    /// with the tool_call event (parser doesn't index back-references).
    pub tool_name: String,
    pub content: String,
    pub is_error: bool,
    /// Set when the result was clamped to a length budget before persistence.
    pub truncated: Option<bool>,
    pub original_length: Option<usize>,
    pub duration_ms: Option<u64>,
}

#[tauri::command]
pub fn thread_append_tool_result(
    request: AppendToolResultRequest,
    log: State<'_, Arc<ThreadEventLog>>,
    app: AppHandle,
) -> Result<String, String> {
    let event_id = log
        .append_tool_result(
            &request.thread_id,
            request.tool_call_id.clone(),
            request.tool_name,
            request.content.clone(),
            request.is_error,
            request.truncated.unwrap_or(false),
            request.original_length,
            request.duration_ms,
        )
        .map_err(|e| format!("Failed to append tool result: {e}"))?;

    emit(
        &app,
        "thread-tool-completed",
        &serde_json::json!({
            "threadId": request.thread_id,
            "toolId": request.tool_call_id,
            "result": request.content,
        }),
    );
    Ok(event_id)
}

// ============================================================
// Cancellation (the user-facing Stop button)
// ============================================================

/// Append a cancellation event to the live turn, synthesising error tool
/// results for any unfinished tool calls. Re-projects the in-memory context
/// manager so the next request reflects the new state.
///
/// Replaces the old `context_discard_current_turn` command — instead of
/// discarding work, we preserve the conversation history and let the model
/// see exactly what completed and what didn't.
///
/// Two reconciliation paths exist depending on what made it to disk:
///
/// 1. **JSONL has the turn** (`append_cancellation` returns `Some`): rebuild
///    the in-memory `ContextManager` from the projected turns. The JSONL is
///    authoritative because it just received synthesised tool-result events
///    for every unfinished call.
///
/// 2. **JSONL has nothing to cancel** (`append_cancellation` returns `None`):
///    the conversation hasn't been persisted via the per-event commands yet
///    (transitional period, or a cancel that raced persistence). Falling
///    through to `init_context_from_turns(empty)` here would wipe the live
///    `ContextManager` and lose the in-flight turn — exactly the "AI forgot
///    what it was doing" regression. Instead, synthesise the cancellation
///    *in-place* on the live manager so the next request still sees
///    coherent `tool_call` ↔ `tool_result` pairs.
#[tauri::command]
pub fn thread_cancel_current_turn(
    thread_id: String,
    reason: Option<String>,
    log: State<'_, Arc<ThreadEventLog>>,
    streams: State<'_, Arc<ActiveStreams>>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    // Drop any active streams for this thread first — their content is now
    // stale because the turn has been cancelled.
    {
        let mut map = streams.0.write();
        map.retain(|_, s| s.thread_id != thread_id);
    }

    let parsed = parse_cancel_reason(reason.as_deref());

    let cancelled_turn = log
        .append_cancellation(&thread_id, parsed)
        .map_err(|e| format!("Failed to record cancellation: {e}"))?;

    if cancelled_turn.is_some() {
        // JSONL just absorbed the cancellation — re-seed the in-memory
        // ContextManager from disk so the next request matches byte-for-byte.
        let projection = log
            .project_thread(&thread_id)
            .map_err(|e| format!("Failed to project thread: {e}"))?;
        let context_window = projection.settings.context_window.unwrap_or(128_000);
        let max_output = projection.settings.max_output.unwrap_or(8_192);
        let mut all_turns = projection.turns.clone();
        if let Some(t) = projection.current_turn.clone() {
            all_turns.push(t);
        }
        let _ = crate::context::manager::init_context_from_turns(
            &thread_id,
            all_turns,
            context_window,
            max_output,
        );
    } else {
        // Nothing in JSONL to cancel — the live ContextManager owns the turn.
        // Cancel in-place so we preserve every tool call/result accumulated so
        // far via the legacy `context_add_*` commands.
        let _ = crate::context::manager::atomic_cancel_current_turn_in_place(&thread_id);
    }

    emit(
        &app,
        "thread-cancelled",
        &serde_json::json!({
            "threadId": thread_id,
            "turnId": cancelled_turn,
            "reason": format!("{parsed:?}").to_lowercase(),
        }),
    );

    Ok(cancelled_turn)
}

fn parse_cancel_reason(s: Option<&str>) -> CancelReason {
    match s.unwrap_or("user_stop").to_ascii_lowercase().as_str() {
        "provider_error" | "provider-error" | "providererror" => CancelReason::ProviderError,
        "tool_timeout" | "tool-timeout" => CancelReason::ToolTimeout,
        "internal_error" | "internal-error" => CancelReason::InternalError,
        _ => CancelReason::UserStop,
    }
}

// ============================================================
// Tests — wire-format adapters only; storage tests live in threads/store.rs.
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threads::events::ThreadEvent;
    use crate::threads::projector;

    #[test]
    fn sanitize_user_message_extracts_user_query_from_legacy_blob() {
        let polluted = "<execution_mode_context authoritative=\"true\" mode=\"agent\">\n\
            stuff\n\
            </execution_mode_context>\n\n\
            <user_info>\nOS: Windows\n</user_info>\n\n\
            <project_layout>\nE:\\Foo/\n</project_layout>\n\n\
            <user_query>\n start \n</user_query>";
        assert_eq!(sanitize_user_message_for_display(polluted), "start");
    }

    #[test]
    fn sanitize_user_message_strips_attached_context_inside_user_query() {
        let polluted = "<execution_mode_context></execution_mode_context>\n\n\
            <user_query>\n\
            <attached_context description=\"x\">\n  Rules: docs-writer\n</attached_context>\n\n\
            start\n\
            </user_query>";
        assert_eq!(sanitize_user_message_for_display(polluted), "start");
    }

    #[test]
    fn sanitize_user_message_passthrough_for_clean_input() {
        assert_eq!(
            sanitize_user_message_for_display("write a poem"),
            "write a poem"
        );
        assert_eq!(
            sanitize_user_message_for_display("multi\nline\nbody"),
            "multi\nline\nbody"
        );
    }

    #[test]
    fn projection_to_messages_flattens_user_assistant_pairs() {
        let session = ThreadEvent::session("t1", Some("Chat".into()));
        let user = ThreadEvent::user_message("t1", session.id(), "hi", None, None);
        let asst = ThreadEvent::AssistantMessage {
            id: "asst1".into(),
            parent_id: user.id().into(),
            thread_id: "t1".into(),
            turn_id: user.id().into(),
            timestamp: "now".into(),
            content: "hello".into(),
            thinking: Some("thinking".into()),
            tool_calls: vec![EventToolCall {
                id: "c1".into(),
                name: "file_read".into(),
                arguments: "{}".into(),
            }],
        };
        let result = ThreadEvent::ToolResult {
            id: "r1".into(),
            parent_id: asst.id().into(),
            thread_id: "t1".into(),
            turn_id: user.id().into(),
            timestamp: "now".into(),
            tool_call_id: "c1".into(),
            tool_name: "file_read".into(),
            content: "ok".into(),
            is_error: false,
            truncated: false,
            original_length: None,
            duration_ms: None,
        };

        let projection = projector::project("t1", &[session, user, asst, result]);
        let messages = projection_to_messages(&projection);
        assert_eq!(messages.len(), 2, "user + assistant");
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
        let calls = messages[1].tool_calls.as_ref().expect("tool_calls present");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].result.as_deref(), Some("ok"));
    }

    #[test]
    fn parse_cancel_reason_defaults_to_user_stop() {
        assert!(matches!(parse_cancel_reason(None), CancelReason::UserStop));
        assert!(matches!(
            parse_cancel_reason(Some("user_stop")),
            CancelReason::UserStop
        ));
        assert!(matches!(
            parse_cancel_reason(Some("provider_error")),
            CancelReason::ProviderError
        ));
        assert!(matches!(
            parse_cancel_reason(Some("tool_timeout")),
            CancelReason::ToolTimeout
        ));
        assert!(matches!(
            parse_cancel_reason(Some("internal_error")),
            CancelReason::InternalError
        ));
        assert!(matches!(
            parse_cancel_reason(Some("garbage")),
            CancelReason::UserStop
        ));
    }

    #[test]
    fn projection_to_summary_uses_turn_count() {
        let session = ThreadEvent::session("t1", Some("Title".into()));
        let user = ThreadEvent::user_message("t1", session.id(), "x", None, None);
        let projection = projector::project("t1", &[session, user]);
        let summary = projection_to_summary(&projection);
        assert_eq!(summary.message_count, 1, "current turn counts as 1");
        assert_eq!(summary.title, "Title");
    }

        /// Sanity guard so we don't accidentally remove the truncation logic that
        /// keeps tool results within budget.
        #[test]
        fn max_tool_result_length_is_set() {
            use crate::context::types::MAX_TOOL_RESULT_LENGTH;
            assert!(MAX_TOOL_RESULT_LENGTH > 0);
        }
}
