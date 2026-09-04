//! Answering "which conversation?" from a terminal.
//!
//! `aurora agent --continue <id>` appends to an existing thread instead of
//! starting a new one. The id has to come from somewhere, and a user will not
//! have memorised it — so this module is built around the case where the id is
//! *wrong* being ordinary rather than exceptional:
//!
//! - the exact id exists → use it
//! - a unique prefix of it exists → use that, because thread ids are long and
//!   nobody types one in full
//! - nothing matches → return the recent threads, so the caller can show them
//!   and let the user pick, instead of printing "not found" and stopping
//!
//! The prefix rule matters more than it looks. Thread ids are ULIDs; the first
//! six characters already identify one uniquely in any realistic history, and
//! requiring all 26 turns `--continue` into a copy-paste ritual.
//!
//! Threads are read straight from the session store — the JSONL logs and their
//! `.meta.json` sidecars under [`crate::paths::sessions_dir`]. Deliberately
//! not through SQLite: chat sessions are not in the database (see the schema
//! note in `db/schema.rs`), and the sidecars are the only authority.

use crate::agent_runtime::session_store::{SessionStore, SessionSummary};
use crate::paths;

/// How many recent threads to offer when a lookup fails.
///
/// Five, because this list is printed as a fallback under an error message and
/// its job is to be *scannable*, not complete. A user who does not recognise
/// any of five wants `aurora threads`, which is the unabridged list.
pub const RECENT_THREAD_COUNT: usize = 5;

/// Why a thread lookup could not be answered.
#[derive(Debug, thiserror::Error)]
pub enum ThreadError {
    #[error("could not read Aurora's chat sessions: {0}")]
    Store(String),

    #[error("no conversation matches {query:?}")]
    NoMatch {
        query: String,
        /// The most recent threads, for the caller to offer as a choice.
        recent: Vec<SessionSummary>,
    },

    #[error("{query:?} matches {} conversations", candidates.len())]
    Ambiguous {
        query: String,
        candidates: Vec<SessionSummary>,
    },
}

/// The chat history, as the CLI sees it.
#[derive(Debug, Clone, Default)]
pub struct Threads {
    /// Every non-archived thread, most recently updated first.
    pub all: Vec<SessionSummary>,
}

impl Threads {
    /// Load the chat history, optionally scoped to one workspace.
    ///
    /// Scoping matters for `--continue`: the user is standing in a project and
    /// means *that* project's conversations. An unscoped lookup would let a
    /// prefix collide with a thread from an unrelated repo and silently append
    /// this task to the wrong conversation.
    pub fn load(workspace_root: Option<&str>) -> Result<Self, ThreadError> {
        let store = SessionStore::new(paths::sessions_dir());
        let mut all = store
            .list_summaries_filtered(workspace_root)
            .map_err(|error| ThreadError::Store(error.to_string()))?;

        // Archived threads are hidden from the window's list, so offering them
        // here would surface conversations the user has already put away.
        all.retain(|summary| summary.archived_at.is_none());

        // Most recent first: `--continue` almost always means "the one I was
        // just in", and a recency-ordered list puts that at the top.
        all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        Ok(Self { all })
    }

    /// The most recently touched threads.
    pub fn recent(&self) -> Vec<SessionSummary> {
        self.all.iter().take(RECENT_THREAD_COUNT).cloned().collect()
    }

    /// The thread a bare `--continue` (no id) means: the latest one.
    pub fn latest(&self) -> Option<&SessionSummary> {
        self.all.first()
    }

    /// Resolve an id, or a unique prefix of one.
    pub fn resolve(&self, query: &str) -> Result<SessionSummary, ThreadError> {
        let query = query.trim();

        // An exact id wins outright, even if it is also a prefix of a longer
        // one. Otherwise a user who pasted a complete, correct id could be
        // told it was ambiguous — which would be absurd.
        if let Some(exact) = self
            .all
            .iter()
            .find(|summary| summary.id.eq_ignore_ascii_case(query))
        {
            return Ok(exact.clone());
        }

        let lowered = query.to_ascii_lowercase();
        // Guard against a stray `--continue ""` selecting the whole history
        // and reporting every thread as a candidate.
        let prefixed: Vec<SessionSummary> = if lowered.is_empty() {
            Vec::new()
        } else {
            self.all
                .iter()
                .filter(|summary| summary.id.to_ascii_lowercase().starts_with(&lowered))
                .cloned()
                .collect()
        };

        match prefixed.len() {
            1 => Ok(prefixed.into_iter().next().expect("length checked")),
            0 => Err(ThreadError::NoMatch {
                query: query.to_string(),
                recent: self.recent(),
            }),
            _ => Err(ThreadError::Ambiguous {
                query: query.to_string(),
                candidates: prefixed,
            }),
        }
    }
}

