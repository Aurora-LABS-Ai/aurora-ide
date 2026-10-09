//! Which sub-agent cards a conversation keeps out beside the icon rail.
//!
//! The window pins an agent's card to watch it, and grows a card with "Show
//! more" to read further back. Both are kept with the conversation, in its own
//! `subagent-rail.json`, so opening the conversation days later puts the same
//! cards back the same way.
//!
//! A sidecar of its own rather than a field in `meta.json`: the runtime
//! rewrites `meta.json` during every turn (usage, title), and a pin written
//! from the window between that read and that write would be lost, or would
//! lose the usage.
//!
//! The file is presentation state. A missing or unreadable one is an empty
//! one, never an error that keeps the conversation from opening.

use std::fs;
use std::io::{self, Write};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::agent_runtime::error::RuntimeError;
use crate::agent_runtime::session_store::SessionStore;

/// Cards that can be pinned at once. The window's cap
/// (`MAX_PINNED_CARDS` in `lib/subagents/rail-layout.ts`): each pinned card is
/// a live tail of a streaming agent, and four tails at once is the measured
/// budget. Enforced here too, so a hand-edited file cannot ask for twenty.
pub const MAX_PINNED: usize = 3;

/// Grown cards remembered per conversation. Far more agents than anyone keeps
/// track of; the bound only stops the file growing without limit.
pub const MAX_EXPANDED: usize = 64;

/// Longest agent id accepted. Real ids are UUID-shaped.
const MAX_ID_LEN: usize = 128;

static RAIL_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> Result<MutexGuard<'static, ()>, RuntimeError> {
    RAIL_LOCK
        .lock()
        .map_err(|_| RuntimeError::InvalidState("sub-agent rail lock was poisoned".into()))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RailState {
    /// Agent ids whose cards are pinned, in the order they were pinned.
    #[serde(default)]
    pub pinned: Vec<String>,
    /// Agent ids whose cards are grown ("Show more").
    #[serde(default)]
    pub expanded: Vec<String>,
}

impl RailState {
    /// Drop blanks, over-long ids and repeats, keep first-seen order, and hold
    /// each list to its cap. Pinned keeps its OLDEST entries over the cap,
    /// because that is the order the window refuses a fourth pin in.
    #[must_use]
    pub fn sanitized(self) -> Self {
        fn clean(ids: Vec<String>, cap: usize) -> Vec<String> {
            let mut out: Vec<String> = Vec::new();
            for id in ids {
                let id = id.trim().to_string();
                if id.is_empty() || id.len() > MAX_ID_LEN || out.contains(&id) {
                    continue;
                }
                out.push(id);
                if out.len() == cap {
                    break;
                }
            }
            out
        }
        Self {
            pinned: clean(self.pinned, MAX_PINNED),
            expanded: clean(self.expanded, MAX_EXPANDED),
        }
    }
}

fn read_unlocked(store: &SessionStore, thread_id: &str) -> RailState {
    let path = store.subagent_rail_path(thread_id);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return RailState::default(),
        Err(e) => {
            crate::logging::log_warn(
                "subagents.rail",
                &format!("Could not read {}: {e}", path.display()),
            );
            return RailState::default();
        }
    };
    match serde_json::from_slice::<RailState>(&bytes) {
        Ok(state) => state.sanitized(),
        Err(e) => {
            crate::logging::log_warn(
                "subagents.rail",
                &format!("Invalid {}: {e}", path.display()),
            );
            RailState::default()
        }
    }
}

/// The conversation's rail state. Empty when it has none.
pub fn read(store: &SessionStore, thread_id: &str) -> Result<RailState, RuntimeError> {
    crate::agent_runtime::project_dir::validate_thread_id(thread_id)?;
    let _guard = lock()?;
    Ok(read_unlocked(store, thread_id))
}

/// Replace the conversation's rail state and return what was stored.
///
/// Refuses a conversation that is not on disk: a pin clicked as the
/// conversation was being deleted must not bring its folder back.
pub fn write(
    store: &SessionStore,
    thread_id: &str,
    state: RailState,
) -> Result<RailState, RuntimeError> {
    crate::agent_runtime::project_dir::validate_thread_id(thread_id)?;
    let state = state.sanitized();
    let _guard = lock()?;
    if !store.exists(thread_id) {
        return Err(RuntimeError::InvalidState(format!(
            "conversation {thread_id} does not exist; its pinned agents were not saved"
        )));
    }
    let path = store.subagent_rail_path(thread_id);
    if state == RailState::default() {
        // Nothing pinned or grown: no file, rather than a file saying so.
        return match fs::remove_file(&path) {
            Ok(()) => Ok(state),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(state),
            Err(e) => Err(RuntimeError::from(e)),
        };
    }
    let json = serde_json::to_vec_pretty(&state)?;
    let temp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(&json)?;
        file.sync_all()?;
    }
    fs::rename(&temp, &path)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(thread_id: &str) -> (tempfile::TempDir, SessionStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SessionStore::new_project(dir.path().to_path_buf());
        store
            .ensure_thread(thread_id, Some("build".into()), None)
            .expect("thread");
        (dir, store)
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    fn only_pinned(list: &[&str]) -> RailState {
        RailState {
            pinned: ids(list),
            expanded: Vec::new(),
        }
    }

    #[test]
    fn a_conversation_without_a_file_has_nothing_pinned() {
        let (_dir, store) = store_with("t1");
        assert_eq!(read(&store, "t1").unwrap(), RailState::default());
    }

    #[test]
    fn pins_and_grown_cards_survive_a_reopen() {
        let (_dir, store) = store_with("t1");
        let saved = RailState {
            pinned: ids(&["a", "b"]),
            expanded: ids(&["b"]),
        };
        write(&store, "t1", saved.clone()).unwrap();
        // A fresh store over the same folder: what the app sees after a restart.
        let reopened = SessionStore::new_project(store.dir().to_path_buf());
        assert_eq!(read(&reopened, "t1").unwrap(), saved);
        assert!(store.thread_dir("t1").join("subagent-rail.json").is_file());
    }

    #[test]
    fn holds_pins_to_the_cap_and_drops_repeats_and_blanks() {
        let (_dir, store) = store_with("t1");
        let stored = write(
            &store,
            "t1",
            RailState {
                pinned: ids(&["a", "a", " ", "b", "c", "d"]),
                expanded: ids(&["x", "x"]),
            },
        )
        .unwrap();
        assert_eq!(stored.pinned, ids(&["a", "b", "c"]));
        assert_eq!(stored.expanded, ids(&["x"]));
    }

    #[test]
    fn an_empty_state_leaves_no_file() {
        let (_dir, store) = store_with("t1");
        write(&store, "t1", only_pinned(&["a"])).unwrap();
        write(&store, "t1", RailState::default()).unwrap();
        assert!(!store.subagent_rail_path("t1").exists());
    }

    #[test]
    fn a_corrupt_file_reads_as_empty() {
        let (_dir, store) = store_with("t1");
        fs::write(store.subagent_rail_path("t1"), b"{not json").unwrap();
        assert_eq!(read(&store, "t1").unwrap(), RailState::default());
    }

    #[test]
    fn never_resurrects_a_deleted_conversation() {
        let (_dir, store) = store_with("t1");
        write(&store, "t1", only_pinned(&["a"])).unwrap();
        store.delete("t1").unwrap();
        assert!(write(&store, "t1", only_pinned(&["a"])).is_err());
        assert!(!store.thread_dir("t1").exists());
    }
}
