//! How a one-shot command reaches the shell process.
//!
//! Aurora never quotes or escapes the model's command. It hands the text over
//! whole and lets the shell parse it, exactly as if someone had typed it at a
//! prompt. The only question is the *channel* the text travels through, and
//! that depends on the shell:
//!
//! - **Most shells** take it as the last argv element after the kind's
//!   [`ShellKind::command_args`]. Rust encodes argv with the MSVCRT rules and
//!   every normal Win32 program (and every Unix program) decodes them back.
//! - **`cmd.exe`** has its own parser that does not understand those rules,
//!   so the text is appended raw inside one quote pair — see
//!   [`CommandDelivery::CmdRaw`].
//! - **MSYS and Cygwin programs on Windows** — Git Bash, MSYS2, Git's `sh` —
//!   decode argv correctly and then run their *own* second parse over it,
//!   treating backslashes as escape characters. `'C:\Users\x'` arrived at
//!   bash as `'C:Usersx'`, inside single quotes that are supposed to preserve
//!   everything. Measured on Git for Windows 2.5x: every strategy that puts the
//!   command on the command line loses that layer, and `MSYS=noglob` stops the
//!   second parse only by also breaking `"` and `$VAR`. The environment block
//!   is not re-parsed, so the command travels there and argv carries only a
//!   fixed bootstrap that evaluates it — [`CommandDelivery::Environment`].
//!
//! Scoped to the shells that have the problem. Unix hosts and native Windows
//! shells keep the plain argument, which was never broken.

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::Path;

use tokio::process::Command as TokioCommand;

use super::env;
use super::kinds::ShellKind;

/// Environment variable that carries the command under
/// [`CommandDelivery::Environment`]. Removed by the bootstrap before the
/// command runs, so nothing the command starts inherits its own source text.
pub const COMMAND_ENV_VAR: &str = "AURORA_SHELL_COMMAND";

/// The argv the shell receives under [`CommandDelivery::Environment`]: copy the
/// command out of the environment, drop the variable, evaluate. Written in
/// plain POSIX so bash, sh, and zsh all accept it, and free of backslashes and
/// glob characters so the MSYS re-parse has nothing to change.
///
/// `eval` reports errors with the line numbers of the command itself
/// (`bash: line 2: foo: command not found`), the same text a terminal shows.
const ENVIRONMENT_BOOTSTRAP: &str =
    "__aurora_cmd=$AURORA_SHELL_COMMAND; unset AURORA_SHELL_COMMAND; eval \"$__aurora_cmd\"";

/// The channel a one-shot command travels through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandDelivery {
    /// Appended as one argv element after the kind's command flags.
    Argument,
    /// `cmd.exe` only. Windows has no real argv: a process receives one
    /// command-line string and parses it itself. Rust's `Command::arg` encodes
    /// with the MSVCRT rules (`"` becomes `\"`), which `cmd.exe` does not
    /// follow. Measured with `dir /b | find /c /v ""`: `arg` gave exit 1 and
    /// `Access denied - \`; a raw argument gave the count. `/s` (in
    /// [`ShellKind::command_args`]) tells cmd to strip the first and last
    /// quote of the remainder and treat everything between them literally, so
    /// the text is wrapped in one quote pair and appended verbatim.
    CmdRaw,
    /// MSYS/Cygwin shells on Windows: the command rides in
    /// [`COMMAND_ENV_VAR`] and argv carries [`ENVIRONMENT_BOOTSTRAP`].
    Environment,
}

impl CommandDelivery {
    /// Pick the channel for a shell, from its kind and where it lives.
    #[must_use]
    pub fn for_shell(kind: ShellKind, exe: &Path) -> Self {
        if kind == ShellKind::Cmd {
            return Self::CmdRaw;
        }
        if cfg!(windows) && kind.is_posix() && is_msys_or_cygwin(exe) {
            return Self::Environment;
        }
        Self::Argument
    }

    /// Put `command` on a process builder that already names the executable.
    /// Adds the kind's flags, the command through this channel, and `$0`
    /// where the bootstrap needs one.
    pub fn apply(self, cmd: &mut TokioCommand, kind: ShellKind, command: &str) {
        for flag in kind.command_args() {
            cmd.arg(flag);
        }
        match self {
            Self::Argument => {
                cmd.arg(command);
            }
            Self::CmdRaw => {
                #[cfg(windows)]
                {
                    cmd.as_std_mut().raw_arg(format!("\"{command}\""));
                }
                #[cfg(not(windows))]
                {
                    cmd.arg(command);
                }
            }
            Self::Environment => {
                cmd.arg(ENVIRONMENT_BOOTSTRAP);
                // `$0`, so error messages read `bash: line 2: …` rather than
                // naming a bootstrap the model never wrote.
                cmd.arg(kind.id());
                cmd.env(COMMAND_ENV_VAR, command);
            }
        }
    }
}