/// A thread's title, or a readable stand-in.
///
/// Titles are generated after the first exchange, so a thread dispatched into
/// and inspected immediately has an empty one. Printing a blank cell in a list
/// of conversations reads as a bug; naming the state does not.
pub fn display_title(summary: &SessionSummary) -> String {
    let title = summary.title.trim();
    if !title.is_empty() {
        return title.to_string();
    }
    let preview = summary.preview.trim();
    if !preview.is_empty() {
        // First line only: a preview is the head of a user message and may
        // carry the whole paragraph, which would wreck a table row.
        let first = preview.lines().next().unwrap_or(preview).trim();
        let mut shortened: String = first.chars().take(60).collect();
        if first.chars().count() > 60 {
            shortened.push('…');
        }
        return shortened;
    }
    "(untitled)".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str, updated_at: &str) -> SessionSummary {
        SessionSummary {
            id: id.to_string(),
            title: format!("thread {id}"),
            message_count: 2,
            preview: "hello".to_string(),
            workspace_root: Some(r"E:\project".to_string()),
            model: Some("fireworks:glm-5.2".to_string()),
            pinned: false,
            archived_at: None,
            deep_research: false,
            created_at: "2026-09-01T10:00:00Z".to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    fn history() -> Threads {
        Threads {
            all: vec![
                summary("01JQ8FAAAA", "2026-09-01T12:00:00Z"),
                summary("01JQ8FBBBB", "2026-09-01T11:00:00Z"),
                summary("01JQ8FCCCC", "2026-09-01T10:00:00Z"),
            ],
        }
    }

    #[test]
    fn an_exact_id_resolves() {
        let found = history().resolve("01JQ8FBBBB").expect("resolves");
        assert_eq!(found.id, "01JQ8FBBBB");
    }

    #[test]
    fn a_unique_prefix_resolves() {
        // The whole point: nobody types 26 characters.
        let found = history().resolve("01JQ8FC").expect("resolves");
        assert_eq!(found.id, "01JQ8FCCCC");
    }

    #[test]
    fn matching_ignores_case() {
        let found = history().resolve("01jq8fbbbb").expect("resolves");
        assert_eq!(found.id, "01JQ8FBBBB");
    }

    #[test]
    fn a_shared_prefix_is_ambiguous() {
        let error = history().resolve("01JQ8F").unwrap_err();
        match error {
            ThreadError::Ambiguous { candidates, .. } => assert_eq!(candidates.len(), 3),
            other => panic!("expected ambiguity, got {other:?}"),
        }
    }

    #[test]
    fn an_exact_id_beats_an_ambiguous_prefix() {
        // `01JQ8FAAAA` is both a complete id and a prefix of itself. A user
        // who pasted the full id must never be told it was ambiguous.
        let mut history = history();
        history.all.push(summary("01JQ8FAAAABBBB", "2026-09-01T09:00:00Z"));
        let found = history.resolve("01JQ8FAAAA").expect("resolves");
        assert_eq!(found.id, "01JQ8FAAAA");
    }

    #[test]
    fn a_miss_offers_the_recent_threads() {
        let error = history().resolve("nope").unwrap_err();
        match error {
            ThreadError::NoMatch { recent, .. } => {
                assert_eq!(recent.len(), 3);
                // Most recent first, so the top of the offered list is the
                // conversation the user was most likely in.
                assert_eq!(recent[0].id, "01JQ8FAAAA");
            }
            other => panic!("expected a miss, got {other:?}"),
        }
    }

    #[test]
    fn recent_is_capped() {
        let mut history = Threads::default();
        for index in 0..12 {
            history
                .all
                .push(summary(&format!("id{index:02}"), "2026-09-01T10:00:00Z"));
        }
        assert_eq!(history.recent().len(), RECENT_THREAD_COUNT);
    }

    #[test]
    fn an_empty_query_matches_nothing() {
        // `--continue ""` must not select the entire history.
        let error = history().resolve("").unwrap_err();
        assert!(matches!(error, ThreadError::NoMatch { .. }));
    }

    #[test]
    fn latest_is_the_newest_thread() {
        assert_eq!(history().latest().map(|s| s.id.as_str()), Some("01JQ8FAAAA"));
        assert!(Threads::default().latest().is_none());
    }

    #[test]
    fn a_titled_thread_shows_its_title() {
        assert_eq!(display_title(&summary("x", "t")), "thread x");
    }

    #[test]
    fn an_untitled_thread_falls_back_to_its_preview() {
        let mut untitled = summary("x", "t");
        untitled.title = "   ".to_string();
        untitled.preview = "refactor the timeline service".to_string();
        assert_eq!(display_title(&untitled), "refactor the timeline service");
    }

    #[test]
    fn a_long_preview_is_shortened_to_one_line() {
        let mut untitled = summary("x", "t");
        untitled.title = String::new();
        untitled.preview = format!("{}\nsecond line", "a".repeat(90));
        let shown = display_title(&untitled);
        assert!(!shown.contains('\n'), "a row must not wrap the table");
        assert!(shown.ends_with('…'));
        assert_eq!(shown.chars().count(), 61);
    }

    #[test]
    fn a_thread_with_nothing_to_show_is_named_not_blank() {
        let mut blank = summary("x", "t");
        blank.title = String::new();
        blank.preview = String::new();
        assert_eq!(display_title(&blank), "(untitled)");
    }
}
