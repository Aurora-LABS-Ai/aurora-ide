//! Shell *kinds* — the invocation grammar Aurora knows how to drive.
//!
//! A kind owns everything except the executable's location: which flags
//! introduce a one-shot command, which flags open an interactive session,
//! and what command syntax the model should write. Users register a shell by
//! **path only** (see [`super::discovery`]); every flag is derived here, so a
//! profile can never carry wrong or hand-edited arguments.
//!
//! Windows note: `pwsh` (PowerShell 7+) and `powershell` (Windows PowerShell
//! 5.1) are deliberately distinct kinds — they are different executables with
//! different versions and different install locations. Aurora's *legacy*
//! `"powershell"` shell argument historically meant "PowerShell 7", so
//! [`super::resolve`] falls back between the two rather than failing.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// A shell family Aurora can execute commands in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    /// Bash — Git Bash / MSYS2 on Windows, the system bash elsewhere.
    Bash,
    /// POSIX `sh` (dash, busybox, …).
    Sh,
    /// Z shell.
    Zsh,
    /// PowerShell 7+ (`pwsh`), cross-platform.
    Pwsh,
    /// Windows PowerShell 5.1 (`powershell.exe`).
    PowerShell,
    /// Windows Command Prompt (`cmd.exe`).
    Cmd,
}

