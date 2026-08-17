//! Agent runtime IPC — `TurnDriver` — the testable core of one `agent_chat_v2` invocation, plus
//! the per-turn runtime config it is built from.
//!
//! Split out of `agent_v2.rs` verbatim; see `mod.rs` for the map.

use super::*;

// ============================================================================
// TurnDriver — the testable core of one agent_chat_v2 invocation
// ============================================================================

/// One-shot driver for a single agent turn, bound to a registry and an
/// emitter. Cheap to construct — internals are `Arc`s — so each Tauri
/// command instantiates a fresh `TurnDriver` per call.
///
/// Lifecycle, in order (Phase 2.3):
///
/// 1. Resolve the session via [`AgentRegistry::load_or_create_session`].
/// 2. Build the API client via the registry's [`ApiFactory`], passing
///    the full [`crate::api::ProviderConfigSnapshot`] from the request.
///    A factory error short-circuits — no events emitted, no user
///    message persisted, no `in_flight` entry left dangling.
/// 3. Build a per-turn [`ToolRegistry`] populated with one
///    [`FrontendBridgeExecutor`] per [`AllowedTool`] in
///    `request.tools`, layered on top of the registry-level base
///    catalogue (empty in Phase 2.3, populated in Phase 3 with native
///    Rust executors that may shadow specific bridge entries).
/// 4. Construct a [`ConversationRuntime`] with the per-turn
///    [`RuntimeConfig`] overlaying `system_prompt`, `temperature`,
///    `max_output_tokens`, `thinking_enabled`, and `ide_context` from
///    the request.
/// 5. Build the user [`ConversationMessage`] from `request.user_message`
///    verbatim — IDE-context wrapping happens inside the runtime per
///    API call, leaving the persisted JSONL bubble clean.
/// 6. Generate a per-turn [`CancellationToken`] and register it in
///    `in_flight` keyed by `request.turn_id`.
/// 7. Spawn a forwarder task that drains [`AgentEventEnvelope`]s out of
///    the runtime's mpsc channel and into [`EventEmitter::emit_event`].
/// 8. Acquire the session's `Mutex<Session>` (a `tokio::sync::Mutex` —
///    held across `.await`), call `runtime.run_turn(…)` to completion or
///    error, then release.
/// 9. Persist the entire post-turn session via [`Session::save_to_path`]
///    in a `finally`-style block (success OR error path, both write).
///    Atomic-rename keeps partial writes off disk.
/// 10. `unregister_in_flight(turn_id)` and `bridge_router.drop_turn(turn_id)`
///     to reclaim any leftover oneshot senders.
/// 11. On `Ok`: emit `agent_turn_complete`. On `Err`: emit
///     `agent_turn_error` with the rendered error (cancellations
///     surface as the literal `"cancelled"`).
pub struct TurnDriver<E: EventEmitter> {
    registry: Arc<AgentRegistry>,
    emitter: Arc<E>,
}

impl<E: EventEmitter> TurnDriver<E> {
    #[must_use]
    pub fn new(registry: Arc<AgentRegistry>, emitter: Arc<E>) -> Self {
        Self { registry, emitter }
    }

