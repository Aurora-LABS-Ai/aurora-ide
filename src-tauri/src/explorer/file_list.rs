//! Every file in a project, in one call — for the composer's `@` picker.
//!
//! The agent window has no explorer tree of its own, so the picker used to
//! build its list by calling `read_directory` once per folder from the
//! frontend, breadth first, stopping at 6,000 files. On a real project that was
//! hundreds of round trips before the first result could show, it was redone
//! after every turn, and anything past the cap simply could not be found.
//!
//! This walks the project once, in Rust, with the `ignore` crate (the walker
//! behind ripgrep): it honours `.gitignore` the way the user's tools do, keeps
//! dot-folders such as `.knowledge` and `.claude` (people mention those), and
//! never descends into `.git` or `node_modules`.

use std::path::Path;

use serde::Serialize;

/// Enough for any project a person mentions files in by name; a monorepo past
/// this is reported as cut short rather than walked forever.
pub const MAX_LISTED_FILES: usize = 50_000;

/// Folders never listed even when no `.gitignore` excludes them: their files
/// are never what someone means by `@`.
const ALWAYS_SKIPPED: [&str; 2] = [".git", "node_modules"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    /// Paths relative to the root, with `/` separators on every platform, so a
    /// query typed with `/` matches on Windows too.
    pub files: Vec<String>,
    /// The walk stopped at [`MAX_LISTED_FILES`].
    pub truncated: bool,
}

/// List the files under `root`, at most `limit`.
pub fn list_files(root: &Path, limit: usize) -> Result<FileList, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        // A project that is not a git repository still has a .gitignore that
        // says what is generated.
        .require_git(false)
        .filter_entry(|entry| {
            !(entry.file_type().is_some_and(|t| t.is_dir())
                && ALWAYS_SKIPPED.iter().any(|skip| entry.file_name() == *skip))
        })
        .build();

    let mut files = Vec::new();
    let mut truncated = false;
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        if files.len() >= limit {
            truncated = true;
            break;
        }
        files.push(rel.to_string_lossy().replace('\\', "/"));
    }
    Ok(FileList { files, truncated })
}

/// The project's files for the composer's `@` picker.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn explorer_list_files(root: String) -> Result<FileList, String> {
    tauri::async_runtime::spawn_blocking(move || list_files(Path::new(&root), MAX_LISTED_FILES))
        .await
        .map_err(|e| format!("file listing failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/apps/agent")).unwrap();
        fs::create_dir_all(root.join(".knowledge")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules/react")).unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("src/apps/agent/AgentComposer.tsx"), "").unwrap();
        fs::write(root.join(".knowledge/lesson.md"), "").unwrap();
        fs::write(root.join(".git/HEAD"), "").unwrap();
        fs::write(root.join("node_modules/react/index.js"), "").unwrap();
        fs::write(root.join("dist/bundle.js"), "").unwrap();
        fs::write(root.join(".gitignore"), "dist/\n").unwrap();
        fs::write(root.join("README.md"), "").unwrap();
        dir
    }

    #[test]
    fn lists_every_file_with_forward_slashes() {
        let dir = project();
        let list = list_files(dir.path(), 100).unwrap();
        assert!(list.files.contains(&"src/apps/agent/AgentComposer.tsx".to_string()));
        assert!(list.files.contains(&"README.md".to_string()));
        assert!(!list.truncated);
    }

    #[test]
    fn keeps_dot_folders_people_mention() {
        let dir = project();
        let list = list_files(dir.path(), 100).unwrap();
        assert!(list.files.contains(&".knowledge/lesson.md".to_string()));
        assert!(list.files.contains(&".gitignore".to_string()));
    }

    #[test]
    fn skips_git_node_modules_and_what_gitignore_excludes() {
        let dir = project();
        let list = list_files(dir.path(), 100).unwrap();
        assert!(!list.files.iter().any(|f| f.starts_with(".git/")));
        assert!(!list.files.iter().any(|f| f.starts_with("node_modules/")));
        assert!(!list.files.iter().any(|f| f.starts_with("dist/")));
    }

    #[test]
    fn says_when_it_stopped_at_the_limit() {
        let dir = project();
        let list = list_files(dir.path(), 2).unwrap();
        assert_eq!(list.files.len(), 2);
        assert!(list.truncated);
    }

    /// `FILE_LIST_ROOT=<project> cargo test --lib file_list::tests::timing -- --ignored --nocapture`
    #[test]
    #[ignore = "measures a real project"]
    fn timing() {
        let root = std::env::var("FILE_LIST_ROOT").expect("FILE_LIST_ROOT");
        let started = std::time::Instant::now();
        let list = list_files(Path::new(&root), MAX_LISTED_FILES).unwrap();
        println!(
            "{} files in {} ms (truncated: {})",
            list.files.len(),
            started.elapsed().as_millis(),
            list.truncated
        );
    }

    #[test]
    fn a_missing_root_is_an_error_not_an_empty_list() {
        assert!(list_files(Path::new("Z:/definitely/not/here"), 10).is_err());
    }
}
