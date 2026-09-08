//! Agent runtime IPC — `AgentRegistry` — the Tauri-managed owner of per-thread sessions,
//! in-flight turns, and the bridge router.
//!
//! Split out of `agent_v2.rs` verbatim; see `mod.rs` for the map.

use super::*;

// ============================================================================
// AgentRegistry — Tauri-managed state
// ============================================================================

/// Process-wide owner of per-thread sessions and per-turn cancellation
/// tokens.
///
/// The Tauri app stores this behind `tauri::State<'_, Arc<AgentRegistry>>`
/// (registered in `lib.rs::run_with_args` via `builder.manage(…)` during
/// the parent agent's integration step). All three Phase 2.2 commands
/// pull it out of state and delegate.
pub struct AgentRegistry {
    /// Sessions in memory keyed by `thread_id`. Lazily loaded on the
    /// first `agent_chat_v2` (or `agent_load_thread`) call for that
    /// thread. Subsequent calls hit the cache.
    sessions: DashMap<String, Arc<Mutex<Session>>>,

    /// Mid-turn queued-message slots keyed by `thread_id`. The
    /// `agent_enqueue_message` IPC writes here WITHOUT touching the
    /// session mutex (which is held for the entire turn by
    /// `run_turn`). The corresponding `Session` shares the same `Arc`
    /// — both ends point to the same `Option<QueuedUserMessage>`, so
    /// a write here is immediately visible to `take_queued_message`
    /// called from inside the running turn.
    queue_slots: DashMap<String, crate::agent_runtime::session::QueueSlot>,

    /// Cancellation tokens keyed by `turn_id`. Inserted when
    /// [`TurnDriver::run_turn`] starts; removed on completion (Ok or
    /// Err) or via [`AgentRegistry::cancel`].
    in_flight: DashMap<String, CancellationToken>,

    /// Builder for the per-turn API client. Stored as `Arc<dyn …>` so
    /// tests inject a mock factory and the real factory plugs in
    /// unchanged.
    api_factory: Arc<dyn ApiFactory>,

    /// Phase 2.3 keeps the registry-level catalogue empty. Each
    /// `TurnDriver::run_turn` builds a per-turn registry of
    /// [`FrontendBridgeExecutor`]s on top of this base. Phase 3 will
    /// pre-populate this with native Rust tool implementations.
    tools: Arc<ToolRegistry>,

    /// Routes `agent_post_tool_result` payloads back to the matching
    /// [`FrontendBridgeExecutor::execute`] oneshot.
    bridge_router: Arc<BridgeRouter>,

    /// Where to put the session JSONL logs and metadata sidecars.
    /// Computed once at startup from Aurora's app-data root
    /// (`<app_data>/agent_v2/`). Tests pass a tempdir.
    ///
    /// All on-disk reads/writes go through this store — there is no
    /// other persistence layer. Frontend thread commands
    /// (`thread_list_summaries`, `thread_load`, `thread_save`,
    /// `thread_delete`, `thread_update_usage`, `thread_get_api_history`,
    /// `thread_update_title`) all delegate here so the runtime and
    /// the chat-list view stay byte-for-byte consistent.
    store: Arc<SessionStore>,
    /// Aurora Chat's conversation store — folder per chat, under
    /// `paths::chats_dir()`.
    ///
    /// A SECOND store rather than a second directory on the first one, because
    /// the two layouts really are different on disk and every path the runtime
    /// derives has to come from whichever store owns the conversation. Routed
    /// per turn by [`AgentRegistry::store_for`].
    chat_store: Arc<SessionStore>,
}

impl std::fmt::Debug for AgentRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentRegistry")
            .field("session_count", &self.sessions.len())
            .field("in_flight_count", &self.in_flight.len())
            .field("tool_count", &self.tools.len())
            .field("pending_bridge_calls", &self.bridge_router.pending_count())
            .field("sessions_dir", &self.store.dir())
            .finish_non_exhaustive()
    }
}