    pub async fn compact_thread(
        &self,
        request: AgentChatRequest,
    ) -> Result<Option<(u32, u32)>, RuntimeError> {
        let turn_id = request.turn_id.clone();
        let thread_id = request.thread_id.clone();

        let session_arc = self.registry.load_or_create_session(&thread_id)?;
        let api_client = self
            .registry
            .api_factory()
            .build(&request.provider_config)?;
        let cancel_token = CancellationToken::new();
        self.registry
            .register_in_flight(turn_id.clone(), cancel_token.clone());

        let runtime = with_compaction_model(
            ConversationRuntime::new(
                api_client,
                Arc::new(build_per_turn_tool_registry(
                    self.registry.tools(),
                    &[],
                    turn_id.clone(),
                    self.registry.bridge_router().clone(),
                    self.emitter.clone() as Arc<dyn BridgeEmitter>,
                    cancel_token.clone(),
                    request.provider_config.supports_vision,
                    request.execution_mode,
                    request.workspace_path.as_deref(),
                    request.transcript_chapters.unwrap_or(false),
                    request.browser_tools.unwrap_or(true),
                    request.defer_tools.unwrap_or(false),
                )),
                build_runtime_config(&request),
            )
            // Oversized tool output lands beside the thread rather than being
            // clamped away, so the model can read the part it needs back.
            .with_store_dir(self.registry.store().dir()),
            &self.registry,
            &request,
        )?;

        let (event_tx, mut event_rx) = mpsc::channel::<AgentEventEnvelope>(64);
        let emitter_for_task = self.emitter.clone();
        let forwarder = tokio::spawn(async move {
            while let Some(envelope) = event_rx.recv().await {
                emitter_for_task.emit_event(&envelope);
            }
        });

        let session_path = self.registry.session_path(&thread_id);
        let result = {
            let mut session = session_arc.lock().await;
            if session.workspace_root.is_none() {
                if let Some(ws) = &request.workspace_path {
                    session.workspace_root = Some(ws.clone());
                }
            }
            session.model = Some(format!("{}:{}", request.provider_id, request.model));

            let mut seq = 0;
            runtime
                .compact_now(&mut session, &turn_id, &mut seq, &event_tx, &cancel_token)
                .await
        };
        drop(event_tx);
        let _ = forwarder.await;

        {
            let session = session_arc.lock().await;
            if let Err(persist_err) = session.save_to_path(&session_path) {
                eprintln!(
                    "agent_v2: failed to persist compacted session for thread {thread_id}: {persist_err}"
                );
            }
        }

        let store = self.registry.store();
        let _ = store.ensure_thread(&thread_id, None, request.workspace_path.clone());
        let _ = store.set_workspace_and_model(
            &thread_id,
            request.workspace_path.clone(),
            Some(format!("{}:{}", request.provider_id, request.model)),
        );

        self.registry.unregister_in_flight(&turn_id);
        self.registry.bridge_router().drop_turn(&turn_id);

        Ok(result)
    }

