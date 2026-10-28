//! File reads, writes and directory listing, with the editor's file cache.
//! Backs the agent's file tools and the window's file commands.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub extension: Option<String>,
}


/// Read directory contents

///
/// Args:
///   path: Directory path to read
///   include_hidden: Whether to include hidden files/folders (starting with .)
pub async fn read_directory(
    path: String,
    include_hidden: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    list_directory(&path, include_hidden.unwrap_or(true)) // Default to showing hidden files
}

/// [`read_directory`] without the async wrapper, for the engine's own reads
/// (skills, project rules) that must list a folder exactly as the window did.
pub fn list_directory(path: &str, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(path);

    if !dir_path.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries = Vec::new();

    match fs::read_dir(dir_path) {
        Ok(read_dir) => {
            for entry in read_dir.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                let file_path = entry.path();
                let metadata = entry.metadata().ok();

                // Skip hidden files/folders if not showing hidden
                // Always show .aurora (our config folder)
                if !show_hidden && file_name.starts_with('.') && file_name != ".aurora" {
                    continue;
                }

                // Always skip .git folder (too many internal files)
                // But .gitignore, .gitattributes etc. are fine (they're files, not the .git folder)
                if file_name == ".git" {
                    continue;
                }

                // Skip large generated folders that slow down the explorer
                if file_name == "node_modules"
                    || file_name == "target"
                    || file_name == "dist"
                    || file_name == ".pnpm"
                {
                    continue;
                }

                let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let is_file = metadata.as_ref().map(|m| m.is_file()).unwrap_or(false);
                let extension = file_path
                    .extension()
                    .map(|e| e.to_string_lossy().to_string());

                entries.push(FileEntry {
                    name: file_name,
                    path: file_path.to_string_lossy().to_string(),
                    is_dir,
                    is_file,
                    extension,
                });
            }
        }
        Err(e) => return Err(format!("Failed to read directory: {}", e)),
    }

    // Sort: directories first, then files, alphabetically
    // Hidden files (starting with .) are sorted among their peers
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Maximum wall-clock time we'll wait for a file read before giving up so a
/// frozen disk or network share can never make the editor "load forever".
const FILE_READ_TIMEOUT_MS: u64 = 10_000;

/// Read file content (cached for performance, bounded by a wall-clock timeout)
pub async fn read_file_content(path: String) -> Result<String, String> {
    let read_path = path.clone();
    let join = tokio::task::spawn_blocking(move || crate::file_cache::read_file_cached(&read_path));

    match tokio::time::timeout(std::time::Duration::from_millis(FILE_READ_TIMEOUT_MS), join).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(format!("Failed to load file: {}", e)),
        Err(_) => Err(format!(
            "File read timed out after {}ms (path: {})",
            FILE_READ_TIMEOUT_MS, path
        )),
    }
}

/// Read file content + metadata (size + mtime) in a single IPC round-trip.
/// The editor uses this so a tab can be mounted with the canonical freshness
/// stamp captured at read time, eliminating the need for a separate stat
/// call after every open. Goes through the same mtime-validated cache as
/// [`read_file_content`].
pub async fn read_file_with_meta(path: String) -> Result<crate::file_cache::FileMeta, String> {
    let read_path = path.clone();
    let join = tokio::task::spawn_blocking(move || {
        crate::file_cache::read_file_cached_with_meta(&read_path)
    });

    match tokio::time::timeout(std::time::Duration::from_millis(FILE_READ_TIMEOUT_MS), join).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(format!("Failed to load file: {}", e)),
        Err(_) => Err(format!(
            "File read timed out after {}ms (path: {})",
            FILE_READ_TIMEOUT_MS, path
        )),
    }
}

/// Cheap freshness probe. Returns the current disk mtime so the editor can
/// decide whether a tab's already-rendered content is still in sync without
/// re-reading the whole file. `None` is encoded as `0` so the frontend can
/// treat "missing" and "epoch" as one degenerate case.
pub async fn stat_file_mtime(path: String) -> Result<u64, String> {
    let read_path = path.clone();
    tokio::task::spawn_blocking(move || crate::file_cache::get_file_mtime(&read_path).unwrap_or(0))
        .await
        .map_err(|e| format!("mtime task failed: {}", e))
}