impl AgentRegistry {
    /// Build a new registry. `sessions_dir` is created on demand by
    /// [`Session::append_to_path`] / [`Session::save_to_path`] when the
    /// first turn actually persists.
    #[must_use]
    pub fn new(api_factory: Arc<dyn ApiFactory>, sessions_dir: PathBuf) -> Self {
        // The chat store defaults INSIDE `sessions_dir` so a caller that never
        // names one (every test) still gets a real, self-contained store that
        // a temp-dir teardown removes. Production overrides it with
        // `paths::chats_dir()` via `with_chat_dir`, because `<root>/Chats` is
        // the documented location and `<root>/sessions/Chats` is not.
        let chat_dir = sessions_dir.join("Chats");
        Self {
            sessions: DashMap::new(),
            queue_slots: DashMap::new(),
            in_flight: DashMap::new(),
            api_factory,
            tools: Arc::new(ToolRegistry::new()),
            bridge_router: Arc::new(BridgeRouter::new()),
            store: Arc::new(SessionStore::new(sessions_dir)),
            chat_store: Arc::new(SessionStore::new_folder(chat_dir)),
        }
    }

    /// Point Aurora Chat's conversations at `dir`. Production wiring; see
    /// [`Self::new`] for why the default is not this.
    #[must_use]
    pub fn with_chat_dir(mut self, dir: PathBuf) -> Self {
        self.chat_store = Arc::new(SessionStore::new_folder(dir));
        self
    }

    /// Get-or-create the queued-message slot for a thread. Returns an
    /// `Arc` clone — the registry keeps one copy, the corresponding
    /// `Session` keeps another, and both point to the same
    /// `Option<QueuedUserMessage>`.
    pub(super) fn get_or_create_queue_slot(
        &self,
        thread_id: &str,
    ) -> crate::agent_runtime::session::QueueSlot {
        self.queue_slots
            .entry(thread_id.to_string())
            .or_insert_with(crate::agent_runtime::session::empty_queue_slot)
            .value()
            .clone()
    }

    /// Borrow the session store so Tauri thread commands can read /
    /// list / mutate session metadata without going through the
    /// per-thread session lock.
    #[must_use]
    pub fn store(&self) -> &Arc<SessionStore> {
        &self.store
    }

    /// Aurora Chat's conversation store.
    #[must_use]
    pub fn chat_store(&self) -> &Arc<SessionStore> {
        &self.chat_store
    }

    /// Which store owns a conversation running in `mode`.
    ///
    /// This is the routing decision, in one place. Every path a turn touches —
    /// the JSONL, the metadata, the artifacts, the spill directory — has to
    /// come from the same store, and picking it per call site is how they end
    /// up disagreeing.
    #[must_use]
    pub fn store_for(&self, mode: AgentExecutionMode) -> &Arc<SessionStore> {
        if mode.is_chat() {
            &self.chat_store
        } else {
            &self.store
        }
    }

    /// Which store owns an EXISTING conversation, looked up from disk by id.
    ///
    /// For a command that is handed only a thread id — artifacts, rename,
    /// archive, delete — there is no mode to route on, and asking every caller
    /// to pass one is how the caller that forgets reads or deletes in the wrong
    /// store without failing. A chat that is not on disk yet is nobody's; it
    /// resolves to Build, exactly as every thread did before chat mode existed.
    #[must_use]
    pub fn store_for_thread(&self, thread_id: &str) -> &Arc<SessionStore> {
        if self.chat_store.exists(thread_id) {
            &self.chat_store
        } else {
            &self.store
        }
    }

    /// Borrow the bridge router so the `agent_post_tool_result`
    /// command can resolve oneshots.
    #[must_use]
    pub fn bridge_router(&self) -> &Arc<BridgeRouter> {
        &self.bridge_router
    }

    /// Resolve a pending frontend tool-call (from
    /// `agent_post_tool_result`). Returns `Err("no pending tool call")`
    /// when no executor is parked on `(turn_id, tool_use_id)` —
    /// matches the contract's wording verbatim so the frontend can
    /// pattern-match on the message if needed.
    pub fn post_tool_result(
        &self,
        turn_id: &str,
        tool_use_id: &str,
        content: String,
        is_error: bool,
    ) -> Result<(), String> {
        let response = ToolBridgeResponse { content, is_error };
        match self.bridge_router.resolve(turn_id, tool_use_id, response) {
            Ok(()) => Ok(()),
            Err(_returned) => Err("no pending tool call".to_string()),
        }
    }

