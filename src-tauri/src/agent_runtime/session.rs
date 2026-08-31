//! In-memory conversation session.
//!
//! `Session` is the canonical message history for one chat thread.
//! It owns a `Vec<ConversationMessage>` plus thread-scoped metadata
//! (workspace root, active model) and provides minimal append /
//! iterate / load / save primitives.
//!
//! ## Persistence
//!
//! The runtime persists every successful turn to one JSONL file per
//! thread under `<app_data>/agent_v2/{thread_id}.jsonl`. Listings,
//! metadata reads, and chat-list mutations go through
//! [`crate::agent_runtime::session_store::SessionStore`], which keeps
//! a tiny `<thread_id>.meta.json` sidecar alongside the JSONL so the
//! Thread History modal doesn't have to scan the whole transcript to
//! show a row.
//!
//! No other persistence layer exists — the runtime is the single
//! source of truth for chat history.

#![allow(dead_code)]

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::error::RuntimeError;
use super::types::{AttachedPromptChip, ConversationMessage, MessageRole};

/// Where a session streams each message as it happens, so a turn that never
/// finishes is not a turn that never existed.
///
/// The end-of-turn [`Session::save_to_path`] remains the authority — it rewrites
/// the whole file and re-syncs this counter. The journal only closes the window
/// between "the model said it" and "the turn returned", which on a long
/// analysis run is twenty minutes of tool results held in nothing but RAM.
///
/// One journal per thread, and the registry holds one `Mutex<Session>` per
/// thread, so appends are serialised per thread and two projects open at once
/// write to two different files with no contention between them.
#[derive(Debug, Default)]
pub struct Journal {
    inner: Option<JournalState>,
}

#[derive(Debug)]
struct JournalState {
    /// The thread's JSONL. Always the file `save_to_path` targets.
    path: PathBuf,
    /// How many messages are already on disk.
    ///
    /// Atomic so `save_to_path` can re-sync it through `&self`, and compared
    /// against `messages.len()` on every append: any history edit the journal
    /// cannot express as "one more line" (a Retry rewind, a compaction
    /// rewrite, a `clear`) desyncs it, and it stays off until a full save
    /// makes the file whole again.
    written: std::sync::atomic::AtomicUsize,
}

impl Clone for Journal {
    /// A clone is a snapshot or a fork, and it must NEVER inherit the
    /// original's write target — two sessions appending to one file would
    /// interleave two conversations into one thread. Forks get no journal
    /// until something deliberately attaches one.
    fn clone(&self) -> Self {
        Self { inner: None }
    }
}

/// Shared, lock-free-from-the-session-mutex slot for the mid-turn
/// queued user message. Held both by the [`Session`] (so the
/// conversation runtime can drain it at tool boundaries) and by the
/// [`crate::commands::agent_v2::AgentRegistry`] (so the
/// `agent_enqueue_message` IPC can write to it WITHOUT contending on
/// the session's tokio `Mutex`, which is held for the entire turn).
///
/// Uses `std::sync::Mutex` because the critical section is two-line
/// `take()`/assign and never `.await`s. This is the whole point —
/// previously the slot lived inside `Session` and enqueueing while a
/// turn was streaming blocked on the session lock, so the queue was
/// never drained.
pub type QueueSlot = Arc<StdMutex<Option<QueuedUserMessage>>>;

/// Build a fresh empty queue slot.
#[must_use]
pub fn empty_queue_slot() -> QueueSlot {
    Arc::new(StdMutex::new(None))
}

/// One user-typed message waiting to ride in on the next tool result.
///
/// Single-slot, replace-on-set. The runtime drains this slot at the
/// end of every tool-call batch (between iterations of the assistant
/// loop) and appends the `text` as a `ContentBlock::Text` block to the
/// just-built tool message — Anthropic sees a single user message
/// containing both the tool_result blocks and the queued text; the
/// OpenAI-compat adapter splits the text into a follow-up `role: user`
/// message after the `role: tool` entries.
///
/// Not persisted: lives only on the in-memory `Session` so it cannot
/// outlive the agent process. If the user cancels mid-stream the slot
/// is cleared with the rest of the session.
/// Framing line prepended to a composer-sent mid-turn injection so the model
/// knows the message arrived WHILE its tool calls were running — without it,
/// "wait, don't run pnpm" landing after the lint output reads as nonsense and
/// the model has to guess whether the instruction predates the results.
/// Stripped back out for display by `commands::threads` (the human saw their
/// message in real time; the framing is for the model only).
pub const MID_TURN_PREAMBLE: &str =
    "[The user sent this while your tool calls were running — results above may predate it:]";

#[derive(Debug, Clone)]
pub struct QueuedUserMessage {
    /// The model-facing text: what the user typed (including serialized
    /// `@path` mentions) plus any `<steering_context>` block the composer
    /// resolved from staged `/` directives (rules verbatim, skill
    /// references, MCP nudges). This is what rides into history.
    pub text: String,
    /// What the user actually typed, for UI echo. `None` means `text` IS
    /// the typed message (no directives were attached). The injected
    /// timeline row and the queued pill must show this, never the full
    /// model text — the steering block is machinery, not the message.
    pub display_text: Option<String>,
    /// Composer pill metadata (file mentions, `/` directives) so the
    /// injected row renders the same chips a normal user bubble would.
    /// Persisted onto the tool message the injection rides in on.
    pub chips: Option<Vec<AttachedPromptChip>>,
    /// True when a person typed this into a composer mid-turn — the runtime
    /// then prepends [`MID_TURN_PREAMBLE`] so the model knows the timing.
    /// False for team-mailbox traffic, which carries its own framing
    /// (`[Message from …]`) and must not claim to be the user.
    pub mid_turn: bool,
    /// Unix epoch milliseconds when the user hit Send.
    pub queued_at_ms: i64,
}

