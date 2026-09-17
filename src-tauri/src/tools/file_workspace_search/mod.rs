//! File / workspace / search tool bucket — Phase 3 Sub-C.
//!
//! Wraps 15 existing Rust commands (in `crate::commands::*` and
//! `crate::commands::editor_ops::*`) as [`ToolExecutor`] trait
//! impls and exposes [`register`] so the Sub-E composer can mount
//! the whole bucket onto a [`ToolRegistry`].
//!
//! One file per tool, mirroring `src/tools/definitions/*.ts` and
//! `src/tools/executors/*.ts`. Each tool lives in its own
//! submodule so a future-Sub can swap an implementation without
//! pulling in the rest of the bucket.
//!
//! ## Tool roster (10 registered)
//!
//! Refined from the original 16: read/edit families collapsed to one
//! tool each, delete + folder-delete merged, folder_move generalised.
//!
//! | name               | role                                                                         |
//! |--------------------|------------------------------------------------------------------------------|
//! | `file_read`        | read one file or many — `path` is always an array; missing → exists:false     |
//! | `file_write`       | create or overwrite a whole file; `content` required; `must_not_exist` guard  |
//! | `file_edit`        | exact-text edit, single or `edits[]` batch (atomic); read-before-edit guard    |
//! | `move_path`        | move/rename a file OR folder (`std::fs::rename`)                              |
//! | `delete_path`      | delete a file, or a folder with `recursive:true`                             |
//! | `folder_create`    | `commands::create_folder`                                                    |
//! | `glob`             | find files by NAME/path shape (`rg --files --glob`)                          |
//! | `grep`             | find files by CONTENT (`commands::ripgrep_search`)                           |
//! | `workspace_tree`   | budget-bounded structure map (`commands::read_directory`)                    |
//! | `auroro_websearch` | `commands::aurora_websearch`                                                 |
//!
//! The three discovery tools answer three different questions and are
//! deliberately not interchangeable: `glob` for "what is this file called",
//! `grep` for "where does this text appear", `workspace_tree` for "how is this
//! project laid out". Before `glob` existed a model that knew a filename had to
//! reach for one of the other two, which is why the tree was over-used.
//!
//! Internal (unregistered) helpers: `multi_file_read` (batch reader for
//! `file_read`), `image_read` (`file_read`'s image path), `search_replace`
//! (diff/result helpers for `file_edit` / `file_write`), `read_tracker`
//! (read-before-edit state).
//!
//! ## Path safety
//!
//! Every path argument flows through [`resolve_path`], which:
//!
//! - When `ctx.workspace_root` is `Some`: runs the input through
//!   `crate::agent_safety::resolve_within_workspace`. Any
//!   `PathSafetyError` is re-raised as
//!   `ToolError::PolicyViolation`. Missing files (a legal input
//!   for `file_create`/`file_write`) are handled by the
//!   parent-directory variant [`resolve_path_for_create`].
//! - When `ctx.workspace_root` is `None`: the access mode decides, because
//!   the setting exists precisely for this case and nothing else is
//!   guarding it. Reads take any path when the mode reaches outside
//!   (`Read`/`Full`); writes and creates only under `Full`. The read
//!   family still honours the spill directory first — the one exception,
//!   a directory Aurora itself wrote. Any other path is refused with
//!   [`ToolError::InvalidInput`] naming both ways out, mirroring
//!   `shell_execute`'s no-workspace guard.

use std::path::{Path, PathBuf};

use crate::agent_runtime::tool_executor::{ToolError, ToolRegistry, WorkspaceAccess};
use crate::agent_safety::{resolve_within_workspace, PathSafetyError};

pub mod auroro_websearch;
pub mod delete_path;
pub mod file_edit;
pub mod file_read;
/// Marker a self-bounding read stamps on its payload so the runtime's
/// spill and history clamp leave it alone. Re-exported here because the
/// runtime checks it without needing the tool's internals.
pub use file_read::EXACT_READ_MARKER;
pub mod file_write;
pub mod folder_create;
pub mod glob;
pub mod grep;
/// Internal: `file_read`'s image path — detects a picture by its bytes and
/// returns it as something a vision model can actually see.
pub mod image_read;
pub mod move_path;
/// Internal: the parallel batch reader, reused by `file_read`'s array
/// form. Not registered as a standalone tool.
pub mod multi_file_read;
/// Internal: reading the path argument out of a mutating tool's input, and
/// naming what actually arrived when it isn't a usable string. Shared by every
/// tool in this bucket that writes.
pub mod edits_argument;
pub mod path_argument;
pub mod path_recovery;
/// Internal: per-session read-before-edit guard state.
pub mod read_tracker;
/// Internal: shared edit-result/diff helpers used by `file_edit` and
/// `file_write`. The `SearchReplaceTool` struct here is no longer
/// registered (its job is now `file_edit`); the module survives for its
/// `render_response` / `emit_post_write` / `diff_side` helpers.
pub mod search_replace;
/// Internal: the single definition of how a write tool announces which files
/// it is about to touch, so the agent window can label the row while the
/// arguments are still streaming. Shared by `file_edit` and `file_write`.
pub mod streaming_targets;
pub mod workspace_tree;

