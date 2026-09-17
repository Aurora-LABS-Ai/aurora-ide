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

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};

/// Characters Windows refuses to store in a file name.
///
/// `:` is absent because it is legal exactly once, as the drive separator, and
/// [`unstorable_path_reason`] checks the components rather than the whole
/// string so the drive letter never reaches this list.
#[cfg(windows)]
const WINDOWS_ILLEGAL: &[char] = &['<', '>', '"', '|', '?', '*'];

/// `cmd`-era device names. These are not files anywhere on the filesystem, so
/// `CON.txt` is as unusable as `CON`.
#[cfg(windows)]
const WINDOWS_DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Why this path cannot exist on this platform, in a sentence naming the
/// offending part, or `None` if it is storable.
///
/// ## Why the shape is checked before the filesystem is touched
///
/// A malformed name does not fail with "that name is malformed". It fails
/// with whatever the OS says about the syscall it refused, and on Windows that
/// is `ERROR_INVALID_NAME` — surfaced as *"The filename, directory name, or
/// volume label syntax is incorrect. (os error 123)"*, attached to whichever
/// call happened to run first. Measured on thread `7ca13ebb` (2026-09-03), a
/// gateway-flattened argument became the filename and the write failed at
/// `create_dir_all`, so the error read as a folder-creation bug and was
/// reported as one.
///
/// `tools::arguments` now stops that particular argument at the door. This is
/// the layer under it: whatever produced the name, the caller is told what is
/// wrong with the name. Claude Code validates the same way and for the same
/// reason — its own rule refuses a path "containing `\"` `%` CR LF NUL, [or]
/// ending with a dot or space" before it goes near the disk.
#[must_use]
pub fn unstorable_path_reason(path: &str) -> Option<String> {
    // Every platform. A NUL terminates the string inside the syscall, so the
    // path that gets acted on is not the path that was asked for.
    if path.contains('\0') {
        return Some(format!(
            "`{}` contains a NUL byte, which no filesystem can store.",
            path.escape_debug()
        ));
    }

    #[cfg(windows)]
    {
        for component in path.split(['/', '\\']) {
            // Not names: a drive qualifier (`E:`), the empty strings a leading
            // or doubled separator produces, and the two relative components.
            //
            // `.` and `..` are exempt explicitly because they would otherwise
            // fail the trailing-dot rule below — which would turn every
            // `../escape.txt` from a workspace-boundary refusal into a
            // "bad name" one, losing the reason that actually matters.
            if component.is_empty()
                || component == "."
                || component == ".."
                || is_drive_qualifier(component)
            {
                continue;
            }
            if let Some(bad) = component.chars().find(|c| WINDOWS_ILLEGAL.contains(c)) {
                return Some(format!(
                    "`{component}` contains `{bad}`, which Windows cannot store in a file or \
                     folder name (illegal: {}). If this came from a tool argument, check that \
                     the path was not sent wrapped in quotes or brackets.",
                    WINDOWS_ILLEGAL.iter().collect::<String>()
                ));
            }
            if let Some(bad) = component.chars().find(|c| (*c as u32) < 0x20) {
                return Some(format!(
                    "`{component}` contains a control character (U+{:04X}), which Windows cannot \
                     store in a file or folder name.",
                    bad as u32
                ));
            }
            // A stray `:` anywhere but the drive qualifier is an NTFS
            // alternate-data-stream separator, not part of the name.
            if component.contains(':') {
                return Some(format!(
                    "`{component}` contains `:`, which Windows allows only as a drive separator \
                     (`E:\\…`)."
                ));
            }
            if component.ends_with('.') || component.ends_with(' ') {
                return Some(format!(
                    "`{component}` ends with a dot or a space. Windows silently strips those, so \
                     the file would not be at the path you asked for."
                ));
            }
            let stem = component
                .split('.')
                .next()
                .unwrap_or(component)
                .to_ascii_lowercase();
            if WINDOWS_DEVICE_NAMES.contains(&stem.as_str()) {
                return Some(format!(
                    "`{component}` is a reserved Windows device name (`{stem}`) and cannot be a \
                     file or folder."
                ));
            }
        }
    }

    None
}

/// Is this component a bare drive qualifier, like `E:`?
#[cfg(windows)]
fn is_drive_qualifier(component: &str) -> bool {
    let mut chars = component.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(letter), Some(':'), None) if letter.is_ascii_alphabetic()
    )
}

