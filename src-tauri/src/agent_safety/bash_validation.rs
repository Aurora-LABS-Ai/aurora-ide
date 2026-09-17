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
///
/// Substring matching, which is safe for every entry left here: each one is a
/// distinctive command word or operator that cannot be assembled by accident
/// out of neighbouring arguments.
///
/// The `rm -rf <target>` cases are deliberately NOT here. They were, and
/// matching them as substrings mislabelled ordinary deletions: `rm -rf
/// ./__pycache__` contains the literal text `rm -rf .`, so it was reported as
/// "Recursive forced deletion of current directory" — a claim about the user's
/// whole project that was simply false. `rm -rf .venv`, `rm -rf .git` and
/// `rm -rf *.pyc` all read the same way. See [`catastrophic_rm_target`], which
/// inspects the actual operands instead.
const DESTRUCTIVE_PATTERNS: &[(&str, &str)] = &[
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

    // `rm -rf` aimed at something irreplaceable, judged by the OPERANDS rather
    // than by the text around them. A target only counts when the whole word
    // is the dangerous thing: `.` is the project, `./build` is a build folder,
    // and calling the second one the first is how a true warning gets ignored.
    let recursive_deletions = recursive_forced_rm_targets(command);
    for targets in &recursive_deletions {
        for target in targets {
            if let Some(warning) = catastrophic_rm_target(target) {
                return ValidationResult::Warn {
                    message: format!("Destructive command detected: {warning}"),
                };
            }
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

    // Check for an actual `rm` invocation with recursive and force flags. Matching
    // shell words prevents unrelated argument substrings from combining into a
    // phantom command (for example, `lucide-react react-hook-form`).
    // Any remaining recursive delete is a warning, UNLESS every one of its
    // targets is a directory the ecosystem rebuilds on demand. Clearing
    // `node_modules` or `__pycache__` is maintenance, not a hazard, and a
    // guard that treats it as one is a guard people learn to talk around.
    if !recursive_deletions.is_empty()
        && !recursive_deletions
            .iter()
            .all(|targets| deletes_only_regenerable_artifacts(targets))
    {
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

/// The `/dev/` entries that are shell plumbing rather than a place on disk.
///
/// `2>/dev/null` is the most-typed idiom in shell, and it is not a target — it
/// is where output goes to be discarded. Matching `/dev/` as a bare substring
/// made every write command carrying one look like a write to a system device.
/// Measured on thread `c4669acf` (2026-09-05):
///
/// ```text
/// rm -f /e/VOID-EDITOR/sub2api/backend/.local-data/config.yaml 2>/dev/null; ls …
///   -> policy violation: Command appears to target files outside the workspace
/// ```
///
/// The path being deleted was inside the workspace root, `file_write` and
/// `file_edit` had been writing to that same directory all session, and the
/// refusal named a permission problem that did not exist — so it sent the user
/// to check a setting instead of showing the real (absent) fault. A real
/// device write (`> /dev/sda`) is still worth a warning, which is why `/dev/`
/// stays on the list and only the pseudo-files below are exempt.
const DEV_PSEUDO_FILES: &[&str] = &[
    "null", "zero", "full", "random", "urandom", "stdin", "stdout", "stderr", "tty",
    // `/dev/fd/3`, `/dev/tcp/host/port`, `/dev/udp/…` — bash's own constructs,
    // matched by prefix because each carries a path after it.
    "fd/", "tcp/", "udp/",
];

/// Does every `/dev/` in this command name shell plumbing rather than a device?
fn only_dev_pseudo_files(command: &str) -> bool {
    command.match_indices("/dev/").all(|(at, _)| {
        let rest = &command[at + "/dev/".len()..];
        DEV_PSEUDO_FILES.iter().any(|name| {
            rest.strip_prefix(name).is_some_and(|after| {
                // `/dev/null` and `/dev/nullify-everything` are different
                // words. A prefix entry (`fd/`) has already consumed its
                // separator, so anything may follow it.
                name.ends_with('/')
                    || after
                        .chars()
                        .next()
                        .is_none_or(|c| !c.is_alphanumeric() && c != '_' && c != '-' && c != '.')
            })
        })
    })
}

/// System locations a write should not silently touch.
///
/// **Windows entries earn their place the hard way.** This list was POSIX-only,
/// which on Aurora's primary platform meant the guard could not see the system
/// directory that actually matters. Measured by the harness rig on 2026-09-06:
///
/// ```text
/// rm -f 'C:/Windows/aurora-probe-nonexistent-zz9.txt'   -> ran, no guard
/// ```
///
/// `shell_validation.rs` does carry Windows markers, but they are written with
/// backslashes and only apply to the PowerShell/cmd path. A POSIX shell on
/// Windows writes forward slashes, so that command fell between both
/// validators. All three spellings are covered here: the drive form
/// (`c:/windows`), the backslash form normalized to it, and Git Bash's mount
/// form (`/c/windows`).
const SYSTEM_PATHS: &[&str] = &[
    "/etc/", "/usr/", "/var/", "/boot/", "/sys/", "/proc/", "/dev/", "/sbin/", "/lib/", "/opt/",
    "c:/windows", "c:/program files", "c:/programdata",
    "/c/windows", "/c/program files", "/c/programdata",
];

/// Lower-case, forward-slashed copy for path matching only.
///
/// Never used to run anything — a scan may flatten `\` freely, where an
/// executor may not. Windows paths are case-insensitive and arrive in every
/// casing a person can type.
fn normalize_for_path_scan(command: &str) -> String {
    command.replace('\\', "/").to_lowercase()
}

/// Every path this command redirects output INTO.
///
/// A redirect is a write, and the guard could not see one: it matched the
/// leading command name against [`WRITE_COMMANDS`], so `echo pwned > /etc/x`
/// was judged by `echo` and waved through. Measured by the harness rig on
/// 2026-09-06. Handles `>`, `>>`, `2>`, `&>` and `1>`, with or without a space,
/// and strips one layer of quoting.
fn redirect_targets(scan: &str) -> Vec<String> {
    let bytes: Vec<char> = scan.chars().collect();
    let mut targets = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != '>' {
            i += 1;
            continue;
        }
        // Skip the operator itself, a doubled `>>`, then any whitespace.
        i += 1;
        if i < bytes.len() && bytes[i] == '>' {
            i += 1;
        }
        while i < bytes.len() && bytes[i].is_whitespace() {
            i += 1;
        }
        // `>&2` and `>&1` duplicate a descriptor; they name no file.
        if i < bytes.len() && bytes[i] == '&' {
            continue;
        }
        let quote = bytes.get(i).copied().filter(|c| *c == '\'' || *c == '"');
        if quote.is_some() {
            i += 1;
        }
        let mut target = String::new();
        while i < bytes.len() {
            let c = bytes[i];
            let done = match quote {
                Some(q) => c == q,
                None => c.is_whitespace() || matches!(c, ';' | '&' | '|' | ')'),
            };
            if done {
                break;
            }
            target.push(c);
            i += 1;
        }
        if !target.is_empty() {
            targets.push(target);
        }
    }
    targets
}

/// Is this one path inside a system location, ignoring `/dev/` plumbing?
///
/// `starts_with`, never `contains`: a redirect target is a whole path, and
/// `src/etc/config.json` is a workspace file that merely spells a system
/// directory somewhere in the middle.
fn is_guarded_system_path(path: &str) -> bool {
    SYSTEM_PATHS.iter().any(|sys| {
        path.starts_with(sys)
            // `> /dev/null` is where output goes to be discarded, not a device.
            && !(*sys == "/dev/" && only_dev_pseudo_files(path))
    })
}

/// Does `scan` name this system location as a path, rather than spell it inside
/// a longer one?
///
/// The whole-command sweep matched a bare substring, so `rm -rf src/etc/build`
/// read as a write to `/etc`. A system path counts only at a boundary — start
/// of string, whitespace, a quote, or `=` — and never when another path
/// segment runs into it.
fn mentions_system_path(scan: &str, sys: &str) -> bool {
    scan.match_indices(sys).any(|(at, _)| match scan[..at].chars().next_back() {
        None => true,
        Some(prev) => !(prev.is_alphanumeric() || matches!(prev, '.' | '_' | '-' | '/')),
    })
}

/// Heuristic: does the command reference absolute paths outside typical workspace dirs?
fn command_targets_outside_workspace(command: &str) -> bool {
    let scan = normalize_for_path_scan(command);

    // A redirect writes wherever it points, whatever the leading command is.
    // Checked BEFORE the write-command test on purpose: `echo`, `printf`, `cat`
    // and `tee`-less pipelines are not write commands and can all clobber a
    // file through `>`.
    if redirect_targets(&scan)
        .iter()
        .any(|target| is_guarded_system_path(target))
    {
        return true;
    }

    let first = extract_first_command(command);
    let is_write_cmd = WRITE_COMMANDS.contains(&first.as_str())
        || STATE_MODIFYING_COMMANDS.contains(&first.as_str());

    if !is_write_cmd {
        return false;
    }

    for sys_path in SYSTEM_PATHS {
        if !mentions_system_path(&scan, sys_path) {
            continue;
        }
        // `/dev/` earns a second look: a redirect to a pseudo-file is not a
        // target at all. See `DEV_PSEUDO_FILES`.
        if *sys_path == "/dev/" && only_dev_pseudo_files(&scan) {
            continue;
        }
        return true;
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

/// One shell word, stripped of quoting, redirects and chain punctuation.
///
/// Not a shell parser — it only has to be good enough to find the words that
/// could be paths, which is what [`validate_paths`] resolves.
///
/// Shared with [`super::shell_validation`], which had its own substring test
/// for `../` and refused traversal that resolved back inside the workspace —
/// the bug this pair already fixed on the POSIX side.
pub(super) fn path_like_words(command: &str) -> impl Iterator<Item = &str> {
    command
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '|' | '&' | '(' | ')'))
        .map(|word| word.trim_matches(|c: char| matches!(c, '"' | '\'' | '`')))
        .map(|word| word.trim_start_matches(['>', '<', '1', '2', '&']))
        .filter(|word| !word.is_empty())
}

/// Walk a relative path's components, answering how far ABOVE its starting
/// directory it ends up, or `None` if it never climbs out.
///
/// Purely lexical, which is the point: the command has not run, nothing may be
/// touched to answer the question, and a symlink is not this guard's problem.
fn climbs_above_start(relative: &str) -> bool {
    let mut depth: i32 = 0;
    for component in relative.split(['/', '\\']) {
        match component {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            _ => depth += 1,
        }
    }
    false
}

/// Does this word climb out of the workspace?
///
/// Only words that actually contain a `..` component are asked. An ABSOLUTE
/// word is not this check's business — [`command_targets_outside_workspace`]
/// and the system-path list own those — so it is left alone here.
pub(super) fn escapes_workspace(word: &str, workspace: &Path) -> bool {
    let normalized = word.replace('\\', "/");
    if !normalized.split('/').any(|component| component == "..") {
        return false;
    }
    if normalized.starts_with('/') || normalized.chars().nth(1) == Some(':') {
        let joined = workspace.join(word);
        return !joined.starts_with(workspace);
    }
    climbs_above_start(&normalized)
}

/// Validate that command paths don't climb out of the workspace.
///
/// Corresponds to upstream `tools/BashTool/pathValidation.ts`.
///
/// ## Why this resolves instead of matching a substring
///
/// It used to warn on ANY `../` in the command unless the command text
/// literally spelled the workspace root out, which made every relative `../`
/// a refusal — including the ones that stay inside. A warning is refused like
/// a block (see `shell_execute::map_bash_error`), so the command never ran.
/// Measured on thread `810f1387` (2026-09-16):
///
/// ```text
/// ls ../gadget-and-power-admin-manager/… 2>/dev/null || ls gadget-and-power-admin-manager/…
///   -> policy violation: warning: Command contains directory traversal pattern '../'
/// ```
///
/// The command carried its own fallback, the second half was correct, and the
/// whole thing was refused over the first half. The advice it got back —
/// "verify the target path resolves within the workspace" — was unactionable,
/// because nothing had run and the message named no path to verify.
///
/// Same shape of fix as [`DEV_PSEUDO_FILES`], for the same reason: a substring
/// that looks like a hazard is not a hazard, and a guard that cannot tell the
/// difference is one people learn to talk around. `src/../src/a.ts` resolves
/// inside the workspace and is allowed. `../../etc/passwd` does not and is
/// still refused — now naming where it actually lands.
#[must_use]
fn validate_paths(command: &str, workspace: &Path) -> ValidationResult {
    if let Some(escaping) = path_like_words(command).find(|word| escapes_workspace(word, workspace))
    {
        return ValidationResult::Warn {
            message: format!(
                "`{escaping}` resolves outside the workspace ({}). Re-issue the command against a \
                 path inside it — paths are relative to the workspace root, so a sibling directory \
                 of the root is not reachable.",
                workspace.display()
            ),
        };
    }

    // Check for home directory references that could escape workspace.
    if references_home_directory(command) {
        return ValidationResult::Warn {
            message:
                "Command references home directory — verify it stays within the workspace scope"
                    .to_string(),
        };
    }

    ValidationResult::Allow
}

/// Does this command name the home directory as a PLACE?
///
/// `~` only means home at the start of a shell word. Anywhere else it is
/// ordinary text, and in one language it is an operator: awk matches with
/// `~`, so `$0 ~ /D/` written without spaces is `s~/D/`, which contains the
/// substring `~/` and nothing to do with anyone's home directory.
///
/// A bare `contains("~/")` could not tell those apart, and refused this —
/// twice, in thread `46b93977` (2026-08-20), a git status summary that touches
/// no path at all:
///
/// ```text
/// git status --porcelain=v1 -uall | awk '… {s=substr($0,1,2); … else if(s~/D/)d++; …}'
///   -> policy violation: warning: Command references home directory
/// ```
///
/// `$HOME` and `$USERPROFILE` need no such care: the `$` already anchors them
/// to a variable reference, and there is no other thing they can be.
fn references_home_directory(command: &str) -> bool {
    if command.contains("$HOME") || command.contains("${HOME}") || command.contains("$USERPROFILE")
    {
        return true;
    }
    command.match_indices("~/").any(|(at, _)| {
        // Start of the command, or preceded by something that ends a word:
        // whitespace, a quote, or an operator that introduces a value.
        command[..at].chars().next_back().is_none_or(|previous| {
            previous.is_whitespace() || matches!(previous, '"' | '\'' | '=' | ':' | '(')
        })
    })
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

/// Classify one operand of an `rm -rf`.
///
/// Whole-word matches only. `.` is the project; `./__pycache__` is a cache
/// folder inside it. Reporting the second as the first is what teaches a
/// reader — human or model — to route around the warning instead of reading
/// it, which costs the warning its value on the day it is right.
///
/// Anything not listed falls through to the generic "verify the target path"
/// warning, which is honest about knowing only that a recursive delete is
/// happening.
fn catastrophic_rm_target(target: &str) -> Option<&'static str> {
    match target {
        "/" => Some("Recursive forced deletion at root — this will destroy the system"),
        "~" | "~/" | "$HOME" | "${HOME}" => Some("Recursive forced deletion of home directory"),
        "*" => Some("Recursive forced deletion of all files in current directory"),
        "." | "./" => Some("Recursive forced deletion of current directory"),
        ".." | "../" => Some("Recursive forced deletion of the parent directory"),
        _ => None,
    }
}

/// Directories and caches that every ecosystem regenerates from a manifest.
///
/// Deleting one of these costs a command, never work. `rm -rf node_modules`
/// and `rm -rf __pycache__` are routine maintenance, and refusing them made
/// Aurora look nervous rather than careful — the agent burned three attempts
/// working around a block on a Python cache folder before giving up and
/// deleting files one at a time.
///
/// Names generic enough to plausibly hold hand-written source are deliberately
/// ABSENT, even where a build system also uses them: `bin` routinely holds
/// committed scripts, and `out`, `lib`, `env`, `tmp` and `logs` are anybody's
/// guess. Those keep the ordinary warning. So does `.git`, which is not
/// regenerable at all.
const REGENERABLE_ARTIFACT_DIRS: &[&str] = &[
    // JavaScript / TypeScript
    "node_modules",
    "dist",
    ".next",
    ".nuxt",
    ".output",
    ".svelte-kit",
    ".astro",
    ".docusaurus",
    ".turbo",
    ".parcel-cache",
    ".rollup.cache",
    ".vite",
    ".swc",
    ".angular",
    ".pnpm-store",
    ".nyc_output",
    // Python
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".nox",
    ".venv",
    "venv",
    ".eggs",
    ".ipynb_checkpoints",
    "htmlcov",
    // Rust, Maven, sbt
    "target",
    // JVM
    ".gradle",
    // .NET — `obj` only. `bin` is excluded above for good reason.
    "obj",
    // Go, PHP, Ruby: restored by `go mod vendor`, `composer install`,
    // `bundle install`.
    "vendor",
    ".bundle",
    // Elixir. `deps` is NOT here: C and vendored-source projects use the same
    // name for code they wrote, and only Elixir's is restored by a manifest.
    "_build",
    // Swift / Xcode
    "DerivedData",
    // C / C++
    "CMakeFiles",
    // Dart / Flutter
    ".dart_tool",
    // Shared output and caches. `build` is NOT here, deliberately: CMake,
    // Gradle and Flutter all write to it, and so do people — a `build/`
    // holding hand-written scripts is common enough that silently deleting one
    // is unrecoverable in a way the warning never is. `cmake-build-*` below
    // covers the CLion case, which IS tool-owned.
    "coverage",
    ".cache",
    ".sass-cache",
    ".eslintcache",
    ".stylelintcache",
    ".terraform",
    ".serverless",
];

/// Is this path segment a directory an ecosystem rebuilds on demand?
fn is_regenerable_segment(name: &str) -> bool {
    if REGENERABLE_ARTIFACT_DIRS.contains(&name) {
        return true;
    }
    // Two conventional patterns rather than a general glob: Python packaging
    // writes `<package>.egg-info`, and CLion/CMake write `cmake-build-<profile>`.
    name.ends_with(".egg-info") || name.starts_with("cmake-build-")
}

/// Whether one `rm -rf` operand names something an ecosystem can rebuild.
///
/// Judged on ANY path segment, so `./__pycache__`, `packages/*/node_modules`
/// and `src/.pytest_cache` all qualify while `src` alone does not.
///
/// The segment test used to look at the FINAL one only, which made the guard
/// inconsistent with itself: `rm -rf .next` was allowed and `rm -rf .next/types`
/// — a strictly smaller delete, inside the same regenerable directory — was
/// refused, because the last segment is `types`. Measured across three threads
/// in September 2026, every one of them clearing a stale Next.js type cache
/// before a typecheck. Anything living under a directory the toolchain rebuilds
/// is rebuilt with it.
///
/// Two restrictions keep the blast radius where the caller can see it:
/// an absolute path is declined, and so is any path stepping up through `..`.
/// Both still get the ordinary warning rather than a refusal, so nothing is
/// impossible — it just has to be looked at.
fn is_regenerable_artifact_path(target: &str) -> bool {
    let normalized = target.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        return false;
    }
    // Absolute, POSIX or Windows drive-qualified.
    if trimmed.starts_with('/') || trimmed.chars().nth(1) == Some(':') {
        return false;
    }
    if trimmed.split('/').any(|segment| segment == "..") {
        return false;
    }
    if trimmed
        .split('/')
        .any(|segment| is_regenerable_segment(segment))
    {
        return true;
    }

    let Some(name) = trimmed.rsplit('/').next() else {
        return false;
    };
    if REGENERABLE_ARTIFACT_DIRS.contains(&name) {
        return true;
    }
    // Two conventional patterns rather than a general glob: Python packaging
    // writes `<package>.egg-info`, and CLion/CMake write `cmake-build-<profile>`.
    name.ends_with(".egg-info") || name.starts_with("cmake-build-")
}

/// Whether one `rm -rf` invocation deletes nothing but regenerable artifacts.
///
/// An invocation with no operands is not one of these — `rm -rf` alone is a
/// half-written command, and the warning is the right answer to it.
fn deletes_only_regenerable_artifacts(targets: &[String]) -> bool {
    !targets.is_empty() && targets.iter().all(|t| is_regenerable_artifact_path(t))
}

/// Split a command line into segments, each a list of shell words.
///
/// A small shell lexer rather than a substring search, because arguments may
/// contain command text without being a command: `bun add lucide-react
/// react-hook-form` supplies `rm`, `-r` and `-f` between two package names and
/// used to be rejected as a recursive delete. Handles quoting and backslash
/// escapes, and starts a new segment at any operator that begins a new command.
fn shell_word_segments(command: &str) -> Vec<Vec<String>> {
    fn finish_word(word: &mut String, segment: &mut Vec<String>) {
        if !word.is_empty() {
            segment.push(std::mem::take(word));
        }
    }

    let mut segments = Vec::new();
    let mut segment = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;

    for character in command.chars() {
        if escaped {
            word.push(character);
            escaped = false;
            continue;
        }

        match quote {
            Some(active_quote) => {
                if character == active_quote {
                    quote = None;
                } else if character == '\\' && active_quote == '"' {
                    escaped = true;
                } else {
                    word.push(character);
                }
            }
            None => match character {
                '\\' => escaped = true,
                '\'' | '"' => quote = Some(character),
                ';' | '|' | '&' | '\n' | '\r' | '(' | ')' | '`' => {
                    finish_word(&mut word, &mut segment);
                    if !segment.is_empty() {
                        segments.push(std::mem::take(&mut segment));
                    }
                }
                character if character.is_whitespace() => {
                    finish_word(&mut word, &mut segment);
                }
                _ => word.push(character),
            },
        }
    }

    finish_word(&mut word, &mut segment);
    if !segment.is_empty() {
        segments.push(segment);
    }
    segments
}

/// Operands of every `rm` invocation carrying both a recursive and a force
/// flag, one entry per invocation.
///
/// An invocation with no operands still yields an (empty) entry, so callers can
/// tell "no recursive delete here" from "a recursive delete with nothing to
/// classify".
fn recursive_forced_rm_targets(command: &str) -> Vec<Vec<String>> {
    let mut found = Vec::new();

    for words in shell_word_segments(command) {
        for (rm_index, word) in words.iter().enumerate() {
            if word.rsplit('/').next() != Some("rm") {
                continue;
            }

            let mut recursive = false;
            let mut force = false;
            let mut targets = Vec::new();
            // Everything after `--` is an operand by definition, however much
            // it looks like a flag.
            let mut operands_only = false;

            for argument in &words[rm_index + 1..] {
                if !operands_only && argument == "--" {
                    operands_only = true;
                    continue;
                }

                if operands_only {
                    targets.push(argument.clone());
                    continue;
                }

                match argument.as_str() {
                    "--recursive" => recursive = true,
                    "--force" => force = true,
                    _ => match argument.strip_prefix('-') {
                        Some(flags) if !flags.is_empty() => {
                            recursive |= flags.contains('r') || flags.contains('R');
                            force |= flags.contains('f');
                        }
                        // A bare `-`, or anything not starting with one, is
                        // a path.
                        _ => targets.push(argument.clone()),
                    },
                }
            }

            if recursive && force {
                found.push(targets);
            }
        }
    }

    found
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

    /// Reported from a real session (thread `c4669acf`, 2026-09-05): deleting
    /// a file INSIDE the workspace was refused as targeting files outside it.
    /// The only thing outside the workspace in that command was `/dev/null`,
    /// which is not a place — it is where the error message went.
    ///
    /// Cost: a one-line cleanup blocked, then routed around, and a refusal
    /// that pointed at a permission the user did have. `file_write` and
    /// `file_edit` had been writing to that very directory all session.
    #[test]
    fn a_dev_null_redirect_is_plumbing_not_a_target() {
        for command in [
            // Verbatim from the session.
            "rm -f /e/VOID-EDITOR/sub2api/backend/.local-data/config.yaml 2>/dev/null; ls /e/VOID-EDITOR/sub2api/backend/.local-data 2>/dev/null || echo 'no .local-data yet'",
            "rm -f build/out.log 2>/dev/null",
            "cp a.txt b.txt >/dev/null 2>&1",
            "mv old new 2>/dev/null",
            "rm -f x && curl -s http://localhost:8080/health > /dev/null",
            // The other pseudo-files, and bash's own constructs.
            "rm -f x < /dev/zero",
            "rm -f x 2>/dev/stderr",
            "rm -f x && exec 3<>/dev/tcp/127.0.0.1/6379",
            "rm -f x > /dev/fd/3",
        ] {
            assert!(
                !command_targets_outside_workspace(command),
                "must not read as a system-path write: {command}"
            );
        }
    }

    /// Both from the harness rig, 2026-09-06, verbatim. Each ran unguarded.
    ///
    /// The guard was POSIX-only on a Windows-first product, and it judged a
    /// command by its leading NAME — so a redirect, which is a write whatever
    /// precedes it, was invisible.
    #[test]
    fn a_windows_system_path_is_guarded_in_every_spelling() {
        for command in [
            // Verbatim from the rig.
            "rm -f 'C:/Windows/aurora-probe-nonexistent-zz9.txt'; echo \"exit=$?\"",
            // The same place, the other two ways a shell on Windows writes it.
            r"rm -f C:\Windows\System32\drivers\etc\hosts",
            "rm -f /c/Windows/notepad.exe",
            // Casing is not a defence: Windows paths are case-insensitive.
            "rm -f 'c:/WINDOWS/x'",
            "cp payload 'C:/Program Files/app/app.exe'",
            "rm -rf C:/ProgramData/state",
        ] {
            assert!(
                command_targets_outside_workspace(command),
                "must be guarded: {command}"
            );
        }
    }

    #[test]
    fn a_redirect_is_a_write_whatever_command_precedes_it() {
        for command in [
            // Verbatim from the rig — `echo` is not a write command, so the
            // old guard judged this by `echo` and let it through.
            "echo pwned > /etc/aurora-no-such-dir-9f/probe.txt; echo \"exit=$?\"",
            "printf x >> /etc/hosts",
            "cat payload > 'C:/Windows/System32/x.dll'",
            "date 2> /var/log/aurora.log",
            "echo x > /c/Windows/y.txt",
        ] {
            assert!(
                command_targets_outside_workspace(command),
                "a redirect into a system path must be guarded: {command}"
            );
        }
    }

    /// The narrowing must survive the widening. These are the commands people
    /// actually type, and every one of them would be a false refusal.
    #[test]
    fn ordinary_redirects_and_workspace_writes_stay_allowed() {
        for command in [
            "echo hello > notes.txt",
            "echo hello >> build/out.log",
            "rm -f build/out.log 2>/dev/null",
            "cp a.txt b.txt >/dev/null 2>&1",
            "echo x > /dev/null",
            "printf done >&2",
            "cd src && rm -rf node_modules 2> /dev/null",
            // Workspace paths that merely SPELL a system directory inside a
            // longer one. Substring matching refused all of these.
            "echo x > src/etc/config.json",
            "rm -rf src/etc/generated",
            "rm -f vendor/usr/share/cache",
            "cp a b my-c:/windows-notes.md",
        ] {
            assert!(
                !command_targets_outside_workspace(command),
                "must stay allowed: {command}"
            );
        }
    }

    #[test]
    fn redirect_targets_reads_the_forms_a_shell_actually_uses() {
        assert_eq!(redirect_targets("echo x > a.txt"), vec!["a.txt"]);
        assert_eq!(redirect_targets("echo x>a.txt"), vec!["a.txt"]);
        assert_eq!(redirect_targets("echo x >> a.txt"), vec!["a.txt"]);
        assert_eq!(redirect_targets("cmd 2> err.log"), vec!["err.log"]);
        assert_eq!(
            redirect_targets("cmd > 'two words.txt'"),
            vec!["two words.txt"]
        );
        assert_eq!(
            redirect_targets("cmd > a.txt; other > b.txt"),
            vec!["a.txt", "b.txt"]
        );
        // Descriptor duplication names no file.
        assert!(redirect_targets("printf done >&2").is_empty());
        assert_eq!(redirect_targets("cmd >/dev/null 2>&1"), vec!["/dev/null"]);
        assert!(redirect_targets("no redirects here").is_empty());
    }

    /// The guard still earns its keep: a real device, and the other system
    /// trees, are exactly what it is for. A near-miss name is not a match.
    #[test]
    fn a_real_device_or_system_tree_still_warns() {
        for command in [
            "dd if=/dev/zero of=/dev/sda",
            "rm -rf /dev/shm/cache",
            "rm -f /etc/hosts",
            "cp payload /usr/local/bin/tool",
            // `/dev/nullify` is not `/dev/null`.
            "rm -f /dev/nullify",
            // One safe redirect does not launder the real target beside it.
            "rm -f /etc/hosts 2>/dev/null",
        ] {
            assert!(
                command_targets_outside_workspace(command),
                "must still warn: {command}"
            );
        }
    }

    // --- destructiveCommandWarning ---

    /// Reported from a real session: clearing `__pycache__` was refused with
    /// "Recursive forced deletion of current directory". It was not deleting
    /// the current directory. The pattern table matched raw substrings, and
    /// `rm -rf ./__pycache__` contains the text `rm -rf .`, so an ordinary
    /// cleanup was described as destroying the project.
    ///
    /// The agent believed the message and spent three attempts working around
    /// a danger that did not exist, which is the actual cost of a warning that
    /// names the wrong thing.
    #[test]
    fn clearing_a_regenerable_artifact_directory_is_allowed() {
        for command in [
            "rm -rf ./__pycache__",
            "rm -rf node_modules",
            "rm -rf .venv",
            "rm -rf target",
            "rm -rf packages/web/node_modules",
            "rm -rf src/aurora.egg-info",
            "rm -rf cmake-build-debug",
            // Several at once, all regenerable.
            "rm -rf node_modules dist .turbo",
            // After a `cd`, which is how the agent actually issues these.
            "cd /tmp/proj && rm -rf __pycache__",
            // INSIDE a regenerable directory. `rm -rf .next` was already
            // routine while `rm -rf .next/types` — a strictly smaller delete
            // in the same place — was refused, because only the last segment
            // was tested. Three threads hit exactly this in September 2026,
            // every one clearing a stale type cache before a typecheck.
            "rm -rf .next/types",
            "cd apps/web && rm -rf .next/types && pnpm exec tsc --noEmit",
            "rm -rf node_modules/.cache/babel-loader",
            "rm -rf target/debug/incremental",
        ] {
            assert!(
                matches!(check_destructive(command), ValidationResult::Allow),
                "{command} should be routine maintenance, got {:?}",
                check_destructive(command)
            );
        }
    }

    #[test]
    fn a_path_that_is_not_a_known_artifact_still_warns_but_is_labelled_honestly() {
        for command in [
            "rm -rf .git/hooks",
            "rm -rf *.pyc",
            // Ambiguous by name: tools write here, and so do people.
            "rm -rf build",
            "rm -rf deps",
            "rm -rf bin",
            "rm -rf out",
            // `..` leaves the directory the command can see; declined.
            "rm -rf ../sibling/node_modules",
            // Absolute paths are declined for the same reason.
            "rm -rf /var/tmp/node_modules",
            // One unknown target contaminates an otherwise routine batch.
            "rm -rf node_modules my-source-dir",
            // A half-written command is not maintenance.
            "rm -rf",
        ] {
            match check_destructive(command) {
                ValidationResult::Warn { message } => assert!(
                    !message.contains("current directory")
                        && !message.contains("parent directory")
                        && !message.contains("home directory")
                        && !message.contains("at root"),
                    "{command} was mislabelled: {message}"
                ),
                other => panic!("{command} expected a generic warning, got {other:?}"),
            }
        }
    }

    /// The other half of the same fix: narrowing the match must not let a
    /// genuinely catastrophic target through.
    #[test]
    fn the_targets_that_really_are_catastrophic_still_say_so() {
        let cases = [
            ("rm -rf /", "at root"),
            ("rm -rf ~", "home directory"),
            ("rm -rf $HOME", "home directory"),
            ("rm -rf *", "all files in current directory"),
            ("rm -rf .", "current directory"),
            ("rm -rf ..", "parent directory"),
            // Flags in any order, and after a `--` terminator.
            ("rm -fr .", "current directory"),
            ("rm --recursive --force /", "at root"),
            ("rm -rf -- /", "at root"),
            // Not the first command in the line.
            ("cd /tmp && rm -rf /", "at root"),
        ];
        for (command, expected) in cases {
            match check_destructive(command) {
                ValidationResult::Warn { message } => assert!(
                    message.contains(expected),
                    "{command} expected {expected:?}, got {message:?}"
                ),
                other => panic!("{command} expected a warning, got {other:?}"),
            }
        }
    }

    /// The regression this lexer was written for in the first place: package
    /// names supplying `rm`, `-r` and `-f` across unrelated arguments.
    #[test]
    fn an_install_that_merely_contains_the_letters_is_not_a_deletion() {
        assert!(matches!(
            check_destructive("bun add lucide-react react-hook-form zod"),
            ValidationResult::Allow
        ));
    }

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

    #[test]
    fn package_names_cannot_combine_into_a_phantom_rm_rf_command() {
        for package_command in ["bun add", "npm install", "pnpm add", "yarn add"] {
            let command =
                format!("{package_command} clsx tailwind-merge lucide-react react-hook-form zod");
            assert_eq!(
                check_destructive(&command),
                ValidationResult::Allow,
                "{command}"
            );
        }
    }

    #[test]
    fn actual_recursive_forced_rm_commands_still_warn() {
        for command in [
            "rm -rf build",
            "rm -r -f build",
            "/bin/rm -Rf build",
            "rm --recursive --force build",
            "bun add clsx && rm -rf build",
        ] {
            assert!(
                matches!(check_destructive(command), ValidationResult::Warn { .. }),
                "{command}"
            );
        }
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
            ValidationResult::Warn { message }
                if message.contains("../../../etc/passwd")
                    && message.contains("outside the workspace")
        ));
    }

    /// A `..` that climbs back down inside the workspace is not an escape, and
    /// used to be refused anyway — the check only allowed traversal when the
    /// command text spelled the workspace root out in full, which no relative
    /// path ever does. Thread `810f1387`, 2026-09-16.
    #[test]
    fn allows_traversal_that_stays_inside_the_workspace() {
        let workspace = PathBuf::from("/workspace/project");
        assert_eq!(
            validate_paths("cat src/../src/main.rs", &workspace),
            ValidationResult::Allow
        );
        assert_eq!(
            validate_paths("ls packages/web/../api/src", &workspace),
            ValidationResult::Allow
        );
    }

    /// A refusal has to name the path it is refusing. The old text said only
    /// that the command "contains directory traversal pattern '../'" and asked
    /// the caller to verify a path it never named, about a command that had
    /// not run.
    #[test]
    fn a_refusal_names_the_path_and_the_workspace() {
        let workspace = PathBuf::from("/workspace/project");
        let ValidationResult::Warn { message } =
            validate_paths("ls ../sibling-project/src", &workspace)
        else {
            panic!("a sibling of the root is outside the workspace");
        };
        assert!(message.contains("../sibling-project/src"), "{message}");
        assert!(message.contains("/workspace/project"), "{message}");
    }

    /// Redirects, quoting and chain punctuation must not hide a path from the
    /// check, nor invent one that isn't there.
    #[test]
    fn traversal_is_found_through_quoting_and_chains() {
        let workspace = PathBuf::from("/workspace/project");
        assert!(matches!(
            validate_paths("ls inside && cat \"../../secrets.env\"", &workspace),
            ValidationResult::Warn { .. }
        ));
        assert!(matches!(
            validate_paths("cat x 2>../../log.txt", &workspace),
            ValidationResult::Warn { .. }
        ));
        assert_eq!(
            validate_paths("ls a/../b 2>/dev/null || ls b", &workspace),
            ValidationResult::Allow
        );
    }

    /// `..` inside a word that is not a path component does not climb
    /// anywhere — a range operator, an ellipsis in a message, a file whose
    /// name happens to contain dots.
    #[test]
    fn dots_that_are_not_a_path_component_are_not_traversal() {
        let workspace = PathBuf::from("/workspace/project");
        assert_eq!(
            validate_paths("git log HEAD~3..HEAD --oneline", &workspace),
            ValidationResult::Allow
        );
        assert_eq!(
            validate_paths("cat src/app/api/[...path]/route.ts", &workspace),
            ValidationResult::Allow
        );
    }

    #[test]
    fn warns_home_directory_reference() {
        let workspace = PathBuf::from("/workspace/project");
        assert!(matches!(
            validate_paths("cat ~/.ssh/id_rsa", &workspace),
            ValidationResult::Warn { message } if message.contains("home directory")
        ));
        assert!(matches!(
            validate_paths("cp \"~/notes.md\" .", &workspace),
            ValidationResult::Warn { .. }
        ));
        assert!(matches!(
            validate_paths("ls $HOME/.aurora", &workspace),
            ValidationResult::Warn { .. }
        ));
    }

    /// awk matches with `~`, so `s~/D/` carries the substring `~/` and names
    /// no directory. Thread `46b93977` (2026-08-20) lost two git status
    /// summaries to this — commands that touch no path at all.
    #[test]
    fn an_awk_match_operator_is_not_a_home_directory() {
        let workspace = PathBuf::from("/workspace/project");
        assert_eq!(
            validate_paths(
                "git status --porcelain=v1 -uall | awk '{s=substr($0,1,2); if(s~/D/)d++; else m++}'",
                &workspace
            ),
            ValidationResult::Allow
        );
        assert_eq!(
            validate_paths("awk '$1~/^src/{print}' files.txt", &workspace),
            ValidationResult::Allow
        );
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
        assert_eq!(validate_command("ls -la", ExecutionMode::ReadOnly), Ok(()));
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
        assert!(matches!(
            err,
            BashValidationError::Warning(ref m)
                if m.contains("../../../etc/passwd") && m.contains("outside the workspace")
        ));
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
        let err =
            validate_command_with_workspace("rm -rf foo", ExecutionMode::ReadOnly, &workspace)
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
        assert_eq!(
            classify_intent("kill -9 1234"),
            CommandIntent::ProcessManagement
        );
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
        assert_eq!(
            CommandIntent::ProcessManagement.as_str(),
            "process_management"
        );
        assert_eq!(
            CommandIntent::PackageManagement.as_str(),
            "package_management"
        );
        assert_eq!(CommandIntent::SystemAdmin.as_str(), "system_admin");
        assert_eq!(CommandIntent::Unknown.as_str(), "unknown");
    }
}
