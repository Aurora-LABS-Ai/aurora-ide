//! Reading the file path out of a write tool's arguments — and saying exactly
//! what arrived when there isn't one.
//!
//! ## Why this module exists
//!
//! `file_write` and `file_edit` ask for the same filename twice. Once in
//! [`streaming_targets::FIELD`] (`affected_paths`), which the tool description
//! orders the model to emit FIRST, every time, and describes as "every file
//! path this call will touch, including when there is only one". Once more in
//! `path`, which is the field the tool actually writes to.
//!
//! Measured across 924 real `file_write` calls on disk, 25 were refused for a
//! bad `path`, and the calls behind them look like this:
//!
//! ```json
//! {"affected_paths": ["tests/__init__.py"], "content": ""}
//! ```
//!
//! The model named the file, in the field we told it to name files in, and did
//! not name it again. That is a fair reading of our own field description, so
//! the schema is what has to give, not the model.
//!
//! The second half of the problem is what we said back. Every one of those
//! calls got `` `path` must be a string ``, because a single
//! `.and_then(Value::as_str)` covers missing, null, list, number and object
//! alike. The model reads a sentence about a TYPE, looks at the string it
//! meant to send, finds nothing wrong with it, and starts theorising. Real
//! transcripts have it landing on both sides of the truth:
//!
//! > "I sent the path as an array accidentally."
//!
//! > "either I omitted it or it was dropped. In the visible call I see
//! > `affected_paths`, `content`, and `path` — hmm, actually the call shows
//! > path present?"
//!
//! [`ToolError::MalformedInput`] already states this rule in its own doc
//! comment — *telling a model "`path` is required" when it did send `path` is
//! what turns one bad block into five wasted iterations* — but it was applied
//! to whole payloads and never to a single field inside one. This module is
//! that rule, one level down.
//!
//! ## What it does
//!
//! [`resolve`] answers with a path wherever the call says one thing, and with a
//! sentence naming what actually arrived wherever it does not:
//!
//! | `path` | `affected_paths` | Result |
//! |---|---|---|
//! | `"a.py"` | anything | `a.py` |
//! | `["a.py"]` | anything | `a.py`, with a note |
//! | `["a.py","b.py"]` | anything | refused — one file per call |
//! | missing | `["a.py"]` | `a.py`, with a note |
//! | missing | `["a.py","b.py"]` | refused — which of the two? |
//! | missing | missing | refused — `path` is required |
//! | `7` | anything | refused, naming the shape |
//!
//! **A repair is never silent.** The write reports a `note` saying what was
//! assumed, the same way [`super::path_recovery`] reports a corrected filename
//! after a bad read. And nothing here guesses between two candidates: the
//! moment there is a choice to make, the model makes it, because a write to
//! the wrong file is not something a later turn can discover.
//!
//! [`require_string`] is the plain half, for the mutating tools that have no
//! `affected_paths` to fall back on (`delete_path`, `folder_create`,
//! `move_path`). It repairs nothing; it only says what arrived.

use serde_json::Value;

use crate::agent_runtime::tool_executor::ToolError;

use super::streaming_targets;

/// A path argument that was understood, and what had to be assumed to get there.
#[derive(Debug)]
pub(crate) struct PathArgument {
    /// The path to act on.
    pub path: String,
    /// Plain-language note for the model when the path did not arrive as a
    /// string in `path`. `None` when the call was already well-formed, which
    /// is the overwhelming majority.
    pub note: Option<String>,
}

/// What a value IS, in the words a model can check its own call against.
///
/// The whole point of the module is not repeating `"must be a string"` at
/// something that is plainly not one without saying what it is instead.
pub(crate) fn describe(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "nothing".into(),
        Some(Value::String(s)) if s.trim().is_empty() => "an empty string".into(),
        Some(Value::String(_)) => "a string".into(),
        Some(Value::Bool(_)) => "a true/false value".into(),
        Some(Value::Number(_)) => "a number".into(),
        Some(Value::Object(_)) => "an object".into(),
        Some(Value::Array(items)) => match items.len() {
            0 => "an empty list".into(),
            1 => "a list of 1 path".into(),
            n => format!("a list of {n} paths"),
        },
    }
}

