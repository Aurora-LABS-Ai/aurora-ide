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
        if !event.paths.iter().any(is_request_path) {
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

/// Claim every pending task and deliver it to the window.
pub fn sweep(app: &AppHandle) {
    let inbox = Inbox::open();
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
    fn the_event_name_is_distinct_from_the_launcher_channel() {
        // `cli-open` means "open this folder" and the IDE window acts on it.
        // Sharing a channel would have each window running the other's intent.
        assert_ne!(CLI_TASK_EVENT, "cli-open");
    }
}
