//! Title derivation for chat threads.
//!
//! When a user starts a new chat, we infer a clean, scannable title from the
//! first message. Naive `chars().take(50)` produces awful titles whenever the
//! user pastes JSON, code, or stack traces. This module normalises markdown
//! and code conventions into a short, human-readable label suitable for the
//! left-hand chat list.
//!
//! Pipeline (each stage is small enough to reason about and unit-test):
//!
//! 1. [`strip_fenced_code_blocks`] — drop everything between ``` … ``` or
//!    ~~~ … ~~~ fences (with or without a language hint).
//! 2. [`strip_inline_code`] — replace short `` `code` `` with the inner text;
//!    drop long inline-code spans entirely.
//! 3. [`strip_json_blobs`] — drop standalone lines that look like a JSON
//!    object/array (heuristic: line trimmed begins with `{` or `[`).
//! 4. [`collapse_whitespace`] — fold every whitespace run (incl. newlines) to
//!    a single ASCII space.
//! 5. [`trim_decorative_chars`] — strip leading/trailing punctuation, quotes,
//!    and stray Markdown markers (`#`, `>`, `*`, `-`, `=`).
//! 6. [`truncate_to_title`] — take the first `MAX_TITLE_WORDS` words, also
//!    capped at `MAX_TITLE_CHARS` characters, breaking on word boundaries.
//!
//! If after every stage the result is empty (e.g. the message was *only* a
//! code block), the title falls back to [`FALLBACK_TITLE`].
//!
//! All operations are pure UTF-8-safe Rust (no regex dependency, no unsafe).

/// Maximum number of words kept in the title.
pub const MAX_TITLE_WORDS: usize = 8;

/// Hard upper bound on title length in Unicode scalar values.
pub const MAX_TITLE_CHARS: usize = 60;

/// Title used when the input collapses to an empty string after normalisation.
pub const FALLBACK_TITLE: &str = "New Chat";

/// Inline-code spans longer than this are dropped instead of inlined, since
/// they're almost always a snippet the user expected the model to read, not
/// natural prose.
const MAX_INLINE_CODE_KEEP_LEN: usize = 30;

/// Ellipsis appended when truncation occurs. We use the single-codepoint `…`
/// (`U+2026`) — narrower than `...` and consistent with VS Code, GitHub, and
/// Slack chat lists.
const ELLIPSIS: char = '…';

/// Derive a clean thread title from a raw user message.
///
/// Returns [`FALLBACK_TITLE`] when the message is empty or contains only
/// stripped material (e.g. fenced code blocks).
pub fn derive_thread_title(message: &str) -> String {
    if message.trim().is_empty() {
        return FALLBACK_TITLE.to_string();
    }

    let stage1 = strip_fenced_code_blocks(message);
    let stage2 = strip_inline_code(&stage1);
    let stage3 = strip_json_blobs(&stage2);
    let stage4 = collapse_whitespace(&stage3);
    let stage5 = trim_decorative_chars(&stage4);

    if stage5.is_empty() {
        return FALLBACK_TITLE.to_string();
    }

    truncate_to_title(&stage5, MAX_TITLE_WORDS, MAX_TITLE_CHARS)
}

// ============================================================================
// STAGE 1 — fenced code blocks
// ============================================================================

