//! Streaming reader for thread JSONL logs.
//!
//! The reader is built around two priorities:
#![allow(dead_code)]
//
// `CorruptedLine` fields and `ReadOutcome::is_empty` are surfaced by the
// telemetry sink that ships in the next phase; keep the dead-code lint quiet
// in the meantime.
//!
//! 1. **Tolerance to the last line being a half-write.** A power loss between
//!    `write_all` and `flush` can leave the final line truncated. Rather than
//!    refusing to load the entire thread, we drop the bad tail and surface a
//!    diagnostic on the [`ReadOutcome`].
//! 2. **Forward compatibility.** Lines that deserialize into
//!    [`ThreadEvent::Unknown`] (a future event type this build doesn't know
//!    about yet) are skipped silently — the projector ignores them and the
//!    writer round-trips them on subsequent appends because we never rewrite
//!    history.
//!
//! Reading is eager (returns `Vec<ThreadEvent>`) because the projector folds
//! the entire history into a snapshot before serving any request, so a lazy
//! iterator wouldn't actually save work.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::threads::events::ThreadEvent;

/// Errors returned by the reader.
///
/// Per-line corruption is *not* an error — it lands in
/// [`ReadOutcome::corrupted_lines`]. These errors are reserved for failures
/// that prevent any reading at all (file missing, permissions, etc.).
#[derive(Debug, thiserror::Error)]
pub enum ReaderError {
    #[error("io error reading {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl ReaderError {
    fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

pub type ReaderResult<T> = Result<T, ReaderError>;

// ============================================================================
// ReadOutcome
// ============================================================================

/// Result of replaying a JSONL log. Carries the parsed events plus
/// diagnostics describing anything the reader skipped.
#[derive(Debug, Clone)]
pub struct ReadOutcome {
    /// Successfully parsed events, in file order.
    pub events: Vec<ThreadEvent>,
    /// Number of lines that deserialized into [`ThreadEvent::Unknown`]. Not
    /// errors — they round-trip on the next write.
    pub unknown_events: u64,
    /// Per-line decode failures. Each entry is `(line_number, raw_line)`.
    /// The reader skips them and continues. Empty when the file is healthy.
    pub corrupted_lines: Vec<CorruptedLine>,
    /// `true` if the **last** physical line failed to parse and looks like a
    /// torn write (incomplete JSON object). The store can emit a diagnostic
    /// or repair on next append; either way the data is intact.
    pub truncated_tail: bool,
}

/// One line that failed to deserialize cleanly.
#[derive(Debug, Clone)]
pub struct CorruptedLine {
    /// 1-based line number in the file.
    pub line_number: u64,
    /// The raw line bytes (lossily decoded as UTF-8). Capped to 256 chars to
    /// keep diagnostics compact.
    pub raw: String,
    /// Stringified serde error. Useful for telemetry.
    pub error: String,
}

impl ReadOutcome {
    fn empty() -> Self {
        Self {
            events: Vec::new(),
            unknown_events: 0,
            corrupted_lines: Vec::new(),
            truncated_tail: false,
        }
    }

    /// `true` if no events were parsed.
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

// ============================================================================
// Reader entrypoints
// ============================================================================

/// Replay every event in a JSONL log file at `path`.
///
/// Returns [`ReadOutcome::empty`] when the file does not exist (the agent
/// treats "no file" identically to "empty file").
pub fn read_log(path: impl AsRef<Path>) -> ReaderResult<ReadOutcome> {
    let path = path.as_ref();
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ReadOutcome::empty()),
        Err(e) => return Err(ReaderError::io(path.to_path_buf(), e)),
    };
    read_from(BufReader::new(file), path)
}

/// Same as [`read_log`] but takes any `BufRead`. Exposed so tests can feed
/// in-memory bytes without touching disk.
pub fn read_from<R: BufRead>(reader: R, path: impl AsRef<Path>) -> ReaderResult<ReadOutcome> {
    let path = path.as_ref().to_path_buf();
    let mut outcome = ReadOutcome::empty();

    // Buffer the lines so we know where the *last* line is — corruption on
    // the last line is treated as a torn write, corruption mid-file is a
    // real fault.
    let lines: Vec<String> = reader
        .lines()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| ReaderError::io(&path, e))?;

    let last_index = lines.len().saturating_sub(1);

    for (idx, raw) in lines.into_iter().enumerate() {
        let line_number = idx as u64 + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            // Blank lines are tolerated (e.g. accidental editor save). Skip.
            continue;
        }

        match serde_json::from_str::<ThreadEvent>(trimmed) {
            Ok(ThreadEvent::Unknown) => {
                outcome.unknown_events += 1;
            }
            Ok(event) => outcome.events.push(event),
            Err(err) => {
                let truncated = idx == last_index;
                outcome.corrupted_lines.push(CorruptedLine {
                    line_number,
                    raw: truncate_for_diagnostic(&raw),
                    error: err.to_string(),
                });
                if truncated {
                    outcome.truncated_tail = true;
                }
            }
        }
    }

    Ok(outcome)
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

