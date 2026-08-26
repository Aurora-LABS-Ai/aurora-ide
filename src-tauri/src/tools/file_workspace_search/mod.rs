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
//! | `file_read`        | read one file or many — `path` takes a string or an array; missing → exists:false |
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
//! `file_read`), `search_replace` (diff/result helpers for `file_edit` /
//! `file_write`), `read_tracker` (read-before-edit state).
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
//! - When `ctx.workspace_root` is `None`: passes the path through
//!   verbatim, on the contract's "absolute paths accepted as-is"
//!   rule.

use std::path::{Path, PathBuf};

use crate::agent_runtime::tool_executor::{ToolError, ToolRegistry};
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
pub mod move_path;
/// Internal: the parallel batch reader, reused by `file_read`'s array
/// form. Not registered as a standalone tool.
pub mod multi_file_read;
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
pub fn register(
    reg: &mut ToolRegistry,
    sink: std::sync::Arc<dyn crate::tools::shell_editor_todo::IdeEventSink>,
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
    reg.register(Arc::new(auroro_websearch::AuroroWebSearchTool));
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
    let raw = Path::new(path);
    match workspace_root {
        Some(root) => resolve_within_workspace(raw, root).map_err(map_path_error),
        None => Ok(raw.to_path_buf()),
    }
}

/// Resolve a path for read-only tools. Existing paths use the
/// strict canonical resolver; missing leaves inside the workspace are
/// still returned so the reader can report a normal `success=false`
/// payload instead of failing the whole tool call.
pub(crate) fn resolve_path_for_read(
    path: &str,
    workspace_root: Option<&Path>,
    allow_outside: bool,
) -> Result<PathBuf, ToolError> {
    resolve_path_for_read_with_spill(path, workspace_root, allow_outside, None)
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
pub(crate) fn resolve_path_for_read_with_spill(
    path: &str,
    workspace_root: Option<&Path>,
    allow_outside: bool,
    spill_dir: Option<&Path>,
) -> Result<PathBuf, ToolError> {
    let raw = Path::new(path);
    if let Some(dir) = spill_dir {
        if is_inside(raw, dir) {
            return Ok(raw.to_path_buf());
        }
    }
    let Some(root) = workspace_root else {
        return Ok(raw.to_path_buf());
    };

    match resolve_within_workspace(raw, root) {
        Ok(resolved) => Ok(resolved),
        Err(PathSafetyError::Io(_)) => resolve_missing_path_inside_workspace(raw, root),
        // A boundary rejection (path resolves OUTSIDE the workspace) is only
        // fatal when the user hasn't opted into out-of-workspace reads. When they
        // have, resolve the path on its own — absolute as-is, relative against
        // the workspace — so the reader can open it.
        Err(error) => {
            if allow_outside {
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
    let resolved_ancestor =
        resolve_within_workspace(&existing_ancestor, root).map_err(map_path_error)?;
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
pub(crate) fn resolve_path_for_create(
    path: &str,
    workspace_root: Option<&Path>,
) -> Result<PathBuf, ToolError> {
    let raw = Path::new(path);
    let Some(root) = workspace_root else {
        return Ok(raw.to_path_buf());
    };

    // First try a straight resolution — handles the case where the
    // file already exists (file_write overwriting an existing
    // file).
    if let Ok(resolved) = resolve_within_workspace(raw, root) {
        return Ok(resolved);
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
        register(&mut reg, test_sink());
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
        register(&mut reg, test_sink());
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

    #[test]
    fn resolve_path_returns_path_verbatim_without_workspace() {
        let resolved = resolve_path("/tmp/whatever", None).expect("ok");
        assert_eq!(resolved, std::path::PathBuf::from("/tmp/whatever"));
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

        let resolved = resolve_path_for_read("missing.txt", Some(tmp.path()), false).expect("ok");
        let expected_parent = dunce::canonicalize(tmp.path()).unwrap();
        assert_eq!(resolved.parent().unwrap(), expected_parent);
        assert_eq!(resolved.file_name().unwrap(), "missing.txt");
    }

    #[test]
    fn resolve_path_for_read_rejects_missing_escape() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();

        let result = resolve_path_for_read("../outside-missing.txt", Some(&workspace), false);
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
        let resolved = resolve_path_for_create("new-file.txt", Some(tmp.path())).expect("ok");
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
        let result = resolve_path_for_create("../escape.txt", Some(&workspace));
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
            resolve_path_for_read(&spilled.to_string_lossy(), Some(&workspace), false),
            Err(_)
        ));

        // With it, the same path resolves — and `allow_outside` is still false.
        let resolved = resolve_path_for_read_with_spill(
            &spilled.to_string_lossy(),
            Some(&workspace),
            false,
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
            false,
            Some(&spill),
        )
        .is_err());

        // Nor is anything reached by walking back out of it.
        let escape = spill.join("..").join("..").join("secrets.txt");
        assert!(resolve_path_for_read_with_spill(
            &escape.to_string_lossy(),
            Some(&workspace),
            false,
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
            false,
            Some(&spill),
        )
        .is_err());
    }
}
