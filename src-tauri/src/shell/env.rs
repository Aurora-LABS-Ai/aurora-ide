//! Environment composition for spawned shells.
//!
//! ## Why this module exists
//!
//! Git for Windows ships **two** bash binaries. `<git>\bin\bash.exe` is a
//! launcher that builds the MSYS environment before exec'ing the real shell;
//! `<git>\usr\bin\bash.exe` is the real shell. Aurora spawns shells directly
//! from a Windows process, so whichever binary is used, the child inherits
//! only the *Windows* `PATH`. MSYS translates that path list into POSIX form
//! but never adds `/usr/bin` or `/mingw64/bin` — that is the launcher's job.
//!
//! The observable damage: `ls`, `cat`, `head`, `sed`, `tr`, `uname`, and
//! `sleep` all report `command not found`, and npm's shell shim (which calls
//! `dirname`/`uname`/`sed` before doing anything) fails with garbled UTF-16
//! output, making a passing test suite look broken.
//!
//! [`compose`] rebuilds what the launcher would have set: Git's userland
//! directories prepended to `PATH`, in Git Bash's own order, plus `MSYSTEM`.
//! It is derived from the executable's location on every resolve, so moving
//! or upgrading a Git install repairs itself with no stored state.

use std::path::{Path, PathBuf};

use super::kinds::ShellKind;

/// Expand environment references in a user-supplied path.
///
/// Windows Terminal profiles and hand-typed paths routinely contain
/// `%PROGRAMFILES%` / `%SystemRoot%`, so a registered path is stored raw and
/// expanded at use time — the profile keeps working when the variable's value
/// differs across machines. Unknown variables are left untouched rather than
/// silently blanked, so a wrong path stays visibly wrong.
#[must_use]
pub fn expand_vars(raw: &str) -> String {
    let expanded = expand_percent_vars(raw);
    expand_dollar_vars(&expanded)
}

/// `%NAME%` expansion (Windows form).
fn expand_percent_vars(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;

    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match (name.is_empty(), std::env::var(name)) {
                    (false, Ok(value)) => out.push_str(&value),
                    // Unknown or empty: keep the literal `%NAME%` text.
                    _ => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                out.push_str(after);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `$NAME` / `${NAME}` expansion plus a leading `~` (POSIX form).
fn expand_dollar_vars(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());

    let with_home = if let Some(tail) = raw.strip_prefix('~') {
        match dirs::home_dir() {
            Some(home) if tail.is_empty() || tail.starts_with('/') || tail.starts_with('\\') => {
                format!("{}{tail}", home.to_string_lossy())
            }
            _ => raw.to_string(),
        }
    } else {
        raw.to_string()
    };

    let mut chars = with_home.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '$' {
            out.push(ch);
            continue;
        }
        let braced = chars.peek() == Some(&'{');
        if braced {
            chars.next();
        }
        let mut name = String::new();
        while let Some(&next) = chars.peek() {
            let valid = next.is_ascii_alphanumeric() || next == '_';
            if braced && next == '}' {
                chars.next();
                break;
            }
            if !valid {
                break;
            }
            name.push(next);
            chars.next();
        }
        match std::env::var(&name) {
            Ok(value) if !name.is_empty() => out.push_str(&value),
            _ => {
                out.push('$');
                if braced {
                    out.push('{');
                }
                out.push_str(&name);
                if braced {
                    out.push('}');
                }
            }
        }
    }
    out
}

/// Locate the MSYS/Git root that owns a bash executable.
///
/// Handles both layouts Git for Windows exposes:
/// `<root>\bin\bash.exe` (launcher) and `<root>\usr\bin\bash.exe` (real
/// shell). The root is the directory that contains `usr\bin`.
#[must_use]
pub fn msys_root(exe: &Path) -> Option<PathBuf> {
    let bin = exe.parent()?;

    // `<root>\bin\bash.exe`
    if let Some(root) = bin.parent() {
        if root.join("usr").join("bin").is_dir() {
            return Some(root.to_path_buf());
        }
    }
    // `<root>\usr\bin\bash.exe`
    if let Some(root) = bin.parent().and_then(Path::parent) {
        if root.join("usr").join("bin").is_dir() {
            return Some(root.to_path_buf());
        }
    }
    None
}

/// Userland directories to prepend, in Git Bash's own precedence order
/// (`/mingw64/bin`, `/usr/local/bin`, `/usr/bin`). Only existing dirs are
/// returned, so a trimmed-down MSYS install contributes what it actually has.
#[must_use]
pub fn msys_path_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for candidate in ["mingw64/bin", "mingw32/bin", "usr/local/bin", "usr/bin"] {
        let path = root.join(candidate.replace('/', std::path::MAIN_SEPARATOR_STR));
        if path.is_dir() {
            dirs.push(path);
        }
        // Only one mingw flavour is ever present; taking both is harmless
        // but taking neither would leave `gcc`-adjacent tooling unreachable.
    }
    dirs
}

/// The `MSYSTEM` value matching an install's mingw flavour. Git Bash sets
/// this and some scripts branch on it (`uname` reports `MINGW64_NT-…` with
/// it set, `MSYS_NT-…` without).
fn msystem_for(root: &Path) -> &'static str {
    if root.join("mingw64").is_dir() {
        "MINGW64"
    } else if root.join("mingw32").is_dir() {
        "MINGW32"
    } else {
        "MSYS"
    }
}

