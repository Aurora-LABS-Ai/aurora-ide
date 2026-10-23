//! The Terminal panel's IPC. The sessions themselves live in
//! [`crate::pty_sessions`]; the window only names a shell and a folder, draws
//! the output and sends keystrokes.

use serde::Serialize;
use tauri::ipc::Channel;

use super::terminal::RunningChild;
use crate::pty_sessions::{self, PtyEvent, SessionInfo, Spawn};

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
            channel: Some(on_event),
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
    pty_sessions::session(id)?.attach(on_event)
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
