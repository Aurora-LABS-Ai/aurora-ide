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
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use uuid::Uuid;

use super::error::RuntimeError;
use super::types::ConversationMessage;

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
        }
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

    /// Append a message to the session's history. Bumps `updated_at`
    /// to the current wall-clock millis.
    pub fn append_message(&mut self, message: ConversationMessage) {
        self.messages.push(message);
        self.touch();
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
        let mut session = Session::new(thread_id);
        for (idx, line) in jsonl.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let msg: ConversationMessage = serde_json::from_str(line).map_err(|e| {
                // Wrap with line number for diagnostics. We cannot
                // reach into serde_json::Error to re-tag, so we use
                // InvalidState which carries the same severity.
                RuntimeError::InvalidState(format!(
                    "session jsonl line {} is malformed: {}",
                    idx + 1,
                    e
                ))
            })?;
            session.messages.push(msg);
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
        let file = std::fs::File::open(path)?;
        let reader = BufReader::new(file);
        let mut session = Session::new(thread_id);
        for (idx, line_res) in reader.lines().enumerate() {
            let line = line_res?;
            if line.trim().is_empty() {
                continue;
            }
            let msg: ConversationMessage = serde_json::from_str(&line).map_err(|e| {
                RuntimeError::InvalidState(format!(
                    "session jsonl {} line {}: {}",
                    path.display(),
                    idx + 1,
                    e
                ))
            })?;
            session.messages.push(msg);
        }
        if !session.messages.is_empty() {
            session.touch();
        }
        Ok(session)
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
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        let line = serde_json::to_string(message)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
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
        }
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
        assert_eq!(
            session.workspace_root.as_deref(),
            Some("E:/aurora/work")
        );
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