fn truncate_for_diagnostic(s: &str) -> String {
    const MAX: usize = 256;
    if s.len() <= MAX {
        return s.to_string();
    }
    let truncate_at = s
        .char_indices()
        .take_while(|(i, _)| *i < MAX)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    format!("{}…", &s[..truncate_at])
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threads::events::{new_event_id, now_rfc3339_ms, ThreadEvent};
    use crate::threads::writer::EventLogWriter;
    use std::io::Cursor;

    fn make_session(thread: &str) -> ThreadEvent {
        ThreadEvent::session(thread, Some("Test thread".into()))
    }

    /// Reading a non-existent file returns an empty outcome (not an error).
    #[test]
    fn missing_file_is_treated_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let outcome = read_log(dir.path().join("does-not-exist.jsonl")).unwrap();
        assert!(outcome.is_empty());
        assert!(!outcome.truncated_tail);
    }

    /// Healthy file with three events round-trips through writer + reader.
    #[test]
    fn round_trip_via_writer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");

        let s = make_session("t1");
        let u = ThreadEvent::user_message("t1", s.id(), "hello", None, None);
        let a = ThreadEvent::AssistantMessage {
            id: new_event_id(),
            parent_id: u.id().to_string(),
            thread_id: "t1".into(),
            turn_id: u.id().to_string(),
            timestamp: now_rfc3339_ms(),
            content: "hi".into(),
            thinking: None,
            tool_calls: vec![],
        };

        let mut w = EventLogWriter::open(&path).unwrap();
        w.append(&s).unwrap();
        w.append(&u).unwrap();
        w.append(&a).unwrap();
        w.close().unwrap();

        let outcome = read_log(&path).unwrap();
        assert_eq!(outcome.events.len(), 3);
        assert!(outcome.corrupted_lines.is_empty());
        assert!(!outcome.truncated_tail);
    }

    /// A torn last line is reported as `truncated_tail`, prior events still
    /// parse cleanly.
    #[test]
    fn truncated_last_line_is_reported_as_torn_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");

        let mut w = EventLogWriter::open(&path).unwrap();
        w.append(&make_session("t1")).unwrap();
        w.close().unwrap();

        // Hand-append a half-written event (no trailing brace).
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(b"{\"type\":\"user_message\",\"id\":\"x\",\"parent_id\":\"y");
        std::fs::write(&path, bytes).unwrap();

        let outcome = read_log(&path).unwrap();
        assert_eq!(outcome.events.len(), 1, "session should still parse");
        assert_eq!(outcome.corrupted_lines.len(), 1);
        assert!(outcome.truncated_tail);
    }

    /// Corruption *mid-file* is reported on its own line, not classified as
    /// a torn tail, and the rest of the file still parses.
    #[test]
    fn mid_file_corruption_does_not_set_truncated_tail() {
        let payload = format!(
            "{}\n{}\n{}\n",
            serde_json::to_string(&make_session("t1")).unwrap(),
            r#"{"type":"user_message","this is not valid json"#,
            serde_json::to_string(&make_session("t1")).unwrap(),
        );

        let outcome = read_from(Cursor::new(payload.as_bytes()), "memory").unwrap();
        assert_eq!(outcome.events.len(), 2, "good lines parsed");
        assert_eq!(outcome.corrupted_lines.len(), 1);
        assert_eq!(outcome.corrupted_lines[0].line_number, 2);
        assert!(!outcome.truncated_tail);
    }

    /// Unknown event types from a newer schema are counted but don't appear
    /// in `events` and don't error.
    #[test]
    fn unknown_event_types_are_skipped_quietly() {
        let payload = format!(
            "{}\n{}\n",
            serde_json::to_string(&make_session("t1")).unwrap(),
            r#"{"type":"some_future_v2_event","id":"x","thread_id":"t1","timestamp":"2026-05-03T00:00:00.000Z"}"#,
        );

        let outcome = read_from(Cursor::new(payload.as_bytes()), "memory").unwrap();
        assert_eq!(outcome.events.len(), 1);
        assert_eq!(outcome.unknown_events, 1);
        assert!(outcome.corrupted_lines.is_empty());
    }

    /// Blank lines (e.g. from an editor inserting a trailing newline twice)
    /// don't show up as corruption.
    #[test]
    fn blank_lines_are_skipped() {
        let payload = format!(
            "{}\n\n\n{}\n",
            serde_json::to_string(&make_session("t1")).unwrap(),
            serde_json::to_string(&ThreadEvent::user_message(
                "t1", "p", "hi", None, None
            ))
            .unwrap(),
        );
        let outcome = read_from(Cursor::new(payload.as_bytes()), "memory").unwrap();
        assert_eq!(outcome.events.len(), 2);
        assert!(outcome.corrupted_lines.is_empty());
    }

    /// Diagnostic strings cap at the documented size so a multi-MB corrupt
    /// line doesn't blow up the error report.
    #[test]
    fn diagnostic_lines_are_capped() {
        let huge = "x".repeat(10_000);
        let truncated = truncate_for_diagnostic(&huge);
        assert!(truncated.len() < huge.len());
        assert!(truncated.ends_with('…'));
    }
}
