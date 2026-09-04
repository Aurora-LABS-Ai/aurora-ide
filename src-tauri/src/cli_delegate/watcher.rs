//! The running app's side of the hand-off: noticing a dispatched task and
//! claiming it.
//!
//! Installed once at startup by [`crate::run_with_args`]. Two mechanisms, and
//! both are needed:
//!
//! - **A sweep at startup**, because a task can be dispatched *before* Aurora
//!   exists. `aurora agent` writes the request and then launches the app, so
//!   the very task that caused the launch is already on disk by the time the
//!   watcher starts — and no filesystem event will ever fire for it.
//! - **A watch afterwards**, via `notify` (already in the build, driving the
//!   file explorer), so a task dispatched while Aurora is running is picked up
//!   within milliseconds rather than on a poll interval.
//!
//! ## Claiming happens here; running happens in the window
//!
//! This module takes ownership of a request and hands it to the frontend. It
//! does not execute anything. The Agent Window owns conversations — the thread
//! list, the model pin, the composer that a message has to enter through for
//! the transcript to render — and a task that bypassed it would run invisibly,
//! which is the opposite of what this feature is for.

use std::path::PathBuf;
use std::time::Duration;

use notify::{recommended_watcher, Config, EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use super::inbox::Inbox;
use super::task::TaskRequest;

/// Event carrying a claimed task to the Agent Window.
///
/// Named on the frontend as `cli-task`. Deliberately *not* `cli-open`, which
/// the IDE window already listens for and which means "open this folder" —
/// two different intents on one channel would have each window acting on the
/// other's messages.
pub const CLI_TASK_EVENT: &str = "cli-task";

/// How long to wait after a filesystem event before sweeping.
///
/// A write-then-rename produces several events in quick succession, and a
/// sweep per event would read the directory three times to find one task. It
/// also lets the rename land before the sweep looks: a sweep racing the rename
/// finds nothing and relies on the next event, which for the final rename
/// would never come.
const SETTLE: Duration = Duration::from_millis(120);

/// How long a claimed-but-undelivered task waits for the window to appear.
///
/// A cold launch reaches this code before the frontend has mounted, so the
/// first sweep can happen with nobody listening — Tauri events are not
/// buffered, and an emit into an unmounted window is simply lost. Rather than
/// emit-and-hope, an undeliverable task stays queued and is retried.
const DELIVERY_RETRY: Duration = Duration::from_millis(400);

/// Attempts at delivering a task before giving up on this app's lifetime.
///
/// Twelve attempts at [`DELIVERY_RETRY`] is a little under five seconds, which
/// covers a cold frontend boot with room to spare. Past that the window is not
/// coming, and the task is left *unclaimed* so a later Aurora can take it —
/// rather than consumed by an instance that could not run it.
const DELIVERY_ATTEMPTS: u32 = 12;

/// Start watching the task directory. Called once, at app startup.
///
/// Returns the watcher, which must be kept alive: dropping it stops the
/// watch. The initial sweep runs on a background thread so a directory full of
/// queued tasks cannot delay the window appearing.
pub fn install(app: AppHandle) -> Option<notify::RecommendedWatcher> {
    let inbox = Inbox::open();
    let dir = inbox.dir().to_path_buf();

    // The catch-up sweep. Deferred to a thread with a short delay rather than
    // run inline: at this point in startup the frontend has not mounted, and
    // delivering to it would be delivering to nobody.
    {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(SETTLE);
            sweep(&app);
        });
    }

    let handler_app = app.clone();
    let mut watcher = match recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else {
            return;
        };
        // Only creations and renames can produce a claimable request; ignoring
        // the rest keeps a busy transcript (appended to on every agent event,
        // in this same directory) from triggering a sweep per line.
        if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            return;
        }
        if !event
            .paths
            .iter()
            .any(|path| is_request_path(path) || is_cancel_path(path))
        {
            return;
        }
        let app = handler_app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(SETTLE);
            sweep(&app);
        });
    }) {
        Ok(watcher) => watcher,
        Err(error) => {
            crate::logging::log_error(
                "cli.watcher",
                &format!("could not watch the CLI task directory: {error}"),
            );
            return None;
        }
    };

    if let Err(error) = watcher.configure(Config::default().with_compare_contents(false)) {
        crate::logging::log_error("cli.watcher", &format!("watcher config failed: {error}"));
    }

    // Non-recursive: everything lives directly in this one directory, and a
    // recursive watch would also report every transcript append.
    if let Err(error) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
        crate::logging::log_error(
            "cli.watcher",
            &format!("could not watch {}: {error}", dir.display()),
        );
        return None;
    }

    Some(watcher)
}