    /// Drive one turn end-to-end. See [`TurnDriver`] for the full
    /// lifecycle.
    pub async fn run_turn(
        &self,
        request: AgentChatRequest,
    ) -> Result<TurnCompletion, RuntimeError> {
        let turn_id = request.turn_id.clone();
        let thread_id = request.thread_id.clone();

        // 1. Resolve the session (cache → disk → fresh).
        let session_arc = self.registry.load_or_create_session(&thread_id)?;

        // 2. Build the API client BEFORE registering the cancel token —
        //    if the factory fails we don't want a stale `in_flight`
        //    entry hanging around for a turn that never started. The
        //    full ProviderConfigSnapshot is passed verbatim; the
        //    adapter is the only code that interprets the inner fields
        //    (api_key, base_url, custom_headers, custom_params, …).
        let api_client = self
            .registry
            .api_factory()
            .build(&request.provider_config)?;

        // 6. (out of order — token built first so the bridge executor
        //    can hold it). Per-turn cancellation token, registered for
        //    agent_cancel.
        let cancel_token = CancellationToken::new();
        self.registry
            .register_in_flight(turn_id.clone(), cancel_token.clone());

        // 3. Build the per-turn ToolRegistry. Start with the
        //    registry-level base (empty in Phase 2.3) and overlay one
        //    FrontendBridgeExecutor per AllowedTool. Re-registering an
        //    existing name overwrites — Phase 3 will use this to let
        //    native Rust tools shadow specific bridge entries.
        let per_turn_tools = build_per_turn_tool_registry(
            self.registry.tools(),
            &request.tools,
            turn_id.clone(),
            self.registry.bridge_router().clone(),
            self.emitter.clone() as Arc<dyn BridgeEmitter>,
            cancel_token.clone(),
            request.provider_config.supports_vision,
            request.execution_mode,
            request.workspace_path.as_deref(),
            request.transcript_chapters.unwrap_or(false),
            request.browser_tools.unwrap_or(true),
            request.defer_tools.unwrap_or(false),
        );

        // 4. Construct the runtime with a fresh RuntimeConfig overlaying
        //    every per-turn override the request carries.
        let runtime = with_compaction_model(
            ConversationRuntime::new(
                api_client,
                Arc::new(per_turn_tools),
                build_runtime_config(&request),
            )
            // Oversized tool output lands beside the thread rather than being
            // clamped away, so the model can read the part it needs back.
            .with_store_dir(self.registry.store().dir()),
            &self.registry,
            &request,
        )?;

        // 5. Wrap the raw user message string into a Text-block
        //    ConversationMessage. The runtime appends it to the session
        //    itself, so we don't pre-append. The IDE context is wired
        //    through RuntimeConfig::ide_context — the runtime wraps it
        //    around the API view of the message only, leaving the
        //    persisted JSONL clean.
        let mut user_message = ConversationMessage::user_text(
            request.user_message.clone(),
            Utc::now().timestamp_millis(),
        );
        // Attach browser-inspector element chips so they persist into the
        // session JSONL as a permanent part of this turn (re-rendered above
        // the user bubble on thread reopen). Empty vecs collapse to None so
        // the field stays absent from the serialized line.
        user_message.attached_selected_elements = request
            .attached_selected_elements
            .clone()
            .filter(|v| !v.is_empty());
        user_message.attached_prompt_chips = request
            .attached_prompt_chips
            .clone()
            .filter(|v| !v.is_empty());

        // 5b. Durability for a brand-new chat: persist the user message to the
        //     JSONL *now*, before the (potentially long) agent loop runs. The
        //     full session is otherwise only flushed at turn END
        //     (`save_to_path` below), so until then a fresh draft has an empty
        //     `.jsonl` (messageCount 0) — invisible to `thread_list_summaries`
        //     and therefore unreachable if the user navigates away mid-turn.
        //     Writing message #1 up front makes the thread real on disk
        //     immediately: it lists, it survives a mid-turn reload/crash, and
        //     the rail can route back to it. Scoped to genuinely fresh threads
        //     (empty log) so existing chats keep their untouched hot path; the
        //     post-turn full `save_to_path` reconciles the line either way, so
        //     there is never a duplicate on the success path.
        {
            let store = self.registry.store();
            let _ = store.ensure_thread(&thread_id, None, request.workspace_path.clone());
            let early_path = self.registry.session_path(&thread_id);
            let is_fresh = std::fs::metadata(&early_path)
                .map(|m| m.len() == 0)
                .unwrap_or(true);
            if is_fresh {
                if let Err(e) = Session::append_to_path(&early_path, &user_message) {
                    eprintln!(
                        "agent_v2: early user-message persist failed for thread {thread_id}: {e}"
                    );
                }
            }
        }

        // 7. Bounded channel + forwarder task. The forwarder exits when
        //    the runtime drops the sender (i.e. when run_turn returns).
        let (event_tx, mut event_rx) = mpsc::channel::<AgentEventEnvelope>(64);
        let emitter_for_task = self.emitter.clone();
        let forwarder = tokio::spawn(async move {
            while let Some(envelope) = event_rx.recv().await {
                emitter_for_task.emit_event(&envelope);
            }
        });

        // 8. Hold the session lock for the entire turn so concurrent
        //    chat calls on the same thread_id serialize. Different
        //    thread_ids get different Arcs and therefore different
        //    locks — they run in parallel.
        let session_path = self.registry.session_path(&thread_id);
        let (result, turn_appended) = {
            let mut session = session_arc.lock().await;

            // Per-turn metadata applied inside the lock so the runtime
            // sees consistent values.
            if session.workspace_root.is_none() {
                if let Some(ws) = &request.workspace_path {
                    session.workspace_root = Some(ws.clone());
                }
            }
            // The active model MUST track the current request every turn.
            // `conversation.rs` sends `session.model` to the provider, while
            // the provider endpoint + API key come from THIS request's
            // provider_config. Pinning the model on the first turn only meant
            // a mid-thread model switch sent the OLD model id to the NEW
            // provider's endpoint — e.g. a Fireworks model id posted to the
            // DeepSeek endpoint → HTTP 400 "supported API model names are …".
            // Updating every turn keeps model + provider consistent, and the
            // thread's persisted model reflects the one actually in use.
            session.model = Some(format!("{}:{}", request.provider_id, request.model));

            // Snapshot the message count before the runtime runs so we
            // can detect whether this turn actually appended anything
            // (used below to decide whether to refresh metadata —
            // turns that errored before the user message landed
            // shouldn't bump `updated_at`). Doing it under the same
            // lock guarantees we see the runtime's writes atomically.
            let prior_len = session.messages().len();

            let outcome = runtime
                .run_turn_with_id(
                    turn_id.clone(),
                    &mut session,
                    user_message,
                    event_tx,
                    cancel_token,
                )
                .await;

            let appended = session.messages().len() > prior_len;
            (outcome, appended)
        };

        // The forwarder ends as soon as the runtime drops its event
        // sender (inside run_turn's return path). Awaiting here makes
        // the test ordering deterministic — by the time we reach the
        // emit_turn_* call, every per-envelope emit_event has fired.
        let _ = forwarder.await;

        // 9. Persist the post-turn session unconditionally. Both Ok and
        //    Err paths write so a turn that errored after partial
        //    progress (e.g. one tool call worth of state) still leaves
        //    the disk log up to date with what the in-memory session
        //    holds. Save errors are logged but never returned — the
        //    user-visible error is whatever `result` already carries.
        {
            let session = session_arc.lock().await;
            if let Err(persist_err) = session.save_to_path(&session_path) {
                eprintln!(
                    "agent_v2: failed to persist session for thread {thread_id}: {persist_err}"
                );
            }
            // Full-fidelity edit results accumulated this turn ride the
            // `.rich.jsonl` sidecar so a reloaded thread renders complete
            // diffs. Best-effort: losing them degrades one turn's reload
            // view to the clamped copy, never the conversation itself.
            let rich = session.drain_rich_results();
            if !rich.is_empty() {
                if let Err(rich_err) = self.registry.store().append_rich_results(&thread_id, &rich)
                {
                    eprintln!(
                        "agent_v2: failed to persist rich tool results for thread {thread_id}: {rich_err}"
                    );
                }
            }
        }

        // 9b. Refresh the metadata sidecar so the chat list reflects
        //     the activity. `SessionStore` is the single source of
        //     truth for `title` / `tokenUsage` / `contextUsage` /
        //     `updatedAt` / `model` / `workspaceRoot`. Auto-titling
        //     from the first user message and per-turn usage updates
        //     happen in the dedicated `thread_*` Tauri commands the
        //     frontend already calls; here we just make sure the
        //     thread row exists, capture the workspace + model, and
        //     bump `updatedAt` so the modal re-orders the thread to
        //     the top after every turn.
        //
        //     Skipped when the runtime didn't append anything (factory
        //     failure, immediate cancel) so a zero-progress turn
        //     doesn't pollute the chat list with a fresh "New Chat"
        //     row.
        if turn_appended {
            let store = self.registry.store();
            let _ = store.ensure_thread(&thread_id, None, request.workspace_path.clone());
            let _ = store.set_workspace_and_model(
                &thread_id,
                request.workspace_path.clone(),
                Some(format!("{}:{}", request.provider_id, request.model)),
            );
            // Auto-title from the first user message: derive a clean
            // chat-list label by stripping markdown fences, JSON
            // blobs, and decorative noise. Only fires when the
            // sidecar still carries the bootstrap "New Chat" title —
            // user-renamed threads are left alone.
            let needs_auto_title = store
                .load_metadata(&thread_id)
                .map(|m| m.title == "New Chat")
                .unwrap_or(false);
            if needs_auto_title {
                let derived =
                    crate::agent_runtime::title::derive_thread_title(&request.user_message);
                if !derived.is_empty() && derived != "New Chat" {
                    let _ = store.set_title(&thread_id, derived);
                }
            }
            let _ = store.touch(&thread_id);
        }

        // 10. Always unregister so a future cancel(same_turn_id) returns
        //     false — turn_ids are single-use by contract. Defensive
        //     drop_turn reclaims any oneshots the bridge executor's own
        //     guard didn't catch (e.g. an abnormal panic).
        self.registry.unregister_in_flight(&turn_id);
        self.registry.bridge_router().drop_turn(&turn_id);

        // 11. Closing event. Cancellations get an error event with the
        //     literal "cancelled" so the frontend has ONE observable
        //     signal that the turn is over without success.
        match result {
            Ok(summary) => {
                self.emitter.emit_turn_complete(&turn_id, &summary);
                Ok(summary)
            }
            Err(err) => {
                let payload = if err.is_cancellation() {
                    "cancelled".to_string()
                } else {
                    err.to_string()
                };
                // Phase 4: classify the error string into a recovery
                // hint. `classify_error` returns `None` when no
                // confident match is found, in which case the wire
                // payload omits the `recoveryHint` field — same shape
                // Phase 2.3 shipped, just optionally enriched.
                let hint = classify_error(&payload);
                self.emitter.emit_turn_error(&turn_id, &payload, hint);
                Err(err)
            }
        }
    }
}

