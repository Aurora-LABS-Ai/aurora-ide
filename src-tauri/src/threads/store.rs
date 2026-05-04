//! [`ThreadEventLog`] — the singleton orchestrating thread persistence.
//!
//! This is the *only* type the rest of the codebase should touch. It owns:
#![allow(dead_code)]
//
// Several `append_*` helpers and the `projection_to_context_manager` adapter
// are the public surface used by `commands::threads` and the next-phase
// context-bridge work; suppress dead-code lints until all callers land.
//!
//! - One [`EventLogWriter`] per active thread (lazy-opened, kept alive while
//!   the app runs).
//! - One [`ProjectedThread`] per active thread, kept in-sync with the writer
//!   via incremental folding (no full-file replay on every append).
//! - The `threads-index.jsonl` writer, serialized through a dedicated mutex.
//! - The Tauri [`AppHandle`] used to broadcast `thread-event-appended` and
//!   `thread-list-updated` to every window.
//!
//! Concurrency model:
//!
//! - One mutex per thread (guarding writer+projection together) → multiple
//!   threads append in parallel without blocking each other.
//! - One mutex on the index → cheap and serializes the rare metadata
//!   updates.
//! - The handle map itself sits behind an `RwLock` so reads (the hot path)
//!   never block other reads, and creating a new entry only blocks the
//!   handful of microseconds an `insert` takes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::context::types::{ApiMessage, Turn};
use crate::db::{ContextUsage, TokenUsage};
use crate::threads::events::{
    new_event_id, now_rfc3339_ms, CancelReason, EventToolCall, ThreadEvent, TurnOutcome,
};
use crate::threads::index::{self, ThreadIndexEntry};
use crate::threads::paths;
use crate::threads::projector::{self, ProjectedThread};
use crate::threads::reader::{self, ReadOutcome};
use crate::threads::writer::EventLogWriter;

