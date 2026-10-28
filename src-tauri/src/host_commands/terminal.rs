//! The Terminal panel: open a tab, show a session the agent opened, type,
//! resize, stop, and what a tab's shell has running. The sessions live in
//! [`crate::pty_sessions`] with the engine, so the agent's `terminal` tool and
//! every front end see the same tabs.
//!
//! Output reaches a client as the named event `terminal-pty-<id>`, which every
//! host forwards like any other event. The desktop window's own tabs can use a
//! Tauri `Channel` instead (`terminal_pty_open`, `terminal_pty_attach`, in
//! `WINDOW_ONLY`); the bodies are shared.

use serde::Serialize;
use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::host_events::Events;
use crate::process::tree::RunningChild;
use crate::pty_sessions::{self, PtyOutput, SessionInfo, Spawn};

pub const COMMANDS: &[&str] = &[
    "terminal_pty_open_events",
    "terminal_pty_attach_events",
    "terminal_pty_write",
    "terminal_pty_resize",
    "terminal_pty_kill",
    "terminal_pty_running",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    ctx: &CommandContext,
    name: &str,
    args: &Value,
) -> Option<Result<Value, CommandError>> {
    let n = name;
    macro_rules! get {
        ($key:literal) => {
            match arg(n, args, $key) {
                Ok(v) => v,
                Err(e) => return Some(Err(e)),
            }
        };
    }
    Some(match name {
        "terminal_pty_open_events" => {
            let profile: Option<String> = get!("profile");
            let cwd: Option<String> = get!("cwd");
            let title: Option<String> = get!("title");
            let cols: u16 = get!("cols");
            let rows: u16 = get!("rows");
            done(open_session(profile, cwd, title, cols, rows, None).await)
        }
        "terminal_pty_attach_events" => {
            let id: u32 = get!("id");
            done(attach_events(ctx.events.clone(), id))
        }
        "terminal_pty_write" => {
            let id: u32 = get!("id");
            let data: String = get!("data");
            done(write(id, data).await)
        }
        "terminal_pty_resize" => {
            let id: u32 = get!("id");
            let cols: u16 = get!("cols");
            let rows: u16 = get!("rows");
            done(pty_sessions::session(id).and_then(|session| session.resize(cols, rows)))
        }
        "terminal_pty_kill" => done(kill(get!("id")).await),
        "terminal_pty_running" => done(running(get!("id")).await),
        _ => return None,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawned {
    /// Aurora's handle for the session; every other command takes it.
    pub id: u32,
    /// The shell's real process id, when the platform reports one.
    pub pid: Option<u32>,
    /// The executable that was started, for the "exited immediately" notice.
    pub exe: String,
}

/// `terminal-pty-<id>`: one session's output for a client without a Tauri
/// `Channel`.
pub fn pty_event_name(id: u32) -> String {
    format!("terminal-pty-{id}")
}

/// A session's output as [`pty_event_name`] events through `events`.
pub fn event_output(events: Events, id: u32) -> PtyOutput {
    let name = pty_event_name(id);
    std::sync::Arc::new(move |event| {
        let _ = events.emit(&name, event);
    })
}

/// Open a user's Terminal tab: resolve the shell from the verified registry,
/// start it at `cwd`, and put it in a job. With no `output` the session
/// starts with nothing attached and the tab attaches next, which replays what
/// was printed meanwhile. `title` is the tab's name, which the agent's list
/// shows.
pub async fn open_session(
    profile: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    cols: u16,
    rows: u16,
    output: Option<PtyOutput>,
) -> Result<PtySpawned, String> {
    tokio::task::spawn_blocking(move || {
        let requested = profile.as_deref().unwrap_or("pwsh");
        let (exe, kind, args, env) = pty_sessions::resolve_shell(requested)?;
        let session = pty_sessions::spawn(Spawn {
            exe: &exe,
            args: &args,
            env: &env,
            cols,
            rows,
            info: SessionInfo {
                title: title.unwrap_or_else(|| kind.id().to_string()),
                shell: kind.id().to_string(),
                cwd,
                owner_thread: None,
                command: None,
            },
            channel: output,
        })?;
        Ok(PtySpawned {
            id: session.id,
            pid: session.pid,
            exe,
        })
    })
    .await
    .map_err(|error| format!("terminal spawn task failed: {error}"))?
}

/// Show a session in a client: replay, then live output, as
/// `terminal-pty-<id>` events. A session streams to one tab at a time, so this
/// takes it over from another tab showing it.
pub fn attach_events(events: Events, id: u32) -> Result<(), String> {
    pty_sessions::session(id)?.attach(event_output(events, id))
}

/// Type into a session.
pub async fn write(id: u32, data: String) -> Result<(), String> {
    let session = pty_sessions::session(id)?;
    tokio::task::spawn_blocking(move || session.write(data.as_bytes()))
        .await
        .map_err(|error| format!("terminal write task failed: {error}"))?
}

/// End a session: the shell and everything it started.
pub async fn kill(id: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || pty_sessions::kill(id))
        .await
        .map_err(|error| format!("terminal kill task failed: {error}"))?
}

/// What the session's shell has running, by job membership.
pub async fn running(id: u32) -> Result<Vec<RunningChild>, String> {
    let Ok(session) = pty_sessions::session(id) else {
        return Ok(Vec::new());
    };
    tokio::task::spawn_blocking(move || session.running_children())
        .await
        .map_err(|error| format!("terminal scan task failed: {error}"))?
}