/// Full-fidelity copy of one tool result whose model-history copy was
/// clamped by `truncate_tool_content`. Written to the
/// `<thread_id>.rich.jsonl` sidecar at persist time so a reloaded thread
/// can render the COMPLETE diff for an edit — the clamped copy inside the
/// session JSONL stays the model-facing truth (context safety), this is
/// display-only. Works regardless of whether the project is a git repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichToolResult {
    /// Provider-issued tool_use id — the join key back to the
    /// `ContentBlock::ToolResult` this enriches.
    pub tool_use_id: String,
    /// Tool name, for diagnostics and future selective loading.
    pub tool: String,
    /// The UI-shaped result payload (same clamps as the live
    /// `tool_execution_result` event: 512 KiB envelope, JSON kept valid).
    pub content: String,
}

/// Shared slot for rich results produced mid-turn. Same shape as
/// [`QueueSlot`]: an `Arc<std::sync::Mutex<…>>` so the tool-execution
/// path (which only holds `&Session`) can push while the turn owns the
/// session, and the persist path drains after `save_to_path`.
pub type RichResultsSlot = Arc<StdMutex<Vec<RichToolResult>>>;

#[must_use]
pub fn empty_rich_results_slot() -> RichResultsSlot {
    Arc::new(StdMutex::new(Vec::new()))
}

/// In-memory conversation state for one open chat thread.
///
/// The agent runtime owns one [`Session`] per active thread. The
/// struct is `Clone` to make snapshot-and-fork operations cheap, but
/// ownership during a running agent turn is single-threaded by
/// convention — the conversation runtime takes the session by `&mut`
/// for the duration of the loop.
#[derive(Debug, Clone)]
pub struct Session {
    /// Opaque session identifier (UUIDv4). Distinct from `thread_id`:
    /// one thread can be re-loaded into multiple sessions over time
    /// (e.g. after restart) but the `session_id` changes each time.
    pub session_id: String,
    /// Aurora thread id this session is bound to. Maps 1:1 to the
    /// JSONL thread log file name.
    pub thread_id: String,
    /// Ordered conversation history.
    pub messages: Vec<ConversationMessage>,
    /// Unix epoch milliseconds.
    pub created_at: i64,
    /// Unix epoch milliseconds; bumped on every mutating call.
    pub updated_at: i64,
    /// Workspace root the session is scoped to. Phase 2 path-safety
    /// checks resolve every tool's path argument relative to this.
    pub workspace_root: Option<String>,
    /// Initial model identifier for telemetry (e.g.
    /// `"anthropic:claude-3-7-sonnet"`). The runtime can swap models
    /// mid-conversation; this records what the session opened with.
    pub model: Option<String>,
    /// Mid-turn user-message queue. Lives behind a `std::sync::Mutex`
    /// in an `Arc` so the registry can also hold a clone of the slot
    /// and write to it WITHOUT acquiring the session's tokio mutex —
    /// the session mutex is held by `run_turn` for the entire turn,
    /// so any path that needs to write during a turn must avoid it.
    /// Single-slot: a second enqueue replaces the previous one
    /// (matches the UI's "type to replace" pill behaviour).
    pub queued_message: QueueSlot,
    /// Full-fidelity tool results accumulated during the current turn,
    /// drained to the `.rich.jsonl` sidecar right after the session
    /// persists. Not serialized into the message JSONL.
    pub rich_results: RichResultsSlot,
    /// Consecutive failed compaction attempts, reset on success.
    ///
    /// Compaction sends the entire head of the conversation to a model, so it
    /// is routinely the most expensive request a long chat makes. When it
    /// fails it does not fix the overrun that triggered it, so the next turn
    /// crosses the same threshold and tries again — an unbounded retry loop
    /// that bills full price every turn and shows the user nothing but a
    /// spinner. Lives on the session (which the registry caches across turns)
    /// rather than the per-turn runtime, because a per-turn counter can never
    /// see the second attempt. Process-local: never persisted, so a restart is
    /// a deliberate clean slate.
    pub compaction_failures: u32,
    /// Epoch millis before which compaction must not be retried. Set when
    /// [`Self::compaction_failures`] hits the ceiling.
    pub compaction_retry_after: Option<i64>,
    /// Streams each appended message to disk. See [`Journal`]. Absent by
    /// default: a session with no journal behaves exactly as it always did,
    /// which is what every test and every non-persisting caller wants.
    journal: Journal,
}

impl Session {
    /// Create a new empty session bound to a thread.
    #[must_use]
    pub fn new(thread_id: impl Into<String>) -> Self {
        let now = current_time_millis();
        Self {
            session_id: Uuid::new_v4().to_string(),
            thread_id: thread_id.into(),
            messages: Vec::new(),
            created_at: now,
            updated_at: now,
            workspace_root: None,
            model: None,
            queued_message: empty_queue_slot(),
            rich_results: empty_rich_results_slot(),
            compaction_failures: 0,
            compaction_retry_after: None,
            journal: Journal::default(),
        }
    }