// ============================================================================
// PUBLIC ERROR
// ============================================================================

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("path error: {0}")]
    Path(#[from] paths::PathError),
    #[error("writer error: {0}")]
    Writer(#[from] crate::threads::writer::WriterError),
    #[error("reader error: {0}")]
    Reader(#[from] crate::threads::reader::ReaderError),
    #[error("index error: {0}")]
    Index(#[from] index::IndexError),
    #[error("thread not found: {0}")]
    ThreadNotFound(String),
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl StoreError {
    fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

// ============================================================================
// EVENT NAMES
// ============================================================================

/// Tauri event broadcast to every window after a successful append.
/// Payload: [`AppendedPayload`].
pub const EVT_THREAD_APPENDED: &str = "thread-event-appended";

/// Broadcast when the index changes (new thread / rename / delete). The UI
/// uses this to refresh the chat list.
pub const EVT_THREAD_LIST_UPDATED: &str = "thread-list-updated";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendedPayload {
    pub thread_id: String,
    pub event: ThreadEvent,
}

// ============================================================================
// STORE
// ============================================================================

struct ThreadHandle {
    writer: EventLogWriter,
    projection: ProjectedThread,
}

/// The agent's thread persistence singleton. Construct once at app start, put
/// it into Tauri's managed state, and never construct another.
pub struct ThreadEventLog {
    handles: RwLock<HashMap<String, Arc<Mutex<ThreadHandle>>>>,
    /// Serializes writes to `threads-index.jsonl`.
    index_lock: Mutex<()>,
    /// Cached path to `threads-index.jsonl`. Resolved once at startup.
    index_path: PathBuf,
    /// Tauri handle for event emission. `None` until [`Self::set_app_handle`]
    /// is called from the Tauri setup hook.
    app: RwLock<Option<AppHandle>>,
}

impl ThreadEventLog {
    /// Construct a new store. Creates `<agent_root>/Threads/` if missing.
    pub fn new() -> StoreResult<Self> {
        paths::ensure_agent_root()?;
        Ok(Self {
            handles: RwLock::new(HashMap::new()),
            index_lock: Mutex::new(()),
            index_path: paths::threads_index_path()?,
            app: RwLock::new(None),
        })
    }

    /// Inject the Tauri app handle. Called from `setup` so events can fan out.
    pub fn set_app_handle(&self, app: AppHandle) {
        *self.app.write() = Some(app);
    }

    // ------------------------------------------------------------------------
    // Thread lifecycle
    // ------------------------------------------------------------------------

    /// Create a new thread on disk with a server-generated UUID, seeded with
    /// a `Session` event.
    pub fn create_thread(&self, title: Option<String>) -> StoreResult<ProjectedThread> {
        let thread_id = uuid::Uuid::new_v4().to_string();
        self.create_thread_with_id(thread_id, title)
    }

    /// Create a new thread with a caller-supplied id. Used by upsert flows
    /// where the frontend pre-generates a UUID for optimistic UI rendering
    /// and only later persists the thread (e.g. when the user sends the first
    /// message). Idempotent: if the thread already exists, returns the
    /// existing projection unchanged.
    pub fn create_thread_with_id(
        &self,
        thread_id: String,
        title: Option<String>,
    ) -> StoreResult<ProjectedThread> {
        // Already on disk? Return the existing projection — never overwrite.
        if let Ok(path) = paths::thread_file(&thread_id) {
            if path.exists() {
                return self.project_thread(&thread_id);
            }
        }

        let session = ThreadEvent::session(&thread_id, title);

        // Open the per-thread file and write the session event.
        let file_path = paths::ensure_thread_file_parent(&thread_id)?;
        let mut writer = EventLogWriter::open(&file_path)?;
        writer.append(&session)?;

        let projection = projector::project(&thread_id, std::slice::from_ref(&session));
        let handle = Arc::new(Mutex::new(ThreadHandle {
            writer,
            projection: projection.clone(),
        }));
        self.handles.write().insert(thread_id.clone(), handle);

        // Index entry & broadcast.
        self.upsert_index_entry(&projection)?;
        self.emit_appended(&thread_id, &session);
        self.emit_list_updated();

        Ok(projection)
    }

    /// Permanently delete a thread: removes the JSONL file and tombstones
    /// the index entry. Returns `Ok(())` even if the file did not exist
    /// (idempotent).
    pub fn delete_thread(&self, thread_id: &str) -> StoreResult<()> {
        // Drop in-memory handle (closes writer).
        self.handles.write().remove(thread_id);

        // Remove the file. NotFound is treated as success (idempotent delete).
        let path = paths::thread_file(thread_id)?;
        match std::fs::remove_file(&path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(StoreError::io(path, e)),
        }

        // Tombstone the index.
        let _guard = self.index_lock.lock();
        index::delete(&self.index_path, thread_id)?;
        drop(_guard);

        self.emit_list_updated();
        Ok(())
    }

    /// Project a thread, hydrating from disk if it is not currently open.
    /// Returns a clone — the caller owns the snapshot.
    pub fn project_thread(&self, thread_id: &str) -> StoreResult<ProjectedThread> {
        if let Some(handle) = self.handles.read().get(thread_id).cloned() {
            return Ok(handle.lock().projection.clone());
        }
        let projection = self.hydrate(thread_id)?;
        Ok(projection)
    }

    /// Check whether the thread already has an open file (cheap, no I/O).
    pub fn is_open(&self, thread_id: &str) -> bool {
        self.handles.read().contains_key(thread_id)
    }

    /// Active thread summaries for the chat list. Cheap — single file scan.
    pub fn list_summaries(&self) -> StoreResult<Vec<ThreadIndexEntry>> {
        Ok(index::load_active(&self.index_path)?)
    }

    /// Best-effort flush + close of every open writer. Used at app shutdown.
    pub fn shutdown(&self) {
        let handles = std::mem::take(&mut *self.handles.write());
        for (_id, handle) in handles {
            // The handle's Mutex is uncontested at shutdown; the unwrap is
            // safe in normal shutdown but we defend with `try_lock` to avoid
            // any pathological hang.
            if let Some(mut h) = handle.try_lock() {
                let _ = h.writer.sync();
            }
        }
    }

    // ------------------------------------------------------------------------
    // Append API
    // ------------------------------------------------------------------------

    /// Append an arbitrary event. The caller is responsible for providing
    /// `parent_id`; use one of the convenience methods below if you want
    /// the store to chain it for you.
    ///
    /// The cached projection is refolded from disk *after* the write succeeds,
    /// guaranteeing the in-memory state matches what's on disk byte-for-byte.
    /// This is O(events) per append — fine for typical threads (<5000 events)
    /// because the file fits in L2 cache and serde_json parses ~1 GB/s. If a
    /// future profile shows this in the hot path, swap [`refold_from_disk`]
    /// for an incremental folder; the projector module is already pure.
    pub fn append(&self, thread_id: &str, event: ThreadEvent) -> StoreResult<()> {
        let handle = self.open_handle(thread_id)?;
        let mut h = handle.lock();
        h.writer.append(&event)?;
        h.projection = self.refold_from_disk(thread_id)?;
        let projection_clone = h.projection.clone();
        drop(h);

        self.upsert_index_entry(&projection_clone)?;
        self.emit_appended(thread_id, &event);
        Ok(())
    }

    /// Append a user message (auto-chains `parent_id` from the projection).
    /// Returns the `id` of the appended event — also the new `turn_id`.
    pub fn append_user_message(
        &self,
        thread_id: &str,
        content: String,
        ide_context: Option<String>,
        attachments: Option<Vec<serde_json::Value>>,
    ) -> StoreResult<String> {
        let handle = self.open_handle(thread_id)?;
        let parent_id = handle
            .lock()
            .projection
            .last_event_id
            .clone()
            .unwrap_or_default();

        let event = ThreadEvent::UserMessage {
            id: new_event_id(),
            parent_id,
            thread_id: thread_id.to_string(),
            timestamp: now_rfc3339_ms(),
            content,
            ide_context,
            attachments,
        };
        let id = event.id().to_string();
        self.append(thread_id, event)?;
        Ok(id)
    }

    /// Append an assistant response with embedded tool calls.
    pub fn append_assistant_message(
        &self,
        thread_id: &str,
        content: String,
        thinking: Option<String>,
        tool_calls: Vec<EventToolCall>,
    ) -> StoreResult<String> {
        let handle = self.open_handle(thread_id)?;
        let (parent_id, turn_id) = {
            let h = handle.lock();
            let parent = h.projection.last_event_id.clone().unwrap_or_default();
            let turn = h
                .projection
                .current_turn
                .as_ref()
                .map(|t| t.id.clone())
                .unwrap_or_else(|| parent.clone());
            (parent, turn)
        };

        let event = ThreadEvent::AssistantMessage {
            id: new_event_id(),
            parent_id,
            thread_id: thread_id.to_string(),
            turn_id,
            timestamp: now_rfc3339_ms(),
            content,
            thinking,
            tool_calls,
        };
        let id = event.id().to_string();
        self.append(thread_id, event)?;
        Ok(id)
    }

    /// Append a tool result.
    #[allow(clippy::too_many_arguments)]
    pub fn append_tool_result(
        &self,
        thread_id: &str,
        tool_call_id: String,
        tool_name: String,
        content: String,
        is_error: bool,
        truncated: bool,
        original_length: Option<usize>,
        duration_ms: Option<u64>,
    ) -> StoreResult<String> {
        let handle = self.open_handle(thread_id)?;
        let (parent_id, turn_id) = {
            let h = handle.lock();
            // Parent is the assistant message that issued the call.
            let parent = h
                .projection
                .current_turn
                .as_ref()
                .and_then(|t| t.rounds.last())
                .map(|r| r.id.clone())
                .unwrap_or_else(|| h.projection.last_event_id.clone().unwrap_or_default());
            let turn = h
                .projection
                .current_turn
                .as_ref()
                .map(|t| t.id.clone())
                .unwrap_or_default();
            (parent, turn)
        };

        let event = ThreadEvent::ToolResult {
            id: new_event_id(),
            parent_id,
            thread_id: thread_id.to_string(),
            turn_id,
            timestamp: now_rfc3339_ms(),
            tool_call_id,
            tool_name,
            content,
            is_error,
            truncated,
            original_length,
            duration_ms,
        };
        let id = event.id().to_string();
        self.append(thread_id, event)?;
        Ok(id)
    }

    /// Append a `Cancelled` event for the in-progress turn.
    ///
    /// Inspects the current projection to compute `completed_tool_call_ids`
    /// and `cancelled_tool_call_ids` automatically — callers only provide the
    /// reason. Returns the `turn_id` that was cancelled, or `None` if there
    /// was no in-progress turn.
    pub fn append_cancellation(
        &self,
        thread_id: &str,
        reason: CancelReason,
    ) -> StoreResult<Option<String>> {
        let handle = self.open_handle(thread_id)?;
        let (parent_id, turn_id, completed, cancelled) = {
            let h = handle.lock();
            let Some(turn) = h.projection.current_turn.as_ref() else {
                return Ok(None);
            };

            let mut completed: Vec<String> = Vec::new();
            let mut cancelled: Vec<String> = Vec::new();
            for round in &turn.rounds {
                for tc in &round.tool_calls {
                    if round.tool_results.contains_key(&tc.id) {
                        completed.push(tc.id.clone());
                    } else {
                        cancelled.push(tc.id.clone());
                    }
                }
            }
            (
                h.projection.last_event_id.clone().unwrap_or_default(),
                turn.id.clone(),
                completed,
                cancelled,
            )
        };

        let event = ThreadEvent::Cancelled {
            id: new_event_id(),
            parent_id,
            thread_id: thread_id.to_string(),
            turn_id: turn_id.clone(),
            timestamp: now_rfc3339_ms(),
            completed_tool_call_ids: completed,
            cancelled_tool_call_ids: cancelled,
            reason,
        };
        self.append(thread_id, event)?;

        // Immediately finalise the turn so the message builder treats it as
        // historical on the next request.
        self.append_turn_finalized(thread_id, &turn_id, TurnOutcome::Cancelled, None, None)?;

        Ok(Some(turn_id))
    }

    /// Append a `TurnFinalized` event closing the in-progress turn.
    pub fn append_turn_finalized(
        &self,
        thread_id: &str,
        turn_id: &str,
        outcome: TurnOutcome,
        token_usage: Option<TokenUsage>,
        context_usage: Option<ContextUsage>,
    ) -> StoreResult<String> {
        let handle = self.open_handle(thread_id)?;
        let parent_id = handle
            .lock()
            .projection
            .last_event_id
            .clone()
            .unwrap_or_default();

        let event = ThreadEvent::TurnFinalized {
            id: new_event_id(),
            parent_id,
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            timestamp: now_rfc3339_ms(),
            outcome,
            token_usage,
            context_usage,
        };
        let id = event.id().to_string();
        self.append(thread_id, event)?;
        Ok(id)
    }

    /// Append a `TitleChanged` event.
    pub fn append_title_changed(
        &self,
        thread_id: &str,
        title: String,
    ) -> StoreResult<String> {
        let handle = self.open_handle(thread_id)?;
        let parent_id = handle
            .lock()
            .projection
            .last_event_id
            .clone()
            .unwrap_or_default();
        let event = ThreadEvent::TitleChanged {
            id: new_event_id(),
            parent_id,
            thread_id: thread_id.to_string(),
            timestamp: now_rfc3339_ms(),
            title,
        };
        let id = event.id().to_string();
        self.append(thread_id, event)?;
        Ok(id)
    }

    /// Append a `TurnSummary` event.
    pub fn append_turn_summary(
        &self,
        thread_id: &str,
        turn_id: &str,
        summary: String,
        original_token_count: Option<u32>,
        summary_token_count: Option<u32>,
    ) -> StoreResult<String> {
        let handle = self.open_handle(thread_id)?;
        let parent_id = handle
            .lock()
            .projection
            .last_event_id
            .clone()
            .unwrap_or_default();
        let event = ThreadEvent::TurnSummary {
            id: new_event_id(),
            parent_id,
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            timestamp: now_rfc3339_ms(),
            summary,
            original_token_count,
            summary_token_count,
        };
        let id = event.id().to_string();
        self.append(thread_id, event)?;
        Ok(id)
    }

    // ------------------------------------------------------------------------
    // Convenience read helpers (cheap — projection is in memory).
    // ------------------------------------------------------------------------

    /// Vec<Turn> for the message builder.
    pub fn finalized_turns(&self, thread_id: &str) -> StoreResult<Vec<Turn>> {
        let projection = self.project_thread(thread_id)?;
        Ok(projection.turns)
    }

    /// In-progress turn (if any) for live UI.
    pub fn current_turn(&self, thread_id: &str) -> StoreResult<Option<Turn>> {
        let projection = self.project_thread(thread_id)?;
        Ok(projection.current_turn)
    }

    /// Build API messages for the next provider request.
    pub fn build_api_messages(
        &self,
        thread_id: &str,
        system_prompt: String,
        token_budget: u32,
    ) -> StoreResult<Vec<ApiMessage>> {
        let projection = self.project_thread(thread_id)?;
        let manager = projection_to_context_manager(&projection);
        let builder =
            crate::context::builder::MessageBuilder::new(system_prompt, token_budget);
        Ok(builder.build(&manager))
    }

    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------

    fn open_handle(&self, thread_id: &str) -> StoreResult<Arc<Mutex<ThreadHandle>>> {
        if let Some(h) = self.handles.read().get(thread_id).cloned() {
            return Ok(h);
        }
        // Hydrate from disk under the write lock (cheap insertion path).
        let projection = self.hydrate(thread_id)?;
        let path = paths::ensure_thread_file_parent(thread_id)?;
        let writer = EventLogWriter::open(&path)?;
        let handle = Arc::new(Mutex::new(ThreadHandle { writer, projection }));
        self.handles
            .write()
            .entry(thread_id.to_string())
            .or_insert_with(|| handle.clone());
        Ok(handle)
    }

    fn hydrate(&self, thread_id: &str) -> StoreResult<ProjectedThread> {
        let path = paths::thread_file(thread_id)?;
        let outcome: ReadOutcome = reader::read_log(&path)?;
        if outcome.events.is_empty() && !path.exists() {
            return Err(StoreError::ThreadNotFound(thread_id.to_string()));
        }
        Ok(projector::project(thread_id, &outcome.events))
    }

    /// Re-read the entire JSONL file and refold the projection. Called after
    /// every append so the cached projection is bit-for-bit identical to
    /// what's on disk (avoiding any in-memory drift bug).
    fn refold_from_disk(&self, thread_id: &str) -> StoreResult<ProjectedThread> {
        let path = paths::thread_file(thread_id)?;
        let outcome = reader::read_log(&path)?;
        Ok(projector::project(thread_id, &outcome.events))
    }

    fn upsert_index_entry(&self, projection: &ProjectedThread) -> StoreResult<()> {
        let entry = ThreadIndexEntry {
            id: projection.thread_id.clone(),
            title: projection.title.clone(),
            preview: projection.preview(),
            message_count: projection.turn_count(),
            created_at: projection.created_at.clone(),
            updated_at: projection.updated_at.clone(),
            deleted: false,
        };
        let _guard = self.index_lock.lock();
        index::upsert(&self.index_path, &entry)?;
        Ok(())
    }

    fn emit_appended(&self, thread_id: &str, event: &ThreadEvent) {
        if let Some(app) = self.app.read().clone() {
            let payload = AppendedPayload {
                thread_id: thread_id.to_string(),
                event: event.clone(),
            };
            if let Err(e) = app.emit(EVT_THREAD_APPENDED, &payload) {
                eprintln!(
                    "[ThreadEventLog] failed to emit {}: {}",
                    EVT_THREAD_APPENDED, e
                );
            }
        }
    }

    fn emit_list_updated(&self) {
        if let Some(app) = self.app.read().clone() {
            let _ = app.emit(EVT_THREAD_LIST_UPDATED, &());
        }
    }
}

// ============================================================================
// HELPERS
// ============================================================================

/// Build a temporary [`ContextManager`] backed by the projected turns. The
/// manager is a *view* — mutations against it are discarded. Callers use it
/// solely to drive `MessageBuilder`.
fn projection_to_context_manager(
    projection: &ProjectedThread,
) -> crate::context::manager::ContextManager {
    let context_window = projection.settings.context_window.unwrap_or(128_000);
    let max_output = projection.settings.max_output.unwrap_or(8_192);
    let mut all_turns = projection.turns.clone();
    if let Some(current) = projection.current_turn.clone() {
        all_turns.push(current);
    }
    crate::context::manager::ContextManager::from_turns(
        projection.thread_id.clone(),
        all_turns,
        context_window,
        max_output,
    )
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Lock around env var manipulation so concurrent test threads don't
    /// trample each other's `AURORA_AGENT_DIR` value.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_root<R>(f: impl FnOnce() -> R) -> R {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let prior = std::env::var(paths::AGENT_DIR_OVERRIDE_ENV).ok();
        std::env::set_var(paths::AGENT_DIR_OVERRIDE_ENV, tmp.path());
        let res = f();
        match prior {
            Some(v) => std::env::set_var(paths::AGENT_DIR_OVERRIDE_ENV, v),
            None => std::env::remove_var(paths::AGENT_DIR_OVERRIDE_ENV),
        }
        // tmp is dropped here, cleaning the directory.
        drop(tmp);
        res
    }

    #[test]
    fn create_then_load_round_trips() {
        with_root(|| {
            let store = ThreadEventLog::new().unwrap();
            let projection = store.create_thread(Some("Hello".into())).unwrap();
            assert_eq!(projection.title, "Hello");

            // Drop in-memory cache to force a hydrate from disk.
            store.handles.write().clear();

            let loaded = store.project_thread(&projection.thread_id).unwrap();
            assert_eq!(loaded.title, "Hello");
            assert_eq!(loaded.turns.len(), 0);
            assert_eq!(loaded.thread_id, projection.thread_id);
        });
    }

    #[test]
    fn user_then_assistant_chain_chains_parents() {
        with_root(|| {
            let store = ThreadEventLog::new().unwrap();
            let proj = store.create_thread(None).unwrap();

            store
                .append_user_message(&proj.thread_id, "do it".into(), None, None)
                .unwrap();
            store
                .append_assistant_message(&proj.thread_id, "ok".into(), None, vec![])
                .unwrap();

            let loaded = store.project_thread(&proj.thread_id).unwrap();
            assert!(loaded.current_turn.is_some());
            assert_eq!(loaded.current_turn.as_ref().unwrap().rounds.len(), 1);
        });
    }

    #[test]
    fn cancellation_synthesizes_results_and_finalizes() {
        with_root(|| {
            let store = ThreadEventLog::new().unwrap();
            let proj = store.create_thread(None).unwrap();
            store
                .append_user_message(&proj.thread_id, "edit 3 files".into(), None, None)
                .unwrap();
            store
                .append_assistant_message(
                    &proj.thread_id,
                    "starting".into(),
                    None,
                    vec![
                        EventToolCall {
                            id: "c1".into(),
                            name: "file_write".into(),
                            arguments: "{}".into(),
                        },
                        EventToolCall {
                            id: "c2".into(),
                            name: "file_write".into(),
                            arguments: "{}".into(),
                        },
                        EventToolCall {
                            id: "c3".into(),
                            name: "file_write".into(),
                            arguments: "{}".into(),
                        },
                    ],
                )
                .unwrap();
            // Only c1 finishes.
            store
                .append_tool_result(
                    &proj.thread_id,
                    "c1".into(),
                    "file_write".into(),
                    "wrote".into(),
                    false,
                    false,
                    None,
                    None,
                )
                .unwrap();
            // User stops.
            store
                .append_cancellation(&proj.thread_id, CancelReason::UserStop)
                .unwrap();

            let loaded = store.project_thread(&proj.thread_id).unwrap();
            // Turn moves to history because cancellation auto-finalises.
            assert_eq!(loaded.turns.len(), 1);
            assert!(loaded.current_turn.is_none());
            let round = &loaded.turns[0].rounds[0];
            assert_eq!(round.tool_results.len(), 3);
            assert!(!round.tool_results["c1"].is_error);
            assert!(round.tool_results["c2"].is_error);
            assert!(round.tool_results["c3"].is_error);
        });
    }

    #[test]
    fn list_summaries_excludes_deleted() {
        with_root(|| {
            let store = ThreadEventLog::new().unwrap();
            let a = store.create_thread(Some("A".into())).unwrap();
            let _b = store.create_thread(Some("B".into())).unwrap();
            store.delete_thread(&a.thread_id).unwrap();

            let list = store.list_summaries().unwrap();
            assert_eq!(list.len(), 1);
            assert_eq!(list[0].title, "B");
        });
    }

    #[test]
    fn delete_removes_thread_file() {
        with_root(|| {
            let store = ThreadEventLog::new().unwrap();
            let p = store.create_thread(None).unwrap();
            let path = paths::thread_file(&p.thread_id).unwrap();
            assert!(path.exists());

            store.delete_thread(&p.thread_id).unwrap();
            assert!(!path.exists());
        });
    }

    #[test]
    fn hydrate_missing_thread_returns_not_found() {
        with_root(|| {
            let store = ThreadEventLog::new().unwrap();
            let err = store.project_thread("00000000-0000-0000-0000-000000000000").unwrap_err();
            assert!(matches!(err, StoreError::ThreadNotFound(_)));
        });
    }
}
