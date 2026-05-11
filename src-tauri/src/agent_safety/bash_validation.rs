//! Bash command validation submodules.
//!
//! Ports the upstream `BashTool` validation pipeline:
//! - `readOnlyValidation` — block write-like commands in read-only mode
//! - `destructiveCommandWarning` — flag dangerous destructive commands
//! - `modeValidation` — enforce permission mode constraints on commands
//! - `sedValidation` — validate sed expressions before execution
//! - `pathValidation` — detect suspicious path patterns
//! - `commandSemantics` — classify command intent
//!
//! Public surface:
//! - [`validate_command`] — workspace-free 3-stage pipeline (mode + sed
//!   + destructive). Always available.
//! - [`validate_command_with_workspace`] — full 4-stage pipeline that
//!   also runs [`validate_paths`] against the active workspace; used by
//!   shell tools when [`crate::agent_runtime::tool_executor::ToolContext::workspace_root`]
//!   is `Some`.
//! - [`classify_intent`] — semantic classification of a command (read-
//!   only, write, destructive, network, …). Surfaced to the frontend in
//!   `shell_execute` / `shell_spawn` JSON output for audit trails.
//! - [`ExecutionMode`], [`BashValidationError`], [`CommandIntent`].
//!
//! Originally a verbatim port of
//! `claw-code/rust/crates/runtime/src/bash_validation.rs`. Two
//! Aurora-specific adjustments persist:
//!
//! 1. `PermissionMode` (originally imported from `crate::permissions`) is
//!    inlined here and renamed to `ExecutionMode`.
//! 2. The upstream `Allow`, `Prompt`, and `DangerFullAccess` variants
//!    were collapsed away: in Aurora the prompt-vs-bypass decision is
//!    made one layer up by
//!    [`crate::tools::permissions::SettingsAwarePermitter`] — by the
//!    time control reaches the validator, the permitter has already
//!    auto-approved (bypass) or run the user's prompt flow. The
//!    validator only ever needs to know whether **filesystem writes
//!    are allowed at all**, which is captured by the two-state
//!    [`ExecutionMode`] enum below.

use std::path::Path;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/// Filesystem-write authority the command is being executed under.
///
/// Two states only — bypass / "danger" mode is handled by
/// [`crate::tools::permissions::SettingsAwarePermitter`] *before*
/// this validator runs (the permitter auto-approves the call, so we
/// never observe a "no validation at all" mode here). Whether or
/// not Aurora prompts the user for each call is also a permitter
/// concern, not a validator concern.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    /// No filesystem or state mutation allowed. Used for the agent's
    /// "plan / read-only" mode.
    ReadOnly,
    /// Writes constrained to the active workspace. The default for
    /// the standard "agent" mode.
    WorkspaceWrite,
}

/// Errors returned by [`validate_command`].
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum BashValidationError {
    /// Command is hard-blocked (e.g. write-like command in read-only mode).
    #[error("blocked: {0}")]
    Blocked(String),
    /// Command requires user confirmation (e.g. destructive pattern).
    #[error("warning: {0}")]
    Warning(String),
}

/// Validate a bash command against the 5-stage safety pipeline.
///
/// Single public entry point for `agent_safety::bash_validation`. Runs:
/// 1. `validate_mode` (which delegates to `validate_read_only`)
/// 2. `validate_sed`
/// 3. `check_destructive`
///
/// Path validation requires a workspace argument and is therefore not run
/// from this entry point; callers that need it should use the underlying
/// helpers via the `agent_safety::paths` module's containment checks.
///
/// Returns:
/// - `Ok(())` if the pipeline returns `Allow`.
/// - `Err(Blocked(reason))` for hard blocks.
/// - `Err(Warning(message))` for destructive patterns that require
///   confirmation.
pub fn validate_command(input: &str, mode: ExecutionMode) -> Result<(), BashValidationError> {
    // 1. Mode-level validation (includes read-only checks).
    match validate_mode(input, mode) {
        ValidationResult::Allow => {}
        ValidationResult::Block { reason } => return Err(BashValidationError::Blocked(reason)),
        ValidationResult::Warn { message } => return Err(BashValidationError::Warning(message)),
    }

    // 2. Sed-specific validation.
    match validate_sed(input, mode) {
        ValidationResult::Allow => {}
        ValidationResult::Block { reason } => return Err(BashValidationError::Blocked(reason)),
        ValidationResult::Warn { message } => return Err(BashValidationError::Warning(message)),
    }

    // 3. Destructive command warnings.
    match check_destructive(input) {
        ValidationResult::Allow => Ok(()),
        ValidationResult::Block { reason } => Err(BashValidationError::Blocked(reason)),
        ValidationResult::Warn { message } => Err(BashValidationError::Warning(message)),
    }
}

