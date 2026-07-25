//! Bundled helper executables Aurora ships alongside its own binary.
//!
//! Aurora's `grep` tool is the model's primary way to search a codebase, and it
//! used to spawn a bare `rg` from `PATH`. On a machine without ripgrep — which
//! is most machines, since it is not something a normal user installs — the
//! tool returned `Failed to execute rg` and the agent lost content search
//! entirely. A shipped desktop app cannot depend on a developer tool being
//! present in the user's environment.
//!
//! So ripgrep is vendored (`src-tauri/binaries/rg-<target-triple>.exe`) and
//! shipped as a Tauri `externalBin`, which places it next to `aurora.exe` in
//! the installed bundle. `build.rs` stages the same file into the Cargo target
//! directory so `cargo run` / `tauri dev` resolve it identically.
//!
//! ## Why bundled wins over `PATH`
//!
//! [`ripgrep`] prefers the shipped copy even when the user has their own. The
//! `--json` event stream this app parses is a versioned interface: ripgrep 11
//! and ripgrep 14 do not emit the same fields. Pinning the binary means the
//! parser in [`crate::commands::ripgrep_search`] is tested against exactly the
//! binary that will run. A user's `rg` is the fallback, not the default.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Where a resolved executable came from — surfaced in errors and logs so a
/// support question ("why is search behaving oddly?") is answerable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinarySource {
    /// The copy Aurora ships, next to the app executable.
    Bundled,
    /// The user's own install, found on `PATH`.
    SystemPath,
}

impl BinarySource {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            BinarySource::Bundled => "bundled",
            BinarySource::SystemPath => "path",
        }
    }
}

/// A helper executable that was actually located on disk.
#[derive(Debug, Clone)]
pub struct ResolvedBinary {
    pub path: PathBuf,
    pub source: BinarySource,
}

static RIPGREP: OnceLock<Option<ResolvedBinary>> = OnceLock::new();

/// Locate ripgrep: the bundled copy first, then the user's own.
///
/// Resolved once per process — the answer cannot change while Aurora runs, and
/// this sits on the hot path of every `grep` tool call.
///
/// Returns `None` only when Aurora's own copy is missing (a broken install or
/// a dev tree with an unpopulated `binaries/`) *and* the user has no ripgrep.
/// Callers must surface that as an actionable message rather than a raw spawn
/// error — see [`ripgrep_missing_message`].
#[must_use]
pub fn ripgrep() -> Option<&'static ResolvedBinary> {
    RIPGREP.get_or_init(resolve_ripgrep).as_ref()
}

fn resolve_ripgrep() -> Option<ResolvedBinary> {
    let exe_name = format!("rg{}", std::env::consts::EXE_SUFFIX);

    if let Some(path) = bundled_beside_executable(&exe_name) {
        return Some(ResolvedBinary {
            path,
            source: BinarySource::Bundled,
        });
    }

    if let Some(path) = lookup_on_path(&exe_name) {
        return Some(ResolvedBinary {
            path,
            source: BinarySource::SystemPath,
        });
    }

    None
}

/// The `externalBin` drop location: Tauri copies `binaries/rg-<triple>` next to
/// the app executable with the triple stripped, and `build.rs` mirrors that for
/// dev runs. Both land in the same directory, so one probe covers both.
fn bundled_beside_executable(exe_name: &str) -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    let dir = current.parent()?;
    let candidate = dir.join(exe_name);
    candidate.is_file().then_some(candidate)
}

/// Minimal `which`: walk `PATH` for an executable of this name.
///
/// Deliberately not a crate dependency — the whole job is a directory join and
/// an `is_file` check, and on Windows the only extra rule is that a bare name
/// may need `PATHEXT` applied. Symlinks and shims resolve naturally because we
/// hand the path to the OS loader rather than inspecting it.
fn lookup_on_path(exe_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(exe_name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(not(windows))]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// The error a caller shows when ripgrep cannot be found at all.
///
/// Names the real cause (Aurora's own copy is missing, so this is an install
/// problem, not a user mistake) and gives one concrete recovery step — a raw
/// `program not found` tells the model nothing it can act on.
#[must_use]
pub fn ripgrep_missing_message() -> String {
    "ripgrep is unavailable: Aurora's bundled copy was not found next to the application, and no \
     `rg` is on PATH. This usually means a damaged install — reinstall Aurora, or install ripgrep \
     (https://github.com/BurntSushi/ripgrep) so search can fall back to it."
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_lookup_finds_a_file_it_placed() {
        let tmp = tempfile::tempdir().unwrap();
        let name = format!("aurora-probe{}", std::env::consts::EXE_SUFFIX);
        let target = tmp.path().join(&name);
        std::fs::write(&target, b"#!/bin/sh\n").unwrap();
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        // Build a PATH containing only our temp dir so the probe is deterministic.
        let joined = std::env::join_paths([tmp.path()]).unwrap();
        let previous = std::env::var_os("PATH");
        // SAFETY: single-threaded test; restored below before returning.
        unsafe { std::env::set_var("PATH", &joined) };
        let found = lookup_on_path(&name);
        match previous {
            Some(value) => unsafe { std::env::set_var("PATH", value) },
            None => unsafe { std::env::remove_var("PATH") },
        }

        assert_eq!(found.as_deref(), Some(target.as_path()));
    }

    #[test]
    fn path_lookup_misses_a_name_that_does_not_exist() {
        assert!(lookup_on_path("aurora-definitely-not-a-real-binary-xyz").is_none());
    }

    #[test]
    fn missing_message_names_the_recovery_step() {
        let message = ripgrep_missing_message();
        assert!(message.contains("reinstall"), "{message}");
        assert!(message.contains("PATH"), "{message}");
    }

    /// The whole point of vendoring: ripgrep resolves on this machine without
    /// anyone having installed it. `build.rs` stages the sidecar into the test
    /// binary's own directory (`<target>/debug/deps/`), so this exercises the
    /// real `bundled_beside_executable` probe rather than a fixture.
    #[test]
    fn ripgrep_resolves() {
        let found = ripgrep().expect("ripgrep must resolve — bundled copy or PATH");
        assert!(
            found.path.is_file(),
            "resolved to a non-file: {}",
            found.path.display()
        );
    }

    #[test]
    fn source_ids_are_stable() {
        assert_eq!(BinarySource::Bundled.as_str(), "bundled");
        assert_eq!(BinarySource::SystemPath.as_str(), "path");
    }
}