    /// Enqueue a user message to be injected into the conversation at
    /// the next tool-result boundary. Single-slot: a second call before
    /// the first is drained replaces the previous text.
    ///
    /// CRITICAL: writes ONLY to the registry-level queue slot, never
    /// touches the session mutex. `run_turn` holds the session mutex
    /// for the entire turn, so any attempt to lock it from here would
    /// block until the turn ended — at which point every tool-result
    /// boundary in the turn would have already passed with an empty
    /// slot. The slot is an `Arc<std::sync::Mutex<Option<…>>>` shared
    /// with the `Session`, so a write here is immediately visible to
    /// `session.take_queued_message()` running inside the turn.
    pub async fn enqueue_message(
        &self,
        thread_id: &str,
        text: String,
        display_text: Option<String>,
        chips: Option<Vec<crate::agent_runtime::types::AttachedPromptChip>>,
        origin: crate::agent_runtime::types::InjectedOrigin,
    ) -> Result<(), String> {
        use crate::agent_runtime::types::InjectedOrigin;
        if text.trim().is_empty() {
            return Err("queued message text cannot be empty".to_string());
        }
        let slot = self.get_or_create_queue_slot(thread_id);
        let mut guard = slot
            .lock()
            .map_err(|e| format!("queue slot mutex poisoned: {e}"))?;
        *guard = Some(crate::agent_runtime::session::QueuedUserMessage {
            text,
            display_text: display_text.filter(|t| !t.trim().is_empty()),
            chips: chips.filter(|c| !c.is_empty()),
            // The mid-turn preamble says "the user sent this while your tools
            // were running". True of a composer message; a lie about a process
            // that ended on its own, which carries its own framing instead.
            mid_turn: origin == InjectedOrigin::User,
            origin,
            queued_at_ms: chrono::Utc::now().timestamp_millis(),
        });
        Ok(())
    }

    /// Clear the queued message for a session without consuming it.
    /// Called by the frontend's Cancel button on the pill. Same
    /// constraint as `enqueue_message`: must not lock the session.
    pub async fn cancel_queued_message(&self, thread_id: &str) -> Result<(), String> {
        if let Some(entry) = self.queue_slots.get(thread_id) {
            if let Ok(mut g) = entry.value().lock() {
                *g = None;
            }
        }
        Ok(())
    }

    /// On-disk path for a given thread's session JSONL. Delegates to
    /// the [`SessionStore`] so tests and runtime see the same paths.
    #[must_use]
    pub fn session_path(&self, thread_id: &str) -> PathBuf {
        self.store.session_path(thread_id)
    }

    /// [`Self::session_path`] for a conversation running in `mode`.
    ///
    /// The bare `session_path` above answers for the project store, which is
    /// what every existing caller means. This one is for the paths that must
    /// follow the conversation into `Chats/` instead.
    #[must_use]
    pub fn session_path_in(&self, mode: AgentExecutionMode, thread_id: &str) -> PathBuf {
        self.store_for(mode).session_path(thread_id)
    }

    /// Cache hit, on-disk hit, or fresh empty session — in that order.
    /// `NotFound` is NOT an error: a thread that has never persisted
    /// returns a fresh [`Session`] bound to the same `thread_id`.
    pub fn load_or_create_session(
        &self,
        thread_id: &str,
    ) -> Result<Arc<Mutex<Session>>, RuntimeError> {
        self.load_or_create_session_in(AgentExecutionMode::Agent, thread_id)
    }

