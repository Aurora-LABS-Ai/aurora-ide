//! What the reader set in a conversation's answer boxes.
//!
//! An answer box is a small tool the model writes into a reply (`aurora-box`
//! fence, drawn by `components/answer-box/` in the window). Change its stepper
//! to 9 and reopen the conversation next week: it should still say 9. That
//! number is kept here, in the conversation's own `answer-boxes.json`, keyed by
//! a hash of the box's text — the one thing a box streamed live and the same
//! box read back from disk always agree on.
//!
//! A sidecar of its own rather than a field in `meta.json`, for the reason
//! `subagents/rail_state.rs` gives: the runtime rewrites `meta.json` during
//! every turn, and a value written from the window between that read and that
//! write would be lost.
//!
//! Presentation state. A missing or unreadable file is an empty one, never an
//! error that keeps the conversation from opening.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::agent_runtime::error::RuntimeError;
use crate::agent_runtime::session_store::SessionStore;

/// Boxes remembered per conversation. Far more than one conversation holds;
/// the bound only stops a file growing without limit.
pub const MAX_BOXES: usize = 256;

/// Inputs remembered per box. The window's parser allows 80 lines in a box,
/// but a box with more than a handful of inputs is not a tool anyone uses.
pub const MAX_VALUES: usize = 32;

/// Longest box key accepted. Real keys are `b` + 8 hex digits + a short length.
const MAX_KEY_LEN: usize = 64;

/// Longest input id accepted. The window's parser caps ids at 40.
const MAX_ID_LEN: usize = 40;

static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> Result<MutexGuard<'static, ()>, RuntimeError> {
    LOCK.lock()
        .map_err(|_| RuntimeError::InvalidState("answer box lock was poisoned".into()))
}

/// Box key → input id → the value the reader left it at.
pub type BoxValues = BTreeMap<String, f64>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerBoxes {
    #[serde(default)]
    pub boxes: BTreeMap<String, BoxValues>,
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Drop anything a hand-edited file could not have come from the window with:
/// bad keys and ids, values that are not finite numbers, past the caps.
fn clean_values(values: BoxValues) -> BoxValues {
    values
        .into_iter()
        .filter(|(id, value)| valid_id(id) && value.is_finite())
        .take(MAX_VALUES)
        .collect()
}

impl AnswerBoxes {
    #[must_use]
    pub fn sanitized(self) -> Self {
        Self {
            boxes: self
                .boxes
                .into_iter()
                .filter(|(key, _)| valid_key(key))
                .map(|(key, values)| (key, clean_values(values)))
                .filter(|(_, values)| !values.is_empty())
                .take(MAX_BOXES)
                .collect(),
        }
    }
}

fn read_unlocked(store: &SessionStore, thread_id: &str) -> AnswerBoxes {
    let path = store.answer_boxes_path(thread_id);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return AnswerBoxes::default(),
        Err(e) => {
            crate::logging::log_warn(
                "answer_boxes",
                &format!("Could not read {}: {e}", path.display()),
            );
            return AnswerBoxes::default();
        }
    };
    match serde_json::from_slice::<AnswerBoxes>(&bytes) {
        Ok(saved) => saved.sanitized(),
        Err(e) => {
            crate::logging::log_warn("answer_boxes", &format!("Invalid {}: {e}", path.display()));
            AnswerBoxes::default()
        }
    }
}

/// Every box value saved in the conversation. Empty when it has none.
pub fn read(store: &SessionStore, thread_id: &str) -> Result<AnswerBoxes, RuntimeError> {
    crate::agent_runtime::project_dir::validate_thread_id(thread_id)?;
    let _guard = lock()?;
    Ok(read_unlocked(store, thread_id))
}

