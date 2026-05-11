//! Workspace boundary + symlink safety primitives.
//!
//! Implements the `agent_safety::paths` contract defined by the Aurora Rust
//! agent migration master plan, § 5.3:
//!
//! - [`resolve_within_workspace`] canonicalises an input path against a
//!   canonicalised workspace root, rejects any escape (`..` traversal,
//!   absolute paths leaving the workspace, symlinks pointing outside),
//!   follows symlinks **once only**, and returns the resolved canonical
//!   path on success.
//! - [`is_within_workspace`] is the boolean shorthand.
//!
//! On Windows, [`dunce::canonicalize`] is used to strip the verbatim
//! `\\?\` UNC prefix so that `Path::starts_with` comparisons remain
//! intuitive; on other platforms, `dunce` falls through to
//! [`std::fs::canonicalize`].
//!
//! ## Note on symlink handling
//!
//! Step 4 below (the explicit `symlink_metadata` re-check) is included
//! literally per the master plan, even though `dunce::canonicalize`
//! already follows all symlinks transitively. In practice, an in-workspace
//! symlink that targets a file outside the workspace is detected at
//! step 3 — the canonical path is the (outside) target, so the
//! `starts_with` check fails and the function returns
//! [`PathSafetyError::OutsideWorkspace`]. The explicit symlink branch
//! remains as a safety belt for filesystems where canonicalisation does
//! not transparently resolve links.

use std::fs;
use std::path::{Path, PathBuf};

/// Errors returned by [`resolve_within_workspace`].
#[derive(Debug, thiserror::Error)]
pub enum PathSafetyError {
    /// The canonical resolved path is not inside the workspace.
    #[error("path escapes workspace: {0}")]
    OutsideWorkspace(PathBuf),
    /// A symlink encountered during resolution targets a location outside
    /// the workspace.
    #[error("symlink target leaves workspace: {0} -> {1}")]
    EscapingSymlink(PathBuf, PathBuf),
    /// I/O error during canonicalization or symlink inspection.
    #[error("io error during canonicalization: {0}")]
    Io(#[from] std::io::Error),
}

/// Resolve `path` against `workspace_root`, canonicalize both, and ensure
/// the resolved path is contained within the workspace. Symlinks are
/// followed **once only** and re-checked for containment.
///
/// # Algorithm
/// 1. Canonicalise `workspace_root` (via [`dunce::canonicalize`]).
/// 2. Join `path` against the canonical workspace, then canonicalise the
///    result (which transparently follows any symlinks in the chain).
/// 3. Reject if the canonical resolved path does not start with the
///    canonical workspace.
/// 4. If, despite canonicalisation, the resolved path itself reports
///    `is_symlink()` (defensive), `read_link` it, canonicalise the target
///    once, and re-check containment.
/// 5. Return the canonicalised resolved path.
///
/// # Errors
/// - [`PathSafetyError::Io`] if either canonicalisation fails (typically
///   because the path does not exist).
/// - [`PathSafetyError::OutsideWorkspace`] if the resolved path escapes the
///   workspace.
/// - [`PathSafetyError::EscapingSymlink`] if a symlink's target lies
///   outside the workspace (defensive branch).
pub fn resolve_within_workspace(
    path: &Path,
    workspace_root: &Path,
) -> Result<PathBuf, PathSafetyError> {
    // 1. Canonicalise workspace_root once.
    let canonical_root = canonicalize(workspace_root)?;

    // 2. Join + canonicalise path. `Path::join` with an absolute right
    //    operand replaces the base, which is the correct behavior.
    let joined = canonical_root.join(path);
    let canonical = canonicalize(&joined)?;

    // 3. Containment check on canonical forms.
    if !canonical.starts_with(&canonical_root) {
        return Err(PathSafetyError::OutsideWorkspace(canonical));
    }

    // 4. Defensive: if the resolved path is itself a symlink, follow it
    //    once and re-check. After step 2, this branch is unreachable on
    //    standard filesystems (canonicalisation already follows all
    //    symlinks), but we keep it as a safety belt.
    let metadata = fs::symlink_metadata(&canonical)?;
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(&canonical)?;
        let target_full = if target.is_absolute() {
            target
        } else {
            // Resolve relative target against the symlink's parent dir.
            canonical
                .parent()
                .unwrap_or(canonical_root.as_path())
                .join(&target)
        };
        let canonical_target = canonicalize(&target_full)?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err(PathSafetyError::EscapingSymlink(canonical, canonical_target));
        }
        return Ok(canonical_target);
    }

    // 5. Resolved path is contained — return it.
    Ok(canonical)
}

/// Convenience predicate: `true` iff `resolve_within_workspace` succeeds.
#[must_use]
pub fn is_within_workspace(path: &Path, workspace_root: &Path) -> bool {
    resolve_within_workspace(path, workspace_root).is_ok()
}

