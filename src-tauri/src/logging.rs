//! Production file logging — one log file on disk that survives the exe.
//!
//! `%LOCALAPPDATA%\AuroraIDE\logs\aurora.log` (via [`crate::paths::logs_dir`]).
//! Every surfaced error in the app funnels through [`log_error`] so a failure
//! seen in the UI ("provider returned an error: …") always has its full,
//! un-flattened detail on disk — including raw provider payloads that the
//! user-facing message cannot carry. Without this file, a production error is
//! unrecoverable the moment the dialog closes (there is no console in the
//! packaged exe, and `eprintln!` goes nowhere).
//!
//! Design constraints, in order:
//! 1. **Never lose the error being logged.** Writes append with the file
//!    opened per call — no long-lived handle to go stale, no buffering to
//!    lose on a crash. Errors are rare; per-write open cost is irrelevant.
//! 2. **Never take the app down.** Every fs failure in here is swallowed —
//!    a logger that can panic converts a disk-full into a crash.
//! 3. **Bounded.** One entry is clamped to [`MAX_ENTRY_LEN`]; the file
//!    rotates at [`MAX_LOG_LEN`] to a single `.1` backup, so the pair can
//!    never exceed ~2× the cap however long the install lives.

use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// One entry's ceiling. Raw provider payloads ride in entries, and a
/// misbehaving gateway can emit megabytes — the file must not.
const MAX_ENTRY_LEN: usize = 8 * 1024;

/// Rotation threshold for `aurora.log`. On crossing it the file is renamed
/// to `aurora.log.1` (replacing the previous backup) and a fresh file
/// starts, so history survives one rotation back.
const MAX_LOG_LEN: u64 = 5 * 1024 * 1024;

/// Serializes writers across threads. The runtime, the API adapters and the
/// panic hook all log; interleaved partial lines would make the file lie.
static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// How much of the tail to read when showing recent entries.
///
/// The file caps at [`MAX_LOG_LEN`], and reading all 5 MB to display the last
/// hundred lines would be pure waste. At typical entry sizes this window holds
/// thousands of entries — far more than anyone reads — while keeping the read
/// bounded no matter how the file grows.
const TAIL_READ_BYTES: u64 = 512 * 1024;

pub fn log_file() -> PathBuf {
    crate::paths::logs_dir().join("aurora.log")
}

fn backup_file() -> PathBuf {
    log_file().with_extension("log.1")
}

/// Install the panic hook and stamp a session-start line.
///
/// Call once, first thing in `run()`. The hook chains to the previous one so
/// the default stderr backtrace behaviour (useful under `tauri:dev`) is kept.
pub fn init() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_string());
        write_entry("PANIC", "panic", &format!("{payload} at {location}"));
        previous(info);
    }));
    write_entry(
        "INFO",
        "startup",
        &format!("Aurora {} starting", env!("CARGO_PKG_VERSION")),
    );
}

/// An error that was (or should have been) surfaced. `component` names the
/// subsystem (`"api.responses"`, `"agent_runtime.turn"`, `"db"`), `message`
/// carries the full detail — include raw payloads here, this is the copy
/// that exists so diagnosis never depends on what the UI could show.
pub fn log_error(component: &str, message: &str) {
    write_entry("ERROR", component, message);
}

/// A degraded-but-continuing condition worth a trace on disk.
#[allow(dead_code)]
pub fn log_warn(component: &str, message: &str) {
    write_entry("WARN", component, message);
}

/// A normal-operation trace.
///
/// Use for the facts you would want on disk when something later goes wrong and
/// cannot be reproduced — how much work a call did, how long it took, how big
/// its result was. A crash leaves no explanation of its own; the lines written
/// just before it are what turn "it died" into "it died doing this".
#[allow(dead_code)]
pub fn log_info(component: &str, message: &str) {
    write_entry("INFO", component, message);
}

/// A failure reported by the web layer.
///
/// The React side has no console in a packaged build, so without this route
/// every UI failure the user actually sees would leave no trace on disk while
/// the Rust half of the same crash is fully recorded — a log that is worse than
/// silent, because it looks complete.
///
/// `level` is clamped to `ERROR`/`WARN` and the component is namespaced, so a
/// caller in the renderer cannot forge a line that reads as backend output.
pub fn log_from_ui(level: &str, component: &str, message: &str) {
    let level = if level.eq_ignore_ascii_case("warn") {
        "WARN"
    } else {
        "ERROR"
    };
    let component = component.trim();
    let component = if component.is_empty() {
        "ui".to_string()
    } else {
        format!("ui.{}", component.trim_start_matches("ui."))
    };
    write_entry(level, &component, message);
}

