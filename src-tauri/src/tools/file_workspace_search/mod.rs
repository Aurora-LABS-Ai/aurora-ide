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
//! ## Tool roster
//!
//! | name                   | wraps                                                             |
//! |------------------------|-------------------------------------------------------------------|
//! | `file_read`            | `commands::read_file_content` + `editor_ops::slice_file_lines`    |
//! | `file_write`           | `commands::write_file_content`                                    |
//! | `file_patch`           | `commands::editor_ops::apply_search_replace` (alias)              |
//! | `file_create`          | `commands::create_file` + `commands::write_file_content`          |
//! | `file_delete`          | `commands::delete_path`                                           |
//! | `file_exists`          | `std::fs::metadata` (no command needed)                           |
//! | `grep`                 | `commands::ripgrep_search`                                        |
//! | `multi_file_read`      | `commands::read_files_batch`                                      |
//! | `search_replace`       | `commands::editor_ops::apply_search_replace`                      |
//! | `multi_search_replace` | `commands::editor_ops::apply_multi_search_replace`                |
//! | `workspace_tree`       | `commands::read_directory` (recursed via manual stack)            |
//! | `folder_create`        | `commands::create_folder`                                         |
//! | `folder_delete`        | `commands::delete_path`                                           |
//! | `aurora_search`        | semantic indexer is not shipped (returns informational error)     |
//! | `auroro_websearch`     | `commands::aurora_websearch`                                      |
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

pub mod aurora_search;
pub mod auroro_websearch;
pub mod file_create;
pub mod file_delete;
pub mod file_exists;
pub mod file_patch;
pub mod file_read;
pub mod file_write;
pub mod folder_create;
pub mod folder_delete;
pub mod grep;
pub mod multi_file_read;
pub mod multi_search_replace;
pub mod search_replace;
pub mod workspace_tree;

/// Register every tool in this bucket against `reg`. Idempotent: a
/// re-registration overwrites the existing entry (this is what the
/// underlying `ToolRegistry` does).
///
/// `sink` is shared across every mutating tool (`file_write`,
/// `file_create`, `file_patch`, `search_replace`,
/// `multi_search_replace`, `file_delete`, `folder_create`,
/// `folder_delete`) so they can fire the `agent_file_changed` Tauri
/// event after a successful disk write — that's how open Monaco
/// buffers, the explorer tree, and the pending-changes diff UI find
/// out that disk just moved. Pass [`NoopIdeEventSink`] in unit tests
/// that don't care about emissions.
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
    reg.register(Arc::new(file_write::FileWriteTool::new(sink.clone())));
    reg.register(Arc::new(file_patch::FilePatchTool::new(sink.clone())));
    reg.register(Arc::new(file_create::FileCreateTool::new(sink.clone())));
    reg.register(Arc::new(file_delete::FileDeleteTool::new(sink.clone())));
    reg.register(Arc::new(file_exists::FileExistsTool));
    reg.register(Arc::new(grep::GrepTool));
    reg.register(Arc::new(multi_file_read::MultiFileReadTool));
    reg.register(Arc::new(search_replace::SearchReplaceTool::new(sink.clone())));
    reg.register(Arc::new(multi_search_replace::MultiSearchReplaceTool::new(
        sink.clone(),
    )));
    reg.register(Arc::new(workspace_tree::WorkspaceTreeTool));
    reg.register(Arc::new(folder_create::FolderCreateTool::new(sink.clone())));
    reg.register(Arc::new(folder_delete::FolderDeleteTool::new(sink)));
    reg.register(Arc::new(aurora_search::AuroraSearchTool));
    reg.register(Arc::new(auroro_websearch::AuroroWebSearchTool));
}

/// The 15 tool names this bucket registers, in roster order. Used
/// by the bucket-level smoke test and by Sub-E's composer test.
pub const TOOL_NAMES: &[&str] = &[
    "file_read",
    "file_write",
    "file_patch",
    "file_create",
    "file_delete",
    "file_exists",
    "grep",
    "multi_file_read",
    "search_replace",
    "multi_search_replace",
    "workspace_tree",
    "folder_create",
    "folder_delete",
    "aurora_search",
    "auroro_websearch",
];

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

    let leaf = absolute.file_name().ok_or_else(|| {
        ToolError::InvalidInput(format!("path has no file name: {}", path))
    })?;

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
    let body = if has_bom { &bytes[UTF8_BOM.len()..] } else { &bytes[..] };
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
    fn register_mounts_all_15_tools() {
        let mut reg = ToolRegistry::new();
        register(&mut reg, test_sink());
        assert_eq!(reg.len(), TOOL_NAMES.len(), "expected 15 tools in bucket");

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
            resolve_path_for_create("new-file.txt", Some(tmp.path())).expect("ok");
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
}
