//! Shell-aware command validation.
//!
//! [`bash_validation`](super::bash_validation) is a faithful port of a POSIX
//! validator: it splits on POSIX operators, understands `rm -rf`, and knows
//! that `>` redirects. None of that describes PowerShell or `cmd`. Before the
//! shell registry existed the mismatch was mostly theoretical — Aurora always
//! *tried* to run bash. Now the model can deliberately ask for `pwsh` or
//! `cmd`, so `Remove-Item -Recurse -Force`, `rd /s /q`, and `del /f /s /q`
//! would otherwise walk straight past every check.
//!
//! This module is the single entry point the shell tools call. POSIX kinds
//! delegate to the existing pipeline unchanged; Windows shells get an
//! equivalent one written in their own grammar.
//!
//! Two grammar differences drive the Windows implementation:
//!
//! - **The dangerous verb is rarely first.** `Get-ChildItem -Recurse |
//!   Remove-Item -Force` puts it at the end of a pipeline, so mutating
//!   commands are matched anywhere in the string rather than only in leading
//!   position.
//! - **Aliases are pervasive.** `ri`, `rm`, `del`, and `erase` are all
//!   `Remove-Item`; matching the canonical name alone would catch nothing.

use std::path::Path;

use super::bash_validation::{
    validate_command, validate_command_with_cwd, BashValidationError, ExecutionMode,
};
use crate::shell::ShellKind;

/// Validate a command against the shell it will actually run in.
///
/// `workspace` enables the extra path-containment stage; pass `None` when no
/// folder is open.
pub fn validate_for_shell(
    command: &str,
    mode: ExecutionMode,
    kind: ShellKind,
    workspace: Option<&Path>,
) -> Result<(), BashValidationError> {
    validate_for_shell_at(command, mode, kind, workspace, workspace)
}

pub fn validate_for_shell_at(
    command: &str,
    mode: ExecutionMode,
    kind: ShellKind,
    workspace: Option<&Path>,
    cwd: Option<&Path>,
) -> Result<(), BashValidationError> {
    if kind.is_posix() {
        if let Some(reason) = bash_would_mangle_powershell_payload(command) {
            return Err(BashValidationError::Blocked(reason));
        }
        return match workspace {
            Some(workspace) => {
                validate_command_with_cwd(command, mode, workspace, cwd.unwrap_or(workspace))
            }
            None => validate_command(command, mode),
        };
    }
    validate_windows_shell(command, mode, kind, workspace, cwd)
}

/// PowerShell variables that only mean something to PowerShell. A bash
/// double-quoted (or unquoted) `$_` expands to bash's own last-argument
/// variable BEFORE PowerShell runs — measured live: `Where-Object { $_.Name }`
/// reached PowerShell as `Where-Object { /usr/bin/bash.Name }` and every line
/// of the result was a CommandNotFoundException.
const POWERSHELL_ONLY_VARIABLES: &[&str] = &[
    "$_",
    "$env:",
    "$psitem",
    "$lastexitcode",
    "$null",
    "$true",
    "$false",
    "$args",
    "$profile",
    "$myinvocation",
];

/// A bash command that invokes PowerShell inline with a payload bash is going
/// to rewrite. Blocked because the corruption is certain, silent, and reads as
/// a PowerShell bug: the command "succeeds" and returns pages of
/// CommandNotFoundException noise instead of an answer.
///
/// Single-quoted payloads pass — bash leaves those alone — so the guard's own
/// message can honestly offer that as the escape.
fn bash_would_mangle_powershell_payload(command: &str) -> Option<String> {
    let lower = command.to_ascii_lowercase();
    if !lower.contains("powershell") && !lower.contains("pwsh") {
        return None;
    }

    // Walk bash quote state; a PowerShell-only variable is mangled wherever
    // bash expands `$` — unquoted or inside double quotes, except when the
    // `$` itself is backslash-escaped.
    let bytes = lower.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for i in 0..bytes.len() {
        let c = bytes[i];
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            b'\\' if !in_single => escaped = true,
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            b'$' if !in_single => {
                let rest = &lower[i..];
                if let Some(hit) = POWERSHELL_ONLY_VARIABLES
                    .iter()
                    .find(|token| rest.starts_with(*token))
                {
                    return Some(format!(
                        "this command runs PowerShell inside bash, and bash expands `{hit}` \
                         before PowerShell ever sees it (a `$_` becomes bash's own last \
                         argument, e.g. `/usr/bin/bash`). Run it with shell: \"pwsh\" instead — \
                         or, if it must stay in bash, single-quote the PowerShell payload so \
                         bash passes it through untouched."
                    ));
                }
            }
            _ => {}
        }
    }
    None
}