    /// Stash a full-fidelity tool result for the sidecar. `&self` on
    /// purpose — the tool-execution path only holds a shared borrow.
    pub fn push_rich_result(&self, entry: RichToolResult) {
        if let Ok(mut g) = self.rich_results.lock() {
            g.push(entry);
        }
    }

    /// Take every stashed rich result, leaving the slot empty. Called
    /// by the persist path after `save_to_path` succeeds.
    #[must_use]
    pub fn drain_rich_results(&self) -> Vec<RichToolResult> {
        self.rich_results
            .lock()
            .map(|mut g| std::mem::take(&mut *g))
            .unwrap_or_default()
    }

    /// Replace the queue slot with one created (or already populated)
    /// by the registry. Lets the registry-level
    /// `agent_enqueue_message` IPC write into the same slot the
    /// runtime drains, without going through the session mutex.
    pub fn set_queue_slot(&mut self, slot: QueueSlot) {
        self.queued_message = slot;
    }

    /// Clone-share the queue slot. The registry calls this once when
    /// it first builds a Session so the IPC handler can hold its own
    /// `Arc` and write to it without locking the session.
    #[must_use]
    pub fn queue_slot(&self) -> QueueSlot {
        self.queued_message.clone()
    }

    /// Enqueue a user message to be injected at the next tool-result
    /// boundary. Single-slot: replaces any previously queued message.
    /// Now `&self` because the slot lives behind its own mutex.
    pub fn enqueue_message(&self, msg: QueuedUserMessage) {
        if let Ok(mut g) = self.queued_message.lock() {
            *g = Some(msg);
        }
    }

    /// Take the queued message, leaving the slot empty. Called by the
    /// conversation runtime when it's about to inject.
    pub fn take_queued_message(&self) -> Option<QueuedUserMessage> {
        self.queued_message.lock().ok().and_then(|mut g| g.take())
    }

    /// Clear the queued message without consuming it. Called by the
    /// frontend's Cancel button.
    pub fn cancel_queued_message(&self) {
        if let Ok(mut g) = self.queued_message.lock() {
            *g = None;
        }
    }

    /// Read the queued message without taking it. For diagnostics.
    #[must_use]
    pub fn peek_queued_message(&self) -> Option<QueuedUserMessage> {
        self.queued_message.lock().ok().and_then(|g| g.clone())
    }

    /// Bind this session to a workspace root path.
    #[must_use]
    pub fn with_workspace_root(mut self, workspace_root: impl Into<String>) -> Self {
        self.workspace_root = Some(workspace_root.into());
        self
    }

    /// Bind this session to an initial model identifier.
    #[must_use]
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Stream every appended message to this path as it happens.
    ///
    /// `already_written` is how many of the current messages are already in the
    /// file — `messages.len()` for a session just loaded from it, `0` for a
    /// fresh thread whose file does not exist yet.
    pub fn attach_journal(&mut self, path: impl Into<PathBuf>, already_written: usize) {
        self.journal.inner = Some(JournalState {
            path: path.into(),
            written: std::sync::atomic::AtomicUsize::new(already_written),
        });
    }

    /// `true` when a journal is attached and the file already holds every
    /// message in memory.
    ///
    /// This is the difference between "the full save failed and the turn is
    /// gone" and "the full save failed but every line was already appended as
    /// it happened". The caller decides how loudly to report a failed
    /// `save_to_path` based on the answer, so a rewrite that could not run is
    /// not reported as lost work when the transcript is in fact complete.
    #[must_use]
    pub fn journal_is_current(&self) -> bool {
        self.journal.inner.as_ref().is_some_and(|j| {
            j.written.load(std::sync::atomic::Ordering::Relaxed) == self.messages.len()
        })
    }

    /// Rewrite the thread's own file so a journal silenced by an in-place
    /// history edit starts appending again.
    ///
    /// [`journal_last`] can only ever say "one more line", so an edit it cannot
    /// express — a compaction inserting a marker mid-history, a rewind — leaves
    /// `written` behind `messages.len()` and every later append this turn goes
    /// quiet. Until this exists the only thing that re-syncs is the end-of-turn
    /// save, which on the turn that compacted is exactly the turn with the most
    /// work in flight: measured 2026-08-27, a compaction at 07:35 left ten
    /// minutes and forty messages — six file writes and edits among them —
    /// living in nothing but RAM until the turn returned at 07:41.
    ///
    /// A no-op without a journal, and never fatal: the caller is mid-turn and a
    /// file it could not rewrite costs crash-recovery, not the turn.
    ///
    /// [`journal_last`]: Session::journal_last
    pub fn resync_journal(&self) -> Result<(), RuntimeError> {
        let Some(path) = self.journal.inner.as_ref().map(|j| j.path.clone()) else {
            return Ok(());
        };
        self.save_to_path(path)
    }

    /// Append a message to the session's history. Bumps `updated_at`
    /// to the current wall-clock millis.
    ///
    /// When a [`Journal`] is attached the message also reaches disk here, which
    /// is the only reason this is the single append entry point: a turn appends
    /// from `run_turn`, from the tool loop, and from three notice paths, and a
    /// rule that has to be remembered at five call sites is a rule that will be
    /// missed at one of them.
    pub fn append_message(&mut self, message: ConversationMessage) {
        self.messages.push(message);
        self.journal_last();
        self.touch();
    }