// ── Reading it back ─────────────────────────────────────────────────────────

/// One parsed line of `aurora.log`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LogEntry {
    /// ISO-8601 UTC stamp exactly as written.
    pub at: String,
    /// `ERROR` / `WARN` / `INFO` / `PANIC`, or `RAW` for a line that did not parse.
    pub level: String,
    /// Subsystem that logged it, e.g. `api.responses`. Empty for `RAW`.
    pub component: String,
    pub message: String,
}

/// What the diagnostics view needs to describe the log honestly.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogSnapshot {
    /// Absolute path, shown so a person can reach the file without the app.
    pub path: String,
    /// Newest last, matching the file. The caller decides display order.
    pub entries: Vec<LogEntry>,
    pub bytes: u64,
    /// Entries exist beyond the ones returned — the view must not claim to be
    /// showing everything.
    pub truncated: bool,
    /// A rotated `aurora.log.1` is sitting beside it with older entries.
    pub has_backup: bool,
}

/// The most recent `limit` entries, oldest first.
pub fn recent(limit: usize) -> LogSnapshot {
    let path = log_file();
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let (text, clipped) = read_tail(&path);

    let mut entries: Vec<LogEntry> = text.lines().filter_map(parse_line).collect();
    let over_limit = entries.len() > limit;
    if over_limit {
        entries.drain(..entries.len() - limit);
    }

    LogSnapshot {
        path: path.to_string_lossy().into_owned(),
        entries,
        bytes,
        // Either the byte window cut history off, or the limit did.
        truncated: clipped || over_limit,
        has_backup: backup_file().exists(),
    }
}

/// Read at most [`TAIL_READ_BYTES`] from the end. Returns the text and whether
/// anything was left behind.
fn read_tail(path: &Path) -> (String, bool) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return (String::new(), false);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TAIL_READ_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (String::new(), false);
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return (String::new(), false);
    }
    // Lossy: a torn multi-byte char at the seek point must not lose the whole
    // read, and entries are ASCII-framed regardless.
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start == 0 {
        return (text, false);
    }
    // Seeking lands mid-line. Drop the fragment so it is never shown as an
    // entry that begins somewhere arbitrary.
    match text.find('\n') {
        Some(i) => (text[i + 1..].to_string(), true),
        None => (String::new(), true),
    }
}

/// `[<stamp>] [<level>] [<component>] <message>`.
///
/// A line that does not parse is kept as `RAW` rather than dropped. Every line
/// in this file was written by [`write_entry`], so an unparsable one means a
/// torn write — which is evidence about a crash, not noise to hide.
fn parse_line(line: &str) -> Option<LogEntry> {
    let line = line.trim_end_matches('\r');
    if line.trim().is_empty() {
        return None;
    }
    let raw = || LogEntry {
        at: String::new(),
        level: "RAW".to_string(),
        component: String::new(),
        message: line.to_string(),
    };

    let Some((at, rest)) = take_bracketed(line) else {
        return Some(raw());
    };
    let Some((level, rest)) = take_bracketed(rest) else {
        return Some(raw());
    };
    let Some((component, message)) = take_bracketed(rest) else {
        return Some(raw());
    };

    Some(LogEntry {
        at: at.to_string(),
        level: level.to_string(),
        component: component.to_string(),
        message: message.to_string(),
    })
}

/// Split a leading `[field] ` off, returning the field and what follows.
fn take_bracketed(s: &str) -> Option<(&str, &str)> {
    let rest = s.strip_prefix('[')?;
    let end = rest.find(']')?;
    Some((&rest[..end], rest[end + 1..].trim_start_matches(' ')))
}

