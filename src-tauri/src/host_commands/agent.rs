//! The conversation commands: start, compact, stop and follow a turn, read
//! and rewind a thread, queue a message. The window's `#[tauri::command]`s
//! (`commands/agent_v2/tauri_layer.rs`) and the HTTP registry both call these.

use std::sync::Arc;

use crate::agent_runtime::host::{AgentRegistry, EventEmitter, TurnDriver};
use crate::agent_runtime::ipc::AgentChatRequest;
use crate::agent_runtime::types::{AgentReportMeta, AttachedPromptChip, ConversationMessage};

/// Drive one agent turn end-to-end. Streams events on the `"agent_event"`
/// channel and a single closing `"agent_turn_complete"` or
/// `"agent_turn_error"` event.
///
/// Returns `Ok(())` on a clean stop (the summary is delivered out-of-band
/// via `agent_turn_complete`, so the client's promise resolution path stays
/// uniform with the streaming events).
pub async fn chat<E: EventEmitter>(
    registry: Arc<AgentRegistry>,
    emitter: Arc<E>,
    request: AgentChatRequest,
) -> Result<(), String> {
    TurnDriver::new(registry, emitter)
        .run_turn(request)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub async fn compact_thread<E: EventEmitter>(
    registry: Arc<AgentRegistry>,
    emitter: Arc<E>,
    request: AgentChatRequest,
) -> Result<Option<(u32, u32)>, String> {
    TurnDriver::new(registry, emitter)
        .compact_thread(request)
        .await
        .map_err(|e| e.to_string())
}

/// Load (or initialize) a thread's session and return its message history.
/// A client calls this on thread-switch to render the existing transcript
/// before any new turn begins.
pub async fn load_thread(
    registry: Arc<AgentRegistry>,
    thread_id: String,
) -> Result<Vec<ConversationMessage>, String> {
    let loaded = tokio::task::spawn_blocking(move || {
        let Some(store) = registry
            .store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok::<_, String>(None);
        };
        registry
            .load_session_from_store(&thread_id, &store)
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

/// Rewind a thread's session to just before its `user_message_ordinal`-th
/// user message (0-indexed), dropping that message and everything after.
///
/// This is the server half of Retry. The client trims its own transcript to
/// the same point and then re-sends the user message, so the retried turn
/// REPLACES the failed one instead of stacking after it. Without this the
/// model would see the dead turn plus a duplicate of the user's message, and
/// the provider's prompt cache would miss.
///
/// Returns how many runtime messages were dropped. A refusal to truncate
/// mid-turn is deliberate: rewinding history under a running turn would
/// corrupt the message list it is actively appending to.
pub fn rewind_to_user_message(
    registry: &AgentRegistry,
    thread_id: &str,
    user_message_ordinal: usize,
) -> Result<usize, String> {
    let store = registry
        .require_store_for_thread(thread_id)
        .map_err(|e| e.to_string())?;
    let session = registry
        .load_session_from_store(thread_id, &store)
        .map_err(|e| e.to_string())?;
    // A running turn holds this mutex for its entire duration, so a failed
    // `try_lock` IS "the thread is still streaming". Awaiting the lock
    // instead would silently rewind history the moment the turn finished —
    // destroying the reply the user was waiting for.
    let mut guard = session
        .try_lock()
        .map_err(|_| "This thread is still running. Stop it before retrying.".to_string())?;
    let removed = guard.truncate_before_user_message(user_message_ordinal);
    if removed > 0 {
        // Rewrite the JSONL so a reload (or the next turn) sees the rewound
        // history. `save_to_path` truncates the file, unlike the append path
        // used during a turn.
        guard
            .save_to_path(store.session_path(thread_id))
            .map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

/// Enqueue a user message to ride in on the next tool-result the agent
/// receives. Single-slot per thread: a second call replaces the previously
/// queued text. Returns immediately — the injection is event-driven
/// (`QueuedMessageInjected`) and happens the next time the conversation loop
/// drains a tool batch.
///
/// `origin`: "user" (the default), "process", or "subagent". Decides the
/// model-facing framing and which row the transcript draws — a background
/// process ending or an agent's report must not arrive wearing the user's
/// voice. `agent` is the agent a "subagent" report is about; ignored for
/// other origins.
pub fn enqueue_message(
    registry: &AgentRegistry,
    thread_id: &str,
    text: String,
    display_text: Option<String>,
    chips: Option<Vec<AttachedPromptChip>>,
    origin: Option<&str>,
    agent: Option<AgentReportMeta>,
) -> Result<(), String> {
    use crate::agent_runtime::types::InjectedOrigin;
    // An unrecognised value falls back to `User`, which is the conservative
    // end: it renders as a message and is framed as one. Silently promoting an
    // unknown string to a machine event would let a typo strip a person's words
    // of their attribution.
    let origin = match origin {
        Some("process") => InjectedOrigin::Process,
        Some("subagent") => InjectedOrigin::Subagent,
        _ => InjectedOrigin::User,
    };
    let agent = agent.filter(|_| origin == InjectedOrigin::Subagent);
    registry.enqueue_with_agent(thread_id, text, display_text, chips, origin, agent)
}
