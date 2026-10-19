//! Turning a configured stdio server into a running process.
//!
//! Two Windows facts drive everything here:
//!
//! * **A file with no extension never runs.** npm installs every CLI twice in
//!   the same folder: `foo` (a `#!/bin/sh` script for Git Bash) and
//!   `foo.cmd`. The previous lookup tried the bare name first, found the
//!   shell script and handed it to `CreateProcessW`, which fails with
//!   "%1 is not a valid Win32 application (os error 193)". The lookup now
//!   tries the runnable extensions first and never returns an extensionless
//!   file.
//! * **Killing a process does not kill its children.** A `.cmd` server runs as
//!   `cmd.exe → node.exe`, and a venv's `python.exe` is a launcher that starts
//!   the real interpreter. Killing the direct child left the real server
//!   running. Every server now starts inside its own job object with
//!   kill-on-close, so stopping it ends the whole tree.
//!
//! The PATH used for lookup, and handed to the child, is the one the registry
//! holds right now (`shell::env::effective_path`), so a server installed after
//! logon is found without restarting Aurora.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use process_wrap::tokio::CommandWrap;
use serde::Serialize;

use super::types::McpServerConfig;

/// Extensions tried, in order, for a command typed without one. Real
/// executables first so a `.exe` is never wrapped in `cmd.exe` needlessly.
#[cfg(windows)]
const RUNNABLE_EXTENSIONS: &[&str] = &["exe", "cmd", "bat", "com", "ps1"];

/// What the settings page shows before saving: does this command exist, and
/// what will actually be launched.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandCheck {
    pub found: bool,
    /// The file Aurora will start (or that the wrapper will run).
    pub resolved: Option<String>,
    /// Why it was not found, phrased for the person typing the command.
    pub problem: Option<String>,
}

/// The program to start plus any arguments that must come before the
/// configured ones (`cmd.exe /d /c foo.cmd`).
#[derive(Debug, Clone, PartialEq)]
pub struct Launch {
    pub program: PathBuf,
    pub prefix_args: Vec<String>,
}

/// Resolve `command` the way Windows itself would, minus its one trap.
pub fn resolve(command: &str, path_env: &str) -> Result<Launch, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("No command is set for this server.".to_string());
    }
    resolve_platform(command, path_env)
}

#[cfg(not(windows))]
fn resolve_platform(command: &str, _path_env: &str) -> Result<Launch, String> {
    Ok(Launch {
        program: PathBuf::from(command),
        prefix_args: Vec::new(),
    })
}

#[cfg(windows)]
fn resolve_platform(command: &str, path_env: &str) -> Result<Launch, String> {
    let file = find_windows_file(command, path_env)?;
    Ok(launch_for(file))
}

/// Find the runnable file for `command`. Never returns an extensionless file.
#[cfg(windows)]
fn find_windows_file(command: &str, path_env: &str) -> Result<PathBuf, String> {
    let typed = Path::new(command);
    let has_dir = typed.is_absolute() || command.contains('\\') || command.contains('/');

    let candidates_in = |base: &Path| -> Vec<PathBuf> {
        if has_runnable_extension(base) {
            vec![base.to_path_buf()]
        } else {
            RUNNABLE_EXTENSIONS
                .iter()
                .map(|ext| with_extra_extension(base, ext))
                .collect()
        }
    };

    if has_dir {
        if let Some(found) = candidates_in(typed).into_iter().find(|p| p.is_file()) {
            return Ok(found);
        }
        return Err(not_found_message(command, typed.is_file()));
    }

    let mut shell_script_seen = false;
    for dir in std::env::split_paths(path_env) {
        let base = dir.join(command);
        if let Some(found) = candidates_in(&base).into_iter().find(|p| p.is_file()) {
            return Ok(found);
        }
        shell_script_seen |= base.is_file();
    }
    Err(not_found_message(command, shell_script_seen))
}

/// `foo.cmd`, never `foo.cm` — `Path::set_extension` would replace a dotted
/// name's tail (`server.v2` → `server.exe`), which is the wrong file.
#[cfg(windows)]
fn with_extra_extension(base: &Path, ext: &str) -> PathBuf {
    let mut name = base.as_os_str().to_os_string();
    name.push(".");
    name.push(ext);
    PathBuf::from(name)
}

#[cfg(windows)]
fn has_runnable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RUNNABLE_EXTENSIONS.iter().any(|r| r.eq_ignore_ascii_case(e)))
}

