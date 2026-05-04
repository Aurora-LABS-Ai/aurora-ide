//! Append-only writer for thread JSONL files.
//!
//! Each event is serialized as one JSON object, terminated by a single `\n`,
//! and pushed through a [`BufWriter`] before being flushed to the OS page
//! cache. The buffer is **flushed after every event** so a crash or pulled
//! plug only ever loses the most recently in-flight write — at worst a single
//! line, which the reader treats as a tolerable corrupted-tail.
#![allow(dead_code)]
//
// `path()`, `events_written()`, `sync()`, and `close()` are part of the
// writer's intentional public surface — they're consumed by the diagnostic
// commands and the index compactor. Suppressed until those callers land.
//!
//! The writer is intentionally *not* internally synchronized: callers (the
//! [`ThreadEventLog`](crate::threads::store) singleton) wrap each writer in a
//! mutex so multiple windows / async tasks serialize cleanly without paying
//! the cost of a second lock on every append.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use crate::threads::events::ThreadEvent;

/// Errors that can occur while appending to a JSONL log.
#[derive(Debug, thiserror::Error)]
pub enum WriterError {
    /// `serde_json` failed to serialize the event. This is a programmer error
    /// (an event variant that contains a non-serializable type) rather than
    /// runtime data — surfaced for completeness.
    #[error("failed to serialize event: {0}")]
    Serialize(#[from] serde_json::Error),

    /// Filesystem write failed. The wrapped path identifies which file the
    /// writer was operating on (helpful for "disk full" debugging).
    #[error("io error writing {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// Caller tried to embed a literal newline inside a field that the
    /// JSONL spec forbids on the line. Cannot happen for our event schema
    /// (serde always JSON-escapes them) but reserved here for assertions.
    #[error("event JSON contained an unescaped newline")]
    EmbeddedNewline,
}

impl WriterError {
    fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

pub type WriterResult<T> = Result<T, WriterError>;

// ============================================================================
// EventLogWriter
// ============================================================================

/// Append-only JSONL writer. Owns a buffered file handle to one log file.
///
/// One instance per file — the store keeps one per active thread plus one
/// each for the index and settings logs.
pub struct EventLogWriter {
    /// Path being written, kept for diagnostics.
    path: PathBuf,
    /// Buffered handle. `None` iff the writer has been closed (terminal
    /// state — every subsequent write returns [`WriterError::Io`] with
    /// `BrokenPipe`, never a panic).
    inner: Option<BufWriter<File>>,
    /// Total events appended through this writer instance (not the file's
    /// historical line count). Used for tests and observability.
    events_written: u64,
}

impl EventLogWriter {
    /// Open `path` for append, creating it if needed. Parent directory must
    /// already exist — use [`crate::threads::paths`] helpers to ensure that.
    pub fn open(path: impl AsRef<Path>) -> WriterResult<Self> {
        let path = path.as_ref().to_path_buf();
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| WriterError::io(&path, e))?;

        // 8 KiB buffer is roughly one large event; bigger buffers don't help
        // because we flush on every event for durability anyway.
        let buf = BufWriter::with_capacity(8 * 1024, file);

        Ok(Self {
            path,
            inner: Some(buf),
            events_written: 0,
        })
    }

    /// Path of the file being written. Stable over the lifetime of the writer.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Number of events successfully appended through this writer instance.
    pub fn events_written(&self) -> u64 {
        self.events_written
    }

