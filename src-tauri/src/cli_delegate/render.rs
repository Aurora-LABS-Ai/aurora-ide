//! Turning a transcript into something a person can read at a glance.
//!
//! The shape is borrowed from the reference CLI
//! (`thirdparty/claude-code-cli`), because it is the shape that works: one
//! marked row per event, its detail indented under it, and nothing else
//! competing for the eye.
//!
//! ```text
//! ● file_read  src/timeline_service.dart
//!   ⎿ 214 lines
//!
//! ● grep  "TimelineService"
//!   ⎿ 14 matches in 6 files
//!
//! ● file_edit  test/timeline_test.dart
//!   ⎿ +3 −1
//! ```
//!
//! ## Rules this file exists to enforce
//!
//! **A row is one line.** Tool output arrives with newlines, tabs, and — from
//! anything that draws its own progress — carriage returns and escape codes.
//! Pasted into a terminal unfiltered, a control character can move the cursor,
//! clear the screen, or repaint the row above. [`summarize`] is the gate: what
//! reaches the terminal is one line of printable text and nothing else.
//!
//! **Assistant text streams; everything else is a row.** Text deltas are
//! written as they arrive with no marker, because a marker per delta would put
//! a bullet between every few words. The row markers belong to discrete
//! events — a tool starting, a result landing.
//!
//! **Nothing here decides what to show, only how.** Which events reach this
//! module is [`super::follow`]'s decision.

use super::task::{ResultKind, TaskEvent};
use super::term::{glyph, Style, Term};

/// Longest tool summary shown on a row before it is cut.
///
/// Sized for a comfortable terminal rather than the widest possible one:
/// wrapping is what destroys the scannability of a marked list, and a summary
/// is a glance, not the content. The full output is in the transcript.
const MAX_SUMMARY: usize = 96;

/// How one event should appear. `None` means "show nothing".
pub enum Row {
    /// Raw text with no marker and no trailing newline — an assistant delta.
    Stream(String),
    /// A complete line, already styled and ready to print.
    Line(String),
    /// A marked row plus its indented detail.
    Pair { head: String, detail: String },
}