/// Whether an executable is an MSYS or Cygwin program — one that will re-parse
/// its own command line.
///
/// Recognised by layout: Git for Windows and MSYS2 keep `usr\bin` beside the
/// shell ([`env::msys_root`]), and every such program loads `msys-2.0.dll` or
/// `cygwin1.dll` from its own directory. WSL's `bash.exe` in `System32` has
/// neither and is a plain Win32 launcher.
#[must_use]
pub fn is_msys_or_cygwin(exe: &Path) -> bool {
    if env::msys_root(exe).is_some() {
        return true;
    }
    exe.parent().is_some_and(|dir| {
        dir.join("msys-2.0.dll").is_file() || dir.join("cygwin1.dll").is_file()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn cmd_always_goes_raw() {
        assert_eq!(
            CommandDelivery::for_shell(ShellKind::Cmd, Path::new(r"C:\Windows\System32\cmd.exe")),
            CommandDelivery::CmdRaw
        );
    }

    #[test]
    fn powershell_is_a_plain_argument() {
        for kind in [ShellKind::Pwsh, ShellKind::PowerShell] {
            assert_eq!(
                CommandDelivery::for_shell(kind, Path::new("pwsh.exe")),
                CommandDelivery::Argument,
                "{kind:?}"
            );
        }
    }

    #[test]
    fn a_bash_with_no_msys_beside_it_is_a_plain_argument() {
        // WSL's launcher, or any bash Aurora cannot place: nothing re-parses
        // argv there, so the argument path is the right one.
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("bash.exe");
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(
            CommandDelivery::for_shell(ShellKind::Bash, &exe),
            CommandDelivery::Argument
        );
    }

    #[test]
    fn git_layout_is_recognised_from_both_bash_locations() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("usr").join("bin")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        for exe in [
            root.join("bin").join("bash.exe"),
            root.join("usr").join("bin").join("bash.exe"),
            root.join("usr").join("bin").join("sh.exe"),
        ] {
            assert!(is_msys_or_cygwin(&exe), "{}", exe.display());
        }
    }

    #[test]
    fn a_sibling_runtime_dll_is_enough() {
        // Cygwin proper keeps `bin` without a `usr\bin` twin on disk.
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("cygwin1.dll"), b"").unwrap();
        assert!(is_msys_or_cygwin(&bin.join("bash.exe")));
    }

    #[test]
    fn msys_shells_use_the_environment_only_on_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("usr").join("bin")).unwrap();
        let exe = root.join("usr").join("bin").join("bash.exe");
        let expected = if cfg!(windows) {
            CommandDelivery::Environment
        } else {
            CommandDelivery::Argument
        };
        assert_eq!(CommandDelivery::for_shell(ShellKind::Bash, &exe), expected);
    }

    #[test]
    fn the_bootstrap_carries_nothing_msys_would_rewrite() {
        // Backslashes and glob characters are exactly what the second parse
        // consumes; the bootstrap must never contain any.
        for forbidden in ['\\', '*', '?', '[', ']', '{', '}'] {
            assert!(
                !ENVIRONMENT_BOOTSTRAP.contains(forbidden),
                "bootstrap contains {forbidden:?}"
            );
        }
        assert!(ENVIRONMENT_BOOTSTRAP.contains(COMMAND_ENV_VAR));
        assert!(
            ENVIRONMENT_BOOTSTRAP.contains(&format!("unset {COMMAND_ENV_VAR}")),
            "children must not inherit the command text"
        );
    }

    #[test]
    fn environment_delivery_sets_the_variable_and_a_dollar_zero() {
        let mut cmd = TokioCommand::new("bash");
        CommandDelivery::Environment.apply(&mut cmd, ShellKind::Bash, "echo 'C:\\x'");
        let std = cmd.as_std();
        let args: Vec<String> = std
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["-c", ENVIRONMENT_BOOTSTRAP, "bash"]);
        let env: Vec<(String, Option<String>)> = std
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.map(|v| v.to_string_lossy().to_string()),
                )
            })
            .collect();
        assert!(
            env.contains(&(COMMAND_ENV_VAR.to_string(), Some("echo 'C:\\x'".to_string()))),
            "{env:?}"
        );
    }

    #[test]
    fn argument_delivery_appends_the_command_after_the_flags() {
        let mut cmd = TokioCommand::new("pwsh");
        CommandDelivery::Argument.apply(&mut cmd, ShellKind::Pwsh, "Get-Date");
        let args: Vec<PathBuf> = cmd.as_std().get_args().map(PathBuf::from).collect();
        assert_eq!(
            args.last().map(|a| a.to_string_lossy().to_string()),
            Some("Get-Date".to_string())
        );
        assert!(args.iter().any(|a| a == Path::new("-NonInteractive")));
    }
}