/// Whether a path is a pending request rather than a transcript.
fn is_request_path(path: &PathBuf) -> bool {
    path.to_string_lossy().ends_with(super::task::TASK_SUFFIX)
}

/// Whether a path is someone asking for a task to stop.
fn is_cancel_path(path: &PathBuf) -> bool {
    path.to_string_lossy()
        .ends_with(super::cancel::CANCEL_SUFFIX)
}

/// Claim every pending task and deliver it to the window.
pub fn sweep(app: &AppHandle) {
    let inbox = Inbox::open();

    // Cancellations first. A task that was dispatched and cancelled before this
    // sweep — the "wrong command, Ctrl-C, retype" sequence — should never be
    // claimed at all, and doing this first is what makes that ordering hold
    // rather than starting the turn and stopping it a moment later.
    sweep_cancellations(app, &inbox);
    let pending = match inbox.pending() {
        Ok(pending) => pending,
        Err(error) => {
            crate::logging::log_error("cli.watcher", &format!("could not list tasks: {error}"));
            return;
        }
    };

    for request in pending {
        // Claim first. The claim is what makes this instance the owner, and
        // doing it before delivery means a second window sweeping the same
        // directory cannot also deliver the task.
        let claimed = match inbox.claim(&request.id) {
            Ok(claimed) => claimed,
            Err(super::inbox::InboxError::AlreadyClaimed(_)) => continue,
            Err(error) => {
                crate::logging::log_error(
                    "cli.watcher",
                    &format!("could not claim task {}: {error}", request.id),
                );
                continue;
            }
        };

        let app = app.clone();
        // One thread per task so a slow delivery cannot hold up the others,
        // and so the retry loop below never runs on the filesystem-event
        // thread (where blocking would stall every later notification).
        std::thread::spawn(move || deliver(&app, claimed));
    }
}

/// What stopping a given task means right now.
///
/// Three states, three different meanings of "stop", and the files are what
/// tell them apart. Separated from the acting so the decision can be tested
/// without an app: the ordering rules here are the whole of the design, and
/// they are not something to verify by launching a window.
#[derive(Debug, PartialEq, Eq)]
enum CancelAction {
    /// A turn is running under this id. Stop it through the registry.
    StopTurn(String),
    /// Still queued. Delete the request and close the transcript.
    DropQueued,
    /// Claimed, no turn yet. Leave the marker for `mirror::bind`.
    Wait,
    /// Nothing to stop — it already ended, or the id never existed.
    Expire,
}

/// Work out what a cancel means for one task.
fn decide_cancel(inbox: &Inbox, id: &str) -> CancelAction {
    // Running. The registry owns the turn, and cancelling it there ends the run
    // exactly as the window's Stop button does — including the `result` line
    // the terminal is waiting for, which the mirror writes when the turn
    // reports back.
    if let Some(turn_id) = super::mirror::turn_for_task(id) {
        return CancelAction::StopTurn(turn_id);
    }

    // Queued. Deleting the request is the cancel: nothing has read it, so
    // nothing will run.
    if inbox.task_path(id).exists() {
        return CancelAction::DropQueued;
    }

    // Claimed, with no turn yet: the app owns this task and is a moment away
    // from starting it. `mirror::bind` consumes the marker, because a result
    // line written here would be overtaken by the turn beginning straight
    // afterwards. Leave it — unless it has waited longer than any start could
    // plausibly take.
    if super::cancel::is_expired(inbox, id) {
        CancelAction::Expire
    } else {
        CancelAction::Wait
    }
}

