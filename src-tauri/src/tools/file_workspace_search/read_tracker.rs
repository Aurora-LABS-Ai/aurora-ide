//! Per-session "files the agent has seen" tracker.
//!
//! Backs the read-before-edit guard in [`super::file_edit`]: `file_edit`
//! refuses to surgically patch a file the agent never read (or wrote)
//! this session, because an exact `old_string` it never saw is a guess.
//! `file_read` and the writers record here on success; `file_edit`
//! consults [`was_seen`] before touching an existing file.
//!
//! ## Why a session-keyed global instead of a `ToolContext` field
//!
//! The seen-set must persist ACROSS tool calls within a session, but
//! `ToolContext` is rebuilt per call. Threading a shared handle through
//! `ToolContext` would touch ~25 construction sites. The `session_id`
//! is already on every `ToolContext`, so a process-global map keyed by
//! it gives the same per-session scoping with zero plumbing.
//!
//! `file_read` is `concurrency_safe`, so several reads in one batch DO
//! record here at the same time — the `Mutex` is load-bearing, not
//! decorative. Contention is still negligible (a `HashSet` insert per
//! read). The ordering the guard depends on is preserved regardless:
//! `file_edit` is not concurrency-safe, so a batch containing both splits
//! and the read always completes before the edit checks [`was_seen`].
//! Entries are keyed by the resolved (canonical) path string so the
//! reader and the editor agree regardless of how the model spelled the
//! path. The map grows with distinct files per session; [`clear_session`]
//! is provided for lifecycle cleanup but is not required for safety.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

type SeenMap = HashMap<String, HashSet<String>>;

/// The window a file was last read through: `(first_line, last_line,
/// total_lines)`, 1-based inclusive. Absent from the map means the whole file
/// was seen.
type WindowMap = HashMap<String, HashMap<String, (usize, usize, usize)>>;

fn store() -> &'static Mutex<SeenMap> {
    static STORE: OnceLock<Mutex<SeenMap>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn windows() -> &'static Mutex<WindowMap> {
    static WINDOWS: OnceLock<Mutex<WindowMap>> = OnceLock::new();
    WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Mark `resolved_path` as seen by `session_id` (read or written).
pub(crate) fn record(session_id: &str, resolved_path: &str) {
    if session_id.is_empty() || resolved_path.is_empty() {
        return;
    }
    if let Ok(mut map) = store().lock() {
        map.entry(session_id.to_string())
            .or_default()
            .insert(resolved_path.to_string());
    }
}

/// Has `session_id` read or written `resolved_path` this session?
pub(crate) fn was_seen(session_id: &str, resolved_path: &str) -> bool {
    store()
        .lock()
        .map(|map| {
            map.get(session_id)
                .is_some_and(|set| set.contains(resolved_path))
        })
        .unwrap_or(false)
}

/// Remember that `resolved_path` was only ever seen through a window.
///
/// A file read as "lines 235-250 of 1588" leaves the caller holding a view, not
/// the file. When an edit against it then matches nothing, the window is often
/// the whole story: the text being matched sits in the 1,338 lines that were
/// never returned. Recording it costs one map entry and turns a dead-end
/// failure into a specific next step. Lines are 1-based and inclusive.
pub(crate) fn record_window(
    session_id: &str,
    resolved_path: &str,
    first_line: usize,
    last_line: usize,
    total_lines: usize,
) {
    if session_id.is_empty() || resolved_path.is_empty() {
        return;
    }
    if let Ok(mut map) = windows().lock() {
        map.entry(session_id.to_string()).or_default().insert(
            resolved_path.to_string(),
            (first_line, last_line, total_lines),
        );
    }
}

/// Remember that the whole of `resolved_path` was seen, clearing any window a
/// narrower read left behind. Every writer calls this too: a file it just wrote
/// is a file it knows in full.
pub(crate) fn record_whole(session_id: &str, resolved_path: &str) {
    record(session_id, resolved_path);
    if session_id.is_empty() || resolved_path.is_empty() {
        return;
    }
    if let Ok(mut map) = windows().lock() {
        if let Some(paths) = map.get_mut(session_id) {
            paths.remove(resolved_path);
        }
    }
}

/// The window `resolved_path` was last read through, or `None` when the whole
/// file was seen (or it was never read at all).
pub(crate) fn last_window(session_id: &str, resolved_path: &str) -> Option<(usize, usize, usize)> {
    windows()
        .lock()
        .ok()
        .and_then(|map| map.get(session_id)?.get(resolved_path).copied())
}

/// Drop a session's seen-set (call when a session is closed). Optional —
/// the guard is correct without it; this only reclaims memory.
pub(crate) fn clear_session(session_id: &str) {
    if let Ok(mut map) = store().lock() {
        map.remove(session_id);
    }
    if let Ok(mut map) = windows().lock() {
        map.remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_reports_seen() {
        let s = "sess-record";
        assert!(!was_seen(s, "/a/b.txt"));
        record(s, "/a/b.txt");
        assert!(was_seen(s, "/a/b.txt"));
        // distinct session is isolated
        assert!(!was_seen("other", "/a/b.txt"));
    }

    #[test]
    fn clear_drops_session() {
        let s = "sess-clear";
        record(s, "/x.txt");
        assert!(was_seen(s, "/x.txt"));
        clear_session(s);
        assert!(!was_seen(s, "/x.txt"));
    }

    #[test]
    fn empty_inputs_are_noops() {
        record("", "/x");
        record("s", "");
        assert!(!was_seen("", "/x"));
        assert!(!was_seen("s", ""));
    }

    #[test]
    fn a_window_read_is_remembered_and_a_whole_read_clears_it() {
        let s = "sess-window";
        assert_eq!(last_window(s, "/big.md"), None, "never read");

        record_window(s, "/big.md", 235, 250, 1588);
        assert_eq!(last_window(s, "/big.md"), Some((235, 250, 1588)));
        assert!(
            !was_seen(s, "/big.md"),
            "a window is not a read-before-edit"
        );

        // Reading it whole retires the window — the caller now holds the file.
        record_whole(s, "/big.md");
        assert_eq!(last_window(s, "/big.md"), None);
        assert!(was_seen(s, "/big.md"));
    }

    #[test]
    fn the_latest_window_wins() {
        let s = "sess-latest";
        record_window(s, "/f.rs", 1, 100, 900);
        record_window(s, "/f.rs", 400, 500, 900);
        assert_eq!(
            last_window(s, "/f.rs"),
            Some((400, 500, 900)),
            "the caller is holding what it read last, not the union of everything"
        );
    }

    #[test]
    fn clearing_a_session_drops_its_windows_too() {
        let s = "sess-clear-windows";
        record_window(s, "/f.rs", 1, 10, 99);
        clear_session(s);
        assert_eq!(last_window(s, "/f.rs"), None);
    }
}
