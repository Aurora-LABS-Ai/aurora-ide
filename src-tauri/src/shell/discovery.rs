//! Shell discovery — find the shells that exist, then prove they work.
//!
//! Discovery deliberately **verifies by execution, not by existence**. A path
//! on disk says nothing about whether the shell can actually run a command:
//! Git's `usr\bin\bash.exe` exists and starts fine while every coreutil is
//! unreachable, which is exactly the failure this module has to catch. Every
//! candidate is therefore launched once, with the environment Aurora would
//! really give it, and classified from what comes back.
//!
//! Candidate sources, in priority order (first match wins on a duplicate
//! path, so the best label survives):
//!
//! 1. **Windows Terminal** — user-authored profiles, with their names and the
//!    user's default. Covers installs in unguessable locations.
//! 2. **`PATH`** — whatever the user's own environment already resolves.
//! 3. **Registry** — `HKLM\SOFTWARE\GitForWindows\InstallPath`, the
//!    authoritative Git for Windows location.
//! 4. **Well-known locations** — `System32`, `Program Files\PowerShell\7`,
//!    the Store `WindowsApps` aliases, and the usual Git install roots.
//!
//! On non-Windows hosts the sources collapse to `$SHELL`, `/etc/shells`, and
//! `PATH`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command as TokioCommand;

// No `CommandExt` import: `tokio::process::Command` has its own inherent
// `creation_flags` on Windows, so the std trait would only shadow it.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use super::env;
use super::kinds::ShellKind;
use super::windows_terminal;
use super::{HealthState, ProfileSource, ShellHealth, ShellProfile};

/// How long a single verification probe may take before the candidate is
/// treated as unusable. Generous enough for a cold Store-aliased `pwsh`,
/// short enough that a full scan of a dozen candidates stays interactive.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Probe script for POSIX shells. Prints the shell's own version and whether
/// the standard Unix utilities are reachable, in one process — `command -v`
/// is a shell builtin, so it answers even when the userland is missing
/// entirely. Plain `sh` reports neither variable and simply has no version.
const POSIX_PROBE: &str = r#"printf '%s|' "${BASH_VERSION:-${ZSH_VERSION:-}}"; command -v uname >/dev/null 2>&1 && printf 'coreutils_ok' || printf 'coreutils_missing'"#;

/// A shell found on disk, before verification.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub kind: ShellKind,
    /// Path as the source expressed it — may contain `%VARS%`.
    pub raw_path: String,
    /// Fully expanded, existence-checked executable path.
    pub exe: PathBuf,
    pub label: String,
    /// The source marked this as the user's preferred shell.
    pub preferred: bool,
}

/// Enumerate every shell candidate on this machine, de-duplicated by
/// executable path.
#[must_use]
pub fn candidates() -> Vec<Candidate> {
    let mut found: Vec<Candidate> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let push = |candidate: Candidate, seen: &mut HashSet<String>, out: &mut Vec<Candidate>| {
        let key = dedupe_key(&candidate.exe);
        if seen.insert(key) {
            out.push(candidate);
        }
    };

    for profile in windows_terminal::discover() {
        // A wrapper profile (`cmd /k …\VsDevCmd.bat`) is an interactive
        // launcher, not a shell Aurora can run one-shot commands in.
        if windows_terminal::is_wrapper(&profile.args) {
            continue;
        }
        let expanded = PathBuf::from(env::expand_vars(&profile.raw_exe));
        let Some(exe) = resolve_executable(&expanded) else {
            continue;
        };
        let Some(kind) = ShellKind::from_exe(&exe) else {
            continue;
        };
        push(
            Candidate {
                kind,
                raw_path: profile.raw_exe.clone(),
                exe,
                label: profile.name.clone(),
                preferred: profile.is_default,
            },
            &mut seen,
            &mut found,
        );
    }

    for kind in ShellKind::ALL {
        for exe in path_lookup(*kind) {
            push(
                Candidate {
                    kind: *kind,
                    raw_path: exe.to_string_lossy().to_string(),
                    label: label_for(*kind, &exe),
                    exe,
                    preferred: false,
                },
                &mut seen,
                &mut found,
            );
        }
    }

    for (kind, exe) in well_known() {
        push(
            Candidate {
                kind,
                raw_path: exe.to_string_lossy().to_string(),
                label: label_for(kind, &exe),
                exe,
                preferred: false,
            },
            &mut seen,
            &mut found,
        );
    }

    found
}