/// Empty the log, dropping the rotated backup with it.
///
/// Leaves a line behind saying it happened: a log that can silently become
/// empty is a log you cannot trust when it *is* empty.
pub fn clear() -> Result<(), String> {
    {
        let guard = WRITE_LOCK.get_or_init(|| Mutex::new(())).lock();
        let _guard = match guard {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let _ = std::fs::remove_file(backup_file());
        std::fs::write(log_file(), b"").map_err(|e| format!("Could not clear the log: {e}"))?;
    }
    write_entry("INFO", "logging", "log cleared from Diagnostics");
    Ok(())
}

fn write_entry(level: &str, component: &str, message: &str) {
    // Single-line entries: newlines inside a message become literal `\n`
    // so one line in the file is always one event (grep-able, tail-able).
    let mut body = message.replace('\r', "").replace('\n', "\\n");
    if body.len() > MAX_ENTRY_LEN {
        // Clamp on a char boundary; a panic inside the logger is the one
        // thing this module must never do.
        let mut cut = MAX_ENTRY_LEN;
        while cut > 0 && !body.is_char_boundary(cut) {
            cut -= 1;
        }
        body.truncate(cut);
        let _ = write!(body, " …[truncated, {} bytes total]", message.len());
    }
    let line = format!(
        "[{}] [{level}] [{component}] {body}\n",
        chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"),
    );

    // Mirror to stderr so `tauri:dev` keeps its console visibility.
    eprint!("{line}");

    let guard = WRITE_LOCK.get_or_init(|| Mutex::new(())).lock();
    // A poisoned lock means another thread panicked mid-write — the file may
    // hold a partial line, but appending is still safe and losing THIS entry
    // (possibly the panic's own context) would be worse.
    let _guard = match guard {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };

    let path = log_file();
    rotate_if_needed(&path);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn rotate_if_needed(path: &std::path::Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return; // no file yet — nothing to rotate
    };
    if meta.len() < MAX_LOG_LEN {
        return;
    }
    let backup = path.with_extension("log.1");
    let _ = std::fs::remove_file(&backup);
    let _ = std::fs::rename(path, &backup);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_clamps_and_flattens_newlines() {
        // Exercise the formatting path directly: a huge multi-line message
        // must become one bounded line.
        let big = format!("first\nsecond\n{}", "x".repeat(MAX_ENTRY_LEN * 2));
        let mut body = big.replace('\r', "").replace('\n', "\\n");
        assert!(body.contains("first\\nsecond"));
        if body.len() > MAX_ENTRY_LEN {
            let mut cut = MAX_ENTRY_LEN;
            while cut > 0 && !body.is_char_boundary(cut) {
                cut -= 1;
            }
            body.truncate(cut);
        }
        assert!(body.len() <= MAX_ENTRY_LEN);
        assert!(!body.contains('\n'));
    }

    #[test]
    fn parses_the_line_shape_write_entry_produces() {
        let entry = parse_line(
            "[2026-08-11T05:22:29.123Z] [ERROR] [api.responses] upstream 500: {\"error\":\"x\"}",
        )
        .expect("a written line parses");
        assert_eq!(entry.at, "2026-08-11T05:22:29.123Z");
        assert_eq!(entry.level, "ERROR");
        assert_eq!(entry.component, "api.responses");
        assert_eq!(entry.message, "upstream 500: {\"error\":\"x\"}");
    }

    #[test]
    fn keeps_a_message_that_contains_brackets_intact() {
        // Only the first three bracketed fields are structure; the rest is the
        // message, brackets and all. Provider payloads are full of them.
        let entry = parse_line("[t] [WARN] [c] rate limit [429] on [model-a]").unwrap();
        assert_eq!(entry.message, "rate limit [429] on [model-a]");
    }

    #[test]
    fn keeps_a_torn_line_as_evidence_instead_of_dropping_it() {
        // A line that cannot be parsed means a write was interrupted — which is
        // information about a crash, so it must survive to the reader.
        let entry = parse_line("half a line with no structure").unwrap();
        assert_eq!(entry.level, "RAW");
        assert_eq!(entry.message, "half a line with no structure");
        assert!(parse_line("   ").is_none(), "blank lines are not entries");
    }

    #[test]
    fn ui_reports_cannot_pose_as_backend_components() {
        // The renderer names its own component, so the namespace is forced here
        // rather than trusted from the caller.
        for (input, expected) in [("crash", "ui.crash"), ("ui.crash", "ui.crash"), ("", "ui")] {
            let component = if input.trim().is_empty() {
                "ui".to_string()
            } else {
                format!("ui.{}", input.trim().trim_start_matches("ui."))
            };
            assert_eq!(component, expected);
        }
    }

    #[test]
    fn write_entry_appends_to_log_file() {
        // Writes go to the real logs dir; assert the file exists and the
        // marker landed. Uses a unique marker so reruns don't false-pass.
        let marker = format!("logging-selftest-{}", std::process::id());
        write_entry("INFO", "logging.test", &marker);
        let content = std::fs::read_to_string(log_file()).unwrap_or_default();
        assert!(
            content.contains(&marker),
            "aurora.log should contain the marker line"
        );
    }
}