/// The usable paths in a list, ignoring blanks and non-strings.
enum Listed {
    /// Exactly one usable path.
    One(String),
    /// Nothing usable — an empty list, or one holding only blanks.
    None,
    /// Several. Which one is the model's to say, never ours.
    Many(usize),
}

fn listed_paths(items: &[Value]) -> Listed {
    let paths: Vec<&str> = items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    match paths.len() {
        0 => Listed::None,
        1 => Listed::One(paths[0].to_string()),
        n => Listed::Many(n),
    }
}

/// Read `path` for a tool that also carries [`streaming_targets::FIELD`].
///
/// `verb` is what this tool does to the file ("write", "edit"), used in the
/// refusals so the model is told which call it is fixing.
pub(crate) fn resolve(input: &Value, verb: &str) -> Result<PathArgument, ToolError> {
    let field = streaming_targets::FIELD;
    match input.get("path") {
        // The well-formed case, and the only one that costs nothing.
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(PathArgument {
            path: s.clone(),
            note: None,
        }),

        Some(Value::Array(items)) => match listed_paths(items) {
            Listed::One(path) => {
                let note = format!(
                    "`path` arrived as a list of one, so {path} was used. Send `path` as a \
                     plain string: `file_read` accepts a list of paths, the write tools take \
                     one file per call."
                );
                Ok(PathArgument {
                    path,
                    note: Some(note),
                })
            }
            // An empty list is a slot-filler, not a choice — treat it as absent
            // and let `affected_paths` answer if it can.
            Listed::None => from_affected(input, verb),
            Listed::Many(n) => Err(ToolError::InvalidInput(format!(
                "`path` was a list of {n} paths. Aurora's write tools take one file per call: \
                 send `path` as a plain string and make one call per file. (`file_read` accepts \
                 a list; the write tools do not.)"
            ))),
        },

        // Absent, null, or an empty string — all of them mean the same thing to
        // the caller, so they get the same second chance.
        None | Some(Value::Null) | Some(Value::String(_)) => from_affected(input, verb),

        other => Err(ToolError::InvalidInput(format!(
            "`path` must be a string naming one file; you sent {}. `{field}` is display metadata \
             for the interface and does not choose the file.",
            describe(other)
        ))),
    }
}

/// Second chance: the model named exactly one file in `affected_paths` and
/// stopped there, which is what the field's own description invites.
fn from_affected(input: &Value, verb: &str) -> Result<PathArgument, ToolError> {
    let field = streaming_targets::FIELD;
    let listed = input.get(field).and_then(Value::as_array).map(|v| listed_paths(v));

    match listed {
        Some(Listed::One(path)) => {
            let note = format!(
                "`path` was missing, so the one file named in `{field}` was used ({path}). Send \
                 `path` as a string as well — `{field}` only labels the row in the interface \
                 while your arguments are still streaming; it does not choose the file."
            );
            Ok(PathArgument {
                path,
                note: Some(note),
            })
        }
        Some(Listed::Many(n)) => Err(ToolError::InvalidInput(format!(
            "Missing required `path` (string): the file to {verb}. `{field}` names {n} files, \
             which does not say which one to {verb} — that field only labels the row in the \
             interface while your arguments are still streaming. Send `path` as a string, one \
             file per call."
        ))),
        _ => Err(ToolError::InvalidInput(format!(
            "Missing required `path` (string): the file to {verb}. Send it alongside `{field}` — \
             that field only labels the row in the interface while your arguments are still \
             streaming, and does not choose the file."
        ))),
    }
}