/// Register every tool in this bucket against `reg`. Idempotent: a
/// re-registration overwrites the existing entry (this is what the
/// underlying `ToolRegistry` does).
///
/// `sink` is shared across every mutating tool (`file_write`,
/// `file_edit`, `move_path`, `delete_path`, `folder_create`) so they can
/// fire the `agent_file_changed` Tauri event after a successful disk
/// write — that's how open Monaco buffers, the explorer tree, and the
/// pending-changes diff UI find out that disk just moved. Pass
/// [`NoopIdeEventSink`] in unit tests that don't care about emissions.
///
/// The contract names this `pub fn register(reg: &mut ToolRegistry)`,
/// but [`ToolRegistry::register`] takes `&self` (the registry is an
/// `Arc<DashMap>` under the hood). We keep `&mut` on the public
/// signature so the contract still type-checks against an exclusive
/// borrow Sub-E may have, and we just don't need the `mut` ourselves.
///
/// `browser` reaches only `auroro_websearch`, as the last rung of its search
/// ladder — see [`crate::services::browser_search`]. It is `None` wherever
/// there is no browser to drive, and the ladder reports that rung as
/// unavailable rather than quietly being one shorter.
pub fn register(
    reg: &mut ToolRegistry,
    sink: std::sync::Arc<dyn crate::tools::shell_editor_todo::IdeEventSink>,
    browser: Option<std::sync::Arc<crate::services::browser_runtime::BrowserManager>>,
) {
    use std::sync::Arc;

    reg.register(Arc::new(file_read::FileReadTool));
    reg.register(Arc::new(file_edit::FileEditTool::new(sink.clone())));
    reg.register(Arc::new(move_path::MovePathTool::new(sink.clone())));
    reg.register(Arc::new(delete_path::DeletePathTool::new(sink.clone())));
    reg.register(Arc::new(glob::GlobTool));
    reg.register(Arc::new(grep::GrepTool));
    reg.register(Arc::new(workspace_tree::WorkspaceTreeTool));
    reg.register(Arc::new(file_write::FileWriteTool::new(sink.clone())));
    reg.register(Arc::new(folder_create::FolderCreateTool::new(sink)));
    reg.register(Arc::new(auroro_websearch::AuroroWebSearchTool::new(browser)));
}

/// The tool names this bucket registers, in roster order. Used by the
/// bucket-level smoke test and by Sub-E's composer test. The refactor
/// from 16→10 merged the read/edit/delete families into one tool each
/// (`file_read`, `file_edit`, `delete_path`) and renamed `folder_move`
/// → `move_path` (now file-or-folder). `multi_file_read`, `file_exists`,
/// `file_create`, `search_replace`, and `multi_search_replace` are gone —
/// folded into `file_read` / `file_write` / `file_edit`.
pub const TOOL_NAMES: &[&str] = &[
    "file_read",
    "file_edit",
    "move_path",
    "delete_path",
    "glob",
    "grep",
    "workspace_tree",
    "file_write",
    "folder_create",
    "auroro_websearch",
];

// ---------------------------------------------------------------------------
// Code-index integration — the ONE seam for "a write tool changed the tree".
// ---------------------------------------------------------------------------

/// A file-mutating tool succeeded: flag the workspace's code index stale and,
/// when an index is already warm, return the edit-impact note for the written
/// file ("other files use what this file defines…").
///
/// The stale flag closes the walk fingerprint's blind spots (same-second
/// mtime, renames) — this is the seam the code-index handoff doc's §5.2a
/// called the actual work. The note reads the warm PRE-edit index via
/// [`peek`](crate::code_index::service::CodeIndexService::peek), which is both
/// free and the right data: impact is about the callers that existed when the
/// edit landed. No index in memory ⇒ no note, never a build.
pub(crate) fn index_note_after_write(
    ctx: &crate::agent_runtime::tool_executor::ToolContext,
    resolved: &str,
) -> Option<String> {
    let root = ctx.workspace_root.as_deref()?;
    let note = crate::code_index::impact::edit_impact_note(root, resolved);
    crate::code_index::service().invalidate(root);
    note
}

/// The stale flag alone, for tools that reshape the tree without a written
/// file to report on (`move_path`, `delete_path`). A rename changes neither
/// the file count nor the newest mtime, so without this the index never
/// notices one.
pub(crate) fn mark_index_stale(ctx: &crate::agent_runtime::tool_executor::ToolContext) {
    if let Some(root) = ctx.workspace_root.as_deref() {
        crate::code_index::service().invalidate(root);
    }
}

// ---------------------------------------------------------------------------
// Path-safety helpers shared across the bucket.
// ---------------------------------------------------------------------------

/// Resolve `path` against an optional workspace root. The path
/// must already exist on disk — the canonicalisation done by
/// `resolve_within_workspace` requires it.
///
/// `PathSafetyError::Io` is mapped to `ToolError::Execution` so
/// "file not found" surfaces as a regular execution error instead
/// of a policy violation. All other variants map to
/// `ToolError::PolicyViolation`.
pub(crate) fn resolve_path(
    path: &str,
    workspace_root: Option<&Path>,
) -> Result<PathBuf, ToolError> {
    resolve_path_with_access(path, workspace_root, WorkspaceAccess::Workspace)
}

/// [`resolve_path`], honouring the turn's access mode.
///
/// Used by the tools that walk a tree they were handed — `grep`, `glob`,
/// `workspace_tree` — and by the mutating tools, all of which need the same
/// answer: is this path in bounds for THIS mode? Only
/// [`WorkspaceAccess::Full`] lifts the boundary; a path outside it under any
/// other mode is refused exactly as before.
///
/// With no workspace open there is no boundary to resolve against, so the
/// access mode decides alone: `Full` takes the path as written, every
/// narrower mode refuses via [`no_workspace_refusal`]. "No folder open" is
/// the app's most common state on a fresh start — it must not also be the
/// one state in which every path on disk is in bounds.
pub(crate) fn resolve_path_with_access(
    path: &str,
    workspace_root: Option<&Path>,
    access: WorkspaceAccess,
) -> Result<PathBuf, ToolError> {
    let path = crate::agent_safety::paths::normalize_platform_path(path);
    let path = path.as_ref();
    if let Some(reason) = crate::agent_safety::paths::unstorable_path_reason(path) {
        return Err(ToolError::InvalidInput(reason));
    }
    let raw = Path::new(path);
    let Some(root) = workspace_root else {
        if access.lifts_boundary() {
            return Ok(raw.to_path_buf());
        }
        return Err(no_workspace_refusal(path));
    };
    match resolve_within_workspace(raw, root) {
        Ok(resolved) => Ok(resolved),
        Err(error) => {
            if access.lifts_boundary() {
                Ok(resolve_outside_workspace(raw, root))
            } else {
                Err(map_path_error(error))
            }
        }
    }
}