/// Act on every outstanding cancel request.
fn sweep_cancellations(app: &AppHandle, inbox: &Inbox) {
    for id in super::cancel::pending(inbox) {
        match decide_cancel(inbox, &id) {
            CancelAction::Wait => {}

            CancelAction::Expire => {
                super::cancel::take(inbox, &id);
            }

            CancelAction::StopTurn(turn_id) => {
                // Taking the marker IS the claim. Losing it means another
                // sweep, or `bind`, got there first and has already acted.
                if super::cancel::take(inbox, &id) {
                    cancel_turn(app, &turn_id);
                }
            }

            CancelAction::DropQueued => {
                if !super::cancel::take(inbox, &id) {
                    continue;
                }
                // Read before deleting, for the `--out` path: a caller watching
                // their own copy of the transcript should see it end too.
                let out_path = inbox
                    .read_request(&inbox.task_path(&id))
                    .ok()
                    .and_then(|request| request.out_path)
                    .map(PathBuf::from);
                let _ = std::fs::remove_file(inbox.task_path(&id));
                close_as_cancelled(inbox, &id, out_path);
            }
        }
    }
}

/// Stop a running turn through the runtime registry.
fn cancel_turn(app: &AppHandle, turn_id: &str) {
    use tauri::Manager;

    let Some(registry) =
        app.try_state::<std::sync::Arc<crate::commands::agent_v2::AgentRegistry>>()
    else {
        crate::logging::log_error(
            "cli.cancel",
            "the agent registry is not available; the turn keeps running",
        );
        return;
    };
    // `false` means the turn had already ended between the lookup and here.
    // Not worth reporting: the caller asked for it to stop and it has.
    registry.cancel(turn_id);
}

/// Write the closing `result` line for a task that was stopped before it ran.
fn close_as_cancelled(inbox: &Inbox, id: &str, out_path: Option<PathBuf>) {
    use super::task::{ResultKind, TaskEvent};

    let Ok(mut transcript) =
        super::inbox::Transcript::open(inbox.transcript_path(id), out_path)
    else {
        return;
    };
    let _ = transcript.append(&TaskEvent::Result {
        subtype: ResultKind::Cancelled,
        result: None,
        error: None,
        // Zero rather than the time since dispatch: nothing ran, and reporting
        // a duration for work that never started would put a number in every
        // caller's log that means nothing.
        duration_ms: 0,
        num_turns: 0,
    });
}

/// Hand a claimed task to the Agent Window, retrying while it boots.
fn deliver(app: &AppHandle, request: TaskRequest) {
    for attempt in 0..DELIVERY_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(DELIVERY_RETRY);
        }
        // A global emit rather than a per-window one: the Agent Window may not
        // exist yet under a known label, and the IDE window ignores this
        // channel. The frontend acknowledges by acting on it.
        if app.emit(CLI_TASK_EVENT, &request).is_ok() && frontend_is_up(app) {
            return;
        }
    }

    // Nothing took it. Put the request back so a later Aurora can, rather than
    // leaving a claimed task that will never run.
    let inbox = Inbox::open();
    if let Err(error) = release(&inbox, &request) {
        crate::logging::log_error(
            "cli.watcher",
            &format!("task {} could not be released: {error}", request.id),
        );
    } else {
        crate::logging::log_error(
            "cli.watcher",
            &format!(
                "task {} was not delivered (no Agent Window); it stays queued",
                request.id
            ),
        );
    }
}

/// Whether a window exists to have received the event.
///
/// `emit` returns `Ok` whether or not anything is listening — it is a
/// broadcast, not a delivery receipt — so the presence of a webview is the
/// only signal available here. It is imperfect: a window that exists but has
/// not finished mounting its listener will read as up. That is why the
/// frontend's own handler is written to be idempotent, and why an undelivered
/// task is released rather than dropped.
fn frontend_is_up(app: &AppHandle) -> bool {
    use tauri::Manager;
    !app.webview_windows().is_empty()
}

