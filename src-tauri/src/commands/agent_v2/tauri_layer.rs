use super::*;
use tauri::{AppHandle, State};

use crate::host_commands::{agent, subagents};

/// A turn's events go to the windows through the app's event sink.
fn window_emitter(app: AppHandle) -> Arc<HostEmitter> {
    Arc::new(HostEmitter::new(Arc::new(app)))
}

// The conversation commands are written once, in `host_commands::agent`; a
// host with no window serves the same functions over HTTP.

/// Drive one agent turn end-to-end (`host_commands::agent::chat`).
#[tauri::command]
pub async fn agent_chat_v2(
    state: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
    request: AgentChatRequest,
) -> Result<(), String> {
    agent::chat(state.inner().clone(), window_emitter(app), request).await
}

#[tauri::command]
pub async fn agent_compact_thread(
    state: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
    request: AgentChatRequest,
) -> Result<Option<(u32, u32)>, String> {
    agent::compact_thread(state.inner().clone(), window_emitter(app), request).await
}

/// Cancel an in-flight turn. Returns whether a token was found —
/// `false` means the turn already completed or never started.
#[tauri::command]
pub async fn agent_cancel(
    state: State<'_, Arc<AgentRegistry>>,
    turn_id: String,
) -> Result<bool, String> {
    Ok(state.cancel(&turn_id))
}

/// The conversation turns running now. A client that opens mid-turn (a
/// browser tab, the desktop window after a reload) follows these, since it
/// missed their `turn_start`.
#[tauri::command]
pub async fn agent_active_turns(
    state: State<'_, Arc<AgentRegistry>>,
) -> Result<Vec<crate::agent_runtime::host::ActiveTurn>, String> {
    Ok(state.active_conversation_turns())
}

/// A thread's message history (`host_commands::agent::load_thread`).
#[tauri::command]
pub async fn agent_load_thread(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
) -> Result<Vec<ConversationMessage>, String> {
    agent::load_thread(state.inner().clone(), thread_id).await
}

/// The server half of Retry (`host_commands::agent::rewind_to_user_message`).
#[tauri::command]
pub async fn agent_rewind_to_user_message(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    user_message_ordinal: usize,
) -> Result<usize, String> {
    agent::rewind_to_user_message(&state, &thread_id, user_message_ordinal)
}

/// Resolve a pending frontend tool-call started by a
/// [`FrontendBridgeExecutor`]. The frontend invokes this once the
/// existing `agent-tool-runner.ts` pipeline has produced a result
/// (or an error).
///
/// Returns `Ok(())` when a pending oneshot was found and resolved.
/// Returns `Err("no pending tool call")` when nothing matched the
/// `(turn_id, tool_use_id)` pair — the turn finished, was
/// cancelled, or the frontend duplicated the post.
#[tauri::command]
pub async fn agent_post_tool_result(
    state: State<'_, Arc<AgentRegistry>>,
    turn_id: String,
    tool_use_id: String,
    content: String,
    is_error: bool,
) -> Result<(), String> {
    state.post_tool_result(&turn_id, &tool_use_id, content, is_error)
}

/// Queue a message for the next tool result
/// (`host_commands::agent::enqueue_message`).
#[tauri::command]
pub async fn agent_enqueue_message(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    text: String,
    display_text: Option<String>,
    chips: Option<Vec<crate::agent_runtime::types::AttachedPromptChip>>,
    origin: Option<String>,
    agent: Option<crate::agent_runtime::types::AgentReportMeta>,
) -> Result<(), String> {
    agent::enqueue_message(
        &state,
        &thread_id,
        text,
        display_text,
        chips,
        origin.as_deref(),
        agent,
    )
}

/// Cancel the queued message for `thread_id` (if any). Never fails:
/// returns Ok even when the slot was already empty so the
/// frontend's pill-clear is idempotent.
#[tauri::command]
pub async fn agent_cancel_queued_message(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
) -> Result<(), String> {
    state.cancel_queued_message(&thread_id).await
}

// ── Sub-agents ──────────────────────────────────────────────────────────
// Written once in `host_commands::subagents`.

#[tauri::command]
pub async fn agent_subagent_list(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
) -> Result<Vec<crate::agent_runtime::subagents::record::TaskSnapshot>, String> {
    subagents::list(state.inner().clone(), parent_thread_id).await
}

#[tauri::command]
pub async fn agent_subagent_load(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
    agent_id: String,
) -> Result<Vec<ConversationMessage>, String> {
    subagents::load(state.inner().clone(), parent_thread_id, agent_id).await
}

#[tauri::command]
pub async fn agent_subagent_pending(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
) -> Result<Vec<crate::agent_runtime::subagents::outbox::PendingWake>, String> {
    Ok(subagents::pending(&state, &parent_thread_id))
}

#[tauri::command]
pub async fn agent_subagent_claim(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
    wake_id: u64,
) -> Result<bool, String> {
    Ok(subagents::claim(&state, &parent_thread_id, wake_id))
}

#[tauri::command]
pub async fn agent_subagent_rail_get(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
) -> Result<crate::agent_runtime::subagents::rail_state::RailState, String> {
    subagents::rail_get(state.inner().clone(), parent_thread_id).await
}

#[tauri::command]
pub async fn agent_subagent_rail_set(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
    pinned: Vec<String>,
    expanded: Vec<String>,
) -> Result<crate::agent_runtime::subagents::rail_state::RailState, String> {
    subagents::rail_set(state.inner().clone(), parent_thread_id, pinned, expanded).await
}

#[tauri::command]
pub async fn agent_subagent_kill(
    state: State<'_, Arc<AgentRegistry>>,
    agent_id: String,
) -> Result<bool, String> {
    Ok(subagents::kill(&state, &agent_id))
}
