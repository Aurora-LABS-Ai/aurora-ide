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

fn store() -> &'static Mutex<SeenMap> {
    static STORE: OnceLock<Mutex<SeenMap>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
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

/// Drop a session's seen-set (call when a session is closed). Optional —
/// the guard is correct without it; this only reclaims memory.
pub(crate) fn clear_session(session_id: &str) {
    if let Ok(mut map) = store().lock() {
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
}
