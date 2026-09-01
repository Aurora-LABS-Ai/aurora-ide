//! The task directory: writing a request, claiming it, and appending to its
//! transcript.
//!
//! Two processes share this folder with no lock between them — the `aurora`
//! CLI that writes requests, and the running Aurora that executes them. Every
//! operation here is built so that an interleaving cannot produce a half-read
//! request or a task run twice.
//!
//! ## The two atomicity rules
//!
//! **Writing a request is write-then-rename.** The JSON goes to
//! `<id>.task.json.tmp` and is renamed into place once complete. A reader
//! scanning the directory therefore sees either no file or a whole one — never
//! the first 40 bytes of a request whose prompt is still being written. This
//! is the same discipline `code_index::persist` uses for its cache, for the
//! same reason.
//!
//! **Claiming a request is a rename.** `<id>.task.json` →
//! `<id>.claimed.json`. Rename-into-an-existing-name fails on Windows and
//! replaces on Unix, so the claim is expressed as "rename succeeded", which
//! only one caller can observe. Two Aurora windows sweeping the same folder at
//! the same instant cannot both win, and the loser sees a plain "already
//! claimed" rather than running the user's task a second time.
//!
//! A lock file would need an owner, an expiry, and a story for a process that
//! dies holding it. A rename needs none of those.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::task::{
    TaskEvent, TaskRequest, CLAIMED_SUFFIX, TASK_FORMAT_VERSION, TASK_SUFFIX, TRANSCRIPT_SUFFIX,
};
use crate::paths;

/// Anything that can go wrong handling the task directory.
#[derive(Debug, thiserror::Error)]
pub enum InboxError {
    #[error("cli task directory: {0}")]
    Io(#[from] std::io::Error),
    #[error("cli task is not valid JSON: {0}")]
    Malformed(#[from] serde_json::Error),
    #[error(
        "cli task was written by a different version of Aurora \
         (task format v{found}, this build speaks v{expected}) — \
         re-run the command with the current `aurora`"
    )]
    VersionMismatch { found: u32, expected: u32 },
    #[error("cli task {0} was already claimed by another Aurora window")]
    AlreadyClaimed(String),
}

/// The task directory, resolved once.
///
/// A struct rather than free functions so tests can point it at a temp dir.
/// Nothing about the logic depends on it being the real app-data location, and
/// a test that writes into the user's actual task inbox is how a stray
/// dispatch ends up running on someone's machine.
#[derive(Debug, Clone)]
pub struct Inbox {
    dir: PathBuf,
}

impl Inbox {
    /// The real task directory under the Aurora root.
    pub fn open() -> Self {
        Self {
            dir: paths::cli_tasks_dir(),
        }
    }