/// Write file content
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    let file_path = Path::new(&path);

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }

    let result = fs::write(file_path, &content).map_err(|e| format!("Failed to write file: {}", e));

    // Invalidate cache after write (file content changed)
    crate::file_cache::get_file_cache().invalidate(&path);

    result
}

/// Create a new folder
pub async fn create_folder(path: String) -> Result<(), String> {
    let dir_path = Path::new(&path);

    // Check if folder already exists
    if dir_path.exists() {
        return Err(format!("Folder already exists: {}", path));
    }

    fs::create_dir_all(dir_path).map_err(|e| format!("Failed to create folder: {}", e))
}

/// Create a new file
pub async fn create_file(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);

    // Check if file already exists
    if file_path.exists() {
        return Err(format!("File already exists: {}", path));
    }

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }

    // Create empty file
    fs::File::create(file_path).map_err(|e| format!("Failed to create file: {}", e))?;

    Ok(())
}

/// Delete a file or folder
pub async fn delete_path(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);

    if !target_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if target_path.is_dir() {
        // Invalidate all cached files under this directory
        crate::file_cache::get_file_cache().invalidate_prefix(&path);
        fs::remove_dir_all(target_path).map_err(|e| format!("Failed to delete folder: {}", e))
    } else {
        // Invalidate the specific file
        crate::file_cache::get_file_cache().invalidate(&path);
        fs::remove_file(target_path).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

/// Rename a file or folder
pub async fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    let new = Path::new(&new_path);

    if !old.exists() {
        return Err(format!("Path does not exist: {}", old_path));
    }

    if new.exists() {
        return Err(format!("Destination already exists: {}", new_path));
    }

    // Invalidate old path from cache (it's being renamed)
    let cache = crate::file_cache::get_file_cache();
    if old.is_dir() {
        cache.invalidate_prefix(&old_path);
    } else {
        cache.invalidate(&old_path);
    }

    fs::rename(old, new).map_err(|e| format!("Failed to rename: {}", e))
}

/// Copy a file or folder to a new location
pub async fn copy_path(source: String, destination: String) -> Result<(), String> {
    let src = Path::new(&source);
    let dest = Path::new(&destination);

    if !src.exists() {
        return Err(format!("Source does not exist: {}", source));
    }

    if dest.exists() {
        return Err(format!("Destination already exists: {}", destination));
    }

    // Create parent directories if needed
    if let Some(parent) = dest.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }

    if src.is_file() {
        fs::copy(src, dest).map_err(|e| format!("Failed to copy file: {}", e))?;
    } else if src.is_dir() {
        copy_dir_recursive(src, dest)?;
    }

    Ok(())
}

/// Recursively copy a directory
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create directory: {}", e))?;

    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path).map_err(|e| format!("Failed to copy file: {}", e))?;
        }
    }

    Ok(())
}

/// Forget cached file contents: one file, or everything under a folder.
pub fn invalidate_file_cache(path: &str, is_prefix: bool) {
    let cache = crate::file_cache::get_file_cache();
    if is_prefix {
        cache.invalidate_prefix(path);
    } else {
        cache.invalidate(path);
    }
}

/// Where a folder picker can start: the user's home and every drive (or `/`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemRoots {
    pub home: Option<String>,
    pub roots: Vec<String>,
}

/// The starting points for the browser's folder picker, which has no OS
/// dialog to fall back on.
pub fn filesystem_roots() -> FilesystemRoots {
    let home = dirs::home_dir().map(|p| p.to_string_lossy().to_string());
    #[cfg(target_os = "windows")]
    let roots = (b'A'..=b'Z')
        .map(|letter| format!("{}:\\", letter as char))
        .filter(|drive| Path::new(drive).exists())
        .collect();
    #[cfg(not(target_os = "windows"))]
    let roots = vec!["/".to_string()];
    FilesystemRoots { home, roots }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_exist_and_home_is_absolute() {
        let found = filesystem_roots();
        assert!(!found.roots.is_empty());
        for root in &found.roots {
            assert!(Path::new(root).is_dir(), "{root} is not a folder");
        }
        if let Some(home) = found.home {
            assert!(Path::new(&home).is_absolute());
        }
    }
}