/// Scan the machine and return **one verified profile per shell family**.
///
/// A machine routinely carries four `pwsh` installs (Store package, Program
/// Files, the x86 build, the WindowsApps alias) and two or three `bash`
/// executables. Listing them all is noise the user has to read past, and it
/// buys nothing: the model selects a shell by *family* (`bash`, `pwsh`,
/// `cmd`), so a second install of the same family can never be chosen.
///
/// [`candidates`] is already ordered by preference — the user's Windows
/// Terminal profile first, then their `PATH`, then well-known locations — so
/// the first candidate that actually runs wins. A family whose only candidate
/// fails is still returned, so the settings page can show *why* rather than
/// silently omitting a shell the user knows is installed.
///
/// Someone who wants a specific install adds it by path; manual profiles are
/// never displaced by a scan.
pub async fn scan() -> Vec<ShellProfile> {
    let mut chosen: Vec<(Candidate, Verification)> = Vec::new();

    for candidate in candidates() {
        let settled = chosen
            .iter()
            .position(|(existing, _)| existing.kind == candidate.kind);

        // A family already represented by a working shell needs no further
        // probing — this also avoids launching the broken WSL `bash.exe`
        // alias once a real bash has answered.
        if let Some(index) = settled {
            if chosen[index].1.health.state != HealthState::Failed {
                continue;
            }
        }

        let outcome = verify(candidate.kind, &candidate.exe).await;
        match settled {
            // The incumbent does not work; take over only by working.
            Some(index) => {
                if outcome.health.state != HealthState::Failed {
                    chosen[index] = (candidate, outcome);
                }
            }
            None => chosen.push((candidate, outcome)),
        }
    }

    let mut profiles = Vec::new();
    for (candidate, outcome) in chosen {
        profiles.push(ShellProfile {
            id: super::profile_id(&candidate.exe),
            kind: candidate.kind,
            label: candidate.label,
            path: candidate.raw_path,
            exe: candidate.exe.to_string_lossy().to_string(),
            // A shell that cannot run a command is registered but off, so it
            // is visible in settings without being offered to the model.
            enabled: outcome.health.state != HealthState::Failed,
            preferred: candidate.preferred,
            source: ProfileSource::Scan,
            version: outcome.version,
            health: outcome.health,
            verified_at_ms: super::now_ms(),
        });
    }
    profiles
}

/// Verify one shell by running it.
pub async fn verify(kind: ShellKind, exe: &Path) -> Verification {
    let args: Vec<String> = match kind {
        k if k.is_posix() => vec!["-c".into(), POSIX_PROBE.into()],
        ShellKind::Pwsh | ShellKind::PowerShell => vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            "$PSVersionTable.PSVersion.ToString()".into(),
        ],
        ShellKind::Cmd => vec!["/d".into(), "/s".into(), "/c".into(), "ver".into()],
        _ => vec![],
    };

    let mut command = TokioCommand::new(exe);
    command.args(&args);
    for (key, value) in env::compose(kind, exe) {
        command.env(key, value);
    }
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = match tokio::time::timeout(PROBE_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return Verification::failed(format!("could not start: {error}"));
        }
        Err(_) => {
            return Verification::failed(format!(
                "did not respond within {}s",
                PROBE_TIMEOUT.as_secs()
            ));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            match output.status.code() {
                Some(code) => format!("exited with code {code}"),
                None => "exited without a status code".to_string(),
            }
        } else {
            first_line(&stderr)
        };
        return Verification::failed(detail);
    }

    if kind.is_posix() {
        let (version, status) = stdout.split_once('|').unwrap_or(("", stdout.as_str()));
        let version = (!version.trim().is_empty()).then(|| version.trim().to_string());
        if status.contains("coreutils_missing") {
            return Verification {
                version,
                health: ShellHealth {
                    state: HealthState::Degraded,
                    detail: Some(
                        "Unix utilities (ls, sed, uname) are not reachable from this shell, so \
                         commands and npm scripts that rely on them will fail."
                            .to_string(),
                    ),
                },
            };
        }
        return Verification {
            version,
            health: ShellHealth::ready(),
        };
    }

    Verification {
        version: (!stdout.is_empty()).then(|| clean_version(&stdout)),
        health: ShellHealth::ready(),
    }
}