#[cfg(windows)]
fn not_found_message(command: &str, only_shell_script: bool) -> String {
    if only_shell_script {
        format!(
            "'{command}' was found only as a script without an extension, which Windows cannot run. \
             Install it so a '{command}.cmd' or '{command}.exe' exists, or use the full path to one."
        )
    } else {
        format!(
            "'{command}' was not found. Checked PATH for {}. Use the full path if it is installed somewhere else.",
            RUNNABLE_EXTENSIONS
                .iter()
                .map(|e| format!("{command}.{e}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

/// Batch files need `cmd.exe`, PowerShell scripts need `powershell.exe`;
/// neither is a program `CreateProcessW` can start by itself.
#[cfg(windows)]
fn launch_for(file: PathBuf) -> Launch {
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    let path = file.to_string_lossy().into_owned();
    match ext.as_deref() {
        // `/d` skips AutoRun so a user's cmd profile can't print into stdout,
        // which is the protocol channel.
        Some("cmd") | Some("bat") => Launch {
            program: PathBuf::from("cmd.exe"),
            prefix_args: vec!["/d".into(), "/c".into(), path],
        },
        Some("ps1") => Launch {
            program: PathBuf::from("powershell.exe"),
            prefix_args: vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                path,
            ],
        },
        _ => Launch {
            program: file,
            prefix_args: Vec::new(),
        },
    }
}

/// The settings page's "does this command exist" answer.
pub fn check(command: &str) -> CommandCheck {
    let path_env = crate::shell::env::effective_path();
    match resolve(command, &path_env) {
        Ok(launch) => CommandCheck {
            found: true,
            resolved: Some(
                launch
                    .prefix_args
                    .last()
                    .cloned()
                    .unwrap_or_else(|| launch.program.to_string_lossy().into_owned()),
            ),
            problem: None,
        },
        Err(problem) => CommandCheck {
            found: false,
            resolved: None,
            problem: Some(problem),
        },
    }
}

/// Build the wrapped command for a stdio server: resolved program, the
/// server's own args and env, current PATH, no console window, and — on
/// Windows — a job object that takes the whole process tree down with it.
pub fn build_command(config: &McpServerConfig) -> Result<(CommandWrap, Launch), String> {
    let command = config
        .command
        .as_deref()
        .ok_or_else(|| "No command is set for this server.".to_string())?;
    let path_env = crate::shell::env::effective_path();
    let launch = resolve(command, &path_env)?;

    let mut cmd = tokio::process::Command::new(&launch.program);
    cmd.args(&launch.prefix_args)
        .args(&config.args)
        .env("PATH", &path_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in &config.env {
        cmd.env(key, value);
    }

    let mut wrapped = CommandWrap::from(cmd);
    #[cfg(windows)]
    {
        use windows_pw::Win32::System::Threading::CREATE_NO_WINDOW;
        wrapped
            .wrap(process_wrap::tokio::CreationFlags(CREATE_NO_WINDOW))
            .wrap(process_wrap::tokio::JobObject);
    }
    #[cfg(unix)]
    {
        wrapped.wrap(process_wrap::tokio::ProcessGroup::leader());
    }
    wrapped.wrap(process_wrap::tokio::KillOnDrop);
    Ok((wrapped, launch))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aurora-mcp-spawn-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The `nuphus-mcp` case: npm's extensionless sh script sits beside the
    /// `.cmd`. The `.cmd` must win, and it must run through `cmd.exe`.
    #[test]
    fn npm_shim_resolves_to_cmd_not_shell_script() {
        let dir = temp_dir("npm");
        std::fs::write(dir.join("nuphus-mcp"), "#!/bin/sh\n").unwrap();
        std::fs::write(dir.join("nuphus-mcp.cmd"), "@echo off\n").unwrap();

        let launch = resolve("nuphus-mcp", dir.to_str().unwrap()).unwrap();
        assert_eq!(launch.program, PathBuf::from("cmd.exe"));
        assert_eq!(
            launch.prefix_args.last().map(PathBuf::from),
            Some(dir.join("nuphus-mcp.cmd"))
        );
    }

    #[test]
    fn only_a_shell_script_is_reported_as_unrunnable() {
        let dir = temp_dir("shonly");
        std::fs::write(dir.join("tool"), "#!/bin/sh\n").unwrap();
        let err = resolve("tool", dir.to_str().unwrap()).unwrap_err();
        assert!(err.contains("without an extension"), "{err}");
    }

    #[test]
    fn exe_beats_cmd_and_runs_directly() {
        let dir = temp_dir("exe");
        std::fs::write(dir.join("srv.exe"), "").unwrap();
        std::fs::write(dir.join("srv.cmd"), "").unwrap();
        let launch = resolve("srv", dir.to_str().unwrap()).unwrap();
        assert_eq!(launch.program, dir.join("srv.exe"));
        assert!(launch.prefix_args.is_empty());
    }

    #[test]
    fn dotted_name_keeps_its_dot() {
        let dir = temp_dir("dotted");
        std::fs::write(dir.join("server.v2.cmd"), "").unwrap();
        let launch = resolve("server.v2", dir.to_str().unwrap()).unwrap();
        assert_eq!(
            launch.prefix_args.last().map(PathBuf::from),
            Some(dir.join("server.v2.cmd"))
        );
    }

    #[test]
    fn full_path_without_extension_finds_the_cmd() {
        let dir = temp_dir("full");
        std::fs::write(dir.join("x"), "#!/bin/sh\n").unwrap();
        std::fs::write(dir.join("x.cmd"), "").unwrap();
        let typed = dir.join("x");
        let launch = resolve(typed.to_str().unwrap(), "").unwrap();
        assert_eq!(
            launch.prefix_args.last().map(PathBuf::from),
            Some(dir.join("x.cmd"))
        );
    }

    #[test]
    fn missing_command_names_what_was_checked() {
        let err = resolve("definitely-not-here-123", "").unwrap_err();
        assert!(err.contains("definitely-not-here-123.cmd"), "{err}");
    }
}