/// Compose `RuntimeConfig` from the request's per-turn overrides.
///
/// The defaults (max_iterations: None, default_max_output_tokens:
/// 8192, thinking_enabled: false, default_temperature: None) come
/// from `RuntimeConfig::default()`; this helper overlays whatever
/// the frontend explicitly sent.
/// Point the runtime's summarization call at the user's pinned compaction
/// model, when there is one (Settings → Agent → Compaction model).
///
/// A no-op when the request carries no override, which is the default and
/// leaves the summary running on the conversation's own model. Built through
/// the same [`ApiFactory`] as the chat client so a pinned provider gets its own
/// key, base URL and wire shape; a factory error surfaces here rather than
/// half-way through a turn.
pub(super) fn with_compaction_model(
    runtime: ConversationRuntime,
    registry: &AgentRegistry,
    request: &AgentChatRequest,
) -> Result<ConversationRuntime, RuntimeError> {
    let Some(cfg) = request.compaction_provider_config.as_ref() else {
        return Ok(runtime);
    };
    let client = registry.api_factory().build(cfg)?;
    // The marker's cost attribution reads this string, and the cost card keys
    // its per-model grouping on the same `providerId:modelKey` shape the
    // frontend sends for the chat model.
    Ok(runtime.with_compaction_client(client, format!("{}:{}", cfg.provider_id, cfg.model)))
}

