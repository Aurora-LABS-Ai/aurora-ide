use super::*;
use tauri::{AppHandle, State};

use crate::host_commands::agent;

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

/// Every sub-agent a conversation has started, oldest first: the files are
/// the list, the live records are the state of whichever are running now.
/// Empty for a conversation that never delegated.
#[tauri::command]
pub async fn agent_subagent_list(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
) -> Result<Vec<crate::agent_runtime::subagents::record::TaskSnapshot>, String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(store) = registry
            .store_for_thread(&parent_thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(Vec::new());
        };
        Ok(list_agents_for(&registry, &store, &parent_thread_id))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A sub-agent's transcript, for the read-only view in the Agents panel.
/// The same shape `agent_load_thread` returns for a conversation.
#[tauri::command]
pub async fn agent_subagent_load(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
    agent_id: String,
) -> Result<Vec<ConversationMessage>, String> {
    let registry = state.inner().clone();
    let loaded = tauri::async_runtime::spawn_blocking(move || {
        let Some(parent_store) = registry
            .store_for_thread(&parent_thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok::<_, String>(None);
        };
        let store = crate::agent_runtime::subagents::store::child_store_for(
            &parent_store,
            &parent_thread_id,
        );
        if !store.exists(&agent_id) {
            return Ok(None);
        }
        registry
            .load_session_from_store(&agent_id, &store)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let Some(session) = loaded else {
        return Ok(Vec::new());
    };
    let guard = session.lock().await;
    Ok(guard.messages().to_vec())
}

/// Sub-agent reports waiting to wake this conversation, oldest first. The
/// window reads this on its list poll as well as on the `report` event, so a
/// report reaches the parent within one poll even when the event channel is
/// backed up (2026-10-08: four reports, 58 s late). Cheap: in memory.
#[tauri::command]
pub async fn agent_subagent_pending(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
) -> Result<Vec<crate::agent_runtime::subagents::outbox::PendingWake>, String> {
    Ok(state.wake_outbox().pending(&parent_thread_id))
}

/// The window opened a turn carrying wake `wake_id`: take it out of the
/// outbox. `false` when it was already claimed, which tells a second claimant
/// (two drains racing for one idle moment) that the report is on its way and
/// must not be sent again.
#[tauri::command]
pub async fn agent_subagent_claim(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
    wake_id: u64,
) -> Result<bool, String> {
    let claimed = state.wake_outbox().claim(&parent_thread_id, wake_id);
    crate::logging::log_info(
        "subagents.events",
        &format!(
            "wake {wake_id} for {parent_thread_id} {}",
            if claimed.is_some() { "claimed" } else { "already claimed" }
        ),
    );
    Ok(claimed.is_some())
}

/// Which of a conversation's agent cards are pinned beside the icon rail, and
/// which are grown. Empty for a conversation that never pinned one, or one
/// that is not on disk.
#[tauri::command]
pub async fn agent_subagent_rail_get(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
) -> Result<crate::agent_runtime::subagents::rail_state::RailState, String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(store) = registry
            .store_for_thread(&parent_thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(Default::default());
        };
        crate::agent_runtime::subagents::rail_state::read(&store, &parent_thread_id)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save which agent cards are pinned and grown, and return what was stored
/// (repeats dropped, pins held to three). Fails for a conversation that is not
/// on disk rather than creating one.
#[tauri::command]
pub async fn agent_subagent_rail_set(
    state: State<'_, Arc<AgentRegistry>>,
    parent_thread_id: String,
    pinned: Vec<String>,
    expanded: Vec<String>,
) -> Result<crate::agent_runtime::subagents::rail_state::RailState, String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = registry
            .store_for_thread(&parent_thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                format!("conversation {parent_thread_id} does not exist; its pinned agents were not saved")
            })?;
        crate::agent_runtime::subagents::rail_state::write(
            &store,
            &parent_thread_id,
            crate::agent_runtime::subagents::rail_state::RailState { pinned, expanded },
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stop a running sub-agent. Returns whether it was running. Its transcript
/// and record stay; it can be resumed later with `send_message`.
#[tauri::command]
pub async fn agent_subagent_kill(
    state: State<'_, Arc<AgentRegistry>>,
    agent_id: String,
) -> Result<bool, String> {
    Ok(state
        .subagent_tasks()
        .get(&agent_id)
        // Only the window calls this, and only for a person's Stop: the
        // parent's own stops go through `stop_agent`.
        .is_some_and(|record| {
            record.kill(crate::agent_runtime::subagents::record::StopBy::User)
        }))
}