    /// An inbox rooted at an arbitrary directory. Used by tests.
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The directory itself.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Path of a pending request.
    pub fn task_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}{TASK_SUFFIX}"))
    }

    /// Path a request is renamed to once claimed.
    pub fn claimed_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}{CLAIMED_SUFFIX}"))
    }

    /// Path of a transcript.
    pub fn transcript_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}{TRANSCRIPT_SUFFIX}"))
    }

    /// Write a request, atomically. Returns the path it landed at.
    ///
    /// The transcript is created empty in the same call, before the request
    /// becomes visible. A follower started immediately after this returns
    /// would otherwise race the claiming process for the file's existence and
    /// have to poll for it; this way the file is always there to open, and
    /// "empty" simply means "not started yet".
    pub fn write_request(&self, request: &TaskRequest) -> Result<PathBuf, InboxError> {
        fs::create_dir_all(&self.dir)?;

        let transcript = self.transcript_path(&request.id);
        if !transcript.exists() {
            fs::File::create(&transcript)?;
        }

        let final_path = self.task_path(&request.id);
        let temp_path = final_path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(request)?;
        {
            let mut file = fs::File::create(&temp_path)?;
            file.write_all(json.as_bytes())?;
            // Flush to the OS before the rename. Without it the rename can be
            // ordered ahead of the data on a crash, publishing a task file
            // that is present but empty.
            file.sync_all()?;
        }
        fs::rename(&temp_path, &final_path)?;
        Ok(final_path)
    }

    /// Every request waiting to be claimed, oldest first.
    ///
    /// Ordering is by filename, which is chronological because task ids lead
    /// with a UTC timestamp — so a backlog is worked in the order it was
    /// dispatched rather than in whatever order the filesystem enumerates.
    ///
    /// A file that fails to parse is skipped, not fatal: one corrupt request
    /// must not stop every other queued task from running. The caller logs it;
    /// the file stays put so it can be inspected.
    pub fn pending(&self) -> Result<Vec<TaskRequest>, InboxError> {
        let mut ids: Vec<String> = Vec::new();
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            // No directory yet simply means nothing has ever been dispatched.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(TASK_SUFFIX) {
                ids.push(id.to_string());
            }
        }
        ids.sort();

        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            match self.read_request(&self.task_path(&id)) {
                Ok(request) => out.push(request),
                Err(_) => continue,
            }
        }
        Ok(out)
    }

    /// Read and validate one request file.
    pub fn read_request(&self, path: &Path) -> Result<TaskRequest, InboxError> {
        let text = fs::read_to_string(path)?;
        let request: TaskRequest = serde_json::from_str(&text)?;
        if request.version != TASK_FORMAT_VERSION {
            return Err(InboxError::VersionMismatch {
                found: request.version,
                expected: TASK_FORMAT_VERSION,
            });
        }
        Ok(request)
    }

    /// Take ownership of a pending request.
    ///
    /// Succeeds for exactly one caller. See the module docs for why this is a
    /// rename and not a lock.
    pub fn claim(&self, id: &str) -> Result<TaskRequest, InboxError> {
        let pending = self.task_path(id);
        let claimed = self.claimed_path(id);

        // Read before renaming: if the rename wins but the read then fails we
        // would have consumed a task we cannot run, and it would be invisible
        // to the next sweep.
        let request = self.read_request(&pending)?;

        fs::rename(&pending, &claimed).map_err(|error| match error.kind() {
            // Someone else got there first — the source no longer exists.
            std::io::ErrorKind::NotFound => InboxError::AlreadyClaimed(id.to_string()),
            _ => InboxError::Io(error),
        })?;

        Ok(request)
    }

    /// Open a transcript for appending.
    pub fn transcript(&self, id: &str) -> Result<Transcript, InboxError> {
        fs::create_dir_all(&self.dir)?;
        Transcript::open(self.transcript_path(id), None)
    }

    /// Delete both files for a task.
    ///
    /// Not called automatically on completion: a finished transcript is the
    /// record of what Aurora did with your instruction, and deleting it the
    /// moment the turn ends would mean a task that finished while you were
    /// away left nothing behind. Retention is [`Self::sweep_older_than`].
    pub fn remove(&self, id: &str) -> Result<(), InboxError> {
        for path in [
            self.task_path(id),
            self.claimed_path(id),
            self.transcript_path(id),
        ] {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    /// Delete finished tasks whose transcript is older than `days`.
    ///
    /// Only *claimed* tasks are swept. An unclaimed request is work that has
    /// not run yet — possibly dispatched against an Aurora that has not
    /// started — and deleting it on age would silently drop the user's
    /// instruction.
    pub fn sweep_older_than(&self, days: i64) -> Result<usize, InboxError> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error.into()),
        };

        let cutoff = std::time::SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(days.max(0) as u64 * 86_400));
        let Some(cutoff) = cutoff else {
            return Ok(0);
        };

        let mut removed = 0usize;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(CLAIMED_SUFFIX) else {
                continue;
            };
            let modified = entry.metadata().and_then(|meta| meta.modified()).ok();
            if modified.is_some_and(|when| when < cutoff) {
                self.remove(id)?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}