/// Resolve a path for read-only tools. Existing paths use the
/// strict canonical resolver; missing leaves inside the workspace are
/// still returned so the reader can report a normal `success=false`
/// payload instead of failing the whole tool call.
pub(crate) fn resolve_path_for_read(
    path: &str,
    workspace_root: Option<&Path>,
    access: WorkspaceAccess,
) -> Result<PathBuf, ToolError> {
    resolve_path_for_read_with_spill(path, workspace_root, access, None)
}

/// True when `path` lands inside `dir`, comparing them normalized.
///
/// Textual, because the spill file may have been created moments ago and
/// canonicalizing is not needed to answer "is this under a directory we
/// ourselves wrote". `..` is rejected outright rather than resolved, so no
/// spelling of the prefix can walk back out of it.
fn is_inside(path: &Path, dir: &Path) -> bool {
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
    let (candidate, prefix) = (norm(path), norm(dir));
    let prefix = prefix.trim_end_matches('/').to_string();
    candidate.starts_with(&format!("{prefix}/"))
}

/// As [`resolve_path_for_read`], plus this thread's tool-results directory.
///
/// A path inside `spill_dir` resolves even when `allow_outside` is false. That
/// directory contains only what THIS agent's own tools just produced —
/// `tool_spill` writes oversized stdout there and tells the model to open it
/// with `file_read`. Refusing it made that instruction a dead end in the
/// default configuration: the file lives under `%LOCALAPPDATA%`, so the
/// boundary check rejected the very path Aurora had just handed over.
///
/// The spill check runs first, so it also holds with no workspace open — the
/// directory is one Aurora itself wrote. Beyond it, the access mode decides:
/// `Read` and `Full` take the path as written, `Workspace` refuses via
/// [`no_workspace_refusal`].
pub(crate) fn resolve_path_for_read_with_spill(
    path: &str,
    workspace_root: Option<&Path>,
    access: WorkspaceAccess,
    spill_dir: Option<&Path>,
) -> Result<PathBuf, ToolError> {
    // Normalized but NOT shape-checked: a read of a path that cannot exist
    // already answers `exists: false`, which is the honest answer and costs
    // the caller nothing. Only the acting resolvers refuse outright.
    let path = crate::agent_safety::paths::normalize_platform_path(path);
    let path = path.as_ref();
    let raw = Path::new(path);
    if let Some(dir) = spill_dir {
        if is_inside(raw, dir) {
            return Ok(raw.to_path_buf());
        }
    }
    let Some(root) = workspace_root else {
        if access.reads_outside() {
            return Ok(raw.to_path_buf());
        }
        return Err(no_workspace_refusal(path));
    };

    match resolve_within_workspace(raw, root) {
        Ok(resolved) => Ok(resolved),
        // A path that does not exist yet fails canonicalization, so it arrives
        // as `Io` and NOT as a boundary rejection — whether or not it is inside
        // the workspace. The access check therefore has to happen here too, and
        // not only in the arm below: without it, a user who has switched reads
        // on can open an outside file that exists and is refused for one that
        // does not, which reads as the permission being ignored at random.
        Err(PathSafetyError::Io(_)) if access.reads_outside() => {
            Ok(resolve_outside_workspace(raw, root))
        }
        Err(PathSafetyError::Io(_)) => resolve_missing_path_inside_workspace(raw, root),
        // A boundary rejection (path resolves OUTSIDE the workspace) is only
        // fatal when the user hasn't opted into out-of-workspace reads. When they
        // have, resolve the path on its own — absolute as-is, relative against
        // the workspace — so the reader can open it.
        Err(error) => {
            if access.reads_outside() {
                Ok(resolve_outside_workspace(raw, root))
            } else {
                Err(map_path_error(error))
            }
        }
    }
}

/// Resolve a path the user explicitly allowed reading from outside the
/// workspace. Absolute paths stay as-is; relative ones anchor to the workspace.
/// Canonicalized when it exists so symlinks/`..` collapse, else returned verbatim
/// (a missing file still surfaces a normal "not found" from the reader).
fn resolve_outside_workspace(raw: &Path, root: &Path) -> PathBuf {
    let absolute = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        root.join(raw)
    };
    dunce::canonicalize(&absolute).unwrap_or(absolute)
}

fn resolve_missing_path_inside_workspace(path: &Path, root: &Path) -> Result<PathBuf, ToolError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };

    let (existing_ancestor, tail) = closest_existing_ancestor(&absolute);
    let resolved_ancestor = resolve_within_workspace(&existing_ancestor, root).map_err(|error| {
        // Report the path the caller actually asked for. The ancestor is an
        // implementation detail of this walk, and naming it produced refusals
        // that pointed at a directory nobody had mentioned — the reader could
        // not tell which of a batch of paths was rejected, or why.
        match error {
            PathSafetyError::OutsideWorkspace(_) => ToolError::PolicyViolation(format!(
                "path escapes workspace: {}",
                absolute.display()
            )),
            other => map_path_error(other),
        }
    })?;
    Ok(resolved_ancestor.join(tail))
}

