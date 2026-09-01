//! Watching a transcript while it is still being written.
//!
//! The file is appended to by another process — the running Aurora — with no
//! coordination beyond the filesystem. Everything here is built around the two
//! consequences of that:
//!
//! **A read can land mid-line.** The writer flushes after each event, but a
//! reader can still arrive between the bytes of a line and its newline. So a
//! line is only parsed once its terminating `\n` has been seen; anything after
//! the last newline is held in a buffer and completed on a later poll. Parsing
//! a partial line would produce a JSON error for a record that is perfectly
//! fine and about to arrive.
//!
//! **The end of the file is not the end of the task.** EOF here means "nothing
//! more *yet*". The transcript is finished when a
//! [`TaskEvent::Result`] line arrives, and not before — so the loop watches
//! for that event rather than for EOF.
//!
//! ## Ctrl-C detaches, it does not cancel
//!
//! The task belongs to the Agent Window, not to the terminal that dispatched
//! it. Interrupting the follower stops *watching*; the work carries on where
//! you can still see it. That is the honest behaviour — the alternative would
//! mean closing a terminal silently killed a long task — and [`follow`] says
//! so on the way out rather than leaving the user to guess.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::task::TaskEvent;

/// How long to wait between checks for new bytes.
///
/// 80ms is under the threshold where output stops feeling live, and it costs
/// one `read` on an already-open handle — cheap enough that a smarter
/// filesystem-notify path would add a dependency and a platform matrix to save
/// nothing measurable.
const POLL_INTERVAL: Duration = Duration::from_millis(80);

/// Anything that can go wrong following a transcript.
#[derive(Debug, thiserror::Error)]
pub enum FollowError {
    #[error("could not read the transcript: {0}")]
    Io(#[from] std::io::Error),

    #[error("timed out after {0:?} waiting for Aurora to start the task")]
    Timeout(Duration),

    #[error("stopped watching")]
    Interrupted,
}

/// Why a follow loop ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowOutcome {
    /// A `result` line arrived — the task is over.
    Finished,
    /// The user interrupted the follower. The task is still running.
    Detached,
    /// Nothing arrived within the caller's patience.
    TimedOut,
}

/// An incremental reader over an append-only JSONL file.
///
/// Holds its own byte offset rather than an open handle across polls, so a
/// writer on Windows is never blocked by the follower's share mode, and a file
/// that has not been created yet is simply "no bytes so far".
pub struct Tail {
    path: PathBuf,
    /// Bytes consumed and handed to the caller so far.
    offset: u64,
    /// Bytes after the last newline: a line still being written.
    partial: String,
}

impl Tail {
    /// Start following `path` from the beginning.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            offset: 0,
            partial: String::new(),
        }
    }

    /// Start following from the current end of the file, skipping history.
    ///
    /// For attaching to a task that is already running when you only want what
    /// happens from now on.
    pub fn from_end(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let offset = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        Self {
            path,
            offset,
            partial: String::new(),
        }
    }

    /// The file being followed.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read whatever is newly complete.
    ///
    /// Returns only lines terminated by a newline. A line that fails to parse
    /// is skipped rather than fatal: the transcript is the record of a run in
    /// progress, and one malformed record must not end the watch on a task
    /// that is otherwise healthy.
    pub fn poll(&mut self) -> Result<Vec<TaskEvent>, FollowError> {
        let mut file = match std::fs::File::open(&self.path) {
            Ok(file) => file,
            // Not created yet — the dispatch is still being written.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };

        let len = file.metadata()?.len();
        if len < self.offset {
            // The file shrank, which means it was replaced — a task id reused
            // after a sweep, or the folder cleared underneath us. Re-reading
            // from the old offset would splice two runs together, so restart.
            self.offset = 0;
            self.partial.clear();
        }
        if len == self.offset {
            return Ok(Vec::new());
        }

        file.seek(SeekFrom::Start(self.offset))?;
        let mut fresh = Vec::with_capacity((len - self.offset) as usize);
        let read = file.read_to_end(&mut fresh)?;
        self.offset += read as u64;

        // Lossy rather than strict: a read can split a multi-byte character
        // across two polls, and failing the whole batch over a half-arrived
        // codepoint would drop records that are about to be complete. The
        // replacement character lands only in the partial tail, which is
        // re-read as valid text once the rest arrives.
        self.partial.push_str(&String::from_utf8_lossy(&fresh));

        let mut events = Vec::new();
        // `split` (not `lines`) so the final element is explicitly the
        // unterminated remainder — `lines` cannot tell "ended with \n" from
        // "did not", which is exactly the distinction that matters here.
        let mut chunks: Vec<&str> = self.partial.split('\n').collect();
        let remainder = chunks.pop().unwrap_or_default().to_string();
        for chunk in chunks {
            let line = chunk.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(event) = serde_json::from_str::<TaskEvent>(line) {
                events.push(event);
            }
        }
        self.partial = remainder;

        Ok(events)
    }
}