/// Workspace-aware variant of [`validate_command`].
///
/// Runs the full 4-stage pipeline (`mode → sed → destructive →
/// path`) — identical to [`validate_command`] but additionally fires
/// [`validate_paths`] against `workspace`, which catches `../`
/// traversal and `~/` / `$HOME` references that would escape the
/// active workspace.
///
/// Shell tools should call this whenever
/// [`crate::agent_runtime::tool_executor::ToolContext::workspace_root`]
/// is `Some`, and fall back to the workspace-free
/// [`validate_command`] otherwise (e.g. agent runs without an open
/// folder).
pub fn validate_command_with_workspace(
    input: &str,
    mode: ExecutionMode,
    workspace: &Path,
) -> Result<(), BashValidationError> {
    match run_pipeline(input, mode, workspace) {
        ValidationResult::Allow => Ok(()),
        ValidationResult::Block { reason } => Err(BashValidationError::Blocked(reason)),
        ValidationResult::Warn { message } => Err(BashValidationError::Warning(message)),
    }
}

/// Classify a bash command into a [`CommandIntent`] (read-only,
/// write, destructive, network, …).
///
/// Public façade over the private [`classify_command`] helper.
/// Used by `shell_execute` / `shell_spawn` to tag tool-call results
/// with their semantic risk class so the chat UI can render
/// risk-aware affordances without re-parsing the command string in
/// JS.
#[must_use]
pub fn classify_intent(command: &str) -> CommandIntent {
    classify_command(command)
}

// ---------------------------------------------------------------------------
// Internal types — verbatim from claw-code, demoted to `fn`/`pub(super)` so
// the public surface is exactly `validate_command` + its types.
// ---------------------------------------------------------------------------

/// Result of validating a bash command before execution.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ValidationResult {
    /// Command is safe to execute.
    Allow,
    /// Command should be blocked with the given reason.
    Block { reason: String },
    /// Command requires user confirmation with the given warning.
    Warn { message: String },
}

/// Semantic classification of a bash command's intent.
///
/// Returned by [`classify_intent`] and surfaced in shell-tool JSON
/// output (`"intent": "read_only"`, `"network"`, …) so the audit
/// log / chat UI can render risk-aware tool cards without re-parsing
/// the command string on the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandIntent {
    /// Read-only operations: ls, cat, grep, find, etc.
    ReadOnly,
    /// File system writes: cp, mv, mkdir, touch, tee, etc.
    Write,
    /// Destructive operations: rm, shred, truncate, etc.
    Destructive,
    /// Network operations: curl, wget, ssh, etc.
    Network,
    /// Process management: kill, pkill, etc.
    ProcessManagement,
    /// Package management: apt, brew, pip, npm, etc.
    PackageManagement,
    /// System administration: sudo, chmod, chown, mount, etc.
    SystemAdmin,
    /// Unknown or unclassifiable command.
    Unknown,
}

impl CommandIntent {
    /// Stable snake_case identifier for serialisation into tool
    /// outputs / audit logs. Avoids pulling `serde_derive` into the
    /// safety crate just for one enum.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            CommandIntent::ReadOnly => "read_only",
            CommandIntent::Write => "write",
            CommandIntent::Destructive => "destructive",
            CommandIntent::Network => "network",
            CommandIntent::ProcessManagement => "process_management",
            CommandIntent::PackageManagement => "package_management",
            CommandIntent::SystemAdmin => "system_admin",
            CommandIntent::Unknown => "unknown",
        }
    }
}

// ---------------------------------------------------------------------------
// readOnlyValidation
// ---------------------------------------------------------------------------

/// Commands that perform write operations and should be blocked in read-only mode.
const WRITE_COMMANDS: &[&str] = &[
    "cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "chown", "chgrp", "ln", "install", "tee",
    "truncate", "shred", "mkfifo", "mknod", "dd",
];

/// Commands that modify system state and should be blocked in read-only mode.
const STATE_MODIFYING_COMMANDS: &[&str] = &[
    "apt",
    "apt-get",
    "yum",
    "dnf",
    "pacman",
    "brew",
    "pip",
    "pip3",
    "npm",
    "yarn",
    "pnpm",
    "bun",
    "cargo",
    "gem",
    "go",
    "rustup",
    "docker",
    "systemctl",
    "service",
    "mount",
    "umount",
    "kill",
    "pkill",
    "killall",
    "reboot",
    "shutdown",
    "halt",
    "poweroff",
    "useradd",
    "userdel",
    "usermod",
    "groupadd",
    "groupdel",
    "crontab",
    "at",
];

/// Shell redirection operators that indicate writes.
const WRITE_REDIRECTIONS: &[&str] = &[">", ">>", ">&"];

