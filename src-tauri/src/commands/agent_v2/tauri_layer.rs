use super::*;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

use crate::agent_runtime::event_batch::{Coalescer, FLUSH_INTERVAL};

/// Production [`EventEmitter`] backed by Tauri's per-app
/// `AppHandle::emit`. Constructed fresh per command invocation —
/// `AppHandle` is `Clone` and cheap.
pub struct TauriEmitter {
    pub app: AppHandle,
}

impl EventEmitter for TauriEmitter {
    fn emit_event(&self, envelope: &AgentEventEnvelope) {
        // A turn dispatched from `aurora agent` is also being watched in a
        // terminal, so the same events are appended to its transcript. Guarded
        // by `is_active` because this runs per streamed token and the common
        // case — no CLI task anywhere — must cost one atomic check, not a hash
        // lookup. See `cli_delegate::mirror`. Fed the raw event, before
        // batching: the transcript is a record, not a frame rate.
        if crate::cli_delegate::mirror::is_active() {
            crate::cli_delegate::mirror::record(&envelope.turn_id, &envelope.event);
        }

        // Token deltas are held and merged per turn, then released at most
        // every `FLUSH_INTERVAL` (`agent_runtime::event_batch`): one webview
        // evaluation per frame per streaming turn, not one per token. Emitted
        // under the lock so a timer's release and a push's release of the
        // same turn cannot cross.
        let arm_timer = {
            let Ok(mut coalescer) = EVENT_BATCH.lock() else {
                emit_agent_event(&self.app, envelope);
                return;
            };
            let pushed = coalescer.push(envelope, Instant::now());
            for ready in &pushed.emit {
                emit_agent_event(&self.app, ready);
            }
            pushed.arm_timer
        };
        if arm_timer {
            let app = self.app.clone();
            let turn_id = envelope.turn_id.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(FLUSH_INTERVAL).await;
                flush_agent_events(&app, &turn_id);
            });
        }
    }

    fn emit_thread_changed(&self, change: &crate::agent_runtime::host::ThreadChanged) {
        let _ = self
            .app
            .emit(crate::agent_runtime::host::THREAD_CHANGED_EVENT, change);
    }

    fn emit_turn_complete(&self, turn_id: &str, summary: &TurnCompletion) {
        flush_agent_events(&self.app, turn_id);
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
        flush_agent_events(&self.app, turn_id);
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

    fn emit_subagent(&self, event: &crate::agent_runtime::subagents::SubagentEvent) {
        use crate::agent_runtime::subagents::SubagentEvent;
        // A handful per task, so each one is worth a log line: when the window
        // shows a stale agent list this is the half of the story Rust can tell.
        let (kind, agent_id) = match event {
            SubagentEvent::Started { agent_id, .. } => ("started", agent_id.as_str()),
            SubagentEvent::Finished { agent_id, .. } => ("finished", agent_id.as_str()),
            SubagentEvent::Message { agent_id, .. } => ("message", agent_id.as_str()),
            SubagentEvent::Report { agent_id, .. } => ("report", agent_id.as_str()),
        };
        match self.app.emit(
            crate::agent_runtime::subagents::events::SUBAGENT_EVENT_CHANNEL,
            stamp_emitted_at(event),
        ) {
            Ok(()) => crate::logging::log_info(
                "subagents.events",
                &format!("emitted {kind} for {agent_id}"),
            ),
            Err(err) => crate::logging::log_warn(
                "subagents.events",
                &format!("failed to emit {kind} for {agent_id}: {err}"),
            ),
        }
    }
}

/// A lifecycle event with `emittedAtMs` beside its own fields, so the window
/// can measure how long the event channel took to deliver it. On 2026-10-08
/// four `report` events were emitted on time and processed 58 s later; the
/// two log lines (`emitted …` here, `received … lag N ms` in the window) are
/// what showed it, and the stamp makes the lag a number instead of a diff of
/// two timestamps by hand.
fn stamp_emitted_at(event: &crate::agent_runtime::subagents::SubagentEvent) -> serde_json::Value {
    let mut value = serde_json::to_value(event).unwrap_or(serde_json::Value::Null);
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "emittedAtMs".to_string(),
            serde_json::Value::from(chrono::Utc::now().timestamp_millis()),
        );
    }
    value
}

