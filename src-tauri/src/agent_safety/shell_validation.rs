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
    validate_command, validate_command_with_workspace, BashValidationError, ExecutionMode,
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
    if kind.is_posix() {
        if let Some(reason) = bash_would_mangle_powershell_payload(command) {
            return Err(BashValidationError::Blocked(reason));
        }
        return match workspace {
            Some(workspace) => validate_command_with_workspace(command, mode, workspace),
            None => validate_command(command, mode),
        };
    }
    validate_windows_shell(command, mode, kind, workspace)
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

    if let Some(warning) = path_warning(&normalized, mode, workspace) {
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

/// Redirections that create or truncate a file in either shell family.
const WRITE_REDIRECTIONS: &[&str] = &[">", ">>"];

fn read_only_violation(normalized: &str, kind: ShellKind) -> Option<String> {
    let mutating: &[&str] = match kind {
        ShellKind::Cmd => CMD_MUTATING,
        _ => POWERSHELL_MUTATING,
    };

    for candidate in mutating {
        if contains_command(normalized, candidate) {
            let name = candidate.trim();
            return Some(format!(
                "Command '{name}' modifies the filesystem or system state and is not allowed in \
                 read-only mode"
            ));
        }
    }

    for redirection in WRITE_REDIRECTIONS {
        if normalized.contains(redirection) {
            return Some(format!(
                "Command contains write redirection '{redirection}' which is not allowed in \
                 read-only mode"
            ));
        }
    }

    None
}

/// Match a mutating command name anywhere in the string, respecting token
/// boundaries so `get-childitem` never matches `ni ` and a path fragment
/// like `\bin\reg-test` never matches `reg `.
fn contains_command(normalized: &str, needle: &str) -> bool {
    let trimmed = needle.trim();
    let mut haystack = normalized;
    let mut offset = 0usize;

    while let Some(index) = haystack.find(trimmed) {
        let absolute = offset + index;
        let before_ok = absolute == 0
            || normalized[..absolute]
                .chars()
                .next_back()
                .is_some_and(|c| matches!(c, ' ' | '|' | ';' | '(' | '&' | '{'));
        let after = normalized[absolute + trimmed.len()..].chars().next();
        let after_ok = after.is_none_or(|c| matches!(c, ' ' | '|' | ';' | ')' | '&' | '}'));
        if before_ok && after_ok {
            return true;
        }
        offset = absolute + trimmed.len();
        haystack = &normalized[offset..];
    }
    false
}

/// Patterns worth stopping a user for, with the reason they see.
const DESTRUCTIVE_PATTERNS: &[(&str, &str)] = &[
    ("rd /s", "Recursive directory deletion"),
    ("rmdir /s", "Recursive directory deletion"),
    ("del /s", "Recursive file deletion"),
    ("del /f", "Forced file deletion"),
    ("erase /s", "Recursive file deletion"),
    ("format ", "Formatting a volume will destroy all data on it"),
    (
        "diskpart",
        "Direct partition manipulation can destroy volumes",
    ),
    (
        "clear-disk",
        "Clearing a disk destroys every partition on it",
    ),
    ("remove-partition", "Removing a partition destroys its data"),
    (
        "initialize-disk",
        "Initializing a disk destroys its contents",
    ),
    (
        "format-volume",
        "Formatting a volume will destroy all data on it",
    ),
    ("cipher /w", "Wiping free space is irreversible"),
    ("reg delete", "Deleting registry keys can break the system"),
    (
        "bcdedit",
        "Boot configuration changes can make Windows unbootable",
    ),
    (
        "shutdown",
        "Shutting down or restarting will interrupt work",
    ),
    ("stop-computer", "Shutting down will interrupt work"),
    ("restart-computer", "Restarting will interrupt work"),
    ("%0|%0", "Fork bomb — will crash the system"),
];

fn destructive_warning(normalized: &str) -> Option<&'static str> {
    // `Remove-Item -Recurse -Force` is the PowerShell `rm -rf`; the flags can
    // appear in either order and are routinely abbreviated (`-r -fo`).
    let removes = contains_command(normalized, "remove-item")
        || contains_command(normalized, "ri")
        || contains_command(normalized, "rm");
    let recursive = normalized.contains("-recurse") || normalized.contains(" -r ");
    let forced = normalized.contains("-force") || normalized.contains(" -fo");
    if removes && recursive && forced {
        return Some("Recursive forced deletion — verify the target path is correct");
    }

    DESTRUCTIVE_PATTERNS
        .iter()
        .find(|(pattern, _)| normalized.contains(pattern))
        .map(|(_, warning)| *warning)
}

/// Locations outside the workspace that a write should not silently touch.
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

fn path_warning(normalized: &str, mode: ExecutionMode, workspace: Option<&Path>) -> Option<String> {
    if mode == ExecutionMode::ReadOnly {
        return None;
    }
    let mutating = POWERSHELL_MUTATING
        .iter()
        .chain(CMD_MUTATING.iter())
        .any(|candidate| contains_command(normalized, candidate));
    if !mutating {
        return None;
    }

    if SENSITIVE_PATH_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return Some(
            "Command appears to target files outside the workspace — requires elevated permission"
                .to_string(),
        );
    }

    // `..\` traversal only matters when a workspace defines an inside.
    if workspace.is_some() && (normalized.contains(r"..\") || normalized.contains("../")) {
        return Some(
            "Command uses parent-directory traversal and may write outside the workspace"
                .to_string(),
        );
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
    fn command_matching_respects_token_boundaries() {
        // `reg-test` must not read as the `reg` command, and `Get-ChildItem`
        // must not read as the `ni` alias.
        assert!(!contains_command("cd src\\reg-test", "reg "));
        assert!(!contains_command("get-childitem -recurse", "ni "));
        assert!(contains_command(
            "get-childitem | remove-item",
            "remove-item"
        ));
        assert!(contains_command("del /f build.log", "del "));
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