/// PowerShell and `cmd` pipeline: read-only enforcement → destructive
/// warnings → path containment.
fn validate_windows_shell(
    command: &str,
    mode: ExecutionMode,
    kind: ShellKind,
    workspace: Option<&Path>,
    cwd: Option<&Path>,
) -> Result<(), BashValidationError> {
    let normalized = normalize(command);

    if mode == ExecutionMode::ReadOnly {
        if let Some(reason) = read_only_violation(&normalized, kind) {
            return Err(BashValidationError::Blocked(reason));
        }
    }

    if let Some(warning) = destructive_warning(&normalized) {
        return Err(BashValidationError::Warning(format!(
            "Destructive command detected: {warning}"
        )));
    }

    if let Some(warning) = path_warning(command, &normalized, mode, workspace, cwd) {
        return Err(BashValidationError::Warning(warning));
    }

    Ok(())
}

/// Lowercased, whitespace-collapsed form. Matching happens on this so
/// `Remove-Item`, `remove-item`, and `REMOVE-ITEM  -Force` all behave alike.
fn normalize(command: &str) -> String {
    command
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// PowerShell commands and aliases that write to disk or change machine
/// state. Aliases are listed explicitly because that is what models emit.
const POWERSHELL_MUTATING: &[&str] = &[
    "remove-item",
    "remove-itemproperty",
    "new-item",
    "new-itemproperty",
    "set-content",
    "add-content",
    "clear-content",
    "set-item",
    "set-itemproperty",
    "out-file",
    "copy-item",
    "move-item",
    "rename-item",
    "set-acl",
    "start-process",
    "stop-process",
    "stop-service",
    "start-service",
    "restart-service",
    "set-service",
    "new-service",
    "stop-computer",
    "restart-computer",
    "install-module",
    "uninstall-module",
    "install-package",
    "uninstall-package",
    "set-executionpolicy",
    "format-volume",
    "clear-disk",
    "initialize-disk",
    "remove-partition",
    "invoke-expression",
    "new-psdrive",
    "remove-psdrive",
    // Aliases, in the form models actually write them.
    "ri ",
    "ni ",
    "sc ",
    "ac ",
    "clc ",
    "cpi ",
    "mi ",
    "rni ",
    "spps ",
    "saps ",
    "iex ",
    "del ",
    "erase ",
    "rd ",
    "rmdir ",
    "md ",
    "mkdir ",
    "copy ",
    "move ",
    "ren ",
    "rename ",
    "kill ",
];

/// `cmd.exe` builtins and bundled tools that write or change machine state.
const CMD_MUTATING: &[&str] = &[
    "del ",
    "erase ",
    "rd ",
    "rmdir ",
    "md ",
    "mkdir ",
    "copy ",
    "xcopy ",
    "robocopy ",
    "move ",
    "ren ",
    "rename ",
    "attrib ",
    "cacls ",
    "icacls ",
    "format ",
    "diskpart",
    "fsutil ",
    "bcdedit",
    "reg ",
    "regedit",
    "sc ",
    "net ",
    "taskkill ",
    "shutdown",
    "chkdsk ",
    "mklink ",
    "setx ",
];

/// Does this command redirect output INTO a file?
///
/// A bare `contains(">")` said yes to anything containing the character, and
/// in read-only mode that is a block. Measured against the searches a plan-mode
/// turn actually runs: `rg -n "->" src/main.rs`, `rg -n "=>" src` and
/// `git log --pretty=format:"%h -> %s"` were all refused as writes.
///
/// Two rules recover them. A `>` inside quotes is part of a search pattern,
/// not an operator — the shell does not read it as one either. And `->`, `=>`,
/// `>=` are arrows, while `>&` duplicates a descriptor and names no file.
fn write_redirection(normalized: &str) -> Option<&'static str> {
    let characters: Vec<char> = normalized.chars().collect();
    let mut quote: Option<char> = None;

    for (index, &character) in characters.iter().enumerate() {
        match quote {
            Some(active) if character == active => quote = None,
            Some(_) => {}
            None if matches!(character, '"' | '\'') => quote = Some(character),
            None if character == '>' => {
                let previous = index.checked_sub(1).map(|i| characters[i]);
                if matches!(previous, Some('-' | '=' | '<')) {
                    continue;
                }
                // `>>` is one operator; judge it at its first character.
                if previous == Some('>') {
                    continue;
                }
                let next = characters.get(index + 1).copied();
                if next == Some('&') {
                    continue;
                }
                return Some(if next == Some('>') { ">>" } else { ">" });
            }
            None => {}
        }
    }
    None
}