/// Validate that a command is allowed under read-only mode.
///
/// Corresponds to upstream `tools/BashTool/readOnlyValidation.ts`.
#[must_use]
fn validate_read_only(command: &str, mode: ExecutionMode) -> ValidationResult {
    if mode != ExecutionMode::ReadOnly {
        return ValidationResult::Allow;
    }

    let first_command = extract_first_command(command);

    // Check for write commands.
    for &write_cmd in WRITE_COMMANDS {
        if first_command == write_cmd {
            return ValidationResult::Block {
                reason: format!(
                    "Command '{write_cmd}' modifies the filesystem and is not allowed in read-only mode"
                ),
            };
        }
    }

    // Check for state-modifying commands.
    for &state_cmd in STATE_MODIFYING_COMMANDS {
        if first_command == state_cmd {
            return ValidationResult::Block {
                reason: format!(
                    "Command '{state_cmd}' modifies system state and is not allowed in read-only mode"
                ),
            };
        }
    }

    // Check for sudo wrapping write commands.
    if first_command == "sudo" {
        let inner = extract_sudo_inner(command);
        if !inner.is_empty() {
            let inner_result = validate_read_only(inner, mode);
            if inner_result != ValidationResult::Allow {
                return inner_result;
            }
        }
    }

    // Check for write redirections.
    for &redir in WRITE_REDIRECTIONS {
        if command.contains(redir) {
            return ValidationResult::Block {
                reason: format!(
                    "Command contains write redirection '{redir}' which is not allowed in read-only mode"
                ),
            };
        }
    }

    // Check for git commands that modify state.
    if first_command == "git" {
        return validate_git_read_only(command);
    }

    ValidationResult::Allow
}

/// Git subcommands that are read-only safe.
const GIT_READ_ONLY_SUBCOMMANDS: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "tag",
    "stash",
    "remote",
    "fetch",
    "ls-files",
    "ls-tree",
    "cat-file",
    "rev-parse",
    "describe",
    "shortlog",
    "blame",
    "bisect",
    "reflog",
    "config",
];

fn validate_git_read_only(command: &str) -> ValidationResult {
    let parts: Vec<&str> = command.split_whitespace().collect();
    // Skip past "git" and any flags (e.g., "git -C /path")
    let subcommand = parts.iter().skip(1).find(|p| !p.starts_with('-'));

    match subcommand {
        Some(&sub) if GIT_READ_ONLY_SUBCOMMANDS.contains(&sub) => ValidationResult::Allow,
        Some(&sub) => ValidationResult::Block {
            reason: format!(
                "Git subcommand '{sub}' modifies repository state and is not allowed in read-only mode"
            ),
        },
        None => ValidationResult::Allow, // bare "git" is fine
    }
}

// ---------------------------------------------------------------------------
// destructiveCommandWarning
// ---------------------------------------------------------------------------

/// Patterns that indicate potentially destructive commands.
const DESTRUCTIVE_PATTERNS: &[(&str, &str)] = &[
    (
        "rm -rf /",
        "Recursive forced deletion at root — this will destroy the system",
    ),
    ("rm -rf ~", "Recursive forced deletion of home directory"),
    (
        "rm -rf *",
        "Recursive forced deletion of all files in current directory",
    ),
    ("rm -rf .", "Recursive forced deletion of current directory"),
    (
        "mkfs",
        "Filesystem creation will destroy existing data on the device",
    ),
    (
        "dd if=",
        "Direct disk write — can overwrite partitions or devices",
    ),
    ("> /dev/sd", "Writing to raw disk device"),
    (
        "chmod -R 777",
        "Recursively setting world-writable permissions",
    ),
    ("chmod -R 000", "Recursively removing all permissions"),
    (":(){ :|:& };:", "Fork bomb — will crash the system"),
];

/// Commands that are always destructive regardless of arguments.
const ALWAYS_DESTRUCTIVE_COMMANDS: &[&str] = &["shred", "wipefs"];

/// Warn if a command looks destructive.
///
/// Corresponds to upstream `tools/BashTool/destructiveCommandWarning.ts`.
#[must_use]
fn check_destructive(command: &str) -> ValidationResult {
    // Check known destructive patterns.
    for &(pattern, warning) in DESTRUCTIVE_PATTERNS {
        if command.contains(pattern) {
            return ValidationResult::Warn {
                message: format!("Destructive command detected: {warning}"),
            };
        }
    }

    // Check always-destructive commands.
    let first = extract_first_command(command);
    for &cmd in ALWAYS_DESTRUCTIVE_COMMANDS {
        if first == cmd {
            return ValidationResult::Warn {
                message: format!(
                    "Command '{cmd}' is inherently destructive and may cause data loss"
                ),
            };
        }
    }

    // Check for "rm -rf" with broad targets.
    if command.contains("rm ") && command.contains("-r") && command.contains("-f") {
        // Already handled the most dangerous patterns above.
        // Flag any remaining "rm -rf" as a warning.
        return ValidationResult::Warn {
            message: "Recursive forced deletion detected — verify the target path is correct"
                .to_string(),
        };
    }

    ValidationResult::Allow
}

