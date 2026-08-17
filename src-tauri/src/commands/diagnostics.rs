//! Diagnostics IPC — reading `aurora.log` back, and letting the web layer
//! write into it.
//!
//! The log has existed since the panic hook went in, with no way to reach it
//! from the app: you had to know the path. These three commands are what
//! Settings → Diagnostics is built on.
//!
//! `logs_report` is the important one. A packaged Aurora has no console, so
//! before this the React half of a crash went nowhere while the Rust half was
//! fully recorded — a log that looks complete and isn't.

use crate::logging::{self, LogSnapshot};

/// Ceiling on entries returned in one call, and the default.
///
/// The view shows the most recent problems, not an archive; anyone who needs
/// the archive opens the file. A cap also keeps one IPC payload bounded when
/// something has been failing in a loop.
const MAX_ENTRIES: usize = 500;

/// Recent log entries plus what is needed to describe the file honestly.
#[tauri::command]
pub async fn logs_recent(limit: Option<usize>) -> Result<LogSnapshot, String> {
    let limit = limit.unwrap_or(MAX_ENTRIES).clamp(1, MAX_ENTRIES);
    Ok(logging::recent(limit))
}

/// Record a failure that happened in the web layer.
///
/// Deliberately infallible from the caller's side beyond transport: an error
/// reporter that can itself raise an error is how one failure becomes a loop.
#[tauri::command]
pub async fn logs_report(level: String, component: String, message: String) {
    logging::log_from_ui(&level, &component, &message);
}

/// Empty the log and drop the rotated backup.
#[tauri::command]
pub async fn logs_clear() -> Result<(), String> {
    logging::clear()
}

/// The `report_aurora_issue` file, as Settings → Diagnostics needs it.
///
/// `exists` is separate from an empty `content` on purpose: "the agent has
/// never reported anything" and "the file is there but empty" are different
/// states, and only the first should read as a clean slate.
#[derive(serde::Serialize)]
pub struct IssueReport {
    pub path: String,
    pub exists: bool,
    pub content: String,
}

/// Read back what the agent has reported about Aurora itself.
#[tauri::command]
pub async fn aurora_issues_read() -> Result<IssueReport, String> {
    let path = crate::tools::diagnostics::issues_path();
    let exists = path.is_file();
    let content = if exists {
        std::fs::read_to_string(&path)
            .map_err(|err| format!("could not read {}: {err}", path.display()))?
    } else {
        String::new()
    };
    Ok(IssueReport {
        path: path.to_string_lossy().to_string(),
        exists,
        content,
    })
}

/// Delete the reported-issues file.
///
/// Removed rather than truncated, so the page returns to "nothing reported yet"
/// instead of showing an empty file that reads as a bug of its own. The tool
/// recreates it on the next report.
#[tauri::command]
pub async fn aurora_issues_clear() -> Result<(), String> {
    let path = crate::tools::diagnostics::issues_path();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("could not clear {}: {err}", path.display())),
    }
}
