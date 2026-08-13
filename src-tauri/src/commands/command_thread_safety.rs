//! Build-time guard: a command answered on the MAIN thread may not wait on the
//! database.
//!
//! ## The rule this enforces
//!
//! Tauri answers a `#[tauri::command]` on the **main thread** when the function
//! is a plain `fn`. That thread also paints the window and processes clicks, so
//! anything it waits for freezes the app — including the close button.
//!
//! Aurora's database is one SQLite file behind one lock. Everything that saves
//! a chat, writes a setting or sweeps usage stats queues for it. So a command
//! that both (a) runs on the main thread and (b) locks the database is a freeze
//! waiting for the right timing.
//!
//! Two spellings are safe and both are accepted here:
//!   * `#[tauri::command] pub async fn …`  — async commands never run on the
//!     main thread.
//!   * `#[tauri::command(async)] pub fn …` — Tauri moves a sync body to a
//!     worker thread.
//!
//! ## Why a test and not a review note
//!
//! This exact freeze has now happened twice, years apart, and both times the
//! command had been written correctly for its original caller — it only became
//! dangerous when a NEW caller put it on a hot path. A convention that has to be
//! remembered at every call site is not a convention, it is a trap. The test
//! reads the real source, so it fails on the commit that introduces the shape
//! rather than on the day someone's window stops closing.

use std::fs;
use std::path::{Path, PathBuf};

/// A main-thread command that reaches the database.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Finding {
    pub file: String,
    pub function: String,
    /// What gave it away — the parameter, or the call inside the body.
    pub evidence: String,
}

/// Strip comments and string/char literals so brace matching cannot be thrown
/// off by a `{` inside one. Replaces their contents with spaces to keep every
/// byte offset identical to the original.
fn blank_comments_and_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = vec![b' '; bytes.len()];
    let mut i = 0;
    while i < bytes.len() {
        let two = if i + 1 < bytes.len() {
            &bytes[i..i + 2]
        } else {
            &bytes[i..i + 1]
        };
        if two == b"//" {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if two == b"/*" {
            i += 2;
            while i + 1 < bytes.len() && &bytes[i..i + 2] != b"*/" {
                if bytes[i] == b'\n' {
                    out[i] = b'\n';
                }
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        if bytes[i] == b'"' {
            i += 1;
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(bytes.len());
            continue;
        }
        out[i] = bytes[i];
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// True when this slice of code reaches Aurora's database.
fn touches_database(code: &str) -> Option<String> {
    for marker in [
        "Mutex<Database>",
        "with_db(",
        "db.lock()",
        "database().lock()",
    ] {
        if code.contains(marker) {
            return Some(marker.to_string());
        }
    }
    None
}

/// Find every plain-`fn` `#[tauri::command]` in `src` that reaches the database.
pub(crate) fn scan_source(file: &str, src: &str) -> Vec<Finding> {
    let clean = blank_comments_and_strings(src);
    let mut findings = Vec::new();
    let mut cursor = 0;

    while let Some(offset) = clean[cursor..].find("#[tauri::command") {
        let attr_start = cursor + offset;
        let attr_end = match clean[attr_start..].find(']') {
            Some(end) => attr_start + end + 1,
            None => break,
        };
        cursor = attr_end;

        // `#[tauri::command(async)]` is already off the main thread.
        if clean[attr_start..attr_end].contains("async") {
            continue;
        }
        // The body's opening brace ends the signature.
        let Some(brace_rel) = clean[attr_end..].find('{') else {
            break;
        };
        let sig_end = attr_end + brace_rel;
        let signature = &clean[attr_end..sig_end];

        // `pub async fn` is safe whatever it does.
        if signature.contains("async fn") {
            continue;
        }
        let Some(name_at) = signature.find("fn ") else {
            continue;
        };
        let function = signature[name_at + 3..]
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .find(|part| !part.is_empty())
            .unwrap_or("<unnamed>")
            .to_string();

        // Brace-match the body.
        let mut depth = 0usize;
        let mut end = sig_end;
        for (idx, ch) in clean[sig_end..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = sig_end + idx + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        cursor = end;

        if let Some(evidence) = touches_database(&clean[attr_end..end]) {
            findings.push(Finding {
                file: file.to_string(),
                function,
                evidence,
            });
        }
    }

    findings
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_main_thread_command_waits_on_the_database() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&root, &mut files);
        assert!(!files.is_empty(), "found no sources to scan under {root:?}");

        let mut findings = Vec::new();
        for path in &files {
            let Ok(src) = fs::read_to_string(path) else {
                continue;
            };
            let label = path
                .strip_prefix(&root)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned();
            findings.extend(scan_source(&label, &src));
        }

        assert!(
            findings.is_empty(),
            "These commands are answered on the MAIN thread and wait on the database, \
             which freezes the window (the close button included):\n{}\n\n\
             Fix by writing `#[tauri::command(async)]`, or by making the function \
             `pub async fn`. If the value is already held in memory, read it from there \
             instead — see `shell_profiles_get`.",
            findings
                .iter()
                .map(|f| format!("  {} :: {} (via `{}`)", f.file, f.function, f.evidence))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    #[test]
    fn the_guard_catches_the_shape_it_exists_for() {
        // The exact spelling that froze the app: sync `fn`, database in the
        // signature. A guard nobody has seen fail is not known to work.
        let bad = r#"
            #[tauri::command]
            pub fn shell_profiles_get(db: State<'_, Mutex<Database>>) -> Result<Profiles, String> {
                with_db(&db, |db| Ok(load(db)))
            }
        "#;
        let found = scan_source("bad.rs", bad);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].function, "shell_profiles_get");
    }

    #[test]
    fn both_safe_spellings_pass() {
        let good = r#"
            #[tauri::command(async)]
            pub fn sync_but_moved_off_thread(db: State<'_, Mutex<Database>>) -> Result<(), String> {
                with_db(&db, |_| Ok(()))
            }

            #[tauri::command]
            pub async fn already_async(db: State<'_, Mutex<Database>>) -> Result<(), String> {
                with_db(&db, |_| Ok(()))
            }

            #[tauri::command]
            pub fn touches_nothing(value: String) -> String {
                value
            }
        "#;
        assert_eq!(scan_source("good.rs", good), Vec::new());
    }

    #[test]
    fn a_brace_inside_a_string_or_comment_cannot_end_a_body_early() {
        // The body below closes AFTER the database call; a naive brace match
        // would stop at the `}` in the string and miss it.
        let tricky = r#"
            #[tauri::command]
            pub fn sneaky(db: State<'_, Mutex<Database>>) -> Result<(), String> {
                let _ = "a brace } in a string";
                // and a } in a comment
                with_db(&db, |_| Ok(()))
            }
        "#;
        assert_eq!(scan_source("tricky.rs", tricky).len(), 1);
    }
}