// ---------------------------------------------------------------------------
// modeValidation
// ---------------------------------------------------------------------------

/// Validate that a command is consistent with the given permission mode.
///
/// Corresponds to upstream `tools/BashTool/modeValidation.ts`.
#[must_use]
fn validate_mode(command: &str, mode: ExecutionMode) -> ValidationResult {
    match mode {
        ExecutionMode::ReadOnly => validate_read_only(command, mode),
        ExecutionMode::WorkspaceWrite => {
            // In workspace-write mode, check for system-level destructive
            // operations that go beyond workspace scope.
            if command_targets_outside_workspace(command) {
                return ValidationResult::Warn {
                    message:
                        "Command appears to target files outside the workspace — requires elevated permission"
                            .to_string(),
                };
            }
            ValidationResult::Allow
        }
    }
}

/// Heuristic: does the command reference absolute paths outside typical workspace dirs?
fn command_targets_outside_workspace(command: &str) -> bool {
    let system_paths = [
        "/etc/", "/usr/", "/var/", "/boot/", "/sys/", "/proc/", "/dev/", "/sbin/", "/lib/", "/opt/",
    ];

    let first = extract_first_command(command);
    let is_write_cmd = WRITE_COMMANDS.contains(&first.as_str())
        || STATE_MODIFYING_COMMANDS.contains(&first.as_str());

    if !is_write_cmd {
        return false;
    }

    for sys_path in &system_paths {
        if command.contains(sys_path) {
            return true;
        }
    }

    false
}

// ---------------------------------------------------------------------------
// sedValidation
// ---------------------------------------------------------------------------

/// Validate sed expressions for safety.
///
/// Corresponds to upstream `tools/BashTool/sedValidation.ts`.
#[must_use]
fn validate_sed(command: &str, mode: ExecutionMode) -> ValidationResult {
    let first = extract_first_command(command);
    if first != "sed" {
        return ValidationResult::Allow;
    }

    // In read-only mode, block sed -i (in-place editing).
    if mode == ExecutionMode::ReadOnly && command.contains(" -i") {
        return ValidationResult::Block {
            reason: "sed -i (in-place editing) is not allowed in read-only mode".to_string(),
        };
    }

    ValidationResult::Allow
}

// ---------------------------------------------------------------------------
// pathValidation
// ---------------------------------------------------------------------------

/// Validate that command paths don't include suspicious traversal patterns.
///
/// Corresponds to upstream `tools/BashTool/pathValidation.ts`.
#[must_use]
fn validate_paths(command: &str, workspace: &Path) -> ValidationResult {
    // Check for directory traversal attempts.
    if command.contains("../") {
        let workspace_str = workspace.to_string_lossy();
        // Allow traversal if it resolves within workspace (heuristic).
        if !command.contains(&*workspace_str) {
            return ValidationResult::Warn {
                message: "Command contains directory traversal pattern '../' — verify the target path resolves within the workspace".to_string(),
            };
        }
    }

    // Check for home directory references that could escape workspace.
    if command.contains("~/") || command.contains("$HOME") {
        return ValidationResult::Warn {
            message:
                "Command references home directory — verify it stays within the workspace scope"
                    .to_string(),
        };
    }

    ValidationResult::Allow
}

// ---------------------------------------------------------------------------
// commandSemantics
// ---------------------------------------------------------------------------

/// Commands that are read-only (no filesystem or state modification).
const SEMANTIC_READ_ONLY_COMMANDS: &[&str] = &[
    "ls",
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "wc",
    "sort",
    "uniq",
    "grep",
    "egrep",
    "fgrep",
    "find",
    "which",
    "whereis",
    "whatis",
    "man",
    "info",
    "file",
    "stat",
    "du",
    "df",
    "free",
    "uptime",
    "uname",
    "hostname",
    "whoami",
    "id",
    "groups",
    "env",
    "printenv",
    "echo",
    "printf",
    "date",
    "cal",
    "bc",
    "expr",
    "test",
    "true",
    "false",
    "pwd",
    "tree",
    "diff",
    "cmp",
    "md5sum",
    "sha256sum",
    "sha1sum",
    "xxd",
    "od",
    "hexdump",
    "strings",
    "readlink",
    "realpath",
    "basename",
    "dirname",
    "seq",
    "yes",
    "tput",
    "column",
    "jq",
    "yq",
    "xargs",
    "tr",
    "cut",
    "paste",
    "awk",
    "sed",
];

/// Commands that perform network operations.
const NETWORK_COMMANDS: &[&str] = &[
    "curl",
    "wget",
    "ssh",
    "scp",
    "rsync",
    "ftp",
    "sftp",
    "nc",
    "ncat",
    "telnet",
    "ping",
    "traceroute",
    "dig",
    "nslookup",
    "host",
    "whois",
    "ifconfig",
    "ip",
    "netstat",
    "ss",
    "nmap",
];

