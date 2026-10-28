//! The workspace file watcher: one recursive watch that sends `fs-changed`
//! to whoever hosts the core, so the file list and git status refresh when
//! something on disk changes.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use notify::{recommended_watcher, Config, Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;

use crate::host_events::Events;

#[derive(Debug, Serialize, Clone)]
pub struct FsEventPayload {
    pub paths: Vec<String>,
    pub kind: String,
}

/// Subtrees that produce constant churn but never carry user-relevant
/// content. Any path whose components contain one of these names is
/// dropped before the watcher emits an `fs-changed` event.
///
/// Keep this list tight — anything we add here will go invisible to
/// the file explorer's auto-refresh + the in-IDE git status reload.
const WATCH_IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "build",
    "dist",
    ".next",
    ".turbo",
    ".cache",
    ".vite",
    ".parcel-cache",
    ".pnpm-store",
    ".yarn",
];

/// File suffixes that are always editor/build noise (lock files,
/// SQLite WAL/SHM, sourcemap rebuilds, …). Filtering these costs us
/// nothing because they're never opened in the editor.
const WATCH_IGNORED_FILE_SUFFIXES: &[&str] = &[
    ".lock",
    ".tmp",
    ".swp",
    ".swo",
    "~",
    ".db-wal",
    ".db-shm",
    ".sqlite-wal",
    ".sqlite-shm",
];

#[inline]
pub fn is_ignored_watch_path(path: &Path) -> bool {
    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
        if WATCH_IGNORED_FILE_SUFFIXES
            .iter()
            .any(|suffix| file_name.ends_with(suffix))
        {
            return true;
        }
    }
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|name| WATCH_IGNORED_DIR_NAMES.contains(&name))
            .unwrap_or(false)
    })
}

static FS_WATCHER: OnceLock<Mutex<Option<notify::RecommendedWatcher>>> = OnceLock::new();

fn get_watcher_handle() -> &'static Mutex<Option<notify::RecommendedWatcher>> {
    FS_WATCHER.get_or_init(|| Mutex::new(None))
}

/// Start a filesystem watcher that sends `fs-changed` events to `events`.
/// Replaces the watcher that was running, if any.
pub async fn start_fs_watcher(events: Events, path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Watch path does not exist: {}", path));
    }

    // Stop existing watcher if any
    {
        let mut guard = get_watcher_handle()
            .lock()
            .map_err(|e| format!("Failed to lock watcher: {}", e))?;
        *guard = None;
    }

    let mut watcher = recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            // Skip Access events outright — they fire on every read
            // (mtime/atime stat) and the frontend ignores them anyway.
            // Without this filter, running `git status` or HMR scans
            // alone produces thousands of IPC roundtrips per second.
            if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
                return;
            }

            // Drop events that touch only IGNORED subtrees (`.git/`,
            // `node_modules/`, `target/`, `build/`, `dist/`, etc).
            // Cargo, pnpm and Vite churn these directories thousands
            // of times during a dev rebuild and every modification
            // would otherwise:
            //   1. Invalidate the Rust file cache for that path
            //   2. Schedule a debounced `git_get_status` reload
            // Both are pure overhead — none of those files are user
            // content. We filter event-level (not path-level) so that
            // a single mixed event still fires for the user-content
            // paths it carries.
            let kept_paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| !is_ignored_watch_path(p))
                .map(|p| p.to_string_lossy().to_string())
                .collect();

            if kept_paths.is_empty() {
                return;
            }

            let kind_str = match event.kind {
                EventKind::Create(_) => "create",
                EventKind::Modify(_) => "modify",
                EventKind::Remove(_) => "remove",
                EventKind::Any => "any",
                EventKind::Access(_) => "access",
                EventKind::Other => "other",
            };

            let _ = events.emit(
                "fs-changed",
                FsEventPayload {
                    paths: kept_paths,
                    kind: kind_str.to_string(),
                },
            );
        }
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .configure(Config::default().with_compare_contents(false))
        .map_err(|e| format!("Failed to configure watcher: {}", e))?;

    watcher
        .watch(target, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    {
        let mut guard = get_watcher_handle()
            .lock()
            .map_err(|e| format!("Failed to lock watcher: {}", e))?;
        *guard = Some(watcher);
    }

    Ok(())
}

/// Stop the filesystem watcher
pub async fn stop_fs_watcher() -> Result<(), String> {
    let mut guard = get_watcher_handle()
        .lock()
        .map_err(|e| format!("Failed to lock watcher: {}", e))?;
    *guard = None;
    Ok(())
}
