//! Reading the batch of edits out of `file_edit`'s arguments — and repairing
//! the three ways it arrives wrong instead of spending a request on each.
//!
//! ## Why this module exists
//!
//! `file_edit` takes two forms: a batch (`edits: [{old_string, new_string}]`)
//! and a single edit (`old_string` + `new_string` at the top level). Neither
//! field is required on its own, so when the batch key is misspelled the parser
//! falls through to the single form, finds no `old_string`, and answers
//!
//! > supply either `edits` (array) or `old_string`+`new_string`
//!
//! which is a true sentence about a call that DID supply the edits. Measured on
//! a real build (2026-09-06, thread `538b2acc`):
//!
//! ```json
//! {"affected_paths": ["tests/test_cli.py"], "path": "tests/test_cli.py",
//!  "edites": "[{\"old_string\": …, \"new_string\": …}]"}
//! ```
//!
//! Two faults in one call, and both of them unambiguous: the key is `edites`,
//! one letter from the only key that could be meant, and its value is the array
//! written as a JSON *string* rather than as JSON. The model re-sent it
//! correctly on the next message — a whole request against the full
//! conversation, spent on a typo nobody could read as anything else.
//!
//! This is [`super::path_argument`]'s rule one level along: where the call says
//! one thing, answer with it; where it genuinely says two, refuse and name what
//! arrived.
//!
//! ## What it repairs
//!
//! | arrives as | result |
//! |---|---|
//! | `edits: [ … ]` / `replacements: [ … ]` | used, no note |
//! | `edits: "[ … ]"` (JSON in a string) | parsed, with a note |
//! | `edits: { … }` (one edit, unwrapped) | wrapped, with a note |
//! | `edites` / `edts` / `edit` carrying any of the above | used, with a note |
//! | none of the above | `None` — the single-edit form runs |
//!
//! **A repair is never silent**: the note rides back in the result, so the
//! model sees the name it should have used and the user can see what was
//! assumed. And a near-miss key is only accepted when its VALUE is the right
//! shape — a misspelling that carries something else is not evidence of intent.

use serde_json::Value;

/// The canonical key and its long-standing alias, in the order they are tried.
const BATCH_KEYS: &[&str] = &["edits", "replacements"];

/// How far a key may be from a known one and still be read as it.
///
/// Two edits covers a transposition plus a slip (`edtis`, `edites`, `eddits`)
/// and stops well short of a different word — `path` is 4 from `edits`, and
/// `content` shares nothing with it.
const MAX_KEY_DISTANCE: usize = 2;

pub struct Batch {
    pub items: Vec<Value>,
    /// What was assumed, in the model's own vocabulary. `None` when the call
    /// was already correct.
    pub note: Option<String>,
}

/// Find the batch of edits, repairing the forms that can only mean one thing.
///
/// `Ok(None)` means no batch was named at all, which is not an error: the
/// single-edit form is the other half of this tool.
pub fn resolve(input: &Value) -> Option<Batch> {
    for key in BATCH_KEYS {
        if let Some(raw) = input.get(*key) {
            // The real key is taken at its word: an array of the wrong thing
            // still goes to `run_batch`, whose per-item refusal ("Edit 2:
            // `old_string` is required") says far more than a generic one.
            if let Some((items, shape_note)) = coerce(raw, Evidence::Named) {
                return Some(Batch {
                    items,
                    note: shape_note.map(|n| format!("`{key}` {n}")),
                });
            }
        }
    }

    // Nothing under a known key. A misspelling is only readable as one when
    // what it carries is the shape the real key takes.
    let object = input.as_object()?;
    for (key, raw) in object {
        if BATCH_KEYS.contains(&key.as_str()) {
            continue;
        }
        let Some(canonical) = near_miss(key) else {
            continue;
        };
        let Some((items, shape_note)) = coerce(raw, Evidence::Guessed) else {
            continue;
        };
        let mut note = format!("read `{key}` as `{canonical}`");
        if let Some(shape) = shape_note {
            note.push_str(&format!(", which {shape}"));
        }
        return Some(Batch {
            items,
            note: Some(note),
        });
    }
    None
}

/// The known key this one is a slip of, if any.
fn near_miss(key: &str) -> Option<&'static str> {
    let lower = key.to_ascii_lowercase();
    BATCH_KEYS
        .iter()
        .map(|candidate| (edit_distance(&lower, candidate), *candidate))
        .filter(|(distance, _)| *distance <= MAX_KEY_DISTANCE)
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, candidate)| candidate)
}

/// How much a value has to look like edits before it is read as them.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Evidence {
    /// The call used a known key. Its contents are the model's own claim about
    /// what it sent, and a wrong item is `run_batch`'s to explain.
    Named,
    /// The key is a guess. Only a value that IS a list of edit objects counts
    /// as evidence — otherwise any stray misspelled field would be claimed.
    Guessed,
}