/// Commands that manage processes.
const PROCESS_COMMANDS: &[&str] = &[
    "kill", "pkill", "killall", "ps", "top", "htop", "bg", "fg", "jobs", "nohup", "disown", "wait",
    "nice", "renice",
];

/// Commands that manage packages.
const PACKAGE_COMMANDS: &[&str] = &[
    "apt", "apt-get", "yum", "dnf", "pacman", "brew", "pip", "pip3", "npm", "yarn", "pnpm", "bun",
    "cargo", "gem", "go", "rustup", "snap", "flatpak",
];

/// Commands that require system administrator privileges.
const SYSTEM_ADMIN_COMMANDS: &[&str] = &[
    "sudo",
    "su",
    "chroot",
    "mount",
    "umount",
    "fdisk",
    "parted",
    "lsblk",
    "blkid",
    "systemctl",
    "service",
    "journalctl",
    "dmesg",
    "modprobe",
    "insmod",
    "rmmod",
    "iptables",
    "ufw",
    "firewall-cmd",
    "sysctl",
    "crontab",
    "at",
    "useradd",
    "userdel",
    "usermod",
    "groupadd",
    "groupdel",
    "passwd",
    "visudo",
];

/// Classify the semantic intent of a bash command.
///
/// Corresponds to upstream `tools/BashTool/commandSemantics.ts`.
#[must_use]
fn classify_command(command: &str) -> CommandIntent {
    let first = extract_first_command(command);
    classify_by_first_command(&first, command)
}

fn classify_by_first_command(first: &str, command: &str) -> CommandIntent {
    if SEMANTIC_READ_ONLY_COMMANDS.contains(&first) {
        if first == "sed" && command.contains(" -i") {
            return CommandIntent::Write;
        }
        return CommandIntent::ReadOnly;
    }

    if ALWAYS_DESTRUCTIVE_COMMANDS.contains(&first) || first == "rm" {
        return CommandIntent::Destructive;
    }

    if WRITE_COMMANDS.contains(&first) {
        return CommandIntent::Write;
    }

    if NETWORK_COMMANDS.contains(&first) {
        return CommandIntent::Network;
    }

    if PROCESS_COMMANDS.contains(&first) {
        return CommandIntent::ProcessManagement;
    }

    if PACKAGE_COMMANDS.contains(&first) {
        return CommandIntent::PackageManagement;
    }

    if SYSTEM_ADMIN_COMMANDS.contains(&first) {
        return CommandIntent::SystemAdmin;
    }

    if first == "git" {
        return classify_git_command(command);
    }

    CommandIntent::Unknown
}

fn classify_git_command(command: &str) -> CommandIntent {
    let parts: Vec<&str> = command.split_whitespace().collect();
    let subcommand = parts.iter().skip(1).find(|p| !p.starts_with('-'));
    match subcommand {
        Some(&sub) if GIT_READ_ONLY_SUBCOMMANDS.contains(&sub) => CommandIntent::ReadOnly,
        _ => CommandIntent::Write,
    }
}

// ---------------------------------------------------------------------------
// Pipeline: run all validations
// ---------------------------------------------------------------------------