/// Canonicalise via `dunce` so Windows UNC `\\?\` prefixes are stripped
/// for stable `starts_with` comparisons. On non-Windows targets, `dunce`
/// transparently falls back to [`std::fs::canonicalize`].
fn canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Try to create a file symlink in a way that works on both Unix and
    /// Windows. Returns `Ok(())` on success, `Err(io::Error)` on failure
    /// (which on Windows is the typical case absent admin / dev-mode
    /// privileges).
    fn try_symlink_file(target: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (target, link);
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "symlink_file not supported on this target",
            ))
        }
    }

    #[test]
    fn resolves_relative_path_inside_workspace() {
        let tmp = TempDir::new().expect("tempdir");
        let workspace = tmp.path();
        let inside = workspace.join("inside.txt");
        fs::write(&inside, "hello").expect("write inside file");

        let resolved = resolve_within_workspace(Path::new("inside.txt"), workspace)
            .expect("relative path inside workspace should resolve");

        // Compare via canonicalisation to avoid platform-specific prefix
        // mismatches.
        let expected = canonicalize(&inside).unwrap();
        assert_eq!(resolved, expected);
        assert!(is_within_workspace(Path::new("inside.txt"), workspace));
    }

    #[test]
    fn resolves_subdir_path_inside_workspace() {
        let tmp = TempDir::new().expect("tempdir");
        let workspace = tmp.path();
        let sub = workspace.join("sub");
        fs::create_dir_all(&sub).expect("create subdir");
        let nested = sub.join("nested.txt");
        fs::write(&nested, "data").expect("write nested file");

        let resolved = resolve_within_workspace(Path::new("sub/nested.txt"), workspace)
            .expect("nested relative path should resolve");
        let expected = canonicalize(&nested).unwrap();
        assert_eq!(resolved, expected);
    }

    #[test]
    fn rejects_dotdot_escape() {
        // Layout:
        //   tmp/
        //     workspace/  (root)
        //     outside.txt
        let tmp = TempDir::new().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        fs::create_dir_all(&workspace).expect("create workspace");
        let outside = tmp.path().join("outside.txt");
        fs::write(&outside, "secret").expect("write outside file");

        let result = resolve_within_workspace(Path::new("../outside.txt"), &workspace);
        assert!(
            matches!(result, Err(PathSafetyError::OutsideWorkspace(_))),
            "expected OutsideWorkspace error, got {result:?}"
        );
        assert!(!is_within_workspace(Path::new("../outside.txt"), &workspace));
    }

    #[test]
    fn rejects_absolute_path_outside_workspace() {
        let tmp = TempDir::new().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        fs::create_dir_all(&workspace).expect("create workspace");
        let outside = tmp.path().join("absolute-outside.txt");
        fs::write(&outside, "external").expect("write outside file");

        let result = resolve_within_workspace(&outside, &workspace);
        assert!(
            matches!(result, Err(PathSafetyError::OutsideWorkspace(_))),
            "expected OutsideWorkspace, got {result:?}"
        );
    }

    #[test]
    fn returns_io_error_for_missing_path() {
        let tmp = TempDir::new().expect("tempdir");
        let workspace = tmp.path();

        let result = resolve_within_workspace(Path::new("does-not-exist.txt"), workspace);
        assert!(
            matches!(result, Err(PathSafetyError::Io(_))),
            "expected Io error for missing path, got {result:?}"
        );
    }

    #[test]
    fn accepts_symlink_with_target_inside_workspace() {
        let tmp = TempDir::new().expect("tempdir");
        let workspace = tmp.path();
        let real = workspace.join("real.txt");
        fs::write(&real, "real content").expect("write real file");

        let link = workspace.join("link.txt");
        // Runtime guard: Windows requires admin or developer mode for
        // symlink creation. If creation fails, skip rather than fail.
        if let Err(err) = try_symlink_file(&real, &link) {
            eprintln!(
                "skipping accepts_symlink_with_target_inside_workspace: cannot create symlink ({err})"
            );
            return;
        }

        let resolved = resolve_within_workspace(Path::new("link.txt"), workspace)
            .expect("symlink-to-inside should resolve");

        // dunce::canonicalize follows the symlink, so resolved equals the
        // canonical real path.
        let expected = canonicalize(&real).unwrap();
        assert_eq!(resolved, expected);
        assert!(is_within_workspace(Path::new("link.txt"), workspace));
    }

    #[test]
    fn rejects_symlink_with_target_outside_workspace() {
        // Layout:
        //   tmp/
        //     workspace/
        //       link.txt -> ../outside-target.txt
        //     outside-target.txt
        let tmp = TempDir::new().expect("tempdir");
        let workspace = tmp.path().join("workspace");
        fs::create_dir_all(&workspace).expect("create workspace");
        let outside = tmp.path().join("outside-target.txt");
        fs::write(&outside, "outside content").expect("write outside target");

        let link = workspace.join("link.txt");
        // Runtime guard for Windows symlink creation.
        if let Err(err) = try_symlink_file(&outside, &link) {
            eprintln!(
                "skipping rejects_symlink_with_target_outside_workspace: cannot create symlink ({err})"
            );
            return;
        }

        let result = resolve_within_workspace(Path::new("link.txt"), &workspace);
        // Either OutsideWorkspace (canonicalisation followed the link to
        // an outside target) or EscapingSymlink (defensive branch fired)
        // is acceptable — both indicate correct rejection.
        assert!(
            matches!(
                result,
                Err(PathSafetyError::OutsideWorkspace(_))
                    | Err(PathSafetyError::EscapingSymlink(_, _))
            ),
            "expected escape rejection, got {result:?}"
        );
    }

    #[test]
    fn is_within_workspace_matches_resolve() {
        let tmp = TempDir::new().expect("tempdir");
        let workspace = tmp.path();
        let inside = workspace.join("inside.txt");
        fs::write(&inside, "data").expect("write inside file");

        assert!(is_within_workspace(Path::new("inside.txt"), workspace));
        assert!(!is_within_workspace(
            Path::new("does-not-exist.txt"),
            workspace
        ));
    }
}