/// What a follow loop reports to its caller for each event.
pub type OnEvent<'a> = &'a mut dyn FnMut(&TaskEvent);

/// Follow a transcript until it finishes, or the caller gives up.
///
/// `first_event_timeout` bounds only the wait for the *first* event, not the
/// run. That split is deliberate: a task that never starts means nothing
/// claimed it — Aurora is not running, or is wedged — and the user should be
/// told rather than left watching an empty file. A task that has started may
/// legitimately run for an hour, and cutting it off on a clock would abandon
/// work that is going fine.
pub fn follow(
    tail: &mut Tail,
    first_event_timeout: Option<Duration>,
    interrupted: &dyn Fn() -> bool,
    on_event: OnEvent<'_>,
) -> Result<FollowOutcome, FollowError> {
    let started = Instant::now();
    let mut seen_any = false;

    loop {
        if interrupted() {
            return Ok(FollowOutcome::Detached);
        }

        let events = tail.poll()?;
        for event in &events {
            seen_any = true;
            on_event(event);
            if matches!(event, TaskEvent::Result { .. }) {
                return Ok(FollowOutcome::Finished);
            }
        }

        if !seen_any {
            if let Some(limit) = first_event_timeout {
                if started.elapsed() >= limit {
                    return Ok(FollowOutcome::TimedOut);
                }
            }
        }

        // Only sleep when there was nothing to do. A burst of buffered events
        // should drain at full speed rather than at one poll interval each.
        if events.is_empty() {
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_delegate::task::ResultKind;
    use std::io::Write;

    fn text_line(text: &str) -> String {
        format!(
            "{}\n",
            serde_json::to_string(&TaskEvent::Text {
                text: text.to_string()
            })
            .expect("serialise")
        )
    }

    fn result_line() -> String {
        format!(
            "{}\n",
            serde_json::to_string(&TaskEvent::Result {
                subtype: ResultKind::Success,
                result: Some("done".to_string()),
                error: None,
                duration_ms: 10,
                num_turns: 1,
            })
            .expect("serialise")
        )
    }

    #[test]
    fn a_missing_file_yields_nothing_rather_than_failing() {
        // The follower attaches before the writer has created the file.
        let mut tail = Tail::new(r"Z:\aurora-no-such-transcript.jsonl");
        assert!(tail.poll().expect("poll").is_empty());
    }

    #[test]
    fn complete_lines_are_returned() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, format!("{}{}", text_line("one"), text_line("two")))
            .expect("write");

        let mut tail = Tail::new(&path);
        let events = tail.poll().expect("poll");
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn a_half_written_line_is_held_until_it_completes() {
        // The core hazard: reading between a line's bytes and its newline.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        let whole = text_line("hello");
        let split_at = whole.len() / 2;

        std::fs::write(&path, &whole[..split_at]).expect("write half");
        let mut tail = Tail::new(&path);
        assert!(
            tail.poll().expect("poll").is_empty(),
            "a partial line must not be parsed"
        );

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open");
        file.write_all(whole[split_at..].as_bytes()).expect("write rest");

        let events = tail.poll().expect("poll");
        assert_eq!(events.len(), 1, "the completed line should arrive");
        match &events[0] {
            TaskEvent::Text { text } => assert_eq!(text, "hello"),
            other => panic!("unexpected event {other:?}"),
        }
    }

    #[test]
    fn each_poll_returns_only_what_is_new() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, text_line("one")).expect("write");

        let mut tail = Tail::new(&path);
        assert_eq!(tail.poll().expect("poll").len(), 1);
        assert!(tail.poll().expect("poll").is_empty(), "re-delivered a line");

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open");
        file.write_all(text_line("two").as_bytes()).expect("append");
        assert_eq!(tail.poll().expect("poll").len(), 1);
    }

    #[test]
    fn a_malformed_line_does_not_end_the_watch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        std::fs::write(
            &path,
            format!("{}{{ broken\n{}", text_line("one"), text_line("two")),
        )
        .expect("write");

        let mut tail = Tail::new(&path);
        let events = tail.poll().expect("poll");
        assert_eq!(events.len(), 2, "the good lines must still arrive");
    }

    #[test]
    fn blank_lines_are_ignored() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, format!("\n\n{}\n", text_line("one"))).expect("write");
        assert_eq!(Tail::new(&path).poll().expect("poll").len(), 1);
    }

    #[test]
    fn a_replaced_file_is_re_read_from_the_start() {
        // A swept task id being reused: the file shrinks. Continuing from the
        // old offset would splice the tail of a new run onto an old one.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, format!("{}{}", text_line("one"), text_line("two")))
            .expect("write");

        let mut tail = Tail::new(&path);
        assert_eq!(tail.poll().expect("poll").len(), 2);

        std::fs::write(&path, text_line("fresh")).expect("replace");
        let events = tail.poll().expect("poll");
        assert_eq!(events.len(), 1);
        match &events[0] {
            TaskEvent::Text { text } => assert_eq!(text, "fresh"),
            other => panic!("unexpected event {other:?}"),
        }
    }

    #[test]
    fn from_end_skips_existing_history() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, text_line("old")).expect("write");

        let mut tail = Tail::from_end(&path);
        assert!(tail.poll().expect("poll").is_empty());

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open");
        file.write_all(text_line("new").as_bytes()).expect("append");
        assert_eq!(tail.poll().expect("poll").len(), 1);
    }

    #[test]
    fn follow_stops_on_the_result_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, format!("{}{}", text_line("working"), result_line()))
            .expect("write");

        let mut seen = 0usize;
        let outcome = follow(
            &mut Tail::new(&path),
            Some(Duration::from_secs(5)),
            &|| false,
            &mut |_event| seen += 1,
        )
        .expect("follow");

        assert_eq!(outcome, FollowOutcome::Finished);
        assert_eq!(seen, 2);
    }

    #[test]
    fn follow_reports_a_task_that_never_starts() {
        // Nothing claimed the task — Aurora is not running.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("empty.jsonl");
        std::fs::write(&path, "").expect("write");

        let outcome = follow(
            &mut Tail::new(&path),
            Some(Duration::from_millis(200)),
            &|| false,
            &mut |_event| {},
        )
        .expect("follow");

        assert_eq!(outcome, FollowOutcome::TimedOut);
    }

    #[test]
    fn follow_detaches_when_interrupted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, text_line("working")).expect("write");

        let outcome = follow(&mut Tail::new(&path), None, &|| true, &mut |_event| {})
            .expect("follow");
        assert_eq!(
            outcome,
            FollowOutcome::Detached,
            "Ctrl-C must detach, never cancel"
        );
    }

    #[test]
    fn a_started_task_is_not_subject_to_the_start_timeout() {
        // Once events flow the clock stops applying: a long turn is normal.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, format!("{}{}", text_line("working"), result_line()))
            .expect("write");

        let outcome = follow(
            &mut Tail::new(&path),
            // Already elapsed by any measure.
            Some(Duration::from_nanos(1)),
            &|| false,
            &mut |_event| {},
        )
        .expect("follow");

        assert_eq!(outcome, FollowOutcome::Finished);
    }
}