/// Rewrite a Git Bash / MSYS mount path into the form Windows understands.
///
/// `/e/VOID-EDITOR/x` and `E:\VOID-EDITOR\x` are the same place, and the first
/// spelling is what a POSIX shell on Windows prints — so it is what the model
/// copies out of `pwd`, `git rev-parse --show-toplevel`, or any `shell_execute`
/// output, and then hands to a file tool.
///
/// Left alone, that path is worse than rejected. `Path::new("/e/x")` on Windows
/// has a root but no prefix, so joining it against the workspace replaces
/// everything except the drive and yields `C:\e\x` — a path that is not the one
/// asked for, does not exist, and reports itself as simply missing.
///
/// Only `^/<letter>/` is touched, which no workspace-relative path can be
/// (a relative path has no leading separator) and no real directory on a
/// Windows drive root realistically is.
#[must_use]
pub fn normalize_platform_path(path: &str) -> Cow<'_, str> {
    #[cfg(windows)]
    {
        let bytes = path.as_bytes();
        let is_mount_form = bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b'/';
        if is_mount_form {
            let drive = path[1..2].to_ascii_uppercase();
            let rest = path[3..].replace('/', "\\");
            return Cow::Owned(format!("{drive}:\\{rest}"));
        }
    }
    Cow::Borrowed(path)
}

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
            return Err(PathSafetyError::EscapingSymlink(
                canonical,
                canonical_target,
            ));
        }
        return Ok(canonical_target);
    }

    // 5. Resolved path is contained — return it.
    Ok(canonical)
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
        assert!(resolve_within_workspace(Path::new("inside.txt"), workspace).is_ok());
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
        assert!(resolve_within_workspace(Path::new("../outside.txt"), &workspace).is_err());
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
        assert!(resolve_within_workspace(Path::new("link.txt"), workspace).is_ok());
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

    /// The exact string that reached `create_dir_all` on thread `7ca13ebb`
    /// (2026-09-03) and came back as `os error 123`.
    #[test]
    fn the_flattened_argument_that_caused_os_error_123_is_named_as_a_bad_name() {
        let reason = unstorable_path_reason(r#"["app/(site)/portfolio/page.tsx"]"#);
        #[cfg(windows)]
        {
            let reason = reason.expect("a quote cannot be stored in a Windows name");
            assert!(reason.contains('"'), "names the offending character: {reason}");
        }
        #[cfg(not(windows))]
        assert!(reason.is_none(), "POSIX stores quotes happily");
    }

    #[test]
    fn a_nul_byte_is_refused_on_every_platform() {
        let reason = unstorable_path_reason("src/a\0.rs").expect("NUL is never storable");
        assert!(reason.contains("NUL"), "{reason}");
    }

    /// The narrowing has to survive: real paths, including the awkward ones
    /// a Next.js or Rust project produces, must pass untouched.
    #[test]
    fn ordinary_paths_are_storable() {
        for path in [
            "src/main.rs",
            "src/app/api/[...path]/route.ts",
            "app/(site)/portfolio/page.tsx",
            r"E:\VOID-EDITOR\Aurora-Agent-IDE\src-tauri\src\lib.rs",
            "E:/VOID-EDITOR/Aurora-Agent-IDE/README.md",
            "packages/web/node_modules/.cache/x",
            "a-b_c.d.e.ts",
            "src/über/naïve.ts",
            // The relative components are path syntax, not names. Judging them
            // as names made every `../x` a "bad name" instead of a workspace
            // escape, which is a different and much less useful refusal.
            "../outside.txt",
            "./src/main.rs",
            "src/../src/main.rs",
            "../../etc/passwd",
        ] {
            assert_eq!(
                unstorable_path_reason(path),
                None,
                "{path} must be storable"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_specific_unstorable_names_are_each_explained() {
        for (path, expected) in [
            ("src/a<b.rs", "<"),
            ("src/a|b.rs", "|"),
            ("src/a?b.rs", "?"),
            ("src/trailing./x.rs", "dot or a space"),
            ("src/trailing /x.rs", "dot or a space"),
            ("src/CON", "reserved"),
            ("src/nul.txt", "reserved"),
            ("src/a:stream.rs", "drive separator"),
        ] {
            let reason =
                unstorable_path_reason(path).unwrap_or_else(|| panic!("{path} must be refused"));
            assert!(
                reason.contains(expected),
                "{path} should mention {expected:?}, got: {reason}"
            );
        }
    }

    /// A drive qualifier is not a name, so it must not trip the `:` check.
    #[cfg(windows)]
    #[test]
    fn a_drive_letter_is_not_an_alternate_data_stream() {
        assert_eq!(unstorable_path_reason(r"E:\project\src\main.rs"), None);
        assert_eq!(unstorable_path_reason("c:/project/src/main.rs"), None);
    }

    /// `/e/x` is where a POSIX shell on Windows says `E:\x` is. Joined
    /// unconverted it becomes `C:\e\x`, which is a different, missing place.
    #[test]
    fn the_git_bash_mount_form_becomes_a_windows_path() {
        let converted = normalize_platform_path("/e/VOID-EDITOR/Aurora-Agent-IDE/README.md");
        #[cfg(windows)]
        assert_eq!(converted, r"E:\VOID-EDITOR\Aurora-Agent-IDE\README.md");
        #[cfg(not(windows))]
        assert_eq!(converted, "/e/VOID-EDITOR/Aurora-Agent-IDE/README.md");
    }

    /// Everything that is not the mount form is returned untouched, and
    /// borrowed rather than copied.
    #[test]
    fn other_paths_pass_through_unchanged() {
        for path in [
            "src/main.rs",
            "./src/main.rs",
            r"E:\project\src",
            "/usr/local/bin/tool",
            "/etc/hosts",
            // A single leading segment that is not one letter.
            "/home/alvan/x",
            "/",
        ] {
            assert_eq!(normalize_platform_path(path), path, "{path} must not change");
        }
    }

    #[test]
    fn resolve_reports_containment_as_result() {
        let tmp = TempDir::new().expect("tempdir");
        let workspace = tmp.path();
        let inside = workspace.join("inside.txt");
        fs::write(&inside, "data").expect("write inside file");

        assert!(resolve_within_workspace(Path::new("inside.txt"), workspace).is_ok());
        assert!(resolve_within_workspace(Path::new("does-not-exist.txt"), workspace).is_err());
    }
}