/// Why one item of a BATCH has no file, said in terms of what the call sent.
///
/// The single-edit form gets [`from_affected`], which uses a lone
/// `affected_paths` entry and explains a list of several. The batch form had
/// neither: with `affected_paths` naming two files and no `path` on any edit,
/// it answered "Edit 1: no `path`. Set `path` on this edit item, or provide a
/// top-level `path` that all edits share." — true about the tool, silent about
/// the call, and it never mentions the field the model actually filled. A
/// model reading it looks at its own payload, sees the files listed right
/// there, and re-sends. Measured three times in one session (thread
/// `c4669acf`, 2026-09-05), three whole requests against the full
/// conversation.
///
/// Same rule as everywhere else in this module: where the call says one thing,
/// serve it; where it genuinely says two, refuse and name what arrived.
pub(crate) fn batch_item_without_path(input: &Value, n: usize) -> String {
    let field = streaming_targets::FIELD;
    let listed = input
        .get(field)
        .and_then(Value::as_array)
        .map(|v| listed_paths(v));

    match listed {
        // Can't happen through `resolve` — one file becomes the top-level path
        // before the batch runs — but stated rather than left to a fallback
        // that would describe the call wrongly if that ever changes.
        Some(Listed::One(path)) => format!(
            "Edit {n}: no `path`. `{field}` names {path}; set `path` on this edit item, or send a \
             top-level `path` that every edit shares."
        ),
        Some(Listed::Many(count)) => format!(
            "Edit {n}: no `path`. `{field}` names {count} files, which does not say which of them \
             THIS edit belongs to — that field only labels the row in the interface while your \
             arguments are still streaming. Give every edit item its own `path` (the batch form \
             is built for exactly this: several files in one call), or send a top-level `path` \
             when they all share one."
        ),
        _ => format!(
            "Edit {n}: no `path`. Set `path` on this edit item, or send a top-level `path` that \
             every edit shares."
        ),
    }
}