/// Return a claimed request to the pending state.
fn release(inbox: &Inbox, request: &TaskRequest) -> Result<(), super::inbox::InboxError> {
    let claimed = inbox.claimed_path(&request.id);
    let pending = inbox.task_path(&request.id);
    match std::fs::rename(&claimed, &pending) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_delegate::task::{TaskMode, TaskOrigin, TASK_FORMAT_VERSION};

    fn request(id: &str) -> TaskRequest {
        TaskRequest {
            version: TASK_FORMAT_VERSION,
            id: id.to_string(),
            created_at: "2026-09-01T14:22:33Z".to_string(),
            prompt: "do it".to_string(),
            workspace_path: r"E:\project".to_string(),
            thread_id: None,
            provider_id: None,
            model: None,
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
    fn only_request_files_trigger_a_sweep() {
        // The transcript lives in this same directory and is appended to on
        // every agent event. If those appends triggered sweeps, a single busy
        // task would re-read the directory hundreds of times.
        assert!(is_request_path(&PathBuf::from(
            r"C:\tasks\20260901T100000-aaa.task.json"
        )));
        assert!(!is_request_path(&PathBuf::from(
            r"C:\tasks\20260901T100000-aaa.jsonl"
        )));
        assert!(!is_request_path(&PathBuf::from(
            r"C:\tasks\20260901T100000-aaa.claimed.json"
        )));
    }

    #[test]
    fn an_undelivered_task_returns_to_the_queue() {
        // The cold-start case: claimed by an instance whose window never came
        // up. Leaving it claimed would mean the task never runs at all.
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let request = request("20260901T100000-aaa");
        inbox.write_request(&request).expect("write");
        inbox.claim(&request.id).expect("claim");
        assert!(inbox.pending().expect("pending").is_empty());

        release(&inbox, &request).expect("release");

        let pending = inbox.pending().expect("pending");
        assert_eq!(pending.len(), 1, "the task should be claimable again");
        assert_eq!(pending[0].id, request.id);
    }

    #[test]
    fn releasing_an_unclaimed_task_is_harmless() {
        // Two paths can reach `release` for one task; the second must not fail.
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        release(&inbox, &request("never-claimed")).expect("release is idempotent");
    }

    #[test]
    fn a_cancel_before_the_claim_drops_the_task() {
        // The common case, and the one that must never run: you dispatched the
        // wrong thing and stopped it before Aurora picked it up.
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let request = request("20260901T100000-aaa");
        inbox.write_request(&request).expect("write");
        super::super::cancel::request(&inbox, &request.id).expect("cancel");

        assert_eq!(decide_cancel(&inbox, &request.id), CancelAction::DropQueued);
    }

    #[test]
    fn a_cancel_between_claim_and_start_waits_for_bind() {
        // The ordering that forces the whole design. Writing a result line here
        // would be overtaken by the turn starting a moment later, leaving a
        // transcript that ends and then keeps going.
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let request = request("20260901T100000-bbb");
        inbox.write_request(&request).expect("write");
        inbox.claim(&request.id).expect("claim");
        super::super::cancel::request(&inbox, &request.id).expect("cancel");

        assert_eq!(decide_cancel(&inbox, &request.id), CancelAction::Wait);
        // And the marker survives, so `bind` can consume it.
        assert!(super::super::cancel::is_requested(&inbox, &request.id));
    }

    #[test]
    fn a_cancel_for_a_task_that_never_existed_expires() {
        // Otherwise it is reconsidered on every sweep for the life of the app.
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        std::fs::create_dir_all(inbox.dir()).expect("create");
        assert_eq!(decide_cancel(&inbox, "never-existed"), CancelAction::Expire);
    }

    #[test]
    fn dropping_a_queued_task_closes_its_transcript() {
        // A terminal is already following this file. Deleting the request
        // without closing it leaves that follower waiting on a file that will
        // never grow again.
        use super::super::task::{ResultKind, TaskEvent};

        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let request = request("20260901T100000-ccc");
        inbox.write_request(&request).expect("write");

        close_as_cancelled(&inbox, &request.id, None);

        let body = std::fs::read_to_string(inbox.transcript_path(&request.id)).expect("read");
        let last: TaskEvent = serde_json::from_str(body.lines().last().expect("a line"))
            .expect("the last line parses");
        assert!(matches!(
            last,
            TaskEvent::Result {
                subtype: ResultKind::Cancelled,
                ..
            }
        ));
    }

    #[test]
    fn a_cancel_marker_is_noticed_by_the_watcher() {
        // The event filter decides whether a cancel ever reaches a sweep. A
        // marker that does not match is a stop request that silently does
        // nothing until the next unrelated dispatch.
        assert!(is_cancel_path(&PathBuf::from(
            r"C:\tasks\20260901T100000-aaa.cancel"
        )));
        assert!(!is_cancel_path(&PathBuf::from(
            r"C:\tasks\20260901T100000-aaa.task.json"
        )));
    }

    #[test]
    fn the_event_name_is_distinct_from_the_launcher_channel() {
        // `cli-open` means "open this folder" and the IDE window acts on it.
        // Sharing a channel would have each window running the other's intent.
        assert_ne!(CLI_TASK_EVENT, "cli-open");
    }
}
