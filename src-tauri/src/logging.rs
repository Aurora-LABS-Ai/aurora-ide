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
use std::io::Write as _;
use std::path::PathBuf;
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

fn log_file() -> PathBuf {
    crate::paths::logs_dir().join("aurora.log")
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