/// Like [`resolve_path`] but tolerant of a missing leaf — used by
/// `file_create` and `file_write` where the file may not exist
/// yet. The tool resolves the parent directory inside the
/// workspace, then re-attaches the leaf.
///
/// If `path` is absolute, the same parent-directory resolution
/// applies; `Path::join` against an absolute right operand
/// replaces the base, matching `std::path::Path::join`.
///
/// Under [`WorkspaceAccess::Full`] the boundary is lifted and the destination
/// is taken as given. Under every other mode this function has no way to be
/// told otherwise — which is what makes "writes stay in the project" a
/// property of the code rather than a promise in a settings hint.
///
/// With no workspace open there is no project for the write to stay in, so
/// the access mode decides alone on the same terms as
/// [`resolve_path_with_access`]: `Full` takes the destination as written,
/// every narrower mode refuses via [`no_workspace_refusal`].
pub(crate) fn resolve_path_for_create(
    path: &str,
    workspace_root: Option<&Path>,
    access: WorkspaceAccess,
) -> Result<PathBuf, ToolError> {
    let path = crate::agent_safety::paths::normalize_platform_path(path);
    let path = path.as_ref();
    // Before the filesystem, so a name Windows cannot store is reported as
    // that rather than as whichever syscall refused it first. See
    // `agent_safety::paths::unstorable_path_reason`.
    if let Some(reason) = crate::agent_safety::paths::unstorable_path_reason(path) {
        return Err(ToolError::InvalidInput(reason));
    }
    let raw = Path::new(path);
    let Some(root) = workspace_root else {
        if access.writes_outside() {
            return Ok(raw.to_path_buf());
        }
        return Err(no_workspace_refusal(path));
    };

    // First try a straight resolution — handles the case where the
    // file already exists (file_write overwriting an existing
    // file).
    if let Ok(resolved) = resolve_within_workspace(raw, root) {
        return Ok(resolved);
    }

    // Allowed out: an absolute destination is taken as written, a relative one
    // still anchors to the project. The parent must exist — a write is not a
    // licence to conjure a directory tree somewhere arbitrary, and the tools
    // that legitimately create one (`folder_create`) say so themselves.
    if access.writes_outside() {
        return Ok(resolve_outside_workspace(raw, root));
    }

    // Fall back to resolving the parent directory.
    let absolute = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        root.join(raw)
    };

    let parent = absolute
        .parent()
        .ok_or_else(|| ToolError::InvalidInput(format!("path has no parent: {}", path)))?;

    let leaf = absolute
        .file_name()
        .ok_or_else(|| ToolError::InvalidInput(format!("path has no file name: {}", path)))?;

    if parent.exists() {
        let resolved_parent = resolve_within_workspace(parent, root).map_err(map_path_error)?;
        return Ok(resolved_parent.join(leaf));
    }

    // Parent missing — we still need to enforce that the eventual
    // canonical destination would land inside the workspace.
    // Strategy: walk up to the closest existing ancestor, resolve
    // that, then re-append the missing tail. If the closest
    // ancestor is outside the workspace, the candidate path is
    // outside the workspace.
    let (existing_ancestor, tail) = closest_existing_ancestor(parent);
    let resolved_ancestor =
        resolve_within_workspace(&existing_ancestor, root).map_err(map_path_error)?;
    Ok(resolved_ancestor.join(tail).join(leaf))
}

/// Walk the path upwards until an existing component is found.
/// Returns `(existing_ancestor, missing_tail)`. The missing tail
/// is the suffix of `path` that did not exist; an empty
/// `PathBuf` if `path` itself exists.
fn closest_existing_ancestor(path: &Path) -> (PathBuf, PathBuf) {
    let mut tail_parts: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor = path;
    loop {
        if cursor.exists() {
            let mut tail = PathBuf::new();
            for part in tail_parts.iter().rev() {
                tail.push(*part);
            }
            return (cursor.to_path_buf(), tail);
        }
        match (cursor.file_name(), cursor.parent()) {
            (Some(name), Some(parent)) => {
                tail_parts.push(name);
                cursor = parent;
            }
            // Reached the filesystem root without finding an
            // existing ancestor (very unusual). Treat the path
            // itself as the closest "ancestor" so the caller's
            // resolve_within_workspace call surfaces a clear Io
            // error.
            _ => return (path.to_path_buf(), PathBuf::new()),
        }
    }
}

/// Map a [`PathSafetyError`] to a [`ToolError`] for the bucket.
pub(crate) fn map_path_error(error: PathSafetyError) -> ToolError {
    match error {
        PathSafetyError::OutsideWorkspace(p) => {
            ToolError::PolicyViolation(format!("path escapes workspace: {}", p.display()))
        }
        PathSafetyError::EscapingSymlink(link, target) => ToolError::PolicyViolation(format!(
            "symlink target leaves workspace: {} -> {}",
            link.display(),
            target.display()
        )),
        PathSafetyError::Io(io) => ToolError::Execution(format!("io error: {}", io)),
    }
}

/// The refusal for a path that arrives with no workspace to resolve it
/// against and an access mode that does not reach outside one.
///
/// Same contract as `shell_execute`'s no-workspace guard: say what is wrong
/// and name both ways out, so the model can act instead of guessing. The
/// path is named so a batch that resolves entry by entry can tell which
/// one was refused.
fn no_workspace_refusal(path: &str) -> ToolError {
    ToolError::InvalidInput(format!(
        "No workspace is open, so there is nothing to resolve '{path}' against. Open a folder \
         in Aurora, or turn on out-of-workspace access in Settings → Agent."
    ))
}