/// Run the full validation pipeline on a bash command.
///
/// Returns the first non-Allow result, or Allow if all validations pass.
///
/// Originally `validate_command` in claw-code; renamed so that the new public
/// `validate_command` (which has a workspace-free signature) can take its
/// name. Still exercised by the in-module test suite.
#[must_use]
fn run_pipeline(command: &str, mode: ExecutionMode, workspace: &Path) -> ValidationResult {
    // 1. Mode-level validation (includes read-only checks).
    let result = validate_mode(command, mode);
    if result != ValidationResult::Allow {
        return result;
    }

    // 2. Sed-specific validation.
    let result = validate_sed(command, mode);
    if result != ValidationResult::Allow {
        return result;
    }

    // 3. Destructive command warnings.
    let result = check_destructive(command);
    if result != ValidationResult::Allow {
        return result;
    }

    // 4. Path validation.
    validate_paths(command, workspace)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract the first bare command from a pipeline/chain, stripping env vars and sudo.
fn extract_first_command(command: &str) -> String {
    let trimmed = command.trim();

    // Skip leading environment variable assignments (KEY=val cmd ...).
    let mut remaining = trimmed;
    loop {
        let next = remaining.trim_start();
        if let Some(eq_pos) = next.find('=') {
            let before_eq = &next[..eq_pos];
            // Valid env var name: alphanumeric + underscore, no spaces.
            if !before_eq.is_empty()
                && before_eq
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                // Skip past the value (might be quoted).
                let after_eq = &next[eq_pos + 1..];
                if let Some(space) = find_end_of_value(after_eq) {
                    remaining = &after_eq[space..];
                    continue;
                }
                // No space found means value goes to end of string — no actual command.
                return String::new();
            }
        }
        break;
    }

    remaining
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

/// Extract the command following "sudo" (skip sudo flags).
fn extract_sudo_inner(command: &str) -> &str {
    let parts: Vec<&str> = command.split_whitespace().collect();
    let sudo_idx = parts.iter().position(|&p| p == "sudo");
    match sudo_idx {
        Some(idx) => {
            // Skip flags after sudo.
            let rest = &parts[idx + 1..];
            for &part in rest {
                if !part.starts_with('-') {
                    // Found the inner command — return from here to end.
                    let offset = command.find(part).unwrap_or(0);
                    return &command[offset..];
                }
            }
            ""
        }
        None => "",
    }
}

/// Find the end of a value in `KEY=value rest` (handles basic quoting).
fn find_end_of_value(s: &str) -> Option<usize> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }

    let first = s.as_bytes()[0];
    if first == b'"' || first == b'\'' {
        let quote = first;
        let mut i = 1;
        while i < s.len() {
            if s.as_bytes()[i] == quote && (i == 0 || s.as_bytes()[i - 1] != b'\\') {
                // Skip past quote.
                i += 1;
                // Find next whitespace.
                while i < s.len() && !s.as_bytes()[i].is_ascii_whitespace() {
                    i += 1;
                }
                return if i < s.len() { Some(i) } else { None };
            }
            i += 1;
        }
        None
    } else {
        s.find(char::is_whitespace)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // --- readOnlyValidation ---

    #[test]
    fn blocks_rm_in_read_only() {
        assert!(matches!(
            validate_read_only("rm -rf /tmp/x", ExecutionMode::ReadOnly),
            ValidationResult::Block { reason } if reason.contains("rm")
        ));
    }

    #[test]
    fn allows_rm_in_workspace_write() {
        assert_eq!(
            validate_read_only("rm -rf /tmp/x", ExecutionMode::WorkspaceWrite),
            ValidationResult::Allow
        );
    }

    #[test]
    fn blocks_write_redirections_in_read_only() {
        assert!(matches!(
            validate_read_only("echo hello > file.txt", ExecutionMode::ReadOnly),
            ValidationResult::Block { reason } if reason.contains("redirection")
        ));
    }

    #[test]
    fn allows_read_commands_in_read_only() {
        assert_eq!(
            validate_read_only("ls -la", ExecutionMode::ReadOnly),
            ValidationResult::Allow
        );
        assert_eq!(
            validate_read_only("cat /etc/hosts", ExecutionMode::ReadOnly),
            ValidationResult::Allow
        );
        assert_eq!(
            validate_read_only("grep -r pattern .", ExecutionMode::ReadOnly),
            ValidationResult::Allow
        );
    }

    #[test]
    fn blocks_sudo_write_in_read_only() {
        assert!(matches!(
            validate_read_only("sudo rm -rf /tmp/x", ExecutionMode::ReadOnly),
            ValidationResult::Block { reason } if reason.contains("rm")
        ));
    }

    #[test]
    fn blocks_git_push_in_read_only() {
        assert!(matches!(
            validate_read_only("git push origin main", ExecutionMode::ReadOnly),
            ValidationResult::Block { reason } if reason.contains("push")
        ));
    }

    #[test]
    fn allows_git_status_in_read_only() {
        assert_eq!(
            validate_read_only("git status", ExecutionMode::ReadOnly),
            ValidationResult::Allow
        );
    }

    #[test]
    fn blocks_package_install_in_read_only() {
        assert!(matches!(
            validate_read_only("npm install express", ExecutionMode::ReadOnly),
            ValidationResult::Block { reason } if reason.contains("npm")
        ));
    }

    // --- destructiveCommandWarning ---

    #[test]
    fn warns_rm_rf_root() {
        assert!(matches!(
            check_destructive("rm -rf /"),
            ValidationResult::Warn { message } if message.contains("root")
        ));
    }

    #[test]
    fn warns_rm_rf_home() {
        assert!(matches!(
            check_destructive("rm -rf ~"),
            ValidationResult::Warn { message } if message.contains("home")
        ));
    }

    #[test]
    fn warns_shred() {
        assert!(matches!(
            check_destructive("shred /dev/sda"),
            ValidationResult::Warn { message } if message.contains("destructive")
        ));
    }

    #[test]
    fn warns_fork_bomb() {
        assert!(matches!(
            check_destructive(":(){ :|:& };:"),
            ValidationResult::Warn { message } if message.contains("Fork bomb")
        ));
    }

    #[test]
    fn allows_safe_commands() {
        assert_eq!(check_destructive("ls -la"), ValidationResult::Allow);
        assert_eq!(check_destructive("echo hello"), ValidationResult::Allow);
    }

    // --- modeValidation ---

    #[test]
    fn workspace_write_warns_system_paths() {
        assert!(matches!(
            validate_mode("cp file.txt /etc/config", ExecutionMode::WorkspaceWrite),
            ValidationResult::Warn { message } if message.contains("outside the workspace")
        ));
    }

    #[test]
    fn workspace_write_allows_local_writes() {
        assert_eq!(
            validate_mode("cp file.txt ./backup/", ExecutionMode::WorkspaceWrite),
            ValidationResult::Allow
        );
    }

    // --- sedValidation ---

    #[test]
    fn blocks_sed_inplace_in_read_only() {
        assert!(matches!(
            validate_sed("sed -i 's/old/new/' file.txt", ExecutionMode::ReadOnly),
            ValidationResult::Block { reason } if reason.contains("sed -i")
        ));
    }

    #[test]
    fn allows_sed_stdout_in_read_only() {
        assert_eq!(
            validate_sed("sed 's/old/new/' file.txt", ExecutionMode::ReadOnly),
            ValidationResult::Allow
        );
    }

    // --- pathValidation ---

    #[test]
    fn warns_directory_traversal() {
        let workspace = PathBuf::from("/workspace/project");
        assert!(matches!(
            validate_paths("cat ../../../etc/passwd", &workspace),
            ValidationResult::Warn { message } if message.contains("traversal")
        ));
    }

    #[test]
    fn warns_home_directory_reference() {
        let workspace = PathBuf::from("/workspace/project");
        assert!(matches!(
            validate_paths("cat ~/.ssh/id_rsa", &workspace),
            ValidationResult::Warn { message } if message.contains("home directory")
        ));
    }

    // --- commandSemantics ---

    #[test]
    fn classifies_read_only_commands() {
        assert_eq!(classify_command("ls -la"), CommandIntent::ReadOnly);
        assert_eq!(classify_command("cat file.txt"), CommandIntent::ReadOnly);
        assert_eq!(
            classify_command("grep -r pattern ."),
            CommandIntent::ReadOnly
        );
        assert_eq!(
            classify_command("find . -name '*.rs'"),
            CommandIntent::ReadOnly
        );
    }

    #[test]
    fn classifies_write_commands() {
        assert_eq!(classify_command("cp a.txt b.txt"), CommandIntent::Write);
        assert_eq!(classify_command("mv old.txt new.txt"), CommandIntent::Write);
        assert_eq!(classify_command("mkdir -p /tmp/dir"), CommandIntent::Write);
    }

    #[test]
    fn classifies_destructive_commands() {
        assert_eq!(
            classify_command("rm -rf /tmp/x"),
            CommandIntent::Destructive
        );
        assert_eq!(
            classify_command("shred /dev/sda"),
            CommandIntent::Destructive
        );
    }

    #[test]
    fn classifies_network_commands() {
        assert_eq!(
            classify_command("curl https://example.com"),
            CommandIntent::Network
        );
        assert_eq!(classify_command("wget file.zip"), CommandIntent::Network);
    }

    #[test]
    fn classifies_sed_inplace_as_write() {
        assert_eq!(
            classify_command("sed -i 's/old/new/' file.txt"),
            CommandIntent::Write
        );
    }

    #[test]
    fn classifies_sed_stdout_as_read_only() {
        assert_eq!(
            classify_command("sed 's/old/new/' file.txt"),
            CommandIntent::ReadOnly
        );
    }

    #[test]
    fn classifies_git_status_as_read_only() {
        assert_eq!(classify_command("git status"), CommandIntent::ReadOnly);
        assert_eq!(
            classify_command("git log --oneline"),
            CommandIntent::ReadOnly
        );
    }

    #[test]
    fn classifies_git_push_as_write() {
        assert_eq!(
            classify_command("git push origin main"),
            CommandIntent::Write
        );
    }

    // --- run_pipeline (full pipeline; was upstream `validate_command`) ---

    #[test]
    fn pipeline_blocks_write_in_read_only() {
        let workspace = PathBuf::from("/workspace");
        assert!(matches!(
            run_pipeline("rm -rf /tmp/x", ExecutionMode::ReadOnly, &workspace),
            ValidationResult::Block { .. }
        ));
    }

    #[test]
    fn pipeline_warns_destructive_in_write_mode() {
        let workspace = PathBuf::from("/workspace");
        assert!(matches!(
            run_pipeline("rm -rf /", ExecutionMode::WorkspaceWrite, &workspace),
            ValidationResult::Warn { .. }
        ));
    }

    #[test]
    fn pipeline_allows_safe_read_in_read_only() {
        let workspace = PathBuf::from("/workspace");
        assert_eq!(
            run_pipeline("ls -la", ExecutionMode::ReadOnly, &workspace),
            ValidationResult::Allow
        );
    }

    // --- extract_first_command ---

    #[test]
    fn extracts_command_from_env_prefix() {
        assert_eq!(extract_first_command("FOO=bar ls -la"), "ls");
        assert_eq!(extract_first_command("A=1 B=2 echo hello"), "echo");
    }

    #[test]
    fn extracts_plain_command() {
        assert_eq!(extract_first_command("grep -r pattern ."), "grep");
    }

    // --- public validate_command (workspace-free, returns Result) ---

    #[test]
    fn public_blocks_rm_in_read_only() {
        assert!(matches!(
            validate_command("rm -rf /tmp/x", ExecutionMode::ReadOnly),
            Err(BashValidationError::Blocked(ref reason)) if reason.contains("rm")
        ));
    }

    #[test]
    fn public_warns_destructive_in_workspace_write() {
        assert!(matches!(
            validate_command("rm -rf /", ExecutionMode::WorkspaceWrite),
            Err(BashValidationError::Warning(ref message)) if message.contains("root")
        ));
    }

    #[test]
    fn public_allows_safe_read_in_read_only() {
        assert_eq!(
            validate_command("ls -la", ExecutionMode::ReadOnly),
            Ok(())
        );
    }

    #[test]
    fn public_blocks_sed_inplace_in_read_only() {
        assert!(matches!(
            validate_command("sed -i 's/old/new/' file.txt", ExecutionMode::ReadOnly),
            Err(BashValidationError::Blocked(ref reason)) if reason.contains("sed -i")
        ));
    }

    #[test]
    fn workspace_write_warns_on_catastrophic_patterns() {
        // Stage 3 (destructive patterns) still flags `rm -rf /` even
        // when the mode would otherwise let writes through. The
        // permitter handles bypass policy; the validator's job is to
        // surface obvious foot-guns.
        assert!(matches!(
            validate_command("rm -rf /", ExecutionMode::WorkspaceWrite),
            Err(BashValidationError::Warning(_))
        ));
        assert_eq!(
            validate_command("ls -la", ExecutionMode::WorkspaceWrite),
            Ok(())
        );
    }

    // --- public validate_command_with_workspace + classify_intent ---

    #[test]
    fn workspace_validator_warns_on_traversal() {
        let workspace = PathBuf::from("/workspace/project");
        let err = validate_command_with_workspace(
            "cat ../../../etc/passwd",
            ExecutionMode::WorkspaceWrite,
            &workspace,
        )
        .expect_err("traversal must be flagged");
        assert!(matches!(err, BashValidationError::Warning(ref m) if m.contains("traversal")));
    }

    #[test]
    fn workspace_validator_allows_local_reads() {
        let workspace = PathBuf::from("/workspace/project");
        assert_eq!(
            validate_command_with_workspace(
                "cat src/main.rs",
                ExecutionMode::WorkspaceWrite,
                &workspace,
            ),
            Ok(())
        );
    }

    #[test]
    fn workspace_validator_blocks_writes_in_read_only() {
        let workspace = PathBuf::from("/workspace/project");
        let err = validate_command_with_workspace(
            "rm -rf foo",
            ExecutionMode::ReadOnly,
            &workspace,
        )
        .expect_err("read-only must block rm");
        assert!(matches!(err, BashValidationError::Blocked(_)));
    }

    #[test]
    fn classify_intent_recognises_main_categories() {
        assert_eq!(classify_intent("ls -la"), CommandIntent::ReadOnly);
        assert_eq!(classify_intent("cp a b"), CommandIntent::Write);
        assert_eq!(classify_intent("rm -rf foo"), CommandIntent::Destructive);
        assert_eq!(
            classify_intent("curl https://example.com"),
            CommandIntent::Network
        );
        assert_eq!(classify_intent("kill -9 1234"), CommandIntent::ProcessManagement);
        assert_eq!(
            classify_intent("npm install react"),
            CommandIntent::PackageManagement
        );
        assert_eq!(classify_intent("sudo whoami"), CommandIntent::SystemAdmin);
        assert_eq!(classify_intent("zorbify --foo"), CommandIntent::Unknown);
    }

    #[test]
    fn command_intent_as_str_covers_all_variants() {
        assert_eq!(CommandIntent::ReadOnly.as_str(), "read_only");
        assert_eq!(CommandIntent::Write.as_str(), "write");
        assert_eq!(CommandIntent::Destructive.as_str(), "destructive");
        assert_eq!(CommandIntent::Network.as_str(), "network");
        assert_eq!(CommandIntent::ProcessManagement.as_str(), "process_management");
        assert_eq!(CommandIntent::PackageManagement.as_str(), "package_management");
        assert_eq!(CommandIntent::SystemAdmin.as_str(), "system_admin");
        assert_eq!(CommandIntent::Unknown.as_str(), "unknown");
    }
}