fn read_only_violation(normalized: &str, kind: ShellKind) -> Option<String> {
    let mutating: &[&str] = match kind {
        ShellKind::Cmd => CMD_MUTATING,
        _ => POWERSHELL_MUTATING,
    };

    // Command position, not mere presence. Every entry below is either an
    // ordinary English word (`copy`, `move`, `rename`, `kill`) or a two-letter
    // alias (`ri`, `ni`, `sc`, `mi`, `ac`), so a grep pattern or a `Get-Help`
    // argument used to read as the write itself. A pipeline still resolves —
    // `Get-ChildItem -Recurse | Remove-Item` puts the verb first in its own
    // segment, which is exactly what command position means.
    for candidate in mutating {
        if runs_command(normalized, candidate) {
            let name = candidate.trim();
            return Some(format!(
                "Command '{name}' modifies the filesystem or system state and is not allowed in \
                 read-only mode"
            ));
        }
    }

    if let Some(redirection) = write_redirection(normalized) {
        return Some(format!(
            "Command contains write redirection '{redirection}' which is not allowed in \
             read-only mode"
        ));
    }

    None
}

/// Operators that end one command and begin the next, in both Windows shells.
const SEGMENT_BREAKS: &[char] = &[';', '|', '&', '(', ')', '{', '}', '\n', '\r'];

/// Tokens after which the rest of the line is a command in its own right —
/// but ONLY when the thing being invoked is a shell.
///
/// Without this, `cmd /c "format c:"` hides the dangerous verb behind `cmd`
/// and reads as "the command being run is `cmd`", which is true and useless.
/// With it applied unconditionally, `rg -c "shutdown" src` would read as
/// running `shutdown`, because `-c` is also ripgrep's count flag. The flag
/// only means "here comes a command" when a shell is the one reading it.
const PAYLOAD_INTRODUCERS: &[&str] = &[" /c ", " /k ", " -c ", " -command "];

/// Programs whose job is to run the rest of the line.
const NESTED_SHELLS: &[&str] = &[
    "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "bash.exe", "sh",
    "sh.exe", "wsl", "wsl.exe",
];

/// The command-position slices of `normalized`: one per shell command, plus
/// one for each payload handed to a nested shell.
fn command_segments(normalized: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0usize;
    for (index, character) in normalized.char_indices() {
        if SEGMENT_BREAKS.contains(&character) {
            segments.push(&normalized[start..index]);
            start = index + character.len_utf8();
        }
    }
    segments.push(&normalized[start..]);

    let mut with_payloads = Vec::with_capacity(segments.len());
    for segment in segments {
        with_payloads.push(segment);
        if !invokes_a_nested_shell(segment) {
            continue;
        }
        if let Some(payload) = PAYLOAD_INTRODUCERS
            .iter()
            .filter_map(|introducer| segment.find(introducer).map(|at| at + introducer.len()))
            .min()
        {
            with_payloads.push(&segment[payload..]);
        }
    }
    with_payloads
}