/// Remove any region delimited by a triple-backtick or triple-tilde fence.
///
/// We only recognise *line-leading* fences (CommonMark requires up to three
/// leading spaces of indentation; we accept arbitrary leading whitespace
/// because user messages are rarely whitespace-significant). The closing
/// fence must use the same character as the opening fence.
pub fn strip_fenced_code_blocks(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut fence: Option<char> = None;
    for line in s.lines() {
        let trimmed = line.trim_start();
        match fence {
            Some(open_char) => {
                if line_is_fence(trimmed, open_char) {
                    fence = None;
                }
                // Either way, drop the line: the fence and its body are
                // both excluded from the title material.
                continue;
            }
            None => {
                if line_is_fence(trimmed, '`') {
                    fence = Some('`');
                    continue;
                }
                if line_is_fence(trimmed, '~') {
                    fence = Some('~');
                    continue;
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// `true` iff `line` begins with at least three of `fence_char` (the rest of
/// the line is a language tag or empty).
fn line_is_fence(line: &str, fence_char: char) -> bool {
    let mut iter = line.chars();
    iter.next() == Some(fence_char)
        && iter.next() == Some(fence_char)
        && iter.next() == Some(fence_char)
}

// ============================================================================
// STAGE 2 — inline code
// ============================================================================

/// Replace `` `short` `` with `short`, drop `` `very-long-snippet` ``.
///
/// Multi-backtick spans (`` ``foo`` ``) are not specifically handled because
/// they're rare in chat input; the simple single-backtick walk catches the
/// common case while leaving the tougher edge cases as harmless residue.
pub fn strip_inline_code(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '`' {
            out.push(c);
            continue;
        }

        // Collect everything up to the next backtick.
        let mut buf = String::new();
        let mut closed = false;
        for nc in chars.by_ref() {
            if nc == '`' {
                closed = true;
                break;
            }
            buf.push(nc);
        }

        if !closed {
            // Unmatched: emit verbatim so we don't silently swallow content.
            out.push('`');
            out.push_str(&buf);
            continue;
        }

        let buf_chars = buf.chars().count();
        if buf_chars > 0 && buf_chars <= MAX_INLINE_CODE_KEEP_LEN {
            // Inline a short identifier or snippet.
            out.push_str(&buf);
        } else {
            // Drop empty (`` `` ``) or oversized snippets, but keep a space
            // so adjacent words don't collide.
            out.push(' ');
        }
    }
    out
}

// ============================================================================
// STAGE 3 — bare JSON blobs
// ============================================================================

/// Strip JSON-looking regions, both single-line and multi-line.
///
/// Strategy: a tiny state machine that tracks brace/bracket depth across
/// lines, ignoring braces inside string literals. We enter "json mode" when
/// a line either:
/// - is *only* `{` or `[` (classic multi-line opener), or
/// - starts with `{`/`[` *and* contains a `"` or `:` (single-line JSON-ish).
///
/// We exit when brace depth returns to zero. This keeps prose like
/// "Wrap this in {curly braces}" intact while stripping pasted config blobs.
pub fn strip_json_blobs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_block = false;
    let mut depth: i32 = 0;

    for line in s.lines() {
        let trim = line.trim();

        if !in_block {
            let starts_brace = trim.starts_with('{') || trim.starts_with('[');
            let is_lone_opener = trim == "{" || trim == "[";
            let looks_json = starts_brace && (line.contains('"') || trim.contains(':'));

            if !is_lone_opener && !looks_json {
                out.push_str(line);
                out.push('\n');
                continue;
            }

            let balance = brace_balance(line);
            if balance <= 0 {
                // Self-contained on one line — drop and continue.
                continue;
            }
            in_block = true;
            depth = balance;
            continue;
        }

        depth += brace_balance(line);
        if depth <= 0 {
            in_block = false;
            depth = 0;
        }
        // In-block lines are dropped regardless.
    }
    out
}

/// Net brace/bracket depth change across the line, ignoring characters
/// inside string literals (handles backslash escapes).
fn brace_balance(line: &str) -> i32 {
    let mut depth: i32 = 0;
    let mut in_str: Option<char> = None;
    let mut escaped = false;
    for ch in line.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if let Some(q) = in_str {
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == q {
                in_str = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            in_str = Some(ch);
            continue;
        }
        if ch == '{' || ch == '[' {
            depth += 1;
        } else if ch == '}' || ch == ']' {
            depth -= 1;
        }
    }
    depth
}

// ============================================================================
// STAGE 4 — whitespace folding
// ============================================================================

/// Replace every whitespace run (spaces, tabs, newlines, Unicode spaces) with
/// a single ASCII space. Leading and trailing whitespace are stripped.
pub fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ============================================================================
// STAGE 5 — decorative chars
// ============================================================================

/// Trim decorative characters that often surround user prose: leading `#`,
/// `>`, `-`, `*`, `=` (Markdown markers); leading/trailing quotes, brackets,
/// and stray punctuation.
pub fn trim_decorative_chars(s: &str) -> String {
    s.trim_matches(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                '#' | '>' | '<' | '*' | '-' | '=' | '_' | '~' | '`'
                    | '"' | '\'' | '“' | '”' | '‘' | '’'
                    | '(' | ')' | '[' | ']' | '{' | '}'
                    | '|' | '\\' | '/' | ',' | '.' | ':' | ';' | '!' | '?'
            )
    })
    .to_string()
}

// ============================================================================
// STAGE 6 — truncation
// ============================================================================

/// Take the first `max_words` words of `s`, then re-cap at `max_chars` Unicode
/// scalars (breaking on a word boundary when possible). Append a Unicode
/// ellipsis if truncation actually removed material.
pub fn truncate_to_title(s: &str, max_words: usize, max_chars: usize) -> String {
    let words: Vec<&str> = s.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }

    let total_words = words.len();
    let kept_words = words.iter().take(max_words);
    let mut joined = kept_words.copied().collect::<Vec<_>>().join(" ");
    let mut truncated = total_words > max_words;

    let char_len = joined.chars().count();
    if char_len > max_chars {
        truncated = true;
        // Walk char_indices and pick the cut point at max_chars - 1 (leave
        // room for the ellipsis), then back up to the last space so we don't
        // chop a word in half.
        let target = max_chars.saturating_sub(1);
        let mut byte_cut = joined.len();
        for (i, (b, _)) in joined.char_indices().enumerate() {
            if i == target {
                byte_cut = b;
                break;
            }
        }
        joined.truncate(byte_cut);
        if let Some(last_space) = joined.rfind(' ') {
            joined.truncate(last_space);
        }
        let trimmed = joined.trim_end_matches(|c: char| {
            c.is_whitespace() || matches!(c, ',' | '.' | ':' | ';' | '-' | '—' | '–')
        });
        joined = trimmed.to_string();
    }

    if truncated {
        joined.push(ELLIPSIS);
    }
    joined
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_falls_back() {
        assert_eq!(derive_thread_title(""), FALLBACK_TITLE);
        assert_eq!(derive_thread_title("   \n\t"), FALLBACK_TITLE);
    }

    #[test]
    fn plain_short_message_is_used_verbatim() {
        assert_eq!(
            derive_thread_title("Refactor the auth middleware"),
            "Refactor the auth middleware"
        );
    }

    #[test]
    fn long_message_is_word_capped_with_ellipsis() {
        let title = derive_thread_title(
            "Refactor the authentication middleware to use JWT tokens with proper rotation and revocation support",
        );
        assert!(title.ends_with('…'), "expected ellipsis: {title:?}");
        // Capped at MAX_TITLE_WORDS=8.
        let word_count = title.trim_end_matches('…').split_whitespace().count();
        assert!(
            word_count <= MAX_TITLE_WORDS,
            "got {word_count} words: {title:?}"
        );
    }

    #[test]
    fn fenced_code_blocks_are_stripped() {
        let input = "Fix this bug:\n```rust\nfn broken() {}\n```\nthanks";
        let title = derive_thread_title(input);
        assert_eq!(title, "Fix this bug: thanks");
    }

    #[test]
    fn tilde_fenced_code_blocks_are_stripped() {
        let input = "Hello\n~~~\nsecret\n~~~\nworld";
        let title = derive_thread_title(input);
        assert_eq!(title, "Hello world");
    }

    #[test]
    fn unclosed_fence_strips_to_end() {
        let input = "Look at\n```\nstuff that never closes";
        let title = derive_thread_title(input);
        assert_eq!(title, "Look at");
    }

    #[test]
    fn inline_code_short_is_inlined() {
        let title = derive_thread_title("Update `useThreadStore` to upsert");
        assert_eq!(title, "Update useThreadStore to upsert");
    }

    #[test]
    fn inline_code_long_is_dropped() {
        let title = derive_thread_title(
            "Make this work `const x = JSON.parse(very long block here exceeding limit)` please",
        );
        // The inline span exceeds MAX_INLINE_CODE_KEEP_LEN=30, so it gets
        // dropped (replaced with a space).
        assert!(title.contains("Make this work"));
        assert!(title.contains("please"));
        assert!(!title.contains("JSON.parse"));
    }

    #[test]
    fn json_blob_is_stripped() {
        let input = "Use these settings:\n{\"foo\": 1, \"bar\": 2}\nthanks";
        let title = derive_thread_title(input);
        assert_eq!(title, "Use these settings: thanks");
    }

    #[test]
    fn json_blob_without_quotes_is_preserved_as_prose() {
        // No `"` or `:` → likely just braces in prose; keep it.
        let input = "Wrap this in {curly braces}";
        let title = derive_thread_title(input);
        assert!(title.contains("Wrap this in"));
    }

    #[test]
    fn bare_array_blob_is_stripped() {
        let input = "Sort:\n[\"alpha\", \"beta\"]\ndone";
        let title = derive_thread_title(input);
        assert_eq!(title, "Sort: done");
    }

    #[test]
    fn markdown_heading_marker_is_trimmed() {
        let title = derive_thread_title("### Refactor the database layer");
        assert_eq!(title, "Refactor the database layer");
    }

    #[test]
    fn quotation_marks_are_trimmed() {
        assert_eq!(derive_thread_title("\"Hello world\""), "Hello world");
        assert_eq!(derive_thread_title("'Quick fix'"), "Quick fix");
    }

    #[test]
    fn message_that_is_only_a_code_block_falls_back() {
        let input = "```rust\nfn main() {}\n```";
        assert_eq!(derive_thread_title(input), FALLBACK_TITLE);
    }

    #[test]
    fn unicode_is_handled_safely() {
        let title = derive_thread_title("Translate «Привет, мир!» to Japanese");
        assert!(title.starts_with("Translate"));
        // No panic on non-ASCII boundaries.
        assert!(title.chars().count() <= MAX_TITLE_CHARS + 1); // +1 for possible ellipsis
    }

    #[test]
    fn extremely_long_word_is_truncated_at_char_cap() {
        let title = derive_thread_title(&"a".repeat(200));
        assert!(title.ends_with('…'));
        assert!(title.chars().count() <= MAX_TITLE_CHARS);
    }

    #[test]
    fn whitespace_runs_collapse_to_single_space() {
        let title = derive_thread_title("Hello     world\n\n\nfoo\t\tbar");
        assert_eq!(title, "Hello world foo bar");
    }

    #[test]
    fn truncation_breaks_on_word_boundary() {
        // Carefully crafted to exceed char cap mid-word.
        let input = "supercalifragilisticexpialidocious is a very long made-up word from the movie Mary Poppins";
        let title = derive_thread_title(input);
        assert!(title.ends_with('…'));
        // The first word alone is too long for the char cap, so the truncator
        // must produce *something* non-empty rather than an infinite loop.
        assert!(!title.is_empty());
        assert!(title.chars().count() <= MAX_TITLE_CHARS);
    }

    #[test]
    fn realistic_user_message_with_code_produces_clean_title() {
        let input = "fix this issue please asap\n\n```\nerror: cannot find module 'react'\n```";
        let title = derive_thread_title(input);
        assert_eq!(title, "fix this issue please asap");
    }

    #[test]
    fn multi_line_json_paste_after_prose_is_stripped() {
        let input = "Update my settings to:\n{\n  \"theme\": \"dark\",\n  \"fontSize\": 14\n}";
        // Trailing `:` is decorative once the JSON it introduced is gone.
        assert_eq!(derive_thread_title(input), "Update my settings to");
    }

    #[test]
    fn internal_colons_preserved_trailing_colons_stripped() {
        let input = "Use these settings:\n{\"foo\": 1, \"bar\": 2}\nthanks";
        assert_eq!(derive_thread_title(input), "Use these settings: thanks");
    }

    #[test]
    fn nested_multi_line_json_is_stripped_completely() {
        let input = "Save this:\n{\n  \"a\": {\n    \"b\": 1\n  }\n}\ndone";
        assert_eq!(derive_thread_title(input), "Save this: done");
    }
}
