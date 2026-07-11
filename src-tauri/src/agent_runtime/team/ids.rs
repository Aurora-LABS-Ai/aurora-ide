//! Stable `projectId` resolution for the Agent Team shared brain.
//!
//! One opened project → one workspace dir under
//! `~/.aurora/projects/<projectId>/` (ground truth §6). The id must be
//! **stable across sessions** for the same repo so the team rehydrates
//! from the same brain every time the user reopens the project — and
//! **insensitive** to cosmetic path differences (trailing slash,
//! relative vs absolute, Windows drive-letter case).
//!
//! We mirror the hashing approach already used by the checkpoint
//! service (`DefaultHasher` over the workspace path) so the team brain
//! shares Aurora's existing notion of workspace identity, but we first
//! canonicalize the path so the same repo always lands on the same id.

#![allow(dead_code)]

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

/// Resolve a stable `projectId` for an opened workspace/repo path.
///
/// The id is the hex hash of the *canonicalized* repo path. Two spellings
/// of the same repo (`C:\Repo`, `c:\repo\`, a symlink, …) resolve to one
/// id, so the project always maps to the same `~/.aurora` brain.
#[must_use]
pub fn project_id_for(repo_path: &str) -> String {
    let canonical = canonicalize_for_id(repo_path);
    let mut hasher = DefaultHasher::new();
    canonical.hash(&mut hasher);
    // 16 hex chars (zero-padded) — short, filesystem-safe, collision
    // risk is negligible for the handful of repos a user opens.
    format!("{:016x}", hasher.finish())
}

/// Normalize a repo path into the canonical string we hash.
///
/// Falls back to the trimmed input when the path can't be canonicalized
/// (e.g. it doesn't exist yet) so id resolution never fails — it just
/// becomes "stable for this exact spelling" in that degenerate case.
fn canonicalize_for_id(repo_path: &str) -> String {
    let trimmed = repo_path.trim().trim_end_matches(['/', '\\']);
    let canonical = Path::new(trimmed)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| trimmed.to_string());

    // Windows filesystems are case-insensitive, so fold case to keep
    // `C:\Repo` and `c:\repo` on the same brain. POSIX paths are
    // case-sensitive — leave them untouched.
    if cfg!(windows) {
        canonical.to_lowercase()
    } else {
        canonical
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_path_yields_same_id() {
        let a = project_id_for("/some/repo");
        let b = project_id_for("/some/repo");
        assert_eq!(a, b);
    }

    #[test]
    fn trailing_separator_does_not_change_id() {
        // Non-existent path so canonicalize falls back to the trimmed
        // string — exercises the slash-trimming branch deterministically.
        let a = project_id_for("/nope/repo");
        let b = project_id_for("/nope/repo/");
        assert_eq!(a, b);
    }

    #[test]
    fn different_paths_yield_different_ids() {
        let a = project_id_for("/repo/one");
        let b = project_id_for("/repo/two");
        assert_ne!(a, b);
    }

    #[test]
    fn id_is_16_hex_chars() {
        let id = project_id_for("/whatever/path");
        assert_eq!(id.len(), 16, "id: {id}");
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "id: {id}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_case_is_folded() {
        let a = project_id_for(r"C:\Nope\Repo");
        let b = project_id_for(r"c:\nope\repo");
        assert_eq!(a, b);
    }
}
