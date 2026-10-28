//! The Terminal panel's commands in the desktop window. The sessions live in
//! [`crate::pty_sessions`] and the bodies in `host_commands::terminal`; the
//! window's own tabs take their output on a Tauri `Channel`
//! (`terminal_pty_open`, `terminal_pty_attach`), every other client as
//! `terminal-pty-<id>` events.

use std::sync::Arc;

use tauri::ipc::Channel;

use super::terminal::RunningChild;
use crate::host_commands::terminal::{self as core, PtySpawned};
use crate::pty_sessions::{self, PtyEvent, PtyOutput};

/// A tab's Tauri channel as the session's output sink.
fn channel_output(channel: Channel<PtyEvent>) -> PtyOutput {
    Arc::new(move |event| {
        let _ = channel.send(event);
    })
}

/// Open a user's Terminal tab with its output on `on_event`.
#[tauri::command]
pub async fn terminal_pty_open(
    profile: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<PtySpawned, String> {
    core::open_session(profile, cwd, title, cols, rows, Some(channel_output(on_event))).await
}

/// The same with output as `terminal-pty-<id>` events (a browser tab).
#[tauri::command]
pub async fn terminal_pty_open_events(
    profile: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<PtySpawned, String> {
    core::open_session(profile, cwd, title, cols, rows, None).await
}

/// Show an existing session (one the agent opened) in a tab: what it printed
/// so far, then live output.
#[tauri::command]
pub async fn terminal_pty_attach(id: u32, on_event: Channel<PtyEvent>) -> Result<(), String> {
    pty_sessions::session(id)?.attach(channel_output(on_event))
}

/// The same as `terminal-pty-<id>` events.
#[tauri::command]
pub async fn terminal_pty_attach_events(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    core::attach_events(Arc::new(app), id)
}

#[tauri::command]
pub async fn terminal_pty_write(id: u32, data: String) -> Result<(), String> {
    core::write(id, data).await
}

#[tauri::command]
pub async fn terminal_pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    pty_sessions::session(id)?.resize(cols, rows)
}

#[tauri::command]
pub async fn terminal_pty_kill(id: u32) -> Result<(), String> {
    core::kill(id).await
}

#[tauri::command]
pub async fn terminal_pty_running(id: u32) -> Result<Vec<RunningChild>, String> {
    core::running(id).await
}