/// Is this segment's leading word a shell, by bare name or by full path?
fn invokes_a_nested_shell(segment: &str) -> bool {
    let Some(leading) = segment
        .trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`'))
        .split_whitespace()
        .next()
    else {
        return false;
    };
    // `C:\Windows\System32\cmd.exe /c …` names the same program as `cmd /c …`.
    let program = leading
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(leading);
    NESTED_SHELLS.contains(&program)
}

/// Is `needle` the command being RUN, rather than a word inside one?
///
/// The distinction `contains_command` cannot make: it honours token
/// boundaries, so `reg-test` is not `reg`, but it has no idea whether the
/// token it found is the verb or an argument. `Select-String -Pattern move`
/// and `Get-Help Remove-Item` both name a mutating command and mutate
/// nothing, and in read-only mode both were blocked as writes.
fn runs_command(normalized: &str, needle: &str) -> bool {
    let needle = needle.trim();
    if needle.is_empty() {
        return false;
    }
    command_segments(normalized).into_iter().any(|segment| {
        let segment = segment.trim_start_matches(|c: char| {
            c.is_whitespace() || matches!(c, '"' | '\'' | '`')
        });
        segment.strip_prefix(needle).is_some_and(|rest| {
            // The verb has to end where the word ends. `format` is the `format`
            // command; `format-volume` is a different one, with its own entry.
            rest.is_empty()
                || rest
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_whitespace() || matches!(c, '"' | '\''))
        })
    })
}

/// How much of a command a pattern has to own before it counts.
///
/// The table below used to be matched with a bare `normalized.contains(…)`,
/// which is only safe when every entry is a word that cannot turn up as an
/// ordinary argument. Two entries are exactly that word: `format` and
/// `shutdown`. Measured on thread `7584a888` (2026-09-16):
///
/// ```text
/// shell_execute(command: "uv run --frozen ruff format --check src", shell: "pwsh")
///   -> policy violation: warning: Destructive command detected:
///      Formatting a volume will destroy all data on it
/// ```
///
/// `ruff format --check` formats Python. It does not format a volume. And
/// because `shell_execute` maps a warning onto `PolicyViolation` (see
/// `shell_execute::map_bash_error`), the refusal was total: the command never
/// ran, twice, and the checks it was gating were abandoned.
///
/// Re-measured after the fix, the same substring test also flagged
/// `dotnet format --verify-no-changes`, `clang-format -i`,
/// `docker ps --format …`, `git log --format …`, `rg shutdown src`,
/// `cargo test shutdown` and `Get-Content src/shutdown.rs` — 11 of 20
/// realistic commands, against 0 of the 10 genuinely dangerous ones that
/// needed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Match {
    /// The pattern is a distinctive verb or a flag combination that cannot be
    /// assembled by accident (`diskpart`, `rd /s`, `reg delete`). Finding it
    /// anywhere is evidence, and matching it anywhere survives a `cmd /c`
    /// wrapper this module does not try to parse.
    Anywhere,
    /// The pattern is an ordinary English word. It only counts as the command
    /// being RUN, never as an argument handed to something else.
    AsCommand,
}

/// Patterns worth stopping a user for, with the reason they see.
const DESTRUCTIVE_PATTERNS: &[(&str, Match, &str)] = &[
    ("rd /s", Match::Anywhere, "Recursive directory deletion"),
    ("rmdir /s", Match::Anywhere, "Recursive directory deletion"),
    ("del /s", Match::Anywhere, "Recursive file deletion"),
    ("del /f", Match::Anywhere, "Forced file deletion"),
    ("erase /s", Match::Anywhere, "Recursive file deletion"),
    (
        "format",
        Match::AsCommand,
        "Formatting a volume will destroy all data on it",
    ),
    (
        "diskpart",
        Match::Anywhere,
        "Direct partition manipulation can destroy volumes",
    ),
    (
        "clear-disk",
        Match::Anywhere,
        "Clearing a disk destroys every partition on it",
    ),
    (
        "remove-partition",
        Match::Anywhere,
        "Removing a partition destroys its data",
    ),
    (
        "initialize-disk",
        Match::Anywhere,
        "Initializing a disk destroys its contents",
    ),
    (
        "format-volume",
        Match::Anywhere,
        "Formatting a volume will destroy all data on it",
    ),
    ("cipher /w", Match::Anywhere, "Wiping free space is irreversible"),
    (
        "reg delete",
        Match::Anywhere,
        "Deleting registry keys can break the system",
    ),
    (
        "bcdedit",
        Match::Anywhere,
        "Boot configuration changes can make Windows unbootable",
    ),
    (
        "shutdown",
        Match::AsCommand,
        "Shutting down or restarting will interrupt work",
    ),
    (
        "stop-computer",
        Match::Anywhere,
        "Shutting down will interrupt work",
    ),
    (
        "restart-computer",
        Match::Anywhere,
        "Restarting will interrupt work",
    ),
    ("%0|%0", Match::Anywhere, "Fork bomb — will crash the system"),
];