/// Set one box's values, or forget the box when `values` is empty (the reader
/// put everything back to what the model wrote). Returns the whole file as
/// stored.
///
/// Refuses a conversation that is not on disk: a value changed as the
/// conversation was being deleted must not bring its folder back.
pub fn set(
    store: &SessionStore,
    thread_id: &str,
    key: &str,
    values: BoxValues,
) -> Result<AnswerBoxes, RuntimeError> {
    crate::agent_runtime::project_dir::validate_thread_id(thread_id)?;
    if !valid_key(key) {
        return Err(RuntimeError::InvalidState(format!(
            "\"{key}\" is not an answer box key"
        )));
    }
    let values = clean_values(values);
    let _guard = lock()?;
    if !store.exists(thread_id) {
        return Err(RuntimeError::InvalidState(format!(
            "conversation {thread_id} does not exist; its answer box was not saved"
        )));
    }
    let mut saved = read_unlocked(store, thread_id);
    if values.is_empty() {
        saved.boxes.remove(key);
    } else {
        if !saved.boxes.contains_key(key) && saved.boxes.len() >= MAX_BOXES {
            return Err(RuntimeError::InvalidState(format!(
                "this conversation already remembers {MAX_BOXES} answer boxes"
            )));
        }
        saved.boxes.insert(key.to_string(), values);
    }

    let path = store.answer_boxes_path(thread_id);
    if saved.boxes.is_empty() {
        // Nothing changed from the model's defaults: no file, rather than a
        // file saying so.
        return match fs::remove_file(&path) {
            Ok(()) => Ok(saved),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(saved),
            Err(e) => Err(RuntimeError::from(e)),
        };
    }
    let json = serde_json::to_vec_pretty(&saved)?;
    let temp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(&json)?;
        file.sync_all()?;
    }
    fs::rename(&temp, &path)?;
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(thread_id: &str) -> (tempfile::TempDir, SessionStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SessionStore::new_project(dir.path().to_path_buf());
        store
            .ensure_thread(thread_id, Some("chat".into()), None)
            .expect("thread");
        (dir, store)
    }

    fn values(pairs: &[(&str, f64)]) -> BoxValues {
        pairs.iter().map(|(k, v)| ((*k).to_string(), *v)).collect()
    }

    #[test]
    fn a_conversation_without_a_file_has_nothing_saved() {
        let (_dir, store) = store_with("t1");
        assert_eq!(read(&store, "t1").unwrap(), AnswerBoxes::default());
    }

    #[test]
    fn a_changed_value_survives_a_reopen() {
        let (_dir, store) = store_with("t1");
        set(&store, "t1", "b1a2b3c4d5", values(&[("people", 9.0)])).unwrap();
        set(&store, "t1", "b99999999z", values(&[("bill", 50.0), ("tip", 0.2)])).unwrap();
        // A fresh store over the same folder: what the app sees after a restart.
        let reopened = SessionStore::new_project(store.dir().to_path_buf());
        let saved = read(&reopened, "t1").unwrap();
        assert_eq!(saved.boxes.len(), 2);
        assert_eq!(saved.boxes["b1a2b3c4d5"], values(&[("people", 9.0)]));
        assert!(store.thread_dir("t1").join("answer-boxes.json").is_file());
    }

    #[test]
    fn putting_everything_back_forgets_the_box_and_then_the_file() {
        let (_dir, store) = store_with("t1");
        set(&store, "t1", "babc", values(&[("people", 9.0)])).unwrap();
        let saved = set(&store, "t1", "babc", BoxValues::new()).unwrap();
        assert!(saved.boxes.is_empty());
        assert!(!store.answer_boxes_path("t1").exists());
    }

    #[test]
    fn drops_values_no_window_could_have_sent() {
        let (_dir, store) = store_with("t1");
        let saved = set(
            &store,
            "t1",
            "babc",
            values(&[("people", 9.0), ("Bad-Id", 1.0), ("nan", f64::NAN), ("inf", f64::INFINITY)]),
        )
        .unwrap();
        assert_eq!(saved.boxes["babc"], values(&[("people", 9.0)]));
        assert!(set(&store, "t1", "../escape", values(&[("a", 1.0)])).is_err());
    }

    #[test]
    fn refuses_a_conversation_that_is_not_on_disk() {
        let (_dir, store) = store_with("t1");
        let err = set(&store, "gone", "babc", values(&[("a", 1.0)])).unwrap_err();
        assert!(err.to_string().contains("does not exist"));
        assert!(!store.answer_boxes_path("gone").exists());
    }

    #[test]
    fn an_unreadable_file_opens_as_nothing_saved() {
        let (_dir, store) = store_with("t1");
        fs::write(store.answer_boxes_path("t1"), b"{not json").unwrap();
        assert_eq!(read(&store, "t1").unwrap(), AnswerBoxes::default());
    }

    #[test]
    fn deleting_the_conversation_takes_the_file_with_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        // The flat layout lists its sidecars one by one; this is the case that
        // can leave an orphan behind.
        let store = SessionStore::new(dir.path().to_path_buf());
        store.ensure_thread("t1", Some("build".into()), None).expect("thread");
        set(&store, "t1", "babc", values(&[("people", 9.0)])).unwrap();
        assert!(store.answer_boxes_path("t1").exists());
        store.delete("t1").unwrap();
        assert!(!store.answer_boxes_path("t1").exists());
    }
}