/// The held token runs of every streaming turn. One for the process: the
/// emitter is built fresh per command, and a child's emitter wraps its
/// parent's, so the state cannot live on either.
static EVENT_BATCH: LazyLock<Mutex<Coalescer>> = LazyLock::new(|| Mutex::new(Coalescer::new()));

/// One `agent_event` across the wire, counted.
///
/// Channel name is hardcoded — the frontend hardcodes the matching literal
/// in Phase 2.3, and we deliberately don't share a `const` so the contract
/// is explicit at both ends.
fn emit_agent_event(app: &AppHandle, envelope: &AgentEventEnvelope) {
    let _ = app.emit("agent_event", envelope);
    note_agent_event_rate();
}

/// Release what the turn is holding. The timer's call, and the turn's
/// ending's: a turn must not end with a token still held.
fn flush_agent_events(app: &AppHandle, turn_id: &str) {
    let Ok(mut coalescer) = EVENT_BATCH.lock() else {
        return;
    };
    if let Some(ready) = coalescer.flush(turn_id) {
        emit_agent_event(app, &ready);
    }
}

/// Streamed `agent_event`s per second over which a log line is written.
///
/// Every emit is one main-thread script evaluation in the webview. Before
/// token deltas were batched (2026-10-09), every token of every running turn
/// was one emit: four sub-agents streaming at once held 400/s for two
/// minutes, peaking at 1,234/s, the window drew at a few frames per second,
/// and lifecycle events were delivered 34 s late. Batched, a streaming turn
/// is at most 25/s, so the line now marks a regression, not the weather.
const AGENT_EVENT_RATE_WARN_PER_SEC: u32 = 250;

/// `(second, count)` for the second currently being counted.
static AGENT_EVENT_RATE: std::sync::Mutex<(i64, u32)> = std::sync::Mutex::new((0, 0));

fn note_agent_event_rate() {
    let now = chrono::Utc::now().timestamp();
    let Ok(mut window) = AGENT_EVENT_RATE.lock() else {
        return;
    };
    if window.0 == now {
        window.1 += 1;
        return;
    }
    let (second, count) = *window;
    *window = (now, 1);
    if second != 0 && count > AGENT_EVENT_RATE_WARN_PER_SEC {
        crate::logging::log_warn(
            "agent_runtime.events",
            &format!("agent_event rate {count}/s: lifecycle events may be delivered late"),
        );
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

/// The conversation turns running now. A client that opens mid-turn (a
/// browser tab, the desktop window after a reload) follows these, since it
/// missed their `turn_start`.
#[tauri::command]
pub async fn agent_active_turns(
    state: State<'_, Arc<AgentRegistry>>,
) -> Result<Vec<crate::agent_runtime::host::ActiveTurn>, String> {
    Ok(state.active_conversation_turns())
}

/// Load (or initialize) a thread's session and return its message
/// history. The frontend calls this on thread-switch to render the
/// existing transcript before any new turn begins.
#[tauri::command]
pub async fn agent_load_thread(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
) -> Result<Vec<ConversationMessage>, String> {
    let registry = state.inner().clone();
    let loaded = tauri::async_runtime::spawn_blocking(move || {
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
    let store = state
        .require_store_for_thread(&thread_id)
        .map_err(|e| e.to_string())?;
    let session = state
        .load_session_from_store(&thread_id, &store)
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
            .save_to_path(store.session_path(&thread_id))
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
    // `origin`: "user" (the default), "process", or "subagent". Decides the
    // model-facing framing and which row the transcript draws — a background
    // process ending or an agent's report must not arrive wearing the user's
    // voice.
    origin: Option<String>,
    // The agent a "subagent" report is about. Ignored for other origins.
    agent: Option<crate::agent_runtime::types::AgentReportMeta>,
) -> Result<(), String> {
    use crate::agent_runtime::types::InjectedOrigin;
    // An unrecognised value falls back to `User`, which is the conservative
    // end: it renders as a message and is framed as one. Silently promoting an
    // unknown string to a machine event would let a typo strip a person's words
    // of their attribution.
    let origin = match origin.as_deref() {
        Some("process") => InjectedOrigin::Process,
        Some("subagent") => InjectedOrigin::Subagent,
        _ => InjectedOrigin::User,
    };
    let agent = agent.filter(|_| origin == InjectedOrigin::Subagent);
    state.enqueue_with_agent(&thread_id, text, display_text, chips, origin, agent)
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