    /// Append one event, flushing to the OS page cache before returning.
    ///
    /// On success the bytes are guaranteed to be visible to other processes
    /// reading the file. They are *not* guaranteed to survive a power loss
    /// — call [`Self::sync`] for that, but use it sparingly (every fsync is
    /// expensive on Windows / macOS).
    pub fn append(&mut self, event: &ThreadEvent) -> WriterResult<()> {
        // serde_json emits compact, escaped JSON with no internal newlines.
        let line = serde_json::to_string(event)?;
        debug_assert!(
            !line.as_bytes().contains(&b'\n'),
            "serde_json should escape newlines"
        );
        if line.as_bytes().contains(&b'\n') {
            return Err(WriterError::EmbeddedNewline);
        }

        // Snapshot the path so we can use it for error context without
        // overlapping the &mut borrow on `self.inner`.
        let path = self.path.clone();
        let inner = self.writer_mut()?;
        inner
            .write_all(line.as_bytes())
            .map_err(|e| WriterError::io(&path, e))?;
        inner
            .write_all(b"\n")
            .map_err(|e| WriterError::io(&path, e))?;
        inner
            .flush()
            .map_err(|e| WriterError::io(&path, e))?;

        self.events_written += 1;
        Ok(())
    }

    /// fsync the underlying file. Forces durability past a power loss.
    ///
    /// Cost: ~1–10ms per call on a modern SSD; ~50ms+ on spinning disks. The
    /// store typically calls this at quiet moments (idle, app exit, explicit
    /// "save" hints) rather than on every append.
    pub fn sync(&mut self) -> WriterResult<()> {
        let path = self.path.clone();
        let inner = self.writer_mut()?;
        inner.flush().map_err(|e| WriterError::io(&path, e))?;
        inner
            .get_ref()
            .sync_data()
            .map_err(|e| WriterError::io(&path, e))
    }

    /// Flush remaining buffered bytes and close the file. The writer is
    /// unusable afterwards (subsequent calls return `BrokenPipe`).
    pub fn close(mut self) -> WriterResult<()> {
        if let Some(mut inner) = self.inner.take() {
            inner
                .flush()
                .map_err(|e| WriterError::io(&self.path, e))?;
            // Drop closes the underlying File.
            drop(inner);
        }
        Ok(())
    }

    fn writer_mut(&mut self) -> WriterResult<&mut BufWriter<File>> {
        match self.inner.as_mut() {
            Some(w) => Ok(w),
            None => Err(WriterError::io(
                &self.path,
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "writer is closed"),
            )),
        }
    }
}

impl Drop for EventLogWriter {
    fn drop(&mut self) {
        // Best-effort flush — if it fails, there's no caller to surface the
        // error to. We rely on `append` having already flushed each event.
        if let Some(mut inner) = self.inner.take() {
            let _ = inner.flush();
        }
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threads::events::{new_event_id, now_rfc3339_ms, EventToolCall, ThreadEvent};
    use std::io::{BufRead, BufReader};

    fn read_lines(path: &Path) -> Vec<String> {
        let f = File::open(path).expect("open");
        BufReader::new(f)
            .lines()
            .collect::<Result<Vec<_>, _>>()
            .expect("lines")
    }

    /// Round-trip: append three events, then read them back as JSONL lines.
    #[test]
    fn append_and_read_back_jsonl_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thread.jsonl");

        let mut w = EventLogWriter::open(&path).unwrap();
        let session = ThreadEvent::session("t1", Some("Hello".into()));
        let user = ThreadEvent::user_message("t1", session.id(), "hi", None, None);
        let asst = ThreadEvent::AssistantMessage {
            id: new_event_id(),
            parent_id: user.id().to_string(),
            thread_id: "t1".into(),
            turn_id: user.id().to_string(),
            timestamp: now_rfc3339_ms(),
            content: "hello back".into(),
            thinking: None,
            tool_calls: vec![],
        };

        w.append(&session).unwrap();
        w.append(&user).unwrap();
        w.append(&asst).unwrap();
        assert_eq!(w.events_written(), 3);
        w.close().unwrap();

        let lines = read_lines(&path);
        assert_eq!(lines.len(), 3, "expected exactly three JSONL lines");

        // Each line parses back into a ThreadEvent.
        let parsed: Vec<ThreadEvent> = lines
            .iter()
            .map(|l| serde_json::from_str(l).expect("parse"))
            .collect();
        assert_eq!(parsed[0].id(), session.id());
        assert_eq!(parsed[1].id(), user.id());
        assert_eq!(parsed[2].id(), asst.id());
    }