    /// [`Self::load_or_create_session`], reading from the store that owns
    /// conversations in `mode`.
    ///
    /// The in-memory `sessions` cache is shared across both stores and keyed by
    /// thread id alone. That is safe because ids are UUIDs, so a chat and a
    /// build thread cannot collide — and it is desirable, because the mutex
    /// per conversation is what serialises its turns, and there must be exactly
    /// one of those however the conversation is reached.
    pub fn load_or_create_session_in(
        &self,
        mode: AgentExecutionMode,
        thread_id: &str,
    ) -> Result<Arc<Mutex<Session>>, RuntimeError> {
        let store = self.store_for(mode);
        if let Some(existing) = self.sessions.get(thread_id) {
            return Ok(existing.value().clone());
        }

        let path = store.session_path(thread_id);
        let mut session = match Session::load_from_path(thread_id, &path) {
            Ok(s) => s,
            Err(RuntimeError::Io(io_err)) if io_err.kind() == std::io::ErrorKind::NotFound => {
                Session::new(thread_id)
            }
            Err(other) => return Err(other),
        };

        // JSONL stores messages only; restore the thread's sticky project scope
        // from its metadata sidecar so a restarted process cannot silently
        // re-home tool execution to whatever workspace the next request sends.
        if session.workspace_root.is_none() {
            if let Ok(meta) = store.load_metadata(thread_id) {
                session.workspace_root = meta.workspace_root;
            }
        }

        // Bind the session to the registry-level queue slot. If the
        // user already enqueued a mid-turn message *before* the first
        // turn ever started for this thread, the slot already holds
        // it; the session inherits the populated slot and the next
        // turn's tool boundary drains it as normal.
        let slot = self.get_or_create_queue_slot(thread_id);
        session.set_queue_slot(slot);

        // Stream each message to the thread's own JSONL as it happens, so a
        // turn that is killed halfway is recoverable up to its last message
        // instead of vanishing entirely. `already_written` is what we just
        // loaded — the file and memory agree at this instant, which is the only
        // moment they are guaranteed to.
        //
        // Per thread, and threads are per project, so several projects open at
        // once journal to several files and never contend: this session is the
        // one behind `sessions[thread_id]`, and a turn holds that mutex for its
        // whole run.
        //
        // Switched off 2026-08-17 as the first suspect in a stack-overflow
        // bisect, then cleared: the crash reproduced with journaling disabled
        // (`.knowledge/knowledge.md`, "Still open: the stack overflow is NOT
        // diagnosed"), and the suspect was never let back in. Restored
        // 2026-08-25. This is the only thing that puts a running turn on disk —
        // without it a twenty-minute turn is one kill away from nothing, and
        // `turn_driver` no longer carries a separate early write to soften
        // that for the first message of a fresh thread.
        let already_written = session.messages().len();
        session.attach_journal(&path, already_written);

        // `entry().or_insert_with(...)` makes the cache insert atomic
        // against a racing concurrent `load_or_create_session` for the
        // same thread_id — only one Arc wins, both callers see it.
        let arc = Arc::new(Mutex::new(session));
        let entry = self
            .sessions
            .entry(thread_id.to_string())
            .or_insert_with(|| arc.clone());
        Ok(entry.value().clone())
    }

    /// Record a turn's cancel token so `agent_cancel(turn_id)` can find
    /// it. Re-registering an existing turn_id overwrites the prior
    /// token — the frontend should not reuse turn_ids.
    pub fn register_in_flight(&self, turn_id: String, token: CancellationToken) {
        self.in_flight.insert(turn_id, token);
    }

    /// Best-effort removal — used as the unregister side of the
    /// register/unregister pair the driver wraps each turn in. Does not
    /// cancel the token; the caller is presumed to have observed the
    /// turn's natural completion.
    pub fn unregister_in_flight(&self, turn_id: &str) {
        self.in_flight.remove(turn_id);
    }

    /// Cancel an in-flight turn. Returns `true` iff a token was found
    /// (and therefore cancelled) — the caller can use this to surface
    /// "no such turn" to the frontend if desired.
    pub fn cancel(&self, turn_id: &str) -> bool {
        if let Some((_, token)) = self.in_flight.remove(turn_id) {
            token.cancel();
            true
        } else {
            false
        }
    }

    /// Number of cached sessions. Diagnostics only.
    #[must_use]
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    /// Number of in-flight turns. Diagnostics only.
    #[must_use]
    pub fn in_flight_count(&self) -> usize {
        self.in_flight.len()
    }

    /// Snapshot of the tool registry (empty in Phase 2.2). Phase 3 will
    /// pre-populate the registry at app startup, so the registry reads
    /// stay non-mutating from this side.
    #[must_use]
    pub fn tools(&self) -> Arc<ToolRegistry> {
        self.tools.clone()
    }

    /// Access the API factory. Internal — used by [`TurnDriver`] to
    /// build the per-turn client.
    pub(super) fn api_factory(&self) -> &Arc<dyn ApiFactory> {
        &self.api_factory
    }
}