/// Read a required path field for a mutating tool with no `affected_paths` to
/// fall back on. Repairs nothing; names what arrived.
///
/// `thing` is what the path points at ("file or folder", "folder"), so the
/// refusal reads as the tool's own sentence rather than a generic one.
pub(crate) fn require_string<'a>(
    input: &'a Value,
    field: &str,
    thing: &str,
) -> Result<&'a str, ToolError> {
    let found = input.get(field);
    if let Some(Value::String(s)) = found {
        if !s.trim().is_empty() {
            return Ok(s);
        }
    }
    let message = match found {
        None | Some(Value::Null) => {
            format!("Missing required `{field}` (string): the {thing} to act on.")
        }
        Some(Value::Array(_)) => format!(
            "`{field}` must be a string naming one {thing}; you sent {}. This tool acts on one \
             {thing} per call — make one call per {thing}.",
            describe(found)
        ),
        _ => format!(
            "`{field}` must be a string naming one {thing}; you sent {}.",
            describe(found)
        ),
    };
    Err(ToolError::InvalidInput(message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(err: ToolError) -> String {
        match err {
            ToolError::InvalidInput(m) => m,
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn a_plain_string_costs_nothing() {
        let arg = resolve(&json!({ "path": "src/a.rs" }), "write").unwrap();
        assert_eq!(arg.path, "src/a.rs");
        assert!(arg.note.is_none(), "a well-formed call must not be annotated");
    }

    /// The call that started this: the model named the file in the field the
    /// description told it to name files in, and nowhere else. Verbatim from
    /// `%LOCALAPPDATA%\AuroraIDE\sessions`.
    #[test]
    fn the_one_file_in_affected_paths_is_the_file() {
        let arg = resolve(
            &json!({ "affected_paths": ["tests/__init__.py"], "content": "" }),
            "write",
        )
        .unwrap();
        assert_eq!(arg.path, "tests/__init__.py");
        let note = arg.note.expect("a repair must say what it assumed");
        assert!(note.contains("tests/__init__.py"));
        assert!(
            note.contains("`path` as a string"),
            "the note has to teach the fix, not just apply it: {note}"
        );
    }

    /// `file_read` takes a list of paths and the write tools do not, so a model
    /// carrying that habit across lands here. One path is unambiguous.
    #[test]
    fn a_list_of_one_is_unwrapped_and_explained() {
        let arg = resolve(&json!({ "path": ["src/a.rs"] }), "write").unwrap();
        assert_eq!(arg.path, "src/a.rs");
        assert!(arg.note.unwrap().contains("file_read"));
    }

    /// The line this module will not cross. Two candidates is a choice, and a
    /// write to the wrong file is not something a later turn can discover.
    #[test]
    fn several_paths_are_never_chosen_between() {
        let err = resolve(&json!({ "path": ["a.rs", "b.rs"] }), "write").unwrap_err();
        let m = message(err);
        assert!(m.contains("2 paths"), "the count is the whole point: {m}");
        assert!(m.contains("one file per call"));

        let err = resolve(
            &json!({ "affected_paths": ["a.rs", "b.rs"], "content": "x" }),
            "write",
        )
        .unwrap_err();
        let m = message(err);
        assert!(m.contains("names 2 files"), "{m}");
        assert!(m.contains("which one to write"), "{m}");
    }

    /// The defect, stated as a test: five different mistakes used to share one
    /// sentence, so the model could not tell which one it had made.
    #[test]
    fn every_wrong_shape_is_named_rather_than_called_not_a_string() {
        let cases = [
            (json!({ "content": "x" }), "nothing"),
            (json!({ "path": 7, "content": "x" }), "a number"),
            (json!({ "path": true, "content": "x" }), "a true/false value"),
            (json!({ "path": {"file": "a.rs"}, "content": "x" }), "an object"),
        ];
        for (input, expected) in cases {
            let m = message(resolve(&input, "write").unwrap_err());
            assert!(
                m.contains(expected) || m.contains("Missing required"),
                "{input} should be described as {expected}, got: {m}"
            );
            assert_ne!(
                m, "`path` must be a string",
                "the old message said nothing about what actually arrived"
            );
        }
    }

    #[test]
    fn an_empty_list_falls_through_to_affected_paths() {
        // Aurora's own `file_read` treats an empty array as a slot-filler
        // rather than a batch; the write side agrees.
        let arg = resolve(
            &json!({ "path": [], "affected_paths": ["a.rs"], "content": "x" }),
            "write",
        )
        .unwrap();
        assert_eq!(arg.path, "a.rs");
    }

    #[test]
    fn an_empty_string_is_missing_not_a_path() {
        let arg = resolve(
            &json!({ "path": "  ", "affected_paths": ["a.rs"] }),
            "write",
        )
        .unwrap();
        assert_eq!(arg.path, "a.rs");

        let m = message(resolve(&json!({ "path": "" }), "write").unwrap_err());
        assert!(m.contains("Missing required `path`"), "{m}");
    }

    #[test]
    fn the_refusal_names_the_verb_of_the_tool_that_refused() {
        let write = message(resolve(&json!({}), "write").unwrap_err());
        let edit = message(resolve(&json!({}), "edit").unwrap_err());
        assert!(write.contains("the file to write"), "{write}");
        assert!(edit.contains("the file to edit"), "{edit}");
    }

    #[test]
    fn the_plain_half_repairs_nothing_but_still_says_what_arrived() {
        let input = json!({ "path": "a.rs" });
        let ok = require_string(&input, "path", "file or folder").unwrap();
        assert_eq!(ok, "a.rs");

        let m = message(
            require_string(&json!({ "path": ["a.rs"] }), "path", "file or folder").unwrap_err(),
        );
        assert!(m.contains("a list of 1 path"), "{m}");
        assert!(
            m.contains("one file or folder per call"),
            "a list is a batch the tool cannot do, and it should say so: {m}"
        );

        // No `affected_paths` rescue here, on purpose: these tools do not carry
        // the field, so there is nothing to fall back to.
        let m = message(
            require_string(
                &json!({ "affected_paths": ["a.rs"] }),
                "path",
                "file or folder",
            )
            .unwrap_err(),
        );
        assert!(m.contains("Missing required `path`"), "{m}");
    }

    #[test]
    fn move_path_names_its_two_ends_separately() {
        let m = message(
            require_string(&json!({ "new_path": "b.rs" }), "old_path", "file or folder")
                .unwrap_err(),
        );
        assert!(m.contains("`old_path`"), "{m}");
        assert!(!m.contains("`new_path`"), "{m}");
    }
}