/// An open, append-only transcript.
///
/// Every [`Self::append`] flushes. That is the whole point of the file: a
/// follower in another process — a `tail -f`, another agent, the CLI's own
/// `--follow` — is reading it *while* the turn runs, and buffered writes would
/// deliver the run in silent chunks separated by long pauses. The cost is a
/// flush per event, against a file written a few times a second.
pub struct Transcript {
    file: fs::File,
    /// Optional second file at the caller's `--out` path.
    mirror: Option<fs::File>,
}

impl Transcript {
    /// Open (or create) a transcript, plus an optional mirror copy.
    pub fn open(path: PathBuf, mirror: Option<PathBuf>) -> Result<Self, InboxError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = fs::OpenOptions::new().create(true).append(true).open(&path)?;

        let mirror = match mirror {
            Some(mirror_path) => {
                if let Some(parent) = mirror_path.parent() {
                    // A `--out` path the user chose may name a directory that
                    // does not exist. Creating it is friendlier than refusing
                    // the dispatch over a missing folder.
                    if !parent.as_os_str().is_empty() {
                        fs::create_dir_all(parent)?;
                    }
                }
                Some(
                    fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&mirror_path)?,
                )
            }
            None => None,
        };

        Ok(Self { file, mirror })
    }

    /// Append one event as a single line.
    ///
    /// A serialisation failure is reported rather than swallowed, but it can
    /// only mean a non-finite float or a map with non-string keys reached a
    /// payload — both bugs in the producer, not conditions to hide.
    pub fn append(&mut self, event: &TaskEvent) -> Result<(), InboxError> {
        let mut line = serde_json::to_string(event)?;
        line.push('\n');
        self.file.write_all(line.as_bytes())?;
        self.file.flush()?;
        if let Some(mirror) = self.mirror.as_mut() {
            // A failing mirror must not kill the run: the canonical transcript
            // is the one in the task directory, and `--out` is a convenience.
            // Losing the copy is worth strictly less than losing the turn.
            let _ = mirror.write_all(line.as_bytes());
            let _ = mirror.flush();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_delegate::task::{new_task_id, ResultKind, TaskMode, TaskOrigin};

    fn request(id: &str) -> TaskRequest {
        TaskRequest {
            version: TASK_FORMAT_VERSION,
            id: id.to_string(),
            created_at: "2026-09-01T14:22:33Z".to_string(),
            prompt: "do the thing".to_string(),
            workspace_path: r"E:\project".to_string(),
            thread_id: None,
            provider_id: Some("fireworks".to_string()),
            model: Some("glm-5.2".to_string()),
            mode: TaskMode::Agent,
            out_path: None,
            origin: TaskOrigin {
                pid: 1,
                cwd: None,
                host: None,
            },
        }
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let id = new_task_id();

        inbox.write_request(&request(&id)).expect("write");

        let pending = inbox.pending().expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].prompt, "do the thing");
        assert_eq!(pending[0].model_pin().as_deref(), Some("fireworks:glm-5.2"));
    }

    #[test]
    fn write_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let id = new_task_id();
        inbox.write_request(&request(&id)).expect("write");

        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read_dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file survived: {leftovers:?}");
    }

    #[test]
    fn transcript_exists_before_the_request_is_visible() {
        // A follower attaches the instant dispatch returns; the file it wants
        // to tail has to already be there.
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let id = new_task_id();
        inbox.write_request(&request(&id)).expect("write");
        assert!(inbox.transcript_path(&id).exists());
    }

    #[test]
    fn only_one_claim_can_win() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let id = new_task_id();
        inbox.write_request(&request(&id)).expect("write");

        let first = inbox.claim(&id);
        assert!(first.is_ok(), "first claim should win");

        // The second Aurora window sweeping the same folder.
        let second = inbox.claim(&id);
        assert!(
            matches!(second, Err(InboxError::AlreadyClaimed(_)) | Err(InboxError::Io(_))),
            "a second claim must not succeed, got {second:?}"
        );
    }

    #[test]
    fn claimed_tasks_leave_the_pending_list() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let id = new_task_id();
        inbox.write_request(&request(&id)).expect("write");
        inbox.claim(&id).expect("claim");

        assert!(inbox.pending().expect("pending").is_empty());
        assert!(inbox.claimed_path(&id).exists());
    }

    #[test]
    fn pending_is_ordered_oldest_first() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        // Hand-written ids so the ordering under test is the filename's, not
        // whatever the clock happened to produce during the test.
        for id in ["20260901T100000-aaa", "20260901T090000-bbb"] {
            inbox.write_request(&request(id)).expect("write");
        }
        let pending = inbox.pending().expect("pending");
        assert_eq!(pending[0].id, "20260901T090000-bbb");
        assert_eq!(pending[1].id, "20260901T100000-aaa");
    }

    #[test]
    fn a_corrupt_request_does_not_hide_the_others() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        inbox.write_request(&request("20260901T100000-good")).expect("write");
        fs::write(
            dir.path().join(format!("20260901T090000-bad{TASK_SUFFIX}")),
            "{ this is not json",
        )
        .expect("write junk");

        let pending = inbox.pending().expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "20260901T100000-good");
    }

    #[test]
    fn a_future_format_version_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let mut future = request("20260901T100000-future");
        future.version = TASK_FORMAT_VERSION + 1;
        inbox.write_request(&future).expect("write");

        let error = inbox.read_request(&inbox.task_path(&future.id));
        assert!(matches!(error, Err(InboxError::VersionMismatch { .. })));
    }

    #[test]
    fn missing_directory_reads_as_empty() {
        let inbox = Inbox::at(r"Z:\aurora-inbox-that-does-not-exist");
        assert!(inbox.pending().expect("pending").is_empty());
    }

    #[test]
    fn transcript_writes_one_line_per_event() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let id = new_task_id();
        let mut transcript = inbox.transcript(&id).expect("open");

        transcript
            .append(&TaskEvent::Text {
                text: "line one\nstill line one".to_string(),
            })
            .expect("append");
        transcript
            .append(&TaskEvent::Result {
                subtype: ResultKind::Success,
                result: Some("done".to_string()),
                error: None,
                duration_ms: 5,
                num_turns: 1,
            })
            .expect("append");

        let body = fs::read_to_string(inbox.transcript_path(&id)).expect("read");
        let lines: Vec<_> = body.lines().collect();
        assert_eq!(lines.len(), 2, "embedded newline split a record");
        // Every line must independently parse — that is the contract a
        // follower depends on.
        for line in lines {
            serde_json::from_str::<TaskEvent>(line).expect("line parses");
        }
    }

    #[test]
    fn transcript_mirror_receives_the_same_lines() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("nested").join("run.jsonl");
        let mut transcript =
            Transcript::open(dir.path().join("main.jsonl"), Some(out.clone())).expect("open");
        transcript
            .append(&TaskEvent::Notice {
                message: "retrying".to_string(),
            })
            .expect("append");

        // The nested directory the user named did not exist beforehand.
        let mirrored = fs::read_to_string(&out).expect("mirror written");
        assert!(mirrored.contains("retrying"));
    }

    #[test]
    fn sweep_leaves_unclaimed_work_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let id = new_task_id();
        inbox.write_request(&request(&id)).expect("write");

        // Age 0 would sweep anything eligible; an unclaimed request is not.
        let removed = inbox.sweep_older_than(0).expect("sweep");
        assert_eq!(removed, 0);
        assert_eq!(inbox.pending().expect("pending").len(), 1);
    }

    #[test]
    fn sweep_removes_claimed_work() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let id = new_task_id();
        inbox.write_request(&request(&id)).expect("write");
        inbox.claim(&id).expect("claim");

        let removed = inbox.sweep_older_than(0).expect("sweep");
        assert_eq!(removed, 1);
        assert!(!inbox.claimed_path(&id).exists());
        assert!(!inbox.transcript_path(&id).exists());
    }

    #[test]
    fn remove_is_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        inbox.remove("never-existed").expect("first remove");
        inbox.remove("never-existed").expect("second remove");
    }
}