    /// Write the message just pushed, if a journal is attached and still in
    /// sync. Never fails the caller: the end-of-turn full save is the authority,
    /// so a journal that cannot write costs crash-recovery, not the turn.
    fn journal_last(&self) {
        use std::sync::atomic::Ordering;

        let Some(journal) = self.journal.inner.as_ref() else {
            return;
        };
        let Some(message) = self.messages.last() else {
            return;
        };

        // The journal can only ever say "one more line". Anything that rewrote
        // history behind its back — a Retry rewind, a compaction replacing the
        // head, `clear` — leaves the file describing a conversation that no
        // longer exists, and appending to it would produce a transcript that
        // never happened. Go quiet instead and let the next full save re-sync.
        let expected = self.messages.len().saturating_sub(1);
        if journal.written.load(Ordering::Relaxed) != expected {
            return;
        }

        match Self::append_to_path(&journal.path, message) {
            Ok(()) => {
                journal
                    .written
                    .store(self.messages.len(), Ordering::Relaxed);
            }
            Err(error) => {
                // Loud, and once: `written` is left behind `messages.len()`, so
                // the desync check above silences every later append this turn
                // rather than logging per message on a full disk.
                crate::logging::log_error(
                    "agent_runtime.session",
                    &format!(
                        "journal append failed for thread {} ({}): {error} — this turn is not \
                         crash-recoverable; it still persists in full when the turn ends",
                        self.thread_id,
                        journal.path.display(),
                    ),
                );
            }
        }
    }

    /// Borrow the in-order message list.
    #[must_use]
    pub fn messages(&self) -> &[ConversationMessage] {
        &self.messages
    }