fn destructive_warning(normalized: &str) -> Option<&'static str> {
    // `Remove-Item -Recurse -Force` is the PowerShell `rm -rf`; the flags can
    // appear in either order and are routinely abbreviated (`-r -fo`). The
    // deleting verb has to be the command, not a word inside one: `Get-Help
    // Remove-Item -Full` mentions it and deletes nothing.
    let removes = runs_command(normalized, "remove-item")
        || runs_command(normalized, "ri")
        || runs_command(normalized, "rm");
    let recursive = normalized.contains("-recurse") || normalized.contains(" -r ");
    let forced = normalized.contains("-force") || normalized.contains(" -fo");
    if removes && recursive && forced {
        return Some("Recursive forced deletion — verify the target path is correct");
    }

    DESTRUCTIVE_PATTERNS
        .iter()
        .find(|(pattern, how, _)| match how {
            Match::Anywhere => normalized.contains(pattern),
            Match::AsCommand => runs_command(normalized, pattern),
        })
        .map(|(_, _, warning)| *warning)
}

/// Locations outside the workspace that a write should not silently touch.
///
/// The `$`-prefixed entries are matched at a word boundary, not as a bare
/// substring: `$home` is the home directory and `$homepage` is a variable
/// somebody named, and writing to the second is not a system write. The `%…%`
/// and `c:\…` forms carry their own delimiters and need no such care.
const SENSITIVE_PATH_MARKERS: &[&str] = &[
    r"c:\windows",
    r"c:\program files",
    r"c:\programdata",
    "%systemroot%",
    "%windir%",
    "$env:windir",
    "$env:systemroot",
    "%userprofile%",
    "$env:userprofile",
    "$home",
    "%appdata%",
    "$env:appdata",
];

/// Does `normalized` name this marker, rather than spell it inside a longer
/// identifier? Only the `$` forms can be extended, so only they are checked.
fn mentions_marker(normalized: &str, marker: &str) -> bool {
    if !marker.starts_with('$') {
        return normalized.contains(marker);
    }
    normalized.match_indices(marker).any(|(at, _)| {
        normalized[at + marker.len()..]
            .chars()
            .next()
            .is_none_or(|next| !(next.is_alphanumeric() || next == '_'))
    })
}