    /// Each append flushes — opening a separate reader between writes sees
    /// the new line immediately (no buffer-blocking).
    #[test]
    fn each_append_flushes_to_os() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thread.jsonl");

        let mut w = EventLogWriter::open(&path).unwrap();
        w.append(&ThreadEvent::session("t1", None)).unwrap();
        // Without closing, an outside reader can already see the line.
        let lines = read_lines(&path);
        assert_eq!(lines.len(), 1);
    }

    /// Open-with-append works on an existing file: new events tack onto the
    /// end without truncating prior history.
    #[test]
    fn reopen_appends_without_truncating() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thread.jsonl");

        {
            let mut w = EventLogWriter::open(&path).unwrap();
            w.append(&ThreadEvent::session("t1", None)).unwrap();
            w.close().unwrap();
        }
        {
            let mut w = EventLogWriter::open(&path).unwrap();
            w.append(&ThreadEvent::user_message("t1", "x", "second", None, None))
                .unwrap();
            w.close().unwrap();
        }
        assert_eq!(read_lines(&path).len(), 2);
    }

    /// JSON encoding escapes embedded newlines so we never split a logical
    /// event across two physical lines.
    #[test]
    fn embedded_newlines_are_escaped_not_split() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thread.jsonl");

        let mut w = EventLogWriter::open(&path).unwrap();
        let session_id = "session-multi";
        let event = ThreadEvent::user_message(
            "t1",
            session_id,
            "line one\nline two\nline three",
            None,
            None,
        );
        w.append(&event).unwrap();
        w.close().unwrap();

        // Exactly one physical line, even though the content has newlines.
        let lines = read_lines(&path);
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].contains("line one\\nline two\\nline three"),
            "newlines should be JSON-escaped: {}",
            lines[0]
        );
    }

    /// Tool calls embedded inside an assistant message survive the write.
    #[test]
    fn assistant_message_tool_calls_persist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thread.jsonl");

        let mut w = EventLogWriter::open(&path).unwrap();
        let asst = ThreadEvent::AssistantMessage {
            id: new_event_id(),
            parent_id: "parent".into(),
            thread_id: "t1".into(),
            turn_id: "turn".into(),
            timestamp: now_rfc3339_ms(),
            content: "calling tool".into(),
            thinking: Some("let me think".into()),
            tool_calls: vec![
                EventToolCall {
                    id: "c1".into(),
                    name: "file_read".into(),
                    arguments: r#"{"path":"/x"}"#.into(),
                },
                EventToolCall {
                    id: "c2".into(),
                    name: "grep".into(),
                    arguments: r#"{"pattern":"foo"}"#.into(),
                },
            ],
        };
        w.append(&asst).unwrap();
        w.close().unwrap();

        let line = read_lines(&path).pop().unwrap();
        let back: ThreadEvent = serde_json::from_str(&line).unwrap();
        match back {
            ThreadEvent::AssistantMessage { tool_calls, thinking, .. } => {
                assert_eq!(tool_calls.len(), 2);
                assert_eq!(tool_calls[0].name, "file_read");
                assert_eq!(thinking.as_deref(), Some("let me think"));
            }
            _ => panic!("expected AssistantMessage"),
        }
    }

    /// Closing the writer makes subsequent appends fail loudly instead of
    /// silently writing to a dead handle.
    #[test]
    fn append_after_close_returns_broken_pipe() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thread.jsonl");
        let mut w = EventLogWriter::open(&path).unwrap();

        // Take the inner handle to simulate a closed writer (keep self alive).
        w.inner.take();

        let err = w.append(&ThreadEvent::session("t1", None)).unwrap_err();
        match err {
            WriterError::Io { source, .. } => {
                assert_eq!(source.kind(), std::io::ErrorKind::BrokenPipe);
            }
            other => panic!("expected BrokenPipe Io, got {other:?}"),
        }
    }
}