    /// Iterate over messages in order.
    pub fn iter(&self) -> std::slice::Iter<'_, ConversationMessage> {
        self.messages.iter()
    }

    /// Drop all messages while keeping the same session id and
    /// creation timestamp. Bumps `updated_at`.
    pub fn clear(&mut self) {
        self.messages.clear();
        self.touch();
    }

    /// Rewind the session to the state it was in immediately BEFORE the
    /// `ordinal`-th user message (0-indexed), dropping that message and
    /// everything after it. Returns the number of messages removed.
    ///
    /// This is what Retry rewinds with. The cut point is expressed as a
    /// user-message ordinal rather than a raw index because the frontend
    /// transcript and this session do not have the same message count —
    /// the runtime holds extra tool-role messages, notices and compaction
    /// markers the UI folds away. Counting user messages is the one
    /// ordering both sides agree on.
    ///
    /// Rewinding rather than appending is what makes a retry a retry: the
    /// re-sent user message lands on a byte-identical prefix, so history
    /// carries no duplicate turn and the provider's cache still hits.
    /// Out-of-range ordinals are a no-op.
    pub fn truncate_before_user_message(&mut self, ordinal: usize) -> usize {
        let mut seen = 0usize;
        let mut cut: Option<usize> = None;
        for (index, message) in self.messages.iter().enumerate() {
            if message.role == MessageRole::User {
                if seen == ordinal {
                    cut = Some(index);
                    break;
                }
                seen += 1;
            }
        }
        let Some(cut) = cut else {
            return 0;
        };
        let removed = self.messages.len() - cut;
        self.messages.truncate(cut);
        self.touch();
        removed
    }

    /// Number of messages currently held in memory.
    #[must_use]
    pub fn len(&self) -> usize {
        self.messages.len()
    }

    /// Whether the session has any messages.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    fn touch(&mut self) {
        self.updated_at = current_time_millis();
    }

    // ─── JSONL persistence ────────────────────────────────────────────
    //
    // Each line of a session log is exactly one JSON-serialized
    // [`ConversationMessage`]. The file format is:
    //
    // ```text
    // {"role":"user","blocks":[…],"timestamp":172…}
    // {"role":"assistant","blocks":[…],"usage":{…},"timestamp":172…}
    // {"role":"tool","blocks":[{"type":"tool_result",…}],"timestamp":172…}
    // ```
    //
    // Empty lines and lines that fail to parse return [`RuntimeError::Serde`];
    // partial logs are recoverable up to the first malformed line.
    //
    // The store is intentionally minimal — message history only. The
    // chat-list modal reads `title` / `tokenUsage` / `contextUsage`
    // from a separate `<thread_id>.meta.json` sidecar managed by
    // [`crate::agent_runtime::session_store::SessionStore`].

    /// Serialize all messages to a JSONL string (one message per line,
    /// trailing newline). Useful for snapshotting; for incremental
    /// writes prefer [`Self::append_to_path`].
    pub fn to_jsonl(&self) -> Result<String, RuntimeError> {
        let mut out = String::with_capacity(self.messages.len() * 256);
        for msg in &self.messages {
            let line = serde_json::to_string(msg)?;
            out.push_str(&line);
            out.push('\n');
        }
        Ok(out)
    }

    /// Reconstruct a [`Session`] from a JSONL slice. `thread_id` is
    /// caller-supplied because the on-disk log doesn't carry it.
    /// Empty lines are tolerated; malformed lines return
    /// [`RuntimeError::Serde`] with the line number embedded.
    pub fn from_jsonl(thread_id: impl Into<String>, jsonl: &str) -> Result<Self, RuntimeError> {
        Self::parse_jsonl(thread_id, jsonl, "session jsonl")
    }

    /// Parse a JSONL transcript, tolerating exactly one torn final record.
    ///
    /// A message is appended as a single write while the turn runs, so a
    /// process that dies mid-write can leave the last record cut short. That
    /// record is unreadable — but it is ALSO the only one that can be, and
    /// refusing the whole file for it would mean a crash costs the entire
    /// thread instead of its last message. The tell is a missing trailing
    /// newline: a complete record always ends with one, so a malformed final
    /// line in a file that does not end in `\n` was interrupted, while a
    /// malformed line anywhere else is real corruption and still fails loud.
    fn parse_jsonl(
        thread_id: impl Into<String>,
        jsonl: &str,
        source: &str,
    ) -> Result<Self, RuntimeError> {
        let mut session = Session::new(thread_id);
        let torn_tail_possible = !jsonl.is_empty() && !jsonl.ends_with('\n');
        let total = jsonl.lines().count();

        for (idx, line) in jsonl.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let parsed: Result<ConversationMessage, _> = serde_json::from_str(line);
            match parsed {
                Ok(msg) => session.messages.push(msg),
                Err(e) if torn_tail_possible && idx + 1 == total => {
                    crate::logging::log_warn(
                        "agent_runtime.session",
                        &format!(
                            "{source} line {} is a torn final record ({} bytes, no trailing \
                             newline) — dropping it and keeping the {} message(s) before it. A \
                             turn was interrupted mid-write: {e}",
                            idx + 1,
                            line.len(),
                            session.messages.len(),
                        ),
                    );
                }
                Err(e) => {
                    // Wrap with line number for diagnostics. We cannot
                    // reach into serde_json::Error to re-tag, so we use
                    // InvalidState which carries the same severity.
                    return Err(RuntimeError::InvalidState(format!(
                        "{source} line {} is malformed: {}",
                        idx + 1,
                        e
                    )));
                }
            }
        }
        if !session.messages.is_empty() {
            session.touch();
        }
        Ok(session)
    }

    /// Read a JSONL session log from disk and return the
    /// reconstructed [`Session`]. The file may not exist — callers
    /// should treat `RuntimeError::Io` with `ErrorKind::NotFound` as
    /// "fresh thread".
    pub fn load_from_path(
        thread_id: impl Into<String>,
        path: impl AsRef<Path>,
    ) -> Result<Self, RuntimeError> {
        let path = path.as_ref();
        // Read whole rather than stream: the torn-tail rule needs to know
        // whether the file ends with a newline, which a line iterator has
        // already thrown away by the time the last record fails to parse.
        let text = std::fs::read_to_string(path)?;
        Self::parse_jsonl(
            thread_id,
            &text,
            &format!("session jsonl {}", path.display()),
        )
    }

    /// Append one message to a JSONL file, creating the file (and
    /// parent directories) if needed. Each call writes exactly one
    /// line — durable as soon as the OS flushes the page cache.
    ///
    /// This does **not** mutate `self`; combine with
    /// [`Self::append_message`] for the in-memory + on-disk pair.
    pub fn append_to_path(
        path: impl AsRef<Path>,
        message: &ConversationMessage,
    ) -> Result<(), RuntimeError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        // ONE write for the line and its terminator. Two calls can be
        // interrupted between them, leaving a record with no newline that reads
        // as the start of the next one; a single append-mode write is the
        // smallest unit the OS will tear.
        let mut line = serde_json::to_string(message)?;
        line.push('\n');
        file.write_all(line.as_bytes())?;
        // Deliberately no `sync_all` here. The failure this guards against is
        // the process dying — a crash, a kill, a closed window — and the page
        // cache outlives all three. An fsync per message would buy power-loss
        // durability at the cost of a disk sync inside the tool loop, and
        // `save_to_path` already syncs when the turn ends.
        Ok(())
    }

    /// Truncate-and-write the entire session log atomically (write to
    /// `path.tmp` then rename). Use sparingly — incremental
    /// [`Self::append_to_path`] is the hot path. Useful for
    /// compaction or rewriting after history edits.
    pub fn save_to_path(&self, path: impl AsRef<Path>) -> Result<(), RuntimeError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path_with_extension(path, "jsonl.tmp");
        {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp)?;
            for msg in &self.messages {
                let line = serde_json::to_string(msg)?;
                file.write_all(line.as_bytes())?;
                file.write_all(b"\n")?;
            }
            file.sync_all()?;
        }
        std::fs::rename(&tmp, path)?;

        // The file now holds exactly this history, so a journal that went quiet
        // after a rewind or a compaction is correct again and resumes here.
        // Guarded on the path: saving a copy elsewhere (fork, duplicate, export)
        // says nothing about the thread's own file.
        if let Some(journal) = self.journal.inner.as_ref() {
            if journal.path == path {
                journal
                    .written
                    .store(self.messages.len(), std::sync::atomic::Ordering::Relaxed);
            }
        }
        Ok(())
    }
}

fn current_time_millis() -> i64 {
    Utc::now().timestamp_millis()
}