/// Environment overlay for a shell, as `(name, value)` pairs applied on top
/// of the inherited environment.
///
/// Returns an empty vector for shells that need nothing special — the vast
/// majority. The overlay is intentionally minimal: `TERM` is left unset so
/// piped output keeps the same shape it has today, and nothing is removed
/// from the inherited environment.
#[must_use]
pub fn compose(kind: ShellKind, exe: &Path) -> Vec<(String, String)> {
    let mut overlay = streaming_env();

    if !kind.is_posix() {
        return overlay;
    }
    let Some(root) = msys_root(exe) else {
        return overlay;
    };
    let dirs = msys_path_dirs(&root);
    if dirs.is_empty() {
        return overlay;
    }

    let inherited = std::env::var("PATH").unwrap_or_default();
    let prefix = std::env::join_paths(dirs.iter())
        .map(|joined| joined.to_string_lossy().to_string())
        .unwrap_or_default();
    if !prefix.is_empty() {
        let path = if inherited.is_empty() {
            prefix
        } else {
            format!("{prefix}{}{inherited}", separator())
        };
        overlay.push(("PATH".to_string(), path));
    }

    // Respect an MSYSTEM the user has already exported (they may be driving a
    // specific MSYS2 subsystem); otherwise match what Git Bash would set.
    if std::env::var("MSYSTEM").is_err() {
        overlay.push(("MSYSTEM".to_string(), msystem_for(&root).to_string()));
    }

    overlay
}

/// Environment that keeps a child's output *arriving* rather than pooling.
///
/// A program writing to a terminal line-buffers; writing to a pipe it usually
/// switches to block buffering and emits nothing until it exits or fills a
/// 4–8 KB buffer. Aurora captures output through pipes, so a script that
/// prints a line a second showed a card that sat empty and then dumped
/// everything at once — measured: six lines over 2.4s all landed inside 0.34s.
///
/// Python is the common offender and honours an explicit opt-out, so set it
/// (unless the user already has an opinion). Node, cargo, npm, and git flush
/// per write and already stream correctly.
///
/// This does not make a child *believe* it has a terminal — tools that check
/// `isatty` still drop colour and progress bars. Only a real PTY does that.
fn streaming_env() -> Vec<(String, String)> {
    if std::env::var("PYTHONUNBUFFERED").is_ok() {
        return Vec::new();
    }
    vec![("PYTHONUNBUFFERED".to_string(), "1".to_string())]
}

/// Index an overlay by name so assertions can ask for one variable.
///
/// Test-only, and marked as such: its doc comment used to claim discovery used
/// it to classify profile health, which was never true — discovery reads the
/// POSIX probe's own `coreutils_ok` / `coreutils_missing` output instead. As a
/// `pub fn` it read as production API that nothing called; `#[cfg(test)]` says
/// what it actually is.
#[cfg(test)]
#[must_use]
fn overlay_map(overlay: &[(String, String)]) -> std::collections::HashMap<&str, &str> {
    overlay
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect()
}

const fn separator() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_unknown_percent_variables_literal() {
        let raw = r"%DEFINITELY_NOT_SET_12345%\Git\bin\bash.exe";
        assert_eq!(expand_vars(raw), raw);
    }

    #[test]
    fn expands_known_percent_variables() {
        std::env::set_var("AURORA_SHELL_TEST_ROOT", "C:/probe");
        assert_eq!(
            expand_vars("%AURORA_SHELL_TEST_ROOT%/bin/bash.exe"),
            "C:/probe/bin/bash.exe"
        );
        std::env::remove_var("AURORA_SHELL_TEST_ROOT");
    }

    #[test]
    fn expands_dollar_variables() {
        std::env::set_var("AURORA_SHELL_TEST_DOLLAR", "/opt/tools");
        assert_eq!(
            expand_vars("$AURORA_SHELL_TEST_DOLLAR/bash"),
            "/opt/tools/bash"
        );
        assert_eq!(
            expand_vars("${AURORA_SHELL_TEST_DOLLAR}/bash"),
            "/opt/tools/bash"
        );
        std::env::remove_var("AURORA_SHELL_TEST_DOLLAR");
    }

    #[test]
    fn non_posix_kinds_get_no_path_repair() {
        let overlay = compose(ShellKind::Cmd, Path::new(r"C:\Windows\System32\cmd.exe"));
        let map = overlay_map(&overlay);
        assert!(!map.contains_key("PATH"), "cmd needs no userland repair");
        assert!(!map.contains_key("MSYSTEM"));
    }

    #[test]
    fn every_shell_gets_unbuffered_python() {
        // Without this a script printing one line a second renders nothing
        // until it exits, because a piped stdout switches to block buffering.
        for kind in [ShellKind::Cmd, ShellKind::Pwsh, ShellKind::Bash] {
            let overlay = compose(kind, Path::new("bash"));
            assert_eq!(
                overlay_map(&overlay).get("PYTHONUNBUFFERED").copied(),
                Some("1"),
                "{kind:?} must stream python output"
            );
        }
    }

    #[test]
    fn msys_root_detects_both_git_layouts() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("usr").join("bin")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();

        let launcher = root.join("bin").join("bash.exe");
        let real = root.join("usr").join("bin").join("bash.exe");
        assert_eq!(msys_root(&launcher).as_deref(), Some(root));
        assert_eq!(msys_root(&real).as_deref(), Some(root));
    }

    #[test]
    fn overlay_prepends_git_userland_to_path() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("usr").join("bin")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();

        let overlay = compose(ShellKind::Bash, &root.join("bin").join("bash.exe"));
        let map = overlay_map(&overlay);
        let path = map.get("PATH").copied().unwrap_or_default();
        assert!(
            path.contains(&root.join("usr").join("bin").to_string_lossy().to_string()),
            "usr/bin must be prepended, got: {path}"
        );
    }
}
