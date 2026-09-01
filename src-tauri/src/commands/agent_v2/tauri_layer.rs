use super::*;
use tauri::{AppHandle, Emitter, State};

/// Production [`EventEmitter`] backed by Tauri's per-app
/// `AppHandle::emit`. Constructed fresh per command invocation —
/// `AppHandle` is `Clone` and cheap.
pub struct TauriEmitter {
    pub app: AppHandle,
}

impl EventEmitter for TauriEmitter {
    fn emit_event(&self, envelope: &AgentEventEnvelope) {
        // Channel name is hardcoded — the frontend hardcodes the
        // matching literal in Phase 2.3, and we deliberately don't
        // share a `const` so the contract is explicit at both ends.
        let _ = self.app.emit("agent_event", envelope);

        // A turn dispatched from `aurora agent` is also being watched in a
        // terminal, so the same events are appended to its transcript. Guarded
        // by `is_active` because this runs per streamed token and the common
        // case — no CLI task anywhere — must cost one atomic check, not a hash
        // lookup. See `cli_delegate::mirror`.
        if crate::cli_delegate::mirror::is_active() {
            crate::cli_delegate::mirror::record(&envelope.turn_id, &envelope.event);
        }
    }

    fn emit_turn_complete(&self, turn_id: &str, summary: &TurnCompletion) {
        let _ = self.app.emit("agent_turn_complete", summary);
        // Closes the transcript with its `result` line. A follower in a
        // terminal stops on that line and nothing else, so a turn that ended
        // without reaching here would leave `aurora agent --follow` waiting on
        // a file that never grows again.
        crate::cli_delegate::mirror::finish(
            turn_id,
            crate::cli_delegate::mirror::Outcome::Complete(summary),
        );
    }

    fn emit_turn_error(&self, turn_id: &str, error: &str, recovery_hint: Option<RecoveryHint>) {
        // Phase 4: payload extended with the optional camelCase
        // `recoveryHint` field. The frontend `TurnErrorPayload`
        // already accepts both `turnId` and `turn_id` defensively;
        // the camelCase rename here aligns this struct with the
        // rest of the Phase 2.3 IPC surface that already uses
        // `#[serde(rename_all = "camelCase")]`.
        #[derive(serde::Serialize, Clone)]
        #[serde(rename_all = "camelCase")]
        struct ErrorPayload<'a> {
            turn_id: &'a str,
            error: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            recovery_hint: Option<RecoveryHint>,
        }
        let _ = self.app.emit(
            "agent_turn_error",
            ErrorPayload {
                turn_id,
                error,
                recovery_hint,
            },
        );
        // The other way a turn can end. Cancellation arrives here too, as the
        // literal "cancelled"; the transcript tells the two apart, because a
        // task the user stopped did not fail.
        crate::cli_delegate::mirror::finish(
            turn_id,
            crate::cli_delegate::mirror::Outcome::Failed(error),
        );
    }

    fn emit_tool_pending(&self, request: &ToolBridgeRequest) {
        // Wire-channel: `"agent_tool_pending"`. Sub-B listens with
        // `listen<ToolBridgeRequest>("agent_tool_pending", …)`. The
        // payload is the camelCased ToolBridgeRequest verbatim
        // (turnId, toolUseId, name, input).
        let _ = self.app.emit("agent_tool_pending", request);
    }
}

/// Drive one agent turn end-to-end. Streams events on the
/// `"agent_event"` channel and a single closing
/// `"agent_turn_complete"` or `"agent_turn_error"` event.
///
/// Returns `Ok(())` on a clean stop (the [`TurnCompletion`]
/// summary is delivered out-of-band via the `agent_turn_complete`
/// event so the frontend's promise resolution path stays uniform
/// with the streaming events).
#[tauri::command]
pub async fn agent_chat_v2(
    state: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
    request: AgentChatRequest,
) -> Result<(), String> {
    let driver = TurnDriver::new(state.inner().clone(), Arc::new(TauriEmitter { app }));
    driver
        .run_turn(request)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_compact_thread(
    state: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
    request: AgentChatRequest,
) -> Result<Option<(u32, u32)>, String> {
    let driver = TurnDriver::new(state.inner().clone(), Arc::new(TauriEmitter { app }));
    driver
        .compact_thread(request)
        .await
        .map_err(|e| e.to_string())
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

/// Load (or initialize) a thread's session and return its message
/// history. The frontend calls this on thread-switch to render the
/// existing transcript before any new turn begins.
#[tauri::command]
pub async fn agent_load_thread(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
) -> Result<Vec<ConversationMessage>, String> {
    let session = state
        .load_or_create_session(&thread_id)
        .map_err(|e| e.to_string())?;
    let guard = session.lock().await;
    Ok(guard.messages().to_vec())
}

/// Rewind a thread's session to just before its `userMessageOrdinal`-th
/// user message (0-indexed), dropping that message and everything after.
///
/// This is the server half of Retry. The frontend trims its own
/// transcript to the same point and then re-sends the user message, so
/// the retried turn REPLACES the failed one instead of stacking after
/// it. Without this the model would see the dead turn plus a duplicate
/// of the user's message, and the provider's prompt cache would miss.
///
/// Returns how many runtime messages were dropped. A refusal to
/// truncate mid-turn is deliberate: rewinding history under a running
/// turn would corrupt the message list it is actively appending to.
#[tauri::command]
pub async fn agent_rewind_to_user_message(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    user_message_ordinal: usize,
) -> Result<usize, String> {
    let session = state
        .load_or_create_session(&thread_id)
        .map_err(|e| e.to_string())?;
    // A running turn holds this mutex for its entire duration, so a
    // failed `try_lock` IS "the thread is still streaming". Awaiting the
    // lock instead would silently rewind history the moment the turn
    // finished — destroying the reply the user was waiting for.
    let mut guard = session
        .try_lock()
        .map_err(|_| "This thread is still running. Stop it before retrying.".to_string())?;
    let removed = guard.truncate_before_user_message(user_message_ordinal);
    if removed > 0 {
        // Rewrite the JSONL so a reload (or the next turn) sees the
        // rewound history. `save_to_path` truncates the file, unlike
        // the append path used during a turn.
        guard
            .save_to_path(state.session_path(&thread_id))
            .map_err(|e| e.to_string())?;
    }
    Ok(removed)
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

/// Enqueue a user message to ride in on the next tool-result the
/// agent receives. Single-slot per thread: a second call replaces
/// the previously queued text. Returns immediately — the actual
/// injection is event-driven (`QueuedMessageInjected`) and happens
/// the next time the conversation loop drains a tool batch.
#[tauri::command]
pub async fn agent_enqueue_message(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    text: String,
    display_text: Option<String>,
    chips: Option<Vec<crate::agent_runtime::types::AttachedPromptChip>>,
) -> Result<(), String> {
    state
        .enqueue_message(&thread_id, text, display_text, chips)
        .await
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