/// Replace (or append) the extension on `path`.
fn path_with_extension(path: &Path, ext: &str) -> PathBuf {
    let mut buf = PathBuf::from(path.as_os_str());
    buf.set_extension(ext);
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};

    fn user_msg(text: &str) -> ConversationMessage {
        ConversationMessage {
            role: MessageRole::User,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            model: None,
        }
    }

    fn msg(role: MessageRole, text: &str) -> ConversationMessage {
        ConversationMessage {
            role,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            model: None,
        }
    }

    /// Retry rewinds to just before the chosen user message so the re-sent
    /// message lands on an identical prefix. Everything after the cut —
    /// the failed assistant turn AND its tool messages — must go.
    #[test]
    fn truncate_before_user_message_rewinds_to_the_chosen_turn() {
        let mut session = Session::new("t");
        session.append_message(msg(MessageRole::User, "first"));
        session.append_message(msg(MessageRole::Assistant, "ok"));
        session.append_message(msg(MessageRole::User, "second"));
        session.append_message(msg(MessageRole::Assistant, "working"));
        session.append_message(msg(MessageRole::Tool, "tool result"));
        session.append_message(msg(MessageRole::Assistant, "")); // the empty turn

        let removed = session.truncate_before_user_message(1);

        assert_eq!(removed, 4, "the user turn and everything after it");
        assert_eq!(session.len(), 2);
        assert_eq!(session.messages()[0].role, MessageRole::User);
        assert_eq!(session.messages()[1].role, MessageRole::Assistant);
    }

    #[test]
    fn truncate_before_user_message_ignores_out_of_range() {
        let mut session = Session::new("t");
        session.append_message(user_msg("only"));
        assert_eq!(session.truncate_before_user_message(7), 0);
        assert_eq!(
            session.len(),
            1,
            "an unknown ordinal must not destroy history"
        );
    }

    /// Ordinal 0 rewinds to an empty session — retrying the very first
    /// message of a thread.
    #[test]
    fn truncate_before_first_user_message_empties_the_session() {
        let mut session = Session::new("t");
        session.append_message(user_msg("hi"));
        session.append_message(msg(MessageRole::Assistant, "hello"));
        assert_eq!(session.truncate_before_user_message(0), 2);
        assert!(session.is_empty());
    }

    #[test]
    fn new_session_starts_empty() {
        let session = Session::new("thread-1");
        assert!(session.is_empty());
        assert_eq!(session.len(), 0);
        assert_eq!(session.thread_id, "thread-1");
        assert!(!session.session_id.is_empty(), "session_id must be set");
        assert!(session.created_at > 0);
        assert_eq!(session.created_at, session.updated_at);
    }

    #[test]
    fn append_message_grows_history_in_order() {
        let mut session = Session::new("t");
        session.append_message(user_msg("first"));
        session.append_message(user_msg("second"));
        session.append_message(user_msg("third"));

        let messages = session.messages();
        assert_eq!(messages.len(), 3);
        for (i, expected) in ["first", "second", "third"].iter().enumerate() {
            match &messages[i].blocks[0] {
                ContentBlock::Text { text } => assert_eq!(text, expected),
                other => panic!("expected text block at {i}, got: {other:?}"),
            }
        }
    }

    #[test]
    fn append_message_does_not_regress_updated_at() {
        let mut session = Session::new("t");
        let initial_updated = session.updated_at;
        // Sleep so the millis-clock has a chance to tick.
        std::thread::sleep(std::time::Duration::from_millis(2));
        session.append_message(user_msg("x"));
        assert!(
            session.updated_at >= initial_updated,
            "updated_at must be monotonic: {} -> {}",
            initial_updated,
            session.updated_at
        );
    }

    #[test]
    fn clear_drops_messages_and_keeps_identity() {
        let mut session = Session::new("t");
        let session_id = session.session_id.clone();
        let created_at = session.created_at;

        session.append_message(user_msg("a"));
        session.append_message(user_msg("b"));
        assert_eq!(session.len(), 2);

        session.clear();

        assert!(session.is_empty());
        assert_eq!(
            session.session_id, session_id,
            "session_id must be preserved across clear()"
        );
        assert_eq!(
            session.created_at, created_at,
            "created_at must be preserved across clear()"
        );
    }

    #[test]
    fn iter_returns_messages_in_append_order() {
        let mut session = Session::new("t");
        session.append_message(user_msg("a"));
        session.append_message(user_msg("b"));

        let collected: Vec<&ConversationMessage> = session.iter().collect();
        assert_eq!(collected.len(), 2);
        match &collected[0].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "a"),
            _ => panic!("expected text block"),
        }
    }

    #[test]
    fn builder_methods_set_optional_fields() {
        let session = Session::new("t")
            .with_workspace_root("E:/aurora/work")
            .with_model("anthropic:claude-3-7-sonnet");
        assert_eq!(session.workspace_root.as_deref(), Some("E:/aurora/work"));
        assert_eq!(
            session.model.as_deref(),
            Some("anthropic:claude-3-7-sonnet")
        );
    }

    #[test]
    fn each_session_has_a_unique_session_id() {
        let a = Session::new("t");
        let b = Session::new("t");
        assert_ne!(
            a.session_id, b.session_id,
            "session_ids must be unique across constructions"
        );
    }

    // ─── JSONL round-trip tests ───────────────────────────────────────

    fn assistant_msg(text: &str) -> ConversationMessage {
        ConversationMessage {
            role: MessageRole::Assistant,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            usage: None,
            timestamp: 1_700_000_000_000,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            model: None,
        }
    }

    #[test]
    fn to_jsonl_serializes_one_line_per_message() {
        let mut session = Session::new("t");
        session.append_message(user_msg("hello"));
        session.append_message(assistant_msg("hi"));

        let jsonl = session.to_jsonl().expect("to_jsonl");
        let lines: Vec<&str> = jsonl.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"role\":\"user\""));
        assert!(lines[1].contains("\"role\":\"assistant\""));
        assert!(jsonl.ends_with('\n'), "trailing newline expected");
    }

    /// The point of the whole change: a turn killed halfway is recoverable up
    /// to its last completed message, instead of vanishing because nothing
    /// reached disk until the turn returned.
    #[test]
    fn a_journalled_session_is_on_disk_before_the_turn_ends() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.jsonl");

        let mut session = Session::new("t");
        session.attach_journal(&path, 0);
        session.append_message(user_msg("analyse this repo"));
        session.append_message(assistant_msg("reading files"));

        // No save_to_path call anywhere — this is mid-turn.
        let recovered = Session::load_from_path("t", &path).expect("load");
        assert_eq!(recovered.len(), 2, "both messages must already be durable");
    }

    /// A record cut short by the process dying costs that record, never the
    /// thread. Without this, per-message journaling would make a crash worse
    /// than the whole-file write it replaced.
    #[test]
    fn a_torn_final_record_is_dropped_not_fatal() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.jsonl");

        let mut session = Session::new("t");
        session.attach_journal(&path, 0);
        session.append_message(user_msg("first"));
        session.append_message(assistant_msg("second"));

        // Simulate the interrupted write: a partial record, no trailing newline.
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str(r#"{"role":"assistant","blocks":[{"type":"text","tex"#);
        std::fs::write(&path, &text).unwrap();

        let recovered = Session::load_from_path("t", &path).expect("a torn tail must not brick");
        assert_eq!(recovered.len(), 2);
    }

    /// A malformed line that is NOT the tail is real corruption — silently
    /// dropping it would hand the model a conversation with a hole in it.
    #[test]
    fn a_malformed_line_before_the_end_still_fails_loud() {
        let mut session = Session::new("t");
        session.append_message(user_msg("first"));
        let mut jsonl = session.to_jsonl().unwrap();
        jsonl.push_str("{not json}\n");
        jsonl.push_str(&serde_json::to_string(&assistant_msg("third")).unwrap());
        jsonl.push('\n');

        assert!(
            Session::from_jsonl("t", &jsonl).is_err(),
            "corruption in the middle is not a torn tail"
        );
    }

    /// History rewrites the journal cannot express as "one more line" must
    /// silence it, or the file would describe a conversation that never
    /// happened. `save_to_path` makes the file whole and resumes it.
    #[test]
    fn a_rewind_silences_the_journal_until_the_next_full_save() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.jsonl");

        let mut session = Session::new("t");
        session.attach_journal(&path, 0);
        session.append_message(user_msg("first"));
        session.append_message(assistant_msg("second"));

        // Retry drops history behind the journal's back.
        session.messages.truncate(1);
        session.append_message(assistant_msg("replacement"));

        // The stale file is untouched: still the two original messages, NOT a
        // third line spliced onto a history that no longer exists.
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk.lines().count(), 2);
        assert!(!on_disk.contains("replacement"));

        // A full save re-syncs, and journaling resumes from there.
        session.save_to_path(&path).expect("save");
        session.append_message(assistant_msg("after save"));
        let recovered = Session::load_from_path("t", &path).expect("load");
        assert_eq!(recovered.len(), 3);
    }

    /// The turn that compacts is the turn with the most work in flight, and
    /// before `resync_journal` existed it was the one turn that journaled
    /// nothing after the halfway point.
    ///
    /// Measured on 2026-08-27: a compaction at 07:35 inserted its marker at
    /// line 122 of a 137-line file, and the next forty messages — six file
    /// writes and edits among them — reached disk only when the turn returned
    /// six minutes later.
    ///
    /// This covers the mechanism, not the call site: it reproduces the exact
    /// mid-history insert compaction performs and proves the desync, the
    /// rewrite, and that appends resume afterwards. Whether `compact_inner`
    /// still calls it is the other half, held by
    /// `conversation::tests::compaction_rewrites_the_journal_so_the_rest_of_the_turn_is_recoverable`.
    #[test]
    fn compaction_resyncs_the_journal_so_the_rest_of_the_turn_is_recoverable() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.jsonl");

        let mut session = Session::new("t");
        session.attach_journal(&path, 0);
        session.append_message(user_msg("first"));
        session.append_message(assistant_msg("second"));

        // What compaction does: insert a marker mid-history, NOT at the end.
        // The journal cannot express that as one more line, so it goes quiet.
        session
            .messages
            .insert(1, assistant_msg("<compaction marker>"));
        session.append_message(assistant_msg("silenced"));
        let during = std::fs::read_to_string(&path).unwrap();
        assert_eq!(during.lines().count(), 2, "the desync must silence appends");

        // The runtime rewrites the file the moment the marker is complete.
        session.resync_journal().expect("resync");
        let after_resync = std::fs::read_to_string(&path).unwrap();
        assert_eq!(after_resync.lines().count(), 4, "the file is whole again");

        // …and every later message this turn reaches disk as it happens, which
        // is the whole point: a crash here must not cost the rest of the turn.
        session.append_message(assistant_msg("post-compaction work"));
        let recovered = Session::load_from_path("t", &path).expect("load");
        assert_eq!(recovered.len(), 5);
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("post-compaction work"),
            "journaling must resume, not wait for the end-of-turn save"
        );
    }

    /// `resync_journal` is called from the turn loop, where a session may have
    /// no journal at all (a fork, a test, a non-persisting caller).
    #[test]
    fn resyncing_without_a_journal_writes_nothing_and_succeeds() {
        let mut session = Session::new("t");
        session.append_message(user_msg("first"));
        session.resync_journal().expect("a no-op, not an error");
    }

    /// A fork must never inherit its source's write target, or two threads
    /// would interleave into one file.
    #[test]
    fn a_cloned_session_does_not_inherit_the_journal() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.jsonl");

        let mut session = Session::new("t");
        session.attach_journal(&path, 0);
        session.append_message(user_msg("original"));

        let mut fork = session.clone();
        fork.append_message(assistant_msg("fork only"));

        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk.lines().count(), 1, "the fork must not have written");
        assert!(!on_disk.contains("fork only"));
    }

    #[test]
    fn from_jsonl_reconstructs_messages_in_order() {
        let original = {
            let mut s = Session::new("t");
            s.append_message(user_msg("first"));
            s.append_message(assistant_msg("second"));
            s
        };
        let jsonl = original.to_jsonl().expect("to_jsonl");
        let reloaded = Session::from_jsonl("t-reloaded", &jsonl).expect("from_jsonl");
        assert_eq!(reloaded.thread_id, "t-reloaded");
        assert_eq!(reloaded.len(), 2);
        match &reloaded.messages[0].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "first"),
            _ => panic!("expected text block"),
        }
        match &reloaded.messages[1].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "second"),
            _ => panic!("expected text block"),
        }
    }

    #[test]
    fn from_jsonl_tolerates_blank_lines() {
        let jsonl = format!(
            "{}\n\n  \n{}\n",
            serde_json::to_string(&user_msg("a")).unwrap(),
            serde_json::to_string(&assistant_msg("b")).unwrap()
        );
        let session = Session::from_jsonl("t", &jsonl).expect("from_jsonl");
        assert_eq!(session.len(), 2);
    }

    #[test]
    fn from_jsonl_rejects_malformed_line_with_line_number() {
        let bad = format!(
            "{}\n{{not json}}\n",
            serde_json::to_string(&user_msg("ok")).unwrap()
        );
        let err = Session::from_jsonl("t", &bad).expect_err("must fail");
        let msg = err.to_string();
        assert!(
            msg.contains("line 2"),
            "error must include line number, got: {msg}"
        );
    }

    #[test]
    fn append_to_path_creates_parent_dirs_and_appends_one_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("session.jsonl");

        let m1 = user_msg("hello");
        let m2 = assistant_msg("hi");
        Session::append_to_path(&path, &m1).expect("append 1");
        Session::append_to_path(&path, &m2).expect("append 2");

        let contents = std::fs::read_to_string(&path).expect("read");
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2, "two appended messages -> two lines");
        assert!(lines[0].contains("\"role\":\"user\""));
        assert!(lines[1].contains("\"role\":\"assistant\""));
    }

    #[test]
    fn load_from_path_returns_session_with_correct_thread_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("s.jsonl");
        Session::append_to_path(&path, &user_msg("p1")).expect("append");
        Session::append_to_path(&path, &assistant_msg("p2")).expect("append");

        let loaded = Session::load_from_path("thread-x", &path).expect("load");
        assert_eq!(loaded.thread_id, "thread-x");
        assert_eq!(loaded.len(), 2);
    }

    #[test]
    fn load_from_path_returns_io_not_found_for_missing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("does-not-exist.jsonl");
        let err = Session::load_from_path("t", &path).expect_err("must fail");
        match err {
            RuntimeError::Io(io_err) => {
                assert_eq!(io_err.kind(), std::io::ErrorKind::NotFound);
            }
            other => panic!("expected Io NotFound, got {other:?}"),
        }
    }

    #[test]
    fn save_to_path_atomically_writes_full_session() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("s.jsonl");

        let mut session = Session::new("t");
        session.append_message(user_msg("a"));
        session.append_message(assistant_msg("b"));
        session.save_to_path(&path).expect("save");

        let reloaded = Session::load_from_path("t", &path).expect("load");
        assert_eq!(reloaded.len(), 2);

        let tmp = path.with_extension("jsonl.tmp");
        assert!(
            !tmp.exists(),
            "atomic rename must remove the .tmp file, found: {}",
            tmp.display()
        );
    }

    #[test]
    fn save_to_path_overwrites_existing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("s.jsonl");

        // Pre-populate with stale data.
        std::fs::write(&path, b"{\"junk\": true}\n").expect("seed");

        let mut session = Session::new("t");
        session.append_message(user_msg("fresh"));
        session.save_to_path(&path).expect("save");

        let reloaded = Session::load_from_path("t", &path).expect("load");
        assert_eq!(reloaded.len(), 1);
        match &reloaded.messages[0].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "fresh"),
            _ => panic!("expected text block"),
        }
    }
}
