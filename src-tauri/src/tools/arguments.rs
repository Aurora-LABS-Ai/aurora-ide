//! Reading an argument a gateway mangled on the way in.
//!
//! Aurora controls its tool schemas; it does not control what a gateway does
//! to a call between the model and the wire. The failure this module exists
//! for is **array flattening**: a parameter declared `"type": "array"` arrives
//! as a STRING holding the characters of the array.
//!
//! ```text
//! sent      {"path": ["src/a.ts", "src/b.ts"]}
//! delivered {"path": "[\"src/a.ts\", \"src/b.ts\"]"}
//! ```
//!
//! It was first measured on `kenari.id` in August and blamed on `path`
//! declaring a union type (`["string", "array"]`), which several gateways
//! serialise differently. The union was removed. On 2026-09-16 the same
//! flattening arrived from `api.meta.ai/v1` against the single-typed array,
//! so the union was one cause and never the only one — see
//! `.knowledge/provider-tool-compat.md` §1 and §15. Any tool taking an array
//! has to survive this rather than assume the schema retired it.
//!
//! The second half is escaping, and it is the half that bit. The gateway
//! copies the array's characters across verbatim without re-escaping them, so
//! the string is only valid JSON when nothing inside it needed an escape. A
//! POSIX path round-trips. A Windows path does not: in
//! `["E:\gadget\x.md"]` the sequences `\g` and `\.` are not valid JSON
//! escapes, `serde_json` refuses the whole thing, and a caller that treats a
//! failed parse as "then it is a plain string" ends up with the entire
//! bracketed blob as one filename.

use serde_json::Value;

/// Decode a string that is really a flattened array, or `None` if it is not
/// one.
///
/// Two attempts, in order:
///
/// 1. Parse it as JSON. This is the well-formed flattening, and the common
///    case.
/// 2. If that fails and the value is bracketed, double every backslash and
///    parse again — the unescaped flattening.
///
/// The repair in step 2 is safe **because** step 1 already failed. At that
/// point the string is not valid JSON, so there is no correctly-escaped
/// content to damage, and every backslash in it is a literal one. Anything
/// that still does not parse is `None`, and the caller keeps whatever
/// behaviour it has for a plain string.
///
/// An empty list is `None` too: it names nothing, so a caller asking "is this
/// really an array?" gains nothing by hearing "yes, of zero things".
pub(crate) fn decode_flattened_array(raw: &str) -> Option<Vec<Value>> {
    if let Ok(decoded) = serde_json::from_str::<Vec<Value>>(raw) {
        if !decoded.is_empty() {
            return Some(decoded);
        }
        return None;
    }

    let trimmed = raw.trim();
    if !(trimmed.starts_with('[') && trimmed.ends_with(']')) {
        return None;
    }
    serde_json::from_str::<Vec<Value>>(&trimmed.replace('\\', "\\\\"))
        .ok()
        .filter(|decoded| !decoded.is_empty())
}

/// Every entry of a flattened array that names something, as strings.
///
/// For callers that only accept strings and have nothing useful to say about
/// an entry of the wrong type. Blank and non-string entries are dropped; if
/// nothing usable survives, the answer is `None` rather than an empty list, so
/// a flattened `["", ""]` cannot masquerade as a well-formed empty argument.
pub(crate) fn decode_flattened_string_array(raw: &str) -> Option<Vec<String>> {
    let decoded = decode_flattened_array(raw)?;
    let strings: Vec<String> = decoded
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect();
    (!strings.is_empty()).then_some(strings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_well_formed_flattening_decodes() {
        let decoded = decode_flattened_array(r#"["src/a.ts", "src/b.ts"]"#).unwrap();
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0], "src/a.ts");
    }

    /// The 2026-09-16 payload. `\g` is not a JSON escape, so the strict parse
    /// cannot see this as an array at all.
    #[test]
    fn a_flattening_carrying_windows_paths_decodes() {
        let raw = r#"["E:\gadget-and-power\PROJECT\.knowledge\knowledge.md", "C:\Users\Alvan\SKILL.md"]"#;
        assert!(
            serde_json::from_str::<Vec<Value>>(raw).is_err(),
            "the premise: strict JSON cannot read this",
        );

        let decoded = decode_flattened_string_array(raw).unwrap();
        assert_eq!(
            decoded,
            vec![
                r"E:\gadget-and-power\PROJECT\.knowledge\knowledge.md".to_string(),
                r"C:\Users\Alvan\SKILL.md".to_string(),
            ]
        );
    }

    /// A path with a comma in it survives, because the repair re-parses as
    /// JSON rather than splitting on punctuation.
    #[test]
    fn a_comma_inside_a_path_is_not_a_separator() {
        let decoded = decode_flattened_string_array(r#"["E:\my, files\notes.md"]"#).unwrap();
        assert_eq!(decoded, vec![r"E:\my, files\notes.md".to_string()]);
    }

    /// A filename is not a list just because it has brackets in it. Next.js
    /// catch-all routes are the common real case.
    #[test]
    fn a_bracketed_filename_is_not_an_array() {
        assert!(decode_flattened_array("src/app/api/proxy/[...path]/route.ts").is_none());
        assert!(decode_flattened_array("[not json at all").is_none());
    }

    #[test]
    fn a_plain_path_is_not_an_array() {
        assert!(decode_flattened_array("src/a.ts").is_none());
        assert!(decode_flattened_array(r"E:\project\src\a.ts").is_none());
    }

    /// An empty list names nothing, so it is not reported as a list.
    #[test]
    fn an_empty_flattening_is_not_an_array() {
        assert!(decode_flattened_array("[]").is_none());
        assert!(decode_flattened_string_array(r#"["", "  "]"#).is_none());
    }
}
