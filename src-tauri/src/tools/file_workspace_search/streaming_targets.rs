//! The one place that decides how a write tool announces which files it is
//! about to touch.
//!
//! ## Why this module exists
//!
//! A tool call does not arrive whole. The model types its arguments as a
//! stream of JSON text, key by key, and the agent window shows the filename
//! the instant those bytes land. Emit the path first and the row is labelled
//! immediately. Emit it after the replacement text and the row sits there
//! naming nothing for the whole write, which is the slow part.
//!
//! Asking politely in prose does not survive contact with reality. Measured
//! over 1,880 real `file_edit` / `file_write` calls on disk, 1,233 named the
//! file too late — and **1,224 of those 1,233 were in plain alphabetical key
//! order**. Not a model ignoring the instruction. A model sorting its keys.
//!
//! Alphabetical order is what the field name has to survive, because it is the
//! single most common thing that happens to it:
//!
//! ```text
//! file_edit   sorted → edits, new_string, old_string, path, …, target_paths
//! file_write  sorted → content, must_not_exist, path
//! ```
//!
//! `target_paths` began with `t`. The one field built to arrive FIRST sorted
//! LAST, and `content` sorted ahead of `path`. Both escape hatches inverted
//! under the exact condition they existed for. Hence [`FIELD`]: it starts with
//! `a`, so it lands first whether the model follows the schema order or sorts.
//!
//! The rule used to live as English prose, worded differently, in two tool
//! descriptions, and only one of the two backed it with a real field. That is
//! what this module replaces.

use serde_json::{json, Value};

/// The field every write tool announces its files through.
///
/// **The leading `a` is load-bearing.** It must sort before every field that
/// can carry file content: `content`, `edits`, `new_string`, `old_string`,
/// `path`. Rename this and a model that sorts its keys goes back to naming the
/// file last. `field_name_survives_alphabetical_sorting` fails if that stops
/// being true.
pub const FIELD: &str = "affected_paths";

/// What this field was called before 2026-08-20.
///
/// Nothing in Rust reads it — it was always inert UI metadata — but threads
/// already on disk carry it inside their `tool_use` blocks, and the agent
/// window still honours it so a replayed transcript keeps its file chips.
pub const LEGACY_FIELD: &str = "target_paths";

/// The ordering rule, in the words the model reads. One sentence, both tools.
pub const RULE: &str = "ALWAYS emit `affected_paths` FIRST, before any file \
                        content, listing every path this call will touch (also \
                        when that is a single file). The interface names the \
                        files being changed from this field while the rest of \
                        the arguments are still streaming, so emitting it late \
                        leaves the reader watching an unlabelled row.";

/// The JSON Schema fragment. Splice it in as the first property.
pub fn property() -> Value {
    json!({
        "type": "array",
        "items": { "type": "string" },
        "description": "Streaming UI metadata: every file path this call will \
                        touch, including when there is only one. Emit it FIRST, \
                        before path/content/old_string/new_string/edits. It does \
                        not change which files are written."
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every field name that can carry file content across the write tools.
    const CONTENT_FIELDS: [&str; 5] = ["content", "edits", "new_string", "old_string", "path"];

    #[test]
    fn field_name_survives_alphabetical_sorting() {
        // The whole point of the rename. A model that sorts its keys must still
        // put this one first, or the agent window has nothing to draw.
        for content in CONTENT_FIELDS {
            assert!(
                FIELD < content,
                "`{FIELD}` must sort before `{content}` — a model that emits \
                 keys alphabetically would otherwise name the file last, which \
                 is the bug this field exists to prevent",
            );
        }
        // The name it replaces failed exactly this check.
        assert!(
            LEGACY_FIELD > "content",
            "the legacy name is kept here as the counter-example",
        );
    }

    #[test]
    fn the_rule_names_the_field_it_is_about() {
        assert!(RULE.contains(FIELD));
        assert_eq!(property()["items"]["type"], "string");
    }
}