fn path_warning(
    command: &str,
    normalized: &str,
    mode: ExecutionMode,
    workspace: Option<&Path>,
    cwd: Option<&Path>,
) -> Option<String> {
    if mode == ExecutionMode::ReadOnly {
        return None;
    }
    let mutating = POWERSHELL_MUTATING
        .iter()
        .chain(CMD_MUTATING.iter())
        .any(|candidate| runs_command(normalized, candidate));
    if !mutating {
        return None;
    }

    if SENSITIVE_PATH_MARKERS
        .iter()
        .any(|marker| mentions_marker(normalized, marker))
    {
        return Some(
            "Command appears to target files outside the workspace — requires elevated permission"
                .to_string(),
        );
    }

    // Use the shared directory-aware traversal check, preserving the original
    // quoted paths rather than the lowercased command-matching copy.
    if let Some(root) = workspace {
        if let Some(escaping) =
            super::shell_paths::escaping_path(command, root, cwd.unwrap_or(root), false)
        {
            return Some(format!(
                "`{escaping}` may resolve outside the workspace ({}). Use a path inside it; \
                 relative paths are checked from `cwd` and each literal directory change.",
                root.display()
            ));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> &'static Path {
        Path::new(r"C:\work\project")
    }

    #[test]
    fn posix_kinds_keep_the_existing_pipeline() {
        let err = validate_for_shell(
            "rm -rf /",
            ExecutionMode::WorkspaceWrite,
            ShellKind::Bash,
            None,
        )
        .expect_err("must warn");
        assert!(matches!(err, BashValidationError::Warning(_)));
    }

    #[test]
    fn posix_package_install_with_rm_like_package_names_is_allowed() {
        validate_for_shell(
            "bun add clsx tailwind-merge lucide-react react-hook-form zod",
            ExecutionMode::WorkspaceWrite,
            ShellKind::Bash,
            Some(workspace()),
        )
        .expect("package-name substrings must not be classified as rm -rf");
    }

    /// The verbatim command from session `41841342`: bash expanded `$_` to
    /// `/usr/bin/bash` and PowerShell answered with pages of
    /// CommandNotFoundException. The guard must name the escape routes.
    #[test]
    fn bash_wrapping_a_powershell_payload_with_dollar_vars_is_blocked() {
        let err = validate_for_shell(
            r#"powershell -NoProfile -Command "Get-Service | Where-Object { $_.Name -match 'postgres|redis|pgsql' } | Format-Table Name,Status,StartType -AutoSize" 2>&1"#,
            ExecutionMode::WorkspaceWrite,
            ShellKind::Bash,
            None,
        )
        .expect_err("bash would mangle $_ before PowerShell runs");
        match err {
            BashValidationError::Blocked(message) => {
                assert!(message.contains("$_"), "names the variable: {message}");
                assert!(message.contains("pwsh"), "names the fix: {message}");
                assert!(
                    message.contains("single-quote"),
                    "names the bash escape: {message}"
                );
            }
            other => panic!("expected a block, got {other:?}"),
        }
    }

    /// Single quotes are bash's pass-through: the payload arrives intact, so
    /// there is nothing to protect against.
    #[test]
    fn a_single_quoted_powershell_payload_is_left_alone() {
        validate_for_shell(
            r"pwsh -NoProfile -Command 'Get-Service | Where-Object { $_.Name -match \'redis\' }'",
            ExecutionMode::WorkspaceWrite,
            ShellKind::Bash,
            None,
        )
        .expect("bash does not expand inside single quotes");
    }

    /// No `$` in the payload — nothing bash could destroy.
    #[test]
    fn a_dollar_free_powershell_payload_is_left_alone() {
        validate_for_shell(
            r#"powershell -NoProfile -Command "Get-Date" "#,
            ExecutionMode::WorkspaceWrite,
            ShellKind::Bash,
            None,
        )
        .expect("no PowerShell-only variables in the payload");
    }

    /// `$_` run natively under pwsh is that shell's own grammar; the guard is
    /// about BASH rewriting it, so pwsh must be untouched.
    #[test]
    fn native_powershell_dollar_underscore_is_untouched() {
        validate_for_shell(
            "Get-Service | Where-Object { $_.Name -match 'redis' }",
            ExecutionMode::WorkspaceWrite,
            ShellKind::Pwsh,
            Some(workspace()),
        )
        .expect("pwsh running its own syntax is the correct form");
    }

    #[test]
    fn powershell_recursive_force_delete_warns() {
        let err = validate_for_shell(
            "Remove-Item -Recurse -Force .\\dist",
            ExecutionMode::WorkspaceWrite,
            ShellKind::Pwsh,
            Some(workspace()),
        )
        .expect_err("must warn");
        match err {
            BashValidationError::Warning(message) => {
                assert!(
                    message.contains("Recursive forced deletion"),
                    "got: {message}"
                );
            }
            other => panic!("expected a warning, got {other:?}"),
        }
    }

    #[test]
    fn cmd_recursive_quiet_delete_warns() {
        let err = validate_for_shell(
            "rd /s /q build",
            ExecutionMode::WorkspaceWrite,
            ShellKind::Cmd,
            Some(workspace()),
        )
        .expect_err("must warn");
        assert!(matches!(err, BashValidationError::Warning(_)));
    }

    #[test]
    fn format_is_flagged_in_cmd() {
        let err = validate_for_shell(
            "format C: /q",
            ExecutionMode::WorkspaceWrite,
            ShellKind::Cmd,
            None,
        )
        .expect_err("must warn");
        assert!(matches!(err, BashValidationError::Warning(_)));
    }

    #[test]
    fn read_only_blocks_powershell_writes_at_the_end_of_a_pipeline() {
        let err = validate_for_shell(
            "Get-ChildItem -Recurse | Remove-Item",
            ExecutionMode::ReadOnly,
            ShellKind::Pwsh,
            None,
        )
        .expect_err("must block");
        assert!(matches!(err, BashValidationError::Blocked(_)));
    }

    #[test]
    fn read_only_blocks_redirection() {
        let err = validate_for_shell(
            "Get-Process > procs.txt",
            ExecutionMode::ReadOnly,
            ShellKind::Pwsh,
            None,
        )
        .expect_err("must block");
        assert!(matches!(err, BashValidationError::Blocked(_)));
    }

    #[test]
    fn read_only_allows_inspection() {
        validate_for_shell(
            "Get-ChildItem -Recurse src",
            ExecutionMode::ReadOnly,
            ShellKind::Pwsh,
            None,
        )
        .expect("read-only inspection is allowed");
        validate_for_shell("dir /b src", ExecutionMode::ReadOnly, ShellKind::Cmd, None)
            .expect("read-only inspection is allowed");
    }

    #[test]
    fn ordinary_workspace_writes_are_allowed() {
        validate_for_shell(
            "New-Item -ItemType Directory src\\generated",
            ExecutionMode::WorkspaceWrite,
            ShellKind::Pwsh,
            Some(workspace()),
        )
        .expect("workspace writes are allowed");
    }

    #[test]
    fn writes_into_system_locations_warn() {
        let err = validate_for_shell(
            "Copy-Item app.exe C:\\Windows\\System32",
            ExecutionMode::WorkspaceWrite,
            ShellKind::Pwsh,
            Some(workspace()),
        )
        .expect_err("must warn");
        assert!(matches!(err, BashValidationError::Warning(_)));
    }

    #[test]
    fn command_position_separates_the_verb_from_its_arguments() {
        // `reg-test` must not read as the `reg` command, and `Get-ChildItem`
        // must not read as the `ni` alias.
        assert!(!runs_command("cd src\\reg-test", "reg "));
        assert!(!runs_command("get-childitem -recurse", "ni "));
        // A pipeline puts the verb first in its own segment.
        assert!(runs_command("get-childitem | remove-item", "remove-item"));
        assert!(runs_command("del /f build.log", "del "));
        // Named, not run.
        assert!(!runs_command("get-help remove-item -full", "remove-item"));
        assert!(!runs_command("select-string -pattern move -path src", "move"));
        // A nested shell's payload is a command in its own right.
        assert!(runs_command("cmd /c \"format c: /q\"", "format"));
        assert!(runs_command(
            "powershell -command \"remove-item x\"",
            "remove-item"
        ));
        assert!(runs_command(
            "c:\\windows\\system32\\cmd.exe /c \"format c:\"",
            "format"
        ));
        // …but `-c` is ripgrep's count flag, not a payload introducer, so the
        // pattern it is counting must not read as the command being run.
        assert!(!runs_command("rg -c \"shutdown\" src", "shutdown"));
        assert!(!runs_command("rg -c \"format\" src", "format"));
        // The verb ends where the word ends.
        assert!(!runs_command("format-volume -driveletter d", "format"));
    }

    /// Verbatim from thread `7584a888` (2026-09-16), plus every other command
    /// the bare-substring table flagged when it was re-measured. Each one is a
    /// total refusal, because `shell_execute` maps a warning onto
    /// `PolicyViolation` and the command never runs.
    #[test]
    fn a_formatter_is_not_a_disk_formatter() {
        for command in [
            // The reported call.
            "uv run --frozen ruff format --check src",
            "ruff format src",
            "dotnet format --verify-no-changes",
            "clang-format -i src/main.cpp",
            // `--format` as a flag, which is everywhere.
            "docker ps --format \"{{.Names}}\"",
            "git log --format \"%h %s\" -n 5",
            "npm run build -- --format esm",
            // `Format-*` cmdlets, named and piped.
            "Get-Service | Format-Table Name,Status -AutoSize",
            "Get-Help Format-Table",
        ] {
            assert_eq!(
                destructive_warning(&normalize(command)),
                None,
                "must not read as a destructive command: {command}"
            );
        }
    }

    /// `shutdown` is a word before it is a command, and the word turns up in
    /// source files, test names and search patterns.
    #[test]
    fn searching_for_the_word_shutdown_is_not_shutting_down() {
        for command in [
            "rg shutdown src",
            "Select-String -Pattern shutdown -Path src",
            "Get-Content src/shutdown.rs",
            "cargo test shutdown",
        ] {
            assert_eq!(
                destructive_warning(&normalize(command)),
                None,
                "must not read as a shutdown: {command}"
            );
        }
    }

    /// The other half of every narrowing: the dangerous forms still warn.
    /// All ten of these were flagged before the change and must stay flagged.
    #[test]
    fn the_genuinely_destructive_commands_still_warn() {
        for command in [
            "format C: /q",
            "Format-Volume -DriveLetter D",
            "diskpart /s script.txt",
            "Clear-Disk -Number 1",
            "Remove-Item -Recurse -Force .\\dist",
            "rd /s /q build",
            "reg delete HKLM\\Software\\X /f",
            "bcdedit /set nx AlwaysOn",
            "shutdown /s /t 0",
            "cipher /w:C",
        ] {
            assert!(
                destructive_warning(&normalize(command)).is_some(),
                "must still warn: {command}"
            );
        }
    }

    /// A `>` in a search pattern is not a redirection. Plan mode refused all
    /// three of these, and a refusal there means the search never ran.
    #[test]
    fn an_arrow_in_a_search_pattern_is_not_a_redirection() {
        for command in [
            "rg -n \"->\" src/main.rs",
            "rg -n \"=>\" src",
            "git log --pretty=format:\"%h -> %s\"",
            "printf done >&2",
        ] {
            assert_eq!(
                write_redirection(&normalize(command)),
                None,
                "must not read as a write redirection: {command}"
            );
        }
        // Real redirections, still caught.
        assert_eq!(write_redirection("get-process > procs.txt"), Some(">"));
        assert_eq!(write_redirection("get-process >> procs.txt"), Some(">>"));
        assert_eq!(write_redirection("get-date 2> err.log"), Some(">"));
    }

    /// Searching for a mutating command's name, in read-only mode, is a read.
    #[test]
    fn read_only_allows_searches_that_merely_name_a_write_command() {
        for command in [
            "Select-String -Pattern move -Path src",
            "git log --grep rename",
            "Get-Help Remove-Item -Full",
            "rg -n \"->\" src/main.rs",
        ] {
            validate_for_shell(command, ExecutionMode::ReadOnly, ShellKind::Pwsh, None)
                .unwrap_or_else(|err| panic!("{command} must be allowed, got {err:?}"));
        }
    }

    /// Traversal that resolves back inside the workspace is not an escape.
    /// Same defect, and same fix, as the POSIX validator's `validate_paths`.
    #[test]
    fn traversal_that_stays_inside_the_workspace_is_allowed() {
        for command in [
            r"Copy-Item src\..\src\a.ts dst\a.ts",
            "Move-Item src/../src/b.ts out/b.ts",
            "New-Item -ItemType Directory packages/web/../api/src",
        ] {
            validate_for_shell(
                command,
                ExecutionMode::WorkspaceWrite,
                ShellKind::Pwsh,
                Some(workspace()),
            )
            .unwrap_or_else(|err| panic!("{command} must be allowed, got {err:?}"));
        }
    }

    /// And one that genuinely leaves is still refused — now naming the path.
    #[test]
    fn traversal_that_leaves_the_workspace_names_the_path() {
        let err = validate_for_shell(
            r"Copy-Item secrets.env ..\..\elsewhere\secrets.env",
            ExecutionMode::WorkspaceWrite,
            ShellKind::Pwsh,
            Some(workspace()),
        )
        .expect_err("a path above the root is outside the workspace");
        let BashValidationError::Warning(message) = err else {
            panic!("expected a warning");
        };
        assert!(message.contains(r"..\..\elsewhere\secrets.env"), "{message}");
        assert!(message.contains("project"), "{message}");
    }

    /// `$home` is the home directory; `$homepage` is a variable someone named.
    #[test]
    fn a_marker_must_be_the_whole_variable_name() {
        assert!(!mentions_marker("set-content $homepage.html x", "$home"));
        assert!(mentions_marker("copy-item a $home/b", "$home"));
        assert!(mentions_marker("copy-item a $home", "$home"));
    }

    #[test]
    fn read_only_does_not_warn_about_paths() {
        validate_for_shell(
            "Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts",
            ExecutionMode::ReadOnly,
            ShellKind::Pwsh,
            Some(workspace()),
        )
        .expect("reading a system file is not a write");
    }
}
