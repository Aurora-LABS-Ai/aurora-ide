//! The Terminal panel's IPC. The sessions themselves live in
//! [`crate::pty_sessions`]; the window only names a shell and a folder, draws
//! the output and sends keystrokes.

use serde::Serialize;
use tauri::ipc::Channel;

use super::terminal::RunningChild;
use crate::pty_sessions::{self, PtyEvent, PtyOutput, SessionInfo, Spawn};

/// A tab's Tauri channel as the session's output sink.
fn channel_output(channel: Channel<PtyEvent>) -> PtyOutput {
    std::sync::Arc::new(move |event| {
        let _ = channel.send(event);
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

/// A tab in a browser: the session's output as the named event
/// [`pty_event_name`], which the web host forwards like any other event (a
/// Tauri `Channel` cannot cross HTTP).
fn event_output(app: tauri::AppHandle, id: u32) -> PtyOutput {
    use tauri::Emitter;
    let name = pty_event_name(id);
    std::sync::Arc::new(move |event| {
        let _ = app.emit(&name, event);
    })
}

/// `terminal-pty-<id>`: one session's output for a browser tab.
pub fn pty_event_name(id: u32) -> String {
    format!("terminal-pty-{id}")
}

/// Open a user's Terminal tab: resolve the shell from the verified registry,
/// start it at `cwd`, and put it in a job. Output and the exit code arrive on
/// `on_event`. `title` is the tab's name, which the agent's list shows.
#[tauri::command]
pub async fn terminal_pty_open(
    profile: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<PtySpawned, String> {
    open_session(profile, cwd, title, cols, rows, Some(channel_output(on_event))).await
}

/// The same for a browser tab, which has no `Channel` to pass: the session
/// starts with nothing attached and the tab calls
/// [`terminal_pty_attach_events`] next, which replays what was printed
/// meanwhile.
#[tauri::command]
pub async fn terminal_pty_open_events(
    profile: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<PtySpawned, String> {
    open_session(profile, cwd, title, cols, rows, None).await
}

async fn open_session(
    profile: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    cols: u16,
    rows: u16,
    output: Option<PtyOutput>,
) -> Result<PtySpawned, String> {
    tauri::async_runtime::spawn_blocking(move || {
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

/// Show an existing session (one the agent opened) in a tab: what it printed
/// so far, then live output.
#[tauri::command]
pub async fn terminal_pty_attach(id: u32, on_event: Channel<PtyEvent>) -> Result<(), String> {
    pty_sessions::session(id)?.attach(channel_output(on_event))
}

/// The same for a browser tab: replay, then live output, as
/// `terminal-pty-<id>` events. A session streams to one tab at a time, so this
/// takes it over from a desktop tab showing it (and the other way round).
#[tauri::command]
pub async fn terminal_pty_attach_events(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    pty_sessions::session(id)?.attach(event_output(app, id))
}

/// Type into a session.
#[tauri::command]
pub async fn terminal_pty_write(id: u32, data: String) -> Result<(), String> {
    let session = pty_sessions::session(id)?;
    tauri::async_runtime::spawn_blocking(move || session.write(data.as_bytes()))
        .await
        .map_err(|error| format!("terminal write task failed: {error}"))?
}

/// Follow the panel's size.
#[tauri::command]
pub async fn terminal_pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    pty_sessions::session(id)?.resize(cols, rows)
}

/// End a session: the shell and everything it started.
#[tauri::command]
pub async fn terminal_pty_kill(id: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pty_sessions::kill(id))
        .await
        .map_err(|error| format!("terminal kill task failed: {error}"))?
}

/// What the session's shell has running, by job membership.
#[tauri::command]
pub async fn terminal_pty_running(id: u32) -> Result<Vec<RunningChild>, String> {
    let Ok(session) = pty_sessions::session(id) else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || session.running_children())
        .await
        .map_err(|error| format!("terminal scan task failed: {error}"))?
}