/// Reduce a probe's greeting to the version itself.
///
/// `cmd /c ver` answers with a whole banner
/// (`Microsoft Windows [Version 10.0.26200.8875]`); the row already says
/// "Command Prompt", so only the number carries information.
fn clean_version(stdout: &str) -> String {
    let line = first_line(stdout);
    if let Some(start) = line.find('[') {
        if let Some(end) = line[start..].find(']') {
            let inside = &line[start + 1..start + end];
            let number = inside
                .rsplit(' ')
                .next()
                .unwrap_or(inside)
                .trim()
                .to_string();
            if !number.is_empty() {
                return number;
            }
        }
    }
    line
}

/// Outcome of a single verification probe.
#[derive(Debug, Clone)]
pub struct Verification {
    pub version: Option<String>,
    pub health: ShellHealth,
}

impl Verification {
    fn failed(detail: String) -> Self {
        Self {
            version: None,
            health: ShellHealth {
                state: HealthState::Failed,
                detail: Some(detail),
            },
        }
    }
}

/// Resolve a user-supplied path to a runnable executable, adding the
/// platform's executable extension when it was omitted.
#[must_use]
pub fn resolve_executable(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(normalize(path));
    }
    if cfg!(windows) && path.extension().is_none() {
        let with_exe = path.with_extension("exe");
        if with_exe.is_file() {
            return Some(normalize(&with_exe));
        }
    }
    None
}

fn normalize(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn dedupe_key(exe: &Path) -> String {
    let text = exe.to_string_lossy().replace('/', "\\");
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

/// A label that distinguishes shells of the same kind from different
/// installs — "Git Bash" vs "Bash" matters when both are registered.
fn label_for(kind: ShellKind, exe: &Path) -> String {
    if kind == ShellKind::Bash && env::msys_root(exe).is_some() {
        let lower = exe.to_string_lossy().to_ascii_lowercase();
        if lower.contains("msys") {
            return "MSYS2 Bash".to_string();
        }
        return "Git Bash".to_string();
    }
    kind.default_label().to_string()
}

/// Walk `PATH` for each of a kind's executable names.
fn path_lookup(kind: ShellKind) -> Vec<PathBuf> {
    let Ok(path) = std::env::var("PATH") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for dir in std::env::split_paths(&path) {
        for name in kind.exe_names() {
            let candidate = if cfg!(windows) {
                dir.join(format!("{name}.exe"))
            } else {
                dir.join(name)
            };
            if candidate.is_file() {
                out.push(normalize(&candidate));
            }
        }
    }
    out
}

/// Locations that are not on `PATH` but are where these shells actually live.
#[cfg(target_os = "windows")]
fn well_known() -> Vec<(ShellKind, PathBuf)> {
    let mut out: Vec<(ShellKind, PathBuf)> = Vec::new();

    let add = |kind: ShellKind, path: PathBuf, out: &mut Vec<(ShellKind, PathBuf)>| {
        if let Some(exe) = resolve_executable(&path) {
            out.push((kind, exe));
        }
    };

    // Git for Windows: the registry key is authoritative; the directory
    // guesses only cover installs that predate or skipped it.
    for root in git_roots() {
        add(ShellKind::Bash, root.join(r"bin\bash.exe"), &mut out);
    }

    if let Ok(system_root) = std::env::var("SystemRoot") {
        let system32 = PathBuf::from(&system_root).join("System32");
        add(ShellKind::Cmd, system32.join("cmd.exe"), &mut out);
        add(
            ShellKind::PowerShell,
            system32.join(r"WindowsPowerShell\v1.0\powershell.exe"),
            &mut out,
        );
    }

    for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(program_files) = std::env::var(variable) {
            add(
                ShellKind::Pwsh,
                PathBuf::from(&program_files).join(r"PowerShell\7\pwsh.exe"),
                &mut out,
            );
        }
    }

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        // The Store execution alias.
        add(
            ShellKind::Pwsh,
            local.join(r"Microsoft\WindowsApps\pwsh.exe"),
            &mut out,
        );
        add(
            ShellKind::Bash,
            local.join(r"Programs\Git\bin\bash.exe"),
            &mut out,
        );
    }

    // The real Store package directory, whose name carries a version.
    for package in windows_apps_packages("Microsoft.PowerShell") {
        add(ShellKind::Pwsh, package.join("pwsh.exe"), &mut out);
    }

    for root in [r"C:\msys64", r"C:\msys32"] {
        add(
            ShellKind::Bash,
            PathBuf::from(root).join(r"usr\bin\bash.exe"),
            &mut out,
        );
        add(
            ShellKind::Zsh,
            PathBuf::from(root).join(r"usr\bin\zsh.exe"),
            &mut out,
        );
    }

    out
}