/// Read a value as a list of edits, whatever shape it came in.
///
/// Returns the items and, when something had to be assumed, the clause naming
/// it. An empty array is deliberately NOT a batch — `file_edit` refuses it with
/// its own sentence, and swallowing it here would turn "you sent nothing to do"
/// into "you sent no edits at all".
fn coerce(raw: &Value, evidence: Evidence) -> Option<(Vec<Value>, Option<String>)> {
    let looks_like_edits =
        |items: &[Value]| evidence == Evidence::Named || items.iter().all(Value::is_object);
    match raw {
        Value::Array(items) if !items.is_empty() && looks_like_edits(items) => {
            Some((items.clone(), None))
        }
        // One edit, not wrapped. Unambiguous: an object here can only be an
        // edit, because the field holds nothing else.
        Value::Object(_) => Some((
            vec![raw.clone()],
            Some("held one edit rather than an array; it was read as a batch of one".into()),
        )),
        // The array written as a string. Only accepted when it parses to a
        // non-empty array of objects — a string that parses to anything else is
        // a different mistake and gets the ordinary refusal.
        Value::String(text) => {
            let parsed: Value = serde_json::from_str(text.trim()).ok()?;
            match parsed {
                Value::Array(items)
                    if !items.is_empty() && items.iter().all(Value::is_object) =>
                {
                    Some((items, Some("arrived as a JSON string and was parsed".into())))
                }
                Value::Object(_) => Some((
                    vec![parsed],
                    Some("arrived as a JSON string holding one edit".into()),
                )),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Levenshtein distance, the same one `agent_runtime::tool_suggest` uses on
/// tool names. Kept local rather than shared because that one is private to its
/// module and a four-line function is not worth a cross-module dependency.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn edit() -> Value {
        json!({"old_string": "a", "new_string": "b"})
    }

    #[test]
    fn a_correct_batch_passes_through_without_a_note() {
        let out = resolve(&json!({"edits": [edit()]})).expect("batch");
        assert_eq!(out.items.len(), 1);
        assert!(out.note.is_none());
    }

    #[test]
    fn the_replacements_alias_still_works() {
        let out = resolve(&json!({"replacements": [edit(), edit()]})).expect("batch");
        assert_eq!(out.items.len(), 2);
        assert!(out.note.is_none());
    }

    /// The measured failure: one letter, and the array written as a string.
    #[test]
    fn a_misspelled_key_holding_a_json_string_is_read_and_reported() {
        let raw = json!({
            "path": "tests/test_cli.py",
            "edites": serde_json::to_string(&json!([edit(), edit()])).unwrap(),
        });
        let out = resolve(&raw).expect("repaired");
        assert_eq!(out.items.len(), 2);
        let note = out.note.expect("a repair is never silent");
        assert!(note.contains("`edites`"), "{note}");
        assert!(note.contains("`edits`"), "{note}");
        assert!(note.contains("JSON string"), "{note}");
    }

    #[test]
    fn a_batch_written_as_a_json_string_is_parsed() {
        let raw = json!({"edits": serde_json::to_string(&json!([edit()])).unwrap()});
        let out = resolve(&raw).expect("repaired");
        assert_eq!(out.items.len(), 1);
        assert!(out.note.unwrap().contains("JSON string"));
    }

    #[test]
    fn one_edit_sent_unwrapped_becomes_a_batch_of_one() {
        let out = resolve(&json!({"edits": edit()})).expect("repaired");
        assert_eq!(out.items.len(), 1);
        assert!(out.note.unwrap().contains("batch of one"));
    }

    /// A near-miss key is evidence only when it carries the right shape.
    /// Otherwise every call with a stray field would be read as a batch.
    #[test]
    fn a_misspelled_key_carrying_something_else_is_ignored() {
        assert!(resolve(&json!({"edites": "just a sentence"})).is_none());
        assert!(resolve(&json!({"edites": 7})).is_none());
        assert!(resolve(&json!({"edites": ["a", "b"]})).is_none());
    }

    /// The single-edit form must keep reaching its own branch untouched.
    #[test]
    fn a_single_edit_call_names_no_batch() {
        assert!(resolve(&json!({
            "path": "a.py",
            "old_string": "a",
            "new_string": "b"
        }))
        .is_none());
    }

    /// An empty array belongs to `file_edit`'s own refusal, which says the call
    /// asked for nothing to be done. Reading it as "no batch at all" would send
    /// the model the wrong sentence.
    #[test]
    fn an_empty_array_is_left_for_the_tools_own_refusal() {
        assert!(resolve(&json!({"edits": []})).is_none());
    }

    /// Real field names that share letters with `edits` must never be claimed.
    #[test]
    fn unrelated_fields_are_never_read_as_the_batch() {
        for key in ["path", "content", "affected_paths", "old_string", "new_string"] {
            assert!(
                near_miss(key).is_none(),
                "`{key}` must not be read as a batch key"
            );
        }
    }

    #[test]
    fn the_slips_worth_catching_are_caught() {
        for key in ["edites", "edtis", "eddits", "Edits", "edit", "edits_"] {
            assert_eq!(near_miss(key), Some("edits"), "{key}");
        }
    }
}