pub(super) fn build_runtime_config(request: &AgentChatRequest) -> RuntimeConfig {
    let defaults = RuntimeConfig::default();
    RuntimeConfig {
        max_iterations: defaults.max_iterations,
        system_prompt: request.system_prompt.clone(),
        default_max_output_tokens: request
            .max_output_tokens
            .unwrap_or(defaults.default_max_output_tokens),
        thinking_enabled: request
            .thinking_enabled
            .unwrap_or(defaults.thinking_enabled),
        // A budget of 0 is the frontend's "no explicit budget" encoding for a
        // model whose reasoning control isn't a budget — treat it as absent so
        // the adapter falls back to its effort-derived default.
        thinking_budget_tokens: request.thinking_budget_tokens.filter(|b| *b > 0),
        default_temperature: request.temperature.or(defaults.default_temperature),
        ide_context: request.ide_context.clone(),
        // Budget-aware trim engages only when the frontend supplies the
        // active provider's window. `None` keeps the legacy "send the
        // whole session every turn" behaviour, so callers that don't
        // know their window (e.g. test mocks) are unaffected.
        context_window: request.context_window.or(defaults.context_window),
        // Compaction: the frontend sends a percentage (50–95); the runtime
        // works in fractions. `0`/absent disables it (trim-only).
        compaction_threshold: request
            .compaction_threshold_pct
            .filter(|p| *p > 0.0)
            .map(|p| (p / 100.0).clamp(0.0, 1.0)),
        compaction_summary_budget: request
            .compaction_summary_budget
            .unwrap_or(defaults.compaction_summary_budget),
        allow_outside_workspace: request.allow_outside_workspace.unwrap_or(false),
        // Read from the SAME provider type the API factory dispatches on, so
        // the token estimate prices a stored reasoning block exactly as the
        // request builder will treat it: dropped, replayed as text, or
        // replayed as an opaque encrypted item.
        reasoning_replay: crate::api::reasoning_replay_for(
            request.provider_config.effective_provider_type(),
        ),
    }
}