#[cfg(not(target_os = "windows"))]
fn well_known() -> Vec<(ShellKind, PathBuf)> {
    let mut out: Vec<(ShellKind, PathBuf)> = Vec::new();

    let add = |kind: ShellKind, path: &str, out: &mut Vec<(ShellKind, PathBuf)>| {
        if let Some(exe) = resolve_executable(Path::new(path)) {
            out.push((kind, exe));
        }
    };

    // `$SHELL` first: it is the user's stated preference.
    if let Ok(shell) = std::env::var("SHELL") {
        let path = PathBuf::from(&shell);
        if let (Some(kind), Some(exe)) = (ShellKind::from_exe(&path), resolve_executable(&path)) {
            out.push((kind, exe));
        }
    }

    if let Ok(listed) = std::fs::read_to_string("/etc/shells") {
        for line in listed.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let path = PathBuf::from(line);
            if let (Some(kind), Some(exe)) = (ShellKind::from_exe(&path), resolve_executable(&path))
            {
                out.push((kind, exe));
            }
        }
    }

    add(ShellKind::Bash, "/bin/bash", &mut out);
    add(ShellKind::Zsh, "/bin/zsh", &mut out);
    add(ShellKind::Sh, "/bin/sh", &mut out);
    add(ShellKind::Pwsh, "/usr/local/bin/pwsh", &mut out);

    out
}

/// Git for Windows install roots, registry first.
#[cfg(target_os = "windows")]
fn git_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Some(root) = git_registry_root() {
        roots.push(root);
    }
    for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(program_files) = std::env::var(variable) {
            roots.push(PathBuf::from(program_files).join("Git"));
        }
    }
    roots.push(PathBuf::from(r"C:\Git"));
    roots
}

#[cfg(target_os = "windows")]
fn git_registry_root() -> Option<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    for (hive, root) in [
        (HKEY_LOCAL_MACHINE, "SOFTWARE\\GitForWindows"),
        (HKEY_CURRENT_USER, "SOFTWARE\\GitForWindows"),
    ] {
        if let Ok(key) = RegKey::predef(hive).open_subkey_with_flags(root, KEY_READ) {
            if let Ok(path) = key.get_value::<String, _>("InstallPath") {
                if !path.trim().is_empty() {
                    return Some(PathBuf::from(path));
                }
            }
        }
    }
    None
}

/// Store package directories whose name starts with `prefix`
/// (`Microsoft.PowerShell_7.6.4.0_x64__8wekyb3d8bbwe`).
#[cfg(target_os = "windows")]
fn windows_apps_packages(prefix: &str) -> Vec<PathBuf> {
    let Ok(program_files) = std::env::var("ProgramFiles") else {
        return Vec::new();
    };
    let root = PathBuf::from(program_files).join("WindowsApps");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(prefix))
        })
        .collect()
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or(text).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_key_is_case_insensitive_on_windows() {
        let a = dedupe_key(Path::new(r"C:\Program Files\Git\bin\bash.exe"));
        let b = dedupe_key(Path::new(r"c:\program files\git\bin\BASH.exe"));
        if cfg!(windows) {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn dedupe_key_treats_slash_styles_alike() {
        assert_eq!(
            dedupe_key(Path::new("C:/Program Files/Git/bin/bash.exe")),
            dedupe_key(Path::new(r"C:\Program Files\Git\bin\bash.exe"))
        );
    }

    #[test]
    fn missing_executables_do_not_resolve() {
        assert!(resolve_executable(Path::new("/definitely/not/a/shell/xyzzy")).is_none());
    }

    #[test]
    fn candidates_are_unique_by_path() {
        let found = candidates();
        let mut seen = HashSet::new();
        for candidate in &found {
            assert!(
                seen.insert(dedupe_key(&candidate.exe)),
                "duplicate candidate: {}",
                candidate.exe.display()
            );
        }
    }

    #[test]
    fn every_candidate_maps_to_a_drivable_kind() {
        for candidate in candidates() {
            assert_eq!(
                ShellKind::from_exe(&candidate.exe),
                Some(candidate.kind),
                "candidate kind must match its executable: {}",
                candidate.exe.display()
            );
        }
    }
}
