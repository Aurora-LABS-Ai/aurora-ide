//! Stopping a dispatched task from outside the app.
//!
//! Stop has always existed in the Agent Window. What did not exist is a way to
//! reach it from the thing that started the work — a terminal that has walked
//! away, or an agent that dispatched a run and has since decided it asked for
//! the wrong thing. That is what this adds: `aurora cancel <id>`, and the
//! `aurora_agent_cancel` tool.
//!
//! ## A marker file, for the same reason the request is one
//!
//! A cancel is a second message to the same recipient, so it travels the same
//! way: `<id>.cancel` lands beside the request in [`crate::paths::cli_tasks_dir`]
//! and the watcher already watching that directory picks it up. No new channel,
//! no new failure mode, and it works when the app is mid-start.
//!
//! The file is empty. Everything a canceller could put in it — who, when, why —
//! is either already known from the id or is not acted on, and an empty file
//! cannot be half-written.
//!
//! ## The three orderings, and why the marker is not always consumed at once
//!
//! A cancel can arrive at any point in a task's life, and each point is handled
//! by whoever is in a position to act:
//!
//! | when it arrives | who handles it | what happens |
//! |---|---|---|
//! | before the app claims the task | the watcher | the request is deleted; it never runs |
//! | while the turn is running | the watcher | the turn is cancelled through the registry |
//! | between claim and turn start | [`super::mirror::bind`] | the turn is refused before it begins |
//!
//! The third row is the one that forces the design. There is a window of a
//! second or two where the app owns the task but no turn exists to cancel, and
//! a watcher that "handled" the cancel by writing a result line would be
//! overtaken by the turn starting immediately afterwards — a transcript that
//! ends and then keeps going. So the watcher leaves the marker alone in that
//! state, and `bind` — the one function every dispatched turn passes through —
//! consumes it instead.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use super::inbox::Inbox;

/// Suffix of the marker asking for a task to stop.
pub const CANCEL_SUFFIX: &str = ".cancel";

/// How long a marker waits for a turn that may still be starting.
///
/// Past this the task is taken to be one that cannot be cancelled — it already
/// finished, or the id never existed — and the marker is cleaned up rather than
/// left to be re-examined on every sweep forever.
///
/// Six seconds because the watcher's delivery retry runs a little under five,
/// and a marker must outlive the slowest legitimate start or it would expire on
/// a cold boot and let a cancelled task run anyway.
pub const START_GRACE: Duration = Duration::from_secs(6);

/// Path of a task's cancel marker.
pub fn marker_path(inbox: &Inbox, id: &str) -> PathBuf {
    inbox.dir().join(format!("{id}{CANCEL_SUFFIX}"))
}

/// Ask for a task to stop.
///
/// Returns once the marker is on disk, which is not the same as the task having
/// stopped — the app does that, and a turn mid-tool-call ends when the tool
/// returns. Callers that need to know it actually ended watch the transcript
/// for its `result` line.
pub fn request(inbox: &Inbox, id: &str) -> std::io::Result<()> {
    fs::create_dir_all(inbox.dir())?;
    fs::File::create(marker_path(inbox, id))?;
    Ok(())
}

/// Whether a cancel has been asked for and not yet acted on.
pub fn is_requested(inbox: &Inbox, id: &str) -> bool {
    marker_path(inbox, id).exists()
}

/// Consume a task's marker, reporting whether there was one.
///
/// The check and the removal are one call on purpose. Two callers race for a
/// single cancel — the watcher sweeping, and `bind` starting a turn — and if
/// each could see the marker before either removed it, a cancelled task would
/// be both refused *and* have its (non-existent) turn cancelled. Removal is the
/// claim, the same way a rename is the claim in [`super::inbox`].
pub fn take(inbox: &Inbox, id: &str) -> bool {
    fs::remove_file(marker_path(inbox, id)).is_ok()
}

/// Every task with an outstanding cancel request.
///
/// Ids only. A marker carries nothing else, and the caller has the inbox.
pub fn pending(inbox: &Inbox) -> Vec<String> {
    let Ok(entries) = fs::read_dir(inbox.dir()) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_suffix(CANCEL_SUFFIX).map(str::to_string)
        })
        .collect()
}

/// Whether a marker has waited longer than a turn could plausibly take to
/// start.
///
/// An unreadable timestamp counts as expired: a marker whose age cannot be
/// established would otherwise be reconsidered on every sweep for the life of
/// the app, and the cost of expiring one early is a cancel that did not apply
/// to anything.
pub fn is_expired(inbox: &Inbox, id: &str) -> bool {
    let Ok(created) = fs::metadata(marker_path(inbox, id)).and_then(|meta| meta.modified()) else {
        return true;
    };
    SystemTime::now()
        .duration_since(created)
        .map(|age| age > START_GRACE)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inbox() -> (tempfile::TempDir, Inbox) {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        fs::create_dir_all(inbox.dir()).expect("create");
        (dir, inbox)
    }

    #[test]
    fn a_request_is_visible_to_the_app() {
        let (_dir, inbox) = inbox();
        assert!(!is_requested(&inbox, "task-a"));
        request(&inbox, "task-a").expect("request");
        assert!(is_requested(&inbox, "task-a"));
    }

    #[test]
    fn only_one_caller_can_take_a_marker() {
        // The whole point of `take`. The watcher and `bind` both reach for the
        // same cancel; if both could win, a task would be refused at start AND
        // have a turn cancelled that never existed.
        let (_dir, inbox) = inbox();
        request(&inbox, "task-a").expect("request");
        assert!(take(&inbox, "task-a"), "the first taker wins");
        assert!(!take(&inbox, "task-a"), "the second must lose");
    }

    #[test]
    fn taking_a_marker_that_was_never_asked_for_is_false() {
        let (_dir, inbox) = inbox();
        assert!(!take(&inbox, "never-cancelled"));
    }

    #[test]
    fn pending_lists_ids_not_filenames() {
        let (_dir, inbox) = inbox();
        request(&inbox, "20260901T100000-aaa").expect("request");
        request(&inbox, "20260901T100001-bbb").expect("request");
        let mut ids = pending(&inbox);
        ids.sort();
        assert_eq!(ids, vec!["20260901T100000-aaa", "20260901T100001-bbb"]);
    }

    #[test]
    fn pending_ignores_the_other_files_in_the_directory() {
        // Requests, transcripts and claims share this directory. A sweep that
        // read one of those as a cancel would stop an unrelated task.
        let (_dir, inbox) = inbox();
        fs::write(inbox.dir().join("20260901T100000-aaa.task.json"), "{}").expect("write");
        fs::write(inbox.dir().join("20260901T100000-aaa.jsonl"), "").expect("write");
        fs::write(inbox.dir().join("20260901T100000-aaa.claimed.json"), "{}").expect("write");
        assert!(pending(&inbox).is_empty());
    }

    #[test]
    fn a_fresh_marker_has_not_expired() {
        // It must survive long enough for a turn that is still starting.
        let (_dir, inbox) = inbox();
        request(&inbox, "task-a").expect("request");
        assert!(!is_expired(&inbox, "task-a"));
    }

    #[test]
    fn a_missing_marker_counts_as_expired() {
        // Reached when two sweeps overlap and the first already took it.
        // Reporting "not expired" would keep it in the retry set forever.
        let (_dir, inbox) = inbox();
        assert!(is_expired(&inbox, "never-existed"));
    }
}
