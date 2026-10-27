//! Opening a file in the IDE window from the agent window, re-creating the
//! IDE window when it was closed. Split out of `editor_ops` when the editing
//! code moved to [`crate::workspace::edit`]; this part is windows only.

use serde::Serialize;

// ---------------------------------------------------------------------------
// Public commands: agent_open_in_ide / take_pending_ide_open
// ---------------------------------------------------------------------------

/// A file the agent window asked the IDE to open while the IDE window was CLOSED.
/// The backend re-creates the main window and stashes the request here; the
/// freshly-mounted IDE drains it via [`take_pending_ide_open`] on startup. This
/// hop sidesteps any "emit before the listener is ready" race.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingIdeOpen {
    pub path: String,
    pub line: Option<u64>,
}

static PENDING_IDE_OPEN: std::sync::Mutex<Option<PendingIdeOpen>> = std::sync::Mutex::new(None);

/// Hand a file off from the agent window (which is view-only) to the MAIN IDE
/// window for editing, bringing that window to the front — RE-CREATING it if the
/// user closed it (the common case: the IDE is closed once the agent window is
/// up, and reopened on demand from here).
///
/// This runs in the backend on purpose. The previous path emitted a global JS
/// event and hoped the main window would focus *itself* — but a background
/// webview can't steal the OS foreground, and if the IDE was closed there was no
/// listener at all, so the click did nothing. From Rust we own every window: we
/// focus reliably, and when the window doesn't exist we build it and queue the
/// file for its startup drain.
#[tauri::command]
pub async fn agent_open_in_ide(
    app: tauri::AppHandle,
    path: String,
    line: Option<u64>,
) -> Result<(), String> {
    // Window lookup and creation live in `reveal_main_window` / `build_main_window`.
    use tauri::Emitter;

    // Already open → bring it forward and deliver the open request to its
    // existing `agent_open_in_ide` listener (only the main window listens).
    if reveal_main_window(&app) {
        app.emit(
            "agent_open_in_ide",
            serde_json::json!({ "path": path, "line": line }),
        )
        .map_err(|error| format!("Couldn't notify the IDE window: {error}"))?;
        return Ok(());
    }

    // Closed → queue the file, then re-create the main window. It drains the
    // queue once its frontend mounts (see `take_pending_ide_open`).
    *PENDING_IDE_OPEN
        .lock()
        .map_err(|_| "pending-open lock poisoned".to_string())? =
        Some(PendingIdeOpen { path, line });

    if let Err(error) = build_main_window(&app) {
        // Don't leave a stale entry if the window failed to build.
        if let Ok(mut guard) = PENDING_IDE_OPEN.lock() {
            *guard = None;
        }
        return Err(error);
    }

    Ok(())
}

/// Bring an existing IDE window forward. `false` when there is no such window.
///
/// `show()` matters as much as `set_focus()`: a launch that opened the agent
/// window from the saved startup preference leaves `main` HIDDEN rather than
/// closed (see `lib.rs`), and focusing a hidden window does nothing visible.
fn reveal_main_window(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;

    match app.get_webview_window("main") {
        Some(win) => {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
            true
        }
        None => false,
    }
}

/// Re-create the IDE window after it has been closed.
///
/// Mirrors the main window from tauri.conf.json (custom title bar → decorations
/// off). `WebviewUrl::App("index.html")` loads the SPA root, which renders the
/// IDE (only `/agent-window` & friends are treated as secondary). Every caller
/// that can find `main` missing goes through here, so the recreated window
/// cannot drift from the configured one in only some of the paths.
fn build_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Aurora")
        .inner_size(1600.0, 1000.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .decorations(false)
        .resizable(true)
        .build()
        .map(|_| ())
        .map_err(|error| format!("Couldn't open the IDE window: {error}"))
}

/// Show the IDE window, creating it if it no longer exists.
///
/// The agent window can be the ONLY surface a launch opens — via `agw` or the
/// saved startup preference — so it needs a path-free way back to the editor.
/// `agent_open_in_ide` cannot serve that: it requires a file, and a fresh agent
/// window may not have one.
///
/// `async` on purpose. A sync `#[tauri::command]` runs on the main thread, and
/// `WebviewWindowBuilder::build()` there deadlocks the Windows UI thread.
#[tauri::command]
pub async fn open_ide_window(app: tauri::AppHandle) -> Result<(), String> {
    if reveal_main_window(&app) {
        return Ok(());
    }
    build_main_window(&app)
}

/// Drained by the main window on startup: returns and clears any file the agent
/// window queued (via [`agent_open_in_ide`]) while the IDE was closed. Returns
/// `null` on a normal launch.
#[tauri::command]
pub fn take_pending_ide_open() -> Option<PendingIdeOpen> {
    PENDING_IDE_OPEN
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}