// ---------------------------------------------------------------------------
// CRLF / BOM preservation
// ---------------------------------------------------------------------------
//
// LLMs return file content as plain UTF-8 with `\n` line endings. Writing
// that verbatim onto an existing Windows source file (CRLF) silently
// flips every line, which:
//   - Triggers a giant noisy diff in git blame.
//   - Confuses editors / tools that key off mtime+content equality.
//   - Breaks tools that depend on CRLF (some Windows VS / .NET tooling).
//
// We mirror VS Code / Cursor / JetBrains here: detect the line ending
// the file currently uses, then normalize the new content to match
// before writing. Same dance for the UTF-8 BOM (`EF BB BF`) — if the
// original starts with one and the new content doesn't, prepend it.

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// What line endings does this byte slice predominantly use?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineEnding {
    /// `\n` only — Unix-style.
    Lf,
    /// `\r\n` — Windows-style.
    Crlf,
}

/// Heuristic: scan the first ~8 KiB and count CRLF vs LF. Whichever
/// wins is treated as the file's convention. Ties go to LF (most
/// modern editors default there). Returns `None` when no newlines
/// were seen in the sampled window (binary or single-line file).
pub(crate) fn detect_line_ending(bytes: &[u8]) -> Option<LineEnding> {
    let window = &bytes[..bytes.len().min(8 * 1024)];
    let mut lf = 0u32;
    let mut crlf = 0u32;
    let mut i = 0;
    while i < window.len() {
        let b = window[i];
        if b == b'\n' {
            // CRLF only counts if the preceding byte was \r.
            if i > 0 && window[i - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
        i += 1;
    }
    if lf == 0 && crlf == 0 {
        return None;
    }
    if crlf > lf {
        Some(LineEnding::Crlf)
    } else {
        Some(LineEnding::Lf)
    }
}

/// Convert `content` so its line endings match `target`. No-op if
/// `target` is `None` (no newlines seen, so we don't care). Always
/// normalises mixed input first by stripping `\r` before `\n`, then
/// re-emitting in the target style — that way we don't accidentally
/// double-`\r` on a file that already had CRLF.
pub(crate) fn normalize_line_endings(content: &str, target: Option<LineEnding>) -> String {
    let Some(target) = target else {
        return content.to_string();
    };
    let normalized: String = content.replace("\r\n", "\n");
    match target {
        LineEnding::Lf => normalized,
        LineEnding::Crlf => normalized.replace('\n', "\r\n"),
    }
}

/// Read the file at `path` (if it exists) and return:
///   - the LF/CRLF convention to honour on the next write
///   - whether the file currently starts with a UTF-8 BOM
///
/// Errors and non-existence both resolve to `(None, false)` — those
/// cases shouldn't fail the caller; they just mean "no convention to
/// preserve, write what you have".
pub(crate) fn detect_write_conventions(path: &std::path::Path) -> (Option<LineEnding>, bool) {
    let Ok(bytes) = std::fs::read(path) else {
        return (None, false);
    };
    let has_bom = bytes.starts_with(UTF8_BOM);
    let body = if has_bom {
        &bytes[UTF8_BOM.len()..]
    } else {
        &bytes[..]
    };
    (detect_line_ending(body), has_bom)
}

/// Apply `(line_ending, bom)` conventions to `new_content` and return
/// the byte sequence ready for `std::fs::write`.
pub(crate) fn apply_write_conventions(
    new_content: &str,
    line_ending: Option<LineEnding>,
    bom: bool,
) -> Vec<u8> {
    let normalized = normalize_line_endings(new_content, line_ending);
    if bom && !normalized.as_bytes().starts_with(UTF8_BOM) {
        let mut out = Vec::with_capacity(UTF8_BOM.len() + normalized.len());
        out.extend_from_slice(UTF8_BOM);
        out.extend_from_slice(normalized.as_bytes());
        out
    } else {
        normalized.into_bytes()
    }
}

#[cfg(test)]
mod write_convention_tests {
    use super::*;

    #[test]
    fn detects_crlf() {
        assert_eq!(detect_line_ending(b"a\r\nb\r\nc"), Some(LineEnding::Crlf));
    }

    #[test]
    fn detects_lf() {
        assert_eq!(detect_line_ending(b"a\nb\nc"), Some(LineEnding::Lf));
    }

    #[test]
    fn no_newlines_returns_none() {
        assert_eq!(detect_line_ending(b"single line"), None);
    }

    #[test]
    fn mixed_prefers_majority() {
        // 2 CRLF + 1 LF → CRLF wins
        assert_eq!(detect_line_ending(b"a\r\nb\nc\r\n"), Some(LineEnding::Crlf));
    }

    #[test]
    fn normalize_to_crlf_idempotent() {
        let already = "a\r\nb\r\n";
        assert_eq!(
            normalize_line_endings(already, Some(LineEnding::Crlf)),
            already
        );
    }

    #[test]
    fn normalize_lf_input_to_crlf() {
        assert_eq!(
            normalize_line_endings("a\nb\nc", Some(LineEnding::Crlf)),
            "a\r\nb\r\nc"
        );
    }

    #[test]
    fn apply_conventions_preserves_bom() {
        let out = apply_write_conventions("hello", None, true);
        assert!(out.starts_with(UTF8_BOM));
        assert_eq!(&out[UTF8_BOM.len()..], b"hello");
    }

    #[test]
    fn apply_conventions_does_not_double_bom() {
        let with_bom = format!("\u{feff}hello");
        let out = apply_write_conventions(&with_bom, None, true);
        // Exactly one BOM at the start.
        assert!(out.starts_with(UTF8_BOM));
        assert!(!out[UTF8_BOM.len()..].starts_with(UTF8_BOM));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::tool_executor::ToolRegistry;
    use crate::tools::shell_editor_todo::NoopIdeEventSink;
    use std::collections::HashSet;
    use std::sync::Arc;

    fn test_sink() -> Arc<dyn crate::tools::shell_editor_todo::IdeEventSink> {
        Arc::new(NoopIdeEventSink)
    }

    #[test]
    fn register_mounts_all_bucket_tools() {
        let mut reg = ToolRegistry::new();
        register(&mut reg, test_sink(), None);
        assert_eq!(reg.len(), TOOL_NAMES.len(), "expected 10 tools in bucket");
        assert_eq!(TOOL_NAMES.len(), 10);

        let registered: HashSet<String> = reg.names().into_iter().collect();
        for &name in TOOL_NAMES {
            assert!(
                registered.contains(name),
                "expected '{name}' in registered tools"
            );
        }
    }

    #[test]
    fn schemas_match_tool_names() {
        let mut reg = ToolRegistry::new();
        register(&mut reg, test_sink(), None);
        for &name in TOOL_NAMES {
            let tool = reg.get(name).unwrap_or_else(|| panic!("{name} missing"));
            let schema = tool.schema();
            assert_eq!(
                schema.name, name,
                "schema name must match registry name for {name}"
            );
            assert!(
                !schema.description.is_empty(),
                "schema description must not be empty for {name}"
            );
        }
    }

    /// Every no-workspace refusal must say what is wrong and name both ways
    /// out — the contract `shell_execute`'s guard set — not merely fail.
    fn assert_no_workspace_refusal(err: &ToolError) {
        let ToolError::InvalidInput(message) = err else {
            panic!("expected InvalidInput, got {err:?}");
        };
        assert!(message.contains("No workspace is open"), "{message}");
        assert!(
            message.contains("Open a folder"),
            "must name the first way out: {message}"
        );
        assert!(
            message.contains("Settings"),
            "must name the access setting: {message}"
        );
    }

    /// The hole this file had: with no workspace the resolvers handed the
    /// caller's path straight back and the access setting was never
    /// consulted — in the one state where nothing else was guarding. The
    /// default access now refuses, and the refusal says what to do about it.
    #[test]
    fn the_write_resolver_refuses_with_no_workspace_and_default_access() {
        let err = resolve_path_with_access("/tmp/whatever", None, WorkspaceAccess::Workspace)
            .expect_err("must not resolve a path unchecked");
        assert_no_workspace_refusal(&err);
        assert!(
            err.to_string().contains("whatever"),
            "must name the refused path: {err}"
        );

        // The convenience wrapper hardcodes the default mode — it must not
        // become a bypass around the guard its callee just grew.
        let err = resolve_path("/tmp/whatever", None).expect_err("wrapper refuses too");
        assert_no_workspace_refusal(&err);
    }

    #[test]
    fn the_read_resolver_refuses_with_no_workspace_and_default_access() {
        let err = resolve_path_for_read("/tmp/whatever", None, WorkspaceAccess::Workspace)
            .expect_err("must not read a path unchecked");
        assert_no_workspace_refusal(&err);
    }

    /// `file_write`, `folder_create`, and a move's destination all resolve
    /// through the create variant — the same hole, closed on the same terms.
    #[test]
    fn the_create_resolver_refuses_with_no_workspace_and_default_access() {
        let err = resolve_path_for_create("/tmp/whatever", None, WorkspaceAccess::Workspace)
            .expect_err("must not create a path unchecked");
        assert_no_workspace_refusal(&err);
    }

    /// The setting exists precisely to decide this. Where it permits
    /// reaching outside, a workspace-less turn still works and the path
    /// comes back verbatim, exactly as it always did.
    #[test]
    fn the_access_setting_decides_when_there_is_no_workspace() {
        // Writes and searches: only Full lifts the boundary.
        let err = resolve_path_with_access("/tmp/anywhere.md", None, WorkspaceAccess::Read)
            .expect_err("Read opens one named file, not writes or searches");
        assert_no_workspace_refusal(&err);
        assert_eq!(
            resolve_path_with_access("/tmp/anywhere.md", None, WorkspaceAccess::Full)
                .expect("Full takes the path as written"),
            std::path::PathBuf::from("/tmp/anywhere.md")
        );

        // Reads: Read and Full both reach outside.
        for access in [WorkspaceAccess::Read, WorkspaceAccess::Full] {
            assert_eq!(
                resolve_path_for_read("/tmp/anywhere.md", None, access)
                    .unwrap_or_else(|err| panic!("{access:?} must allow it: {err}")),
                std::path::PathBuf::from("/tmp/anywhere.md")
            );
        }

        // Creates: Full only.
        let err = resolve_path_for_create("/tmp/anywhere.md", None, WorkspaceAccess::Read)
            .expect_err("Read must not create outside");
        assert_no_workspace_refusal(&err);
        assert_eq!(
            resolve_path_for_create("/tmp/anywhere.md", None, WorkspaceAccess::Full)
                .expect("Full takes the destination as written"),
            std::path::PathBuf::from("/tmp/anywhere.md")
        );
    }

    /// The spill check runs before any of this and is untouched: the model
    /// reads its own oversized tool output from a directory Aurora itself
    /// wrote, with no workspace and in every access mode. Everything outside
    /// that directory is subject to the new refusal, exactly as before.
    #[test]
    fn a_spilled_result_still_resolves_with_no_workspace_whatever_the_access() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let spill = tmp.path().join("t1.tool-results");
        std::fs::create_dir_all(&spill).unwrap();
        let spilled = spill.join("out-3f2a91c8.txt");
        std::fs::write(&spilled, "full build log").unwrap();

        for access in [
            WorkspaceAccess::Workspace,
            WorkspaceAccess::Read,
            WorkspaceAccess::Full,
        ] {
            let resolved = resolve_path_for_read_with_spill(
                &spilled.to_string_lossy(),
                None,
                access,
                Some(&spill),
            )
            .unwrap_or_else(|err| panic!("{access:?} must reach the spill dir: {err}"));
            assert_eq!(resolved, spilled);
        }

        // The exemption is still only the spill directory — a sibling of it
        // gets the same refusal as everything else on disk.
        let err = resolve_path_for_read_with_spill(
            &tmp.path().join("elsewhere.txt").to_string_lossy(),
            None,
            WorkspaceAccess::Workspace,
            Some(&spill),
        )
        .expect_err("the spill exemption must not open the rest of the disk");
        assert_no_workspace_refusal(&err);
    }

    #[test]
    fn resolve_path_within_workspace_succeeds() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let inside = tmp.path().join("hello.txt");
        std::fs::write(&inside, "hi").unwrap();

        let resolved = resolve_path("hello.txt", Some(tmp.path())).expect("ok");
        // dunce::canonicalize matches dunce::canonicalize on both sides.
        let expected = dunce::canonicalize(&inside).unwrap();
        assert_eq!(resolved, expected);
    }

    #[test]
    fn resolve_path_for_read_allows_missing_inside_workspace() {
        let tmp = tempfile::tempdir().expect("tempdir");

        let resolved =
            resolve_path_for_read("missing.txt", Some(tmp.path()), WorkspaceAccess::Workspace)
                .expect("ok");
        let expected_parent = dunce::canonicalize(tmp.path()).unwrap();
        assert_eq!(resolved.parent().unwrap(), expected_parent);
        assert_eq!(resolved.file_name().unwrap(), "missing.txt");
    }

    #[test]
    fn resolve_path_for_read_rejects_missing_escape() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();

        let result = resolve_path_for_read(
            "../outside-missing.txt",
            Some(&workspace),
            WorkspaceAccess::Workspace,
        );
        assert!(matches!(result, Err(ToolError::PolicyViolation(_))));
    }

    #[test]
    fn resolve_path_rejects_dotdot_escape() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(tmp.path().join("outside.txt"), "secret").unwrap();

        let result = resolve_path("../outside.txt", Some(&workspace));
        assert!(matches!(result, Err(ToolError::PolicyViolation(_))));
    }

    #[test]
    fn resolve_path_for_create_handles_missing_leaf() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let resolved =
            resolve_path_for_create("new-file.txt", Some(tmp.path()), WorkspaceAccess::Workspace)
                .expect("ok");
        // Compare canonicalised parents.
        let expected_parent = dunce::canonicalize(tmp.path()).unwrap();
        assert_eq!(resolved.parent().unwrap(), expected_parent);
        assert_eq!(resolved.file_name().unwrap(), "new-file.txt");
    }

    #[test]
    fn resolve_path_for_create_rejects_escape() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let result = resolve_path_for_create(
            "../escape.txt",
            Some(&workspace),
            WorkspaceAccess::Workspace,
        );
        assert!(matches!(result, Err(ToolError::PolicyViolation(_))));
    }

    /// The case that was broken: `tool_spill` writes oversized output under
    /// `%LOCALAPPDATA%` and tells the model to open it with `file_read`, but
    /// the boundary check refused it whenever `allow_outside_workspace` was
    /// false — which is the default. The agent was pointed at its own output
    /// and could not reach it.
    #[test]
    fn a_spilled_result_is_readable_without_outside_workspace_access() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        let spill = tmp.path().join("sessions").join("t1.tool-results");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&spill).unwrap();
        let spilled = spill.join("out-3f2a91c8.txt");
        std::fs::write(&spilled, "full build log").unwrap();

        // Without the spill directory this is exactly the refusal.
        assert!(matches!(
            resolve_path_for_read(
                &spilled.to_string_lossy(),
                Some(&workspace),
                WorkspaceAccess::Workspace
            ),
            Err(_)
        ));

        // With it, the same path resolves — and `allow_outside` is still false.
        let resolved = resolve_path_for_read_with_spill(
            &spilled.to_string_lossy(),
            Some(&workspace),
            WorkspaceAccess::Workspace,
            Some(&spill),
        )
        .expect("a spilled result must be readable");
        assert_eq!(resolved, spilled);
    }

    #[test]
    fn the_spill_exemption_does_not_open_the_rest_of_the_disk() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        let spill = tmp.path().join("sessions").join("t1.tool-results");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&spill).unwrap();

        // A sibling of the spill directory is not in it.
        let sibling = tmp.path().join("sessions").join("t1.jsonl");
        assert!(resolve_path_for_read_with_spill(
            &sibling.to_string_lossy(),
            Some(&workspace),
            WorkspaceAccess::Workspace,
            Some(&spill),
        )
        .is_err());

        // Nor is anything reached by walking back out of it.
        let escape = spill.join("..").join("..").join("secrets.txt");
        assert!(resolve_path_for_read_with_spill(
            &escape.to_string_lossy(),
            Some(&workspace),
            WorkspaceAccess::Workspace,
            Some(&spill),
        )
        .is_err());

        // And a prefix that merely LOOKS like the directory is not it either.
        let lookalike = tmp
            .path()
            .join("sessions")
            .join("t1.tool-results-elsewhere")
            .join("x.txt");
        assert!(resolve_path_for_read_with_spill(
            &lookalike.to_string_lossy(),
            Some(&workspace),
            WorkspaceAccess::Workspace,
            Some(&spill),
        )
        .is_err());
    }

    /// A workspace with a file beside it, the shape every mode is judged on.
    fn workspace_with_a_neighbour() -> (tempfile::TempDir, std::path::PathBuf, String) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, "notes").unwrap();
        let outside = outside.to_string_lossy().into_owned();
        (tmp, workspace, outside)
    }

    /// The middle mode is a targeted allowance: open the file I am pointing
    /// at. It must not become a licence to walk the disk or to change what it
    /// finds there.
    #[test]
    fn read_access_opens_a_named_file_and_nothing_else() {
        let (_tmp, workspace, outside) = workspace_with_a_neighbour();
        let root = Some(workspace.as_path());

        assert!(resolve_path_for_read(&outside, root, WorkspaceAccess::Read).is_ok());
        assert!(
            resolve_path_with_access(&outside, root, WorkspaceAccess::Read).is_err(),
            "searching and editing outside stay closed in Read"
        );
        assert!(
            resolve_path_for_create(&outside, root, WorkspaceAccess::Read).is_err(),
            "a write outside stays closed in Read"
        );
    }

    /// Full is the mode that exists because the strict one blocked real work:
    /// a dependency's source, a second checkout, a config in the home
    /// directory. Every resolver has to agree, or the agent hits the same wall
    /// one tool later.
    #[test]
    fn full_access_lifts_the_boundary_for_every_resolver() {
        let (_tmp, workspace, outside) = workspace_with_a_neighbour();
        let root = Some(workspace.as_path());

        assert!(resolve_path_for_read(&outside, root, WorkspaceAccess::Full).is_ok());
        assert!(resolve_path_with_access(&outside, root, WorkspaceAccess::Full).is_ok());
        assert!(resolve_path_for_create(&outside, root, WorkspaceAccess::Full).is_ok());
    }

    /// The strictest mode is unchanged by any of this — the whole point of a
    /// default is that it did not quietly widen.
    #[test]
    fn the_strict_mode_still_refuses_all_three() {
        let (_tmp, workspace, outside) = workspace_with_a_neighbour();
        let root = Some(workspace.as_path());

        for resolve in [
            resolve_path_for_read(&outside, root, WorkspaceAccess::Workspace),
            resolve_path_with_access(&outside, root, WorkspaceAccess::Workspace),
            resolve_path_for_create(&outside, root, WorkspaceAccess::Workspace),
        ] {
            assert!(matches!(resolve, Err(ToolError::PolicyViolation(_))));
        }
    }

    /// An in-workspace path resolves the same way in every mode. Widening the
    /// boundary must not change where ordinary work lands.
    #[test]
    fn a_path_inside_the_project_resolves_identically_in_every_mode() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("in.txt"), "x").unwrap();
        let root = Some(workspace.as_path());
        let expected = dunce::canonicalize(workspace.join("in.txt")).unwrap();

        for access in [
            WorkspaceAccess::Workspace,
            WorkspaceAccess::Read,
            WorkspaceAccess::Full,
        ] {
            assert_eq!(
                resolve_path_with_access("in.txt", root, access).expect("in-project"),
                expected,
                "{access:?} moved an in-project path"
            );
        }
    }

    /// A MISSING file outside the workspace must be refused or allowed on the
    /// same terms as one that exists.
    ///
    /// It was not. A missing path fails canonicalization, so it arrives as
    /// `Io` rather than as a boundary rejection, and that arm never consulted
    /// the access mode. With reads switched on, an outside file that existed
    /// opened and one that did not was refused as a policy violation — so the
    /// permission looked like it was being ignored at random, and the real
    /// problem (the file is not there) never reached the caller.
    #[test]
    fn a_missing_file_outside_the_workspace_is_not_a_policy_violation_once_reads_are_allowed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        let elsewhere = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let root = Some(workspace.as_path());

        // Nothing was ever created at this path, and its parent directory does
        // not exist either — the shape that walked up to an outside ancestor.
        let missing = elsewhere.join("skills/dev-guide/references/structure.md");
        let missing = missing.to_string_lossy().to_string();

        for access in [WorkspaceAccess::Read, WorkspaceAccess::Full] {
            let resolved = resolve_path_for_read(&missing, root, access)
                .unwrap_or_else(|err| panic!("{access:?} refused a missing outside path: {err}"));
            // Returned verbatim so the reader reports a normal "does not
            // exist", which is the true fault.
            assert!(!resolved.exists());
        }

        // Workspace-only mode still refuses it, and now names the path that
        // was asked for rather than whichever ancestor happened to exist.
        let err = resolve_path_for_read(&missing, root, WorkspaceAccess::Workspace)
            .expect_err("workspace mode must still refuse an outside path");
        let message = err.to_string();
        assert!(message.contains("escapes workspace"), "{message}");
        assert!(
            message.contains("structure.md"),
            "the refusal should name the requested file, got: {message}"
        );
    }

    /// A missing file INSIDE the project keeps resolving in every mode, so the
    /// reader can answer "does not exist" instead of failing the whole call.
    #[test]
    fn a_missing_file_inside_the_project_still_resolves_in_every_mode() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let root = Some(workspace.as_path());

        for access in [
            WorkspaceAccess::Workspace,
            WorkspaceAccess::Read,
            WorkspaceAccess::Full,
        ] {
            let resolved = resolve_path_for_read("src/nope.rs", root, access)
                .unwrap_or_else(|err| panic!("{access:?} refused a missing in-project path: {err}"));
            assert!(resolved.ends_with("nope.rs"), "{access:?}: {resolved:?}");
        }
    }

    /// The wire carries two spellings. An install that upgrades without
    /// opening Settings sends only the old boolean, and it must keep the
    /// access it already had — but must never be promoted to Full, which
    /// nobody consented to.
    #[test]
    fn the_legacy_boolean_maps_to_read_and_never_to_full() {
        use WorkspaceAccess as W;
        assert_eq!(W::from_wire(None, Some(true)), W::Read);
        assert_eq!(W::from_wire(None, Some(false)), W::Workspace);
        assert_eq!(W::from_wire(None, None), W::Workspace);

        // The mode wins wherever it is present.
        assert_eq!(W::from_wire(Some("full"), Some(false)), W::Full);
        assert_eq!(W::from_wire(Some("workspace"), Some(true)), W::Workspace);
        assert_eq!(W::from_wire(Some("read"), None), W::Read);

        // Anything unrecognised falls back — it never widens.
        assert_eq!(W::from_wire(Some("everything"), None), W::Workspace);
        assert_eq!(W::from_wire(Some(""), Some(true)), W::Read);
    }
}
