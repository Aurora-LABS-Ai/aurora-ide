//! Which work cards the reader opened in a conversation.
//!
//! With Transcript → Work cards on, the window folds each long stretch of a
//! reply that has no text for the reader (thoughts and tool calls only) into
//! one card, closed by default. Opening one is something the reader did on
//! purpose, so it is kept with the conversation, in its own `work-cards.json`:
//! reopening the chat next week shows the same cards open.
//!
//! Cards are keyed by the id of the FIRST tool call in the stretch. A tool call
//! id comes from the model and is written to the transcript as-is, so a card
//! streamed live and the same card read back from disk always agree on it.
//!
//! A sidecar of its own rather than a field in `meta.json`, for the reason
//! `subagents/rail_state.rs` gives: the runtime rewrites `meta.json` during
//! every turn. One card changes per call, under a lock, so the main pane and a
//! docked copy of the same chat cannot overwrite each other's choices.
//!
//! Presentation state. A missing or unreadable file is an empty one, never an
//! error that keeps the conversation from opening.

use std::fs;
use std::io::{self, Write};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::agent_runtime::error::RuntimeError;
use crate::agent_runtime::session_store::SessionStore;

/// Open cards remembered per conversation. Far more than anyone opens; the
/// bound only stops the file growing without limit. The oldest go first.
pub const MAX_OPEN: usize = 512;

/// Longest card id accepted. Real ids are a provider's tool call id.
const MAX_ID_LEN: usize = 160;

static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> Result<MutexGuard<'static, ()>, RuntimeError> {
    LOCK.lock()
        .map_err(|_| RuntimeError::InvalidState("work card lock was poisoned".into()))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkCards {
    /// Ids of the cards the reader opened, oldest first.
    #[serde(default)]
    pub open: Vec<String>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_LEN && !id.chars().any(char::is_control)
}

impl WorkCards {
    /// Drop blank, over-long and repeated ids, and keep the NEWEST `MAX_OPEN`.
    #[must_use]
    pub fn sanitized(self) -> Self {
        let mut open: Vec<String> = Vec::new();
        for id in self.open {
            if valid_id(&id) && !open.contains(&id) {
                open.push(id);
            }
        }
        if open.len() > MAX_OPEN {
            open.drain(..open.len() - MAX_OPEN);
        }
        Self { open }
    }
}

fn read_unlocked(store: &SessionStore, thread_id: &str) -> WorkCards {
    let path = store.work_cards_path(thread_id);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return WorkCards::default(),
        Err(e) => {
            crate::logging::log_warn("work_cards", &format!("Could not read {}: {e}", path.display()));
            return WorkCards::default();
        }
    };
    match serde_json::from_slice::<WorkCards>(&bytes) {
        Ok(cards) => cards.sanitized(),
        Err(e) => {
            crate::logging::log_warn("work_cards", &format!("Invalid {}: {e}", path.display()));
            WorkCards::default()
        }
    }
}

/// The conversation's open work cards. Empty when it has none.
pub fn read(store: &SessionStore, thread_id: &str) -> Result<WorkCards, RuntimeError> {
    crate::agent_runtime::project_dir::validate_thread_id(thread_id)?;
    let _guard = lock()?;
    Ok(read_unlocked(store, thread_id))
}

/// Open or close one card and return the conversation's open cards.
///
/// Refuses a conversation that is not on disk: a click on a card as the
/// conversation was being deleted must not bring its folder back.
pub fn set(
    store: &SessionStore,
    thread_id: &str,
    card_id: &str,
    open: bool,
) -> Result<WorkCards, RuntimeError> {
    crate::agent_runtime::project_dir::validate_thread_id(thread_id)?;
    if !valid_id(card_id) {
        return Err(RuntimeError::InvalidState(format!("invalid work card id {card_id:?}")));
    }
    let _guard = lock()?;
    if !store.exists(thread_id) {
        return Err(RuntimeError::InvalidState(format!(
            "conversation {thread_id} does not exist; the work card was not saved"
        )));
    }
    let mut cards = read_unlocked(store, thread_id);
    let had = cards.open.iter().any(|id| id == card_id);
    if had == open {
        return Ok(cards);
    }
    if open {
        cards.open.push(card_id.to_string());
    } else {
        cards.open.retain(|id| id != card_id);
    }
    let cards = cards.sanitized();
    let path = store.work_cards_path(thread_id);
    if cards.open.is_empty() {
        // Nothing open: no file, rather than a file saying so.
        return match fs::remove_file(&path) {
            Ok(()) => Ok(cards),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(cards),
            Err(e) => Err(RuntimeError::from(e)),
        };
    }
    let json = serde_json::to_vec_pretty(&cards)?;
    let temp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(&json)?;
        file.sync_all()?;
    }
    fs::rename(&temp, &path)?;
    Ok(cards)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(thread_id: &str) -> (tempfile::TempDir, SessionStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SessionStore::new_project(dir.path().to_path_buf());
        store.ensure_thread(thread_id, Some("build".into()), None).expect("thread");
        (dir, store)
    }

    #[test]
    fn a_conversation_without_a_file_has_no_open_cards() {
        let (_dir, store) = store_with("t1");
        assert_eq!(read(&store, "t1").unwrap(), WorkCards::default());
    }

    #[test]
    fn an_opened_card_survives_reopening_and_closing_removes_the_file() {
        let (_dir, store) = store_with("t1");
        set(&store, "t1", "toolu_01ABC", true).unwrap();
        set(&store, "t1", "call_9", true).unwrap();
        assert_eq!(read(&store, "t1").unwrap().open, vec!["toolu_01ABC", "call_9"]);
        assert!(store.thread_dir("t1").join("work-cards.json").is_file());

        set(&store, "t1", "toolu_01ABC", false).unwrap();
        assert_eq!(read(&store, "t1").unwrap().open, vec!["call_9"]);
        set(&store, "t1", "call_9", false).unwrap();
        assert!(!store.work_cards_path("t1").exists(), "nothing open, no file");
    }

    #[test]
    fn opening_twice_is_one_entry() {
        let (_dir, store) = store_with("t1");
        set(&store, "t1", "a", true).unwrap();
        set(&store, "t1", "a", true).unwrap();
        assert_eq!(read(&store, "t1").unwrap().open, vec!["a"]);
    }

    #[test]
    fn a_missing_conversation_is_refused_and_not_created() {
        let (_dir, store) = store_with("t1");
        assert!(set(&store, "gone", "a", true).is_err());
        assert!(!store.work_cards_path("gone").exists());
    }

    #[test]
    fn a_broken_file_reads_as_empty() {
        let (_dir, store) = store_with("t1");
        fs::write(store.work_cards_path("t1"), b"{not json").unwrap();
        assert_eq!(read(&store, "t1").unwrap(), WorkCards::default());
    }

    #[test]
    fn the_cap_keeps_the_newest() {
        let ids: Vec<String> = (0..MAX_OPEN + 3).map(|i| format!("c{i}")).collect();
        let cards = WorkCards { open: ids }.sanitized();
        assert_eq!(cards.open.len(), MAX_OPEN);
        assert_eq!(cards.open.first().map(String::as_str), Some("c3"));
    }

    #[test]
    fn blank_and_control_ids_are_refused() {
        let (_dir, store) = store_with("t1");
        assert!(set(&store, "t1", "", true).is_err());
        assert!(set(&store, "t1", "a\nb", true).is_err());
    }
}