impl ShellKind {
    /// Every kind, in the order Aurora prefers them when picking a default.
    pub const ALL: &'static [ShellKind] = &[
        ShellKind::Bash,
        ShellKind::Zsh,
        ShellKind::Sh,
        ShellKind::Pwsh,
        ShellKind::PowerShell,
        ShellKind::Cmd,
    ];

    /// Stable identifier used in settings JSON, tool arguments, and the
    /// model-facing `shell` enum.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            ShellKind::Bash => "bash",
            ShellKind::Sh => "sh",
            ShellKind::Zsh => "zsh",
            ShellKind::Pwsh => "pwsh",
            ShellKind::PowerShell => "powershell",
            ShellKind::Cmd => "cmd",
        }
    }

    /// Parse a kind identifier. Accepts the canonical ids plus the aliases
    /// that appear in older Aurora settings and in Windows Terminal profile
    /// sources.
    #[must_use]
    pub fn from_id(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "bash" | "git-bash" | "gitbash" | "git bash" => Some(Self::Bash),
            "sh" => Some(Self::Sh),
            "zsh" => Some(Self::Zsh),
            "pwsh" | "powershell-core" | "powershellcore" | "pwsh.exe" => Some(Self::Pwsh),
            "powershell" | "windows-powershell" | "powershell.exe" => Some(Self::PowerShell),
            "cmd" | "cmd.exe" | "command-prompt" | "commandprompt" => Some(Self::Cmd),
            _ => None,
        }
    }

    /// Human label used when no better name is available (a Windows Terminal
    /// import or a manual entry can supply a nicer one).
    #[must_use]
    pub const fn default_label(self) -> &'static str {
        match self {
            ShellKind::Bash => "Bash",
            ShellKind::Sh => "sh",
            ShellKind::Zsh => "Zsh",
            ShellKind::Pwsh => "PowerShell 7",
            ShellKind::PowerShell => "Windows PowerShell",
            ShellKind::Cmd => "Command Prompt",
        }
    }

    /// Flags that precede a **one-shot** command string. The command itself
    /// is never interpolated, quoted, or escaped anywhere in Aurora; how it
    /// is handed over — argv, a raw argument, or the environment — is
    /// [`super::delivery`]'s decision.
    #[must_use]
    pub const fn command_args(self) -> &'static [&'static str] {
        match self {
            ShellKind::Bash | ShellKind::Sh | ShellKind::Zsh => &["-c"],
            // `-NonInteractive` stops a prompt from hanging a piped child
            // forever; `-NoProfile` keeps the agent's environment predictable.
            ShellKind::Pwsh | ShellKind::PowerShell => {
                &["-NoProfile", "-NonInteractive", "-Command"]
            }
            // `/d` skips AutoRun registry commands, `/s` fixes cmd's quote
            // mangling, `/c` runs and exits (never `/k`, which never returns).
            ShellKind::Cmd => &["/d", "/s", "/c"],
        }
    }

    /// Flags that open an **interactive** session in the PTY terminal.
    /// PowerShell kinds expect the caller to append its own `-Command`
    /// initialisation string after these.
    #[must_use]
    pub const fn interactive_args(self) -> &'static [&'static str] {
        match self {
            // `-i` only. `--noprofile --norc` was here so Aurora could impose
            // its own `PROMPT_COMMAND`, which meant an interactive Git Bash
            // started with none of the user's aliases, functions, completions
            // or prompt — the opposite of what a terminal is for. A PTY session
            // is the user's shell; the agent's non-interactive `command_args`
            // path is the one that must stay hermetic.
            ShellKind::Bash => &["-i"],
            ShellKind::Sh | ShellKind::Zsh => &["-i"],
            ShellKind::Pwsh | ShellKind::PowerShell => &["-NoLogo", "-NoExit"],
            ShellKind::Cmd => &[],
        }
    }

    /// True for POSIX-syntax shells (`&&`, `|`, single-quote quoting, `$VAR`).
    /// Drives which safety validator runs and which syntax hint the model gets.
    #[must_use]
    pub const fn is_posix(self) -> bool {
        matches!(self, ShellKind::Bash | ShellKind::Sh | ShellKind::Zsh)
    }

    /// One line telling the model how to write commands for this kind.
    /// Rendered into the `shell_execute` / `shell_spawn` tool description so
    /// the guidance can never drift from what is actually installed.
    #[must_use]
    pub const fn syntax_hint(self) -> &'static str {
        match self {
            ShellKind::Bash | ShellKind::Sh | ShellKind::Zsh => {
                "POSIX syntax: ls, cat, rm, &&, |, single-quote quoting"
            }
            ShellKind::Pwsh | ShellKind::PowerShell => {
                "PowerShell syntax: Get-ChildItem, Remove-Item, ;, |, $env:VAR"
            }
            ShellKind::Cmd => "Command Prompt syntax: dir, del, &&, %VAR%",
        }
    }

    /// Executable base names to look for when scanning `PATH`.
    #[must_use]
    pub const fn exe_names(self) -> &'static [&'static str] {
        match self {
            ShellKind::Bash => &["bash"],
            ShellKind::Sh => &["sh"],
            ShellKind::Zsh => &["zsh"],
            ShellKind::Pwsh => &["pwsh"],
            ShellKind::PowerShell => &["powershell"],
            ShellKind::Cmd => &["cmd"],
        }
    }

    /// Infer the kind from an executable path (`…\Git\bin\bash.exe` → Bash).
    /// Returns `None` for anything Aurora cannot drive — batch files, MSYS2
    /// launcher scripts, `wsl.exe`, and so on.
    #[must_use]
    pub fn from_exe(path: &Path) -> Option<Self> {
        let stem = path.file_stem()?.to_string_lossy().to_ascii_lowercase();
        match stem.as_str() {
            "bash" => Some(Self::Bash),
            "sh" => Some(Self::Sh),
            "zsh" => Some(Self::Zsh),
            "pwsh" => Some(Self::Pwsh),
            "powershell" => Some(Self::PowerShell),
            "cmd" => Some(Self::Cmd),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn ids_round_trip() {
        for kind in ShellKind::ALL {
            assert_eq!(ShellKind::from_id(kind.id()), Some(*kind));
        }
    }

    #[test]
    fn pwsh_and_windows_powershell_are_distinct() {
        assert_eq!(ShellKind::from_id("pwsh"), Some(ShellKind::Pwsh));
        assert_eq!(
            ShellKind::from_id("powershell"),
            Some(ShellKind::PowerShell)
        );
    }

    #[test]
    fn infers_kind_from_executable() {
        assert_eq!(
            ShellKind::from_exe(&PathBuf::from(r"C:\Program Files\Git\bin\bash.exe")),
            Some(ShellKind::Bash)
        );
        assert_eq!(
            ShellKind::from_exe(&PathBuf::from(r"C:\Windows\System32\cmd.exe")),
            Some(ShellKind::Cmd)
        );
        // Launcher scripts and wrappers are not shells Aurora can drive.
        assert_eq!(
            ShellKind::from_exe(&PathBuf::from(r"C:\msys64\msys2_shell.cmd")),
            None
        );
        assert_eq!(
            ShellKind::from_exe(&PathBuf::from("/usr/bin/wsl.exe")),
            None
        );
    }

    #[test]
    fn cmd_never_uses_the_non_returning_k_flag() {
        assert!(!ShellKind::Cmd.command_args().contains(&"/k"));
        assert!(ShellKind::Cmd.command_args().contains(&"/c"));
    }

    #[test]
    fn powershell_one_shot_is_non_interactive() {
        for kind in [ShellKind::Pwsh, ShellKind::PowerShell] {
            assert!(kind.command_args().contains(&"-NonInteractive"));
            assert!(kind.command_args().contains(&"-NoProfile"));
        }
    }
}