/// Render one transcript event.
///
/// Returns `None` for events with nothing to say on a terminal — a `Dispatch`
/// header the caller already printed, a `Usage` update mid-turn.
pub fn render(term: &Term, event: &TaskEvent, verbose: bool) -> Option<Row> {
    match event {
        TaskEvent::Dispatch { .. } => None,

        TaskEvent::Text { text } => Some(Row::Stream(text.clone())),

        TaskEvent::Thinking { text } => {
            // Reasoning is off by default. It is long, it is not the answer,
            // and a terminal that prints it drowns the work the user asked to
            // watch. `--verbose` opts in.
            if !verbose {
                return None;
            }
            Some(Row::Line(format!(
                "{} {}",
                term.paint(Style::Muted, term.g(glyph::SPARK)),
                term.paint(Style::Muted, &summarize(text, MAX_SUMMARY))
            )))
        }

        TaskEvent::Tool { name, input, .. } => Some(Row::Line(format!(
            "{} {}  {}",
            term.paint(Style::Active, term.g(glyph::DOT)),
            term.bold(name),
            term.paint(Style::Muted, &tool_argument(name, input))
        ))),

        TaskEvent::ToolResult {
            ok,
            content,
            truncated_from,
            ..
        } => {
            let mut detail = summarize(content, MAX_SUMMARY);
            if detail.is_empty() {
                // A tool that returns nothing succeeded silently; an empty
                // continuation row reads as a broken renderer.
                detail = if *ok { "done".to_string() } else { "failed".to_string() };
            }
            if truncated_from.is_some() {
                detail.push_str(" …");
            }
            let style = if *ok { Style::Muted } else { Style::Error };
            Some(Row::Line(format!(
                "  {} {}",
                term.paint(style, term.g(glyph::ELBOW)),
                term.paint(style, &detail)
            )))
        }

        TaskEvent::Usage {
            input_tokens,
            output_tokens,
            cost_usd,
            ..
        } => {
            if !verbose {
                return None;
            }
            let mut parts = vec![format!("{} in", thousands(*input_tokens))];
            parts.push(format!("{} out", thousands(*output_tokens)));
            if let Some(cost) = cost_usd {
                parts.push(format!("${cost:.4}"));
            }
            let sep = format!(" {} ", term.g(glyph::MIDDOT));
            Some(Row::Line(term.paint(Style::Muted, &parts.join(&sep))))
        }

        TaskEvent::Notice { message } => Some(Row::Line(format!(
            "{} {}",
            term.paint(Style::Warning, term.g(glyph::WARN)),
            term.paint(Style::Muted, &summarize(message, MAX_SUMMARY))
        ))),

        TaskEvent::Result {
            subtype,
            error,
            duration_ms,
            num_turns,
            ..
        } => {
            let (mark, style, label) = match subtype {
                ResultKind::Success => (term.g(glyph::CHECK), Style::Success, "done"),
                ResultKind::Error => (term.g(glyph::CROSS), Style::Error, "failed"),
                ResultKind::Cancelled => (term.g(glyph::CROSS), Style::Warning, "stopped"),
            };
            let sep = format!(" {} ", term.g(glyph::MIDDOT));
            let stats = format!(
                "{}{sep}{}",
                duration(*duration_ms),
                plural(*num_turns, "step", "steps")
            );
            let head = format!(
                "{} {}  {}",
                term.paint(style, mark),
                term.strong(style, label),
                term.paint(Style::Muted, &stats)
            );
            match error {
                Some(message) => Some(Row::Pair {
                    head,
                    detail: format!(
                        "  {} {}",
                        term.paint(Style::Error, term.g(glyph::ELBOW)),
                        term.paint(Style::Error, &summarize(message, MAX_SUMMARY * 2))
                    ),
                }),
                None => Some(Row::Line(head)),
            }
        }
    }
}

/// The one argument worth showing beside a tool name.
///
/// A tool's full input is JSON and belongs in the transcript, not on a row.
/// What a reader wants is the *object*: which file, which pattern, which
/// command. So this pulls the field that answers "on what?" and shows only
/// that — falling back to a compact form of the whole input when a tool has no
/// obvious subject.
fn tool_argument(name: &str, input: &serde_json::Value) -> String {
    // Ordered by how specific the field is, so a tool carrying several picks
    // the most informative. These names are Aurora's own tool schemas
    // (`tools/file_workspace_search`, `tools/shell`, …).
    const SUBJECT_KEYS: [&str; 8] = [
        "path",
        "file_path",
        "pattern",
        "query",
        "command",
        "url",
        "old_path",
        "todos",
    ];

    if let Some(object) = input.as_object() {
        for key in SUBJECT_KEYS {
            match object.get(key) {
                Some(serde_json::Value::String(value)) if !value.trim().is_empty() => {
                    return summarize(value, MAX_SUMMARY);
                }
                // A non-string subject (`todos` is an array) is worth counting
                // rather than dumping.
                Some(serde_json::Value::Array(items)) => {
                    return plural(items.len() as u32, "item", "items");
                }
                _ => {}
            }
        }
        if object.is_empty() {
            return String::new();
        }
        // No recognised subject: name the keys rather than the values. Values
        // can be a whole file's contents; keys are always short, and they
        // still say what kind of call this was.
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        return summarize(&keys.join(", "), MAX_SUMMARY);
    }

    let _ = name;
    String::new()
}

/// Collapse arbitrary text into one printable line.
///
/// Three jobs, and every one of them is a safety property rather than a
/// cosmetic one:
///
/// 1. **Strip control characters.** Tool output can contain `\r`, `\x1b[2J`,
///    or a terminal title sequence. Echoed into a terminal these are
///    *commands*, not text — they can erase the screen or overwrite the rows
///    above. Anything below `0x20` that is not an ordinary space is dropped.
/// 2. **Collapse whitespace.** A row is one line; runs of spaces and newlines
///    become single spaces so the result cannot wrap into a second.
/// 3. **Cut to a budget**, on a character boundary.
pub fn summarize(text: &str, max: usize) -> String {
    let mut out = String::with_capacity(text.len().min(max + 1));
    let mut pending_space = false;

    for ch in text.chars() {
        // `is_control` covers C0, DEL and C1 — which is what carries ANSI
        // escapes, and therefore every way a string can move a cursor.
        if ch.is_control() || ch.is_whitespace() {
            // Leading whitespace never starts the summary.
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        if out.chars().count() >= max {
            // Trailing ellipsis marks the cut so a reader is not left thinking
            // a path or a message simply ended there.
            out.push('…');
            return out;
        }
        out.push(ch);
    }
    out
}

/// A duration a person can read: `840ms`, `4.2s`, `1m 12s`.
fn duration(ms: u64) -> String {
    if ms < 1_000 {
        return format!("{ms}ms");
    }
    let seconds = ms as f64 / 1_000.0;
    if seconds < 60.0 {
        return format!("{seconds:.1}s");
    }
    let whole = ms / 1_000;
    format!("{}m {}s", whole / 60, whole % 60)
}

/// Thousands separators, so a token count is legible at a glance.
fn thousands(value: u32) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// `1 step` / `3 steps`, because "1 steps" reads as a bug in the tool.
fn plural(count: u32, one: &str, many: &str) -> String {
    if count == 1 {
        format!("1 {one}")
    } else {
        format!("{count} {many}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plain() -> Term {
        Term::plain()
    }

    fn line_of(row: Option<Row>) -> String {
        match row.expect("expected a row") {
            Row::Line(line) => line,
            Row::Stream(text) => text,
            Row::Pair { head, detail } => format!("{head}\n{detail}"),
        }
    }

    #[test]
    fn a_tool_row_names_its_subject() {
        let row = render(
            &plain(),
            &TaskEvent::Tool {
                tool_use_id: "t1".to_string(),
                name: "file_read".to_string(),
                input: json!({ "path": "src/timeline_service.dart", "offset": 0 }),
            },
            false,
        );
        let line = line_of(row);
        assert!(line.contains("file_read"));
        assert!(line.contains("src/timeline_service.dart"));
        // The uninteresting argument stays off the row.
        assert!(!line.contains("offset"));
    }

    #[test]
    fn a_tool_with_no_known_subject_names_its_keys_not_its_values() {
        // The failure this prevents: a `file_write` dumping an entire file
        // onto one terminal row.
        let row = render(
            &plain(),
            &TaskEvent::Tool {
                tool_use_id: "t1".to_string(),
                name: "mystery_tool".to_string(),
                input: json!({ "contents": "a".repeat(5_000), "flag": true }),
            },
            false,
        );
        let line = line_of(row);
        assert!(line.contains("contents, flag"));
        assert!(!line.contains("aaaa"));
    }

    #[test]
    fn an_array_argument_is_counted() {
        let row = render(
            &plain(),
            &TaskEvent::Tool {
                tool_use_id: "t1".to_string(),
                name: "todo".to_string(),
                input: json!({ "todos": [1, 2, 3] }),
            },
            false,
        );
        assert!(line_of(row).contains("3 items"));
    }

    #[test]
    fn a_failed_result_row_is_marked() {
        let row = render(
            &plain(),
            &TaskEvent::ToolResult {
                tool_use_id: "t1".to_string(),
                name: "shell_execute".to_string(),
                ok: false,
                content: "command not found".to_string(),
                truncated_from: None,
            },
            false,
        );
        assert!(line_of(row).contains("command not found"));
    }

    #[test]
    fn an_empty_result_still_says_something() {
        let row = render(
            &plain(),
            &TaskEvent::ToolResult {
                tool_use_id: "t1".to_string(),
                name: "file_write".to_string(),
                ok: true,
                content: String::new(),
                truncated_from: None,
            },
            false,
        );
        assert!(line_of(row).contains("done"));
    }

    #[test]
    fn thinking_is_hidden_unless_asked_for() {
        let event = TaskEvent::Thinking {
            text: "let me consider".to_string(),
        };
        assert!(render(&plain(), &event, false).is_none());
        assert!(render(&plain(), &event, true).is_some());
    }

    #[test]
    fn usage_is_hidden_unless_asked_for() {
        let event = TaskEvent::Usage {
            input_tokens: 12_400,
            output_tokens: 800,
            cache_read_tokens: None,
            cost_usd: Some(0.0321),
        };
        assert!(render(&plain(), &event, false).is_none());
        let line = line_of(render(&plain(), &event, true));
        assert!(line.contains("12,400 in"));
        assert!(line.contains("$0.0321"));
    }

    #[test]
    fn a_failed_run_shows_the_reason_under_the_verdict() {
        let row = render(
            &plain(),
            &TaskEvent::Result {
                subtype: ResultKind::Error,
                result: None,
                error: Some("provider returned 429".to_string()),
                duration_ms: 4_200,
                num_turns: 2,
            },
            false,
        );
        match row.expect("row") {
            Row::Pair { head, detail } => {
                assert!(head.contains("failed"));
                assert!(head.contains("4.2s"));
                assert!(detail.contains("429"));
            }
            _ => panic!("an error result should carry its reason"),
        }
    }

    // ── summarize: the safety gate ──────────────────────────────────────

    #[test]
    fn summarize_strips_ansi_escapes() {
        // The attack this closes: tool output that repaints the terminal.
        let hostile = "before\x1b[2J\x1b[1;1Hafter";
        let safe = summarize(hostile, 100);
        assert!(!safe.contains('\x1b'));
        assert!(safe.contains("before"));
        assert!(safe.contains("after"));
    }

    #[test]
    fn summarize_strips_carriage_returns() {
        // `\r` alone rewrites the current line, hiding what came before it.
        let safe = summarize("real output\rFAKE PROMPT $", 100);
        assert!(!safe.contains('\r'));
        assert!(safe.contains("real output"));
    }

    #[test]
    fn summarize_produces_exactly_one_line() {
        let safe = summarize("one\ntwo\r\nthree\tfour", 100);
        assert!(!safe.contains('\n'));
        assert_eq!(safe, "one two three four");
    }

    #[test]
    fn summarize_collapses_runs_of_whitespace() {
        assert_eq!(summarize("  a     b  ", 100), "a b");
    }

    #[test]
    fn summarize_cuts_to_budget_and_marks_it() {
        let safe = summarize(&"x".repeat(200), 10);
        assert_eq!(safe.chars().count(), 11, "10 chars plus the ellipsis");
        assert!(safe.ends_with('…'));
    }

    #[test]
    fn summarize_never_splits_a_codepoint() {
        let safe = summarize(&"あ".repeat(200), 10);
        assert!(safe.chars().all(|c| c == 'あ' || c == '…'));
    }

    #[test]
    fn summarize_handles_empty_input() {
        assert_eq!(summarize("", 10), "");
        assert_eq!(summarize("   \n\t ", 10), "");
    }

    // ── formatting helpers ──────────────────────────────────────────────

    #[test]
    fn durations_read_naturally() {
        assert_eq!(duration(840), "840ms");
        assert_eq!(duration(4_200), "4.2s");
        assert_eq!(duration(72_000), "1m 12s");
    }

    #[test]
    fn token_counts_are_grouped() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_000), "1,000");
        assert_eq!(thousands(12_400), "12,400");
        assert_eq!(thousands(1_234_567), "1,234,567");
    }

    #[test]
    fn counts_are_pluralised() {
        assert_eq!(plural(1, "step", "steps"), "1 step");
        assert_eq!(plural(0, "step", "steps"), "0 steps");
        assert_eq!(plural(3, "step", "steps"), "3 steps");
    }
}
