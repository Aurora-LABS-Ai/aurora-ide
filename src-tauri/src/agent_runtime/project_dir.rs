//! Workspace-owned storage, shared by conversations and the code index.
//!
//! Slugs are readable but lossy. `project.json` is the authority for which
//! workspace owns a directory; a collision must never combine two projects.

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

pub const MAX_SLUG_LEN: usize = 120;
pub const UNSCOPED: &str = "_unscoped";

static OPEN_LOCK: Mutex<()> = Mutex::new(());
// Include the root so separate registries and test fixtures cannot share hits.
static LOCATIONS: LazyLock<DashMap<(PathBuf, String), PathBuf>> = LazyLock::new(DashMap::new);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMetadata {
    workspace_root: String,
    created_at: String,
    last_opened_at: String,
}

/// The same path identity used for both project routing and scoped listings.
pub fn normalize(workspace: &Path) -> String {
    let normalized = workspace
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase();
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() && !normalized.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

fn hash8(normalized: &str) -> String {
    Sha256::digest(normalized.as_bytes())[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A stable, bounded folder name; the hash is independent of Rust's version.
pub fn slug(workspace: &Path) -> String {
    let normalized = normalize(workspace);
    let mut name: String = normalized
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    // Reserved Windows filenames are possible for relative workspace names.
    if name.is_empty()
        || matches!(name.as_str(), "con" | "prn" | "aux" | "nul")
        || (name.len() == 4
            && (name.starts_with("com") || name.starts_with("lpt"))
            && matches!(name.as_bytes()[3], b'1'..=b'9'))
    {
        name.insert(0, '-');
    }
    if name.len() > MAX_SLUG_LEN {
        name.truncate(MAX_SLUG_LEN - 9);
        name.push('-');
        name.push_str(&hash8(&normalized));
    }
    name
}

/// Explicit root ownership keeps tests and CLI callers off the live app data.
#[derive(Debug, Clone)]
pub struct ProjectDirs {
    root: PathBuf,
}

impl ProjectDirs {
    pub fn with_root(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Create or validate this workspace's folder, preserving its real spelling.
    pub fn open_or_create(&self, workspace: &Path) -> io::Result<PathBuf> {
        let normalized = normalize(workspace);
        if normalized.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "workspace path is empty",
            ));
        }
        let _guard = OPEN_LOCK
            .lock()
            .map_err(|_| io::Error::other("project directory lock poisoned"))?;
        fs::create_dir_all(&self.root)?;
        // CLI readers can open projects while the GUI is running. Serialize
        // the metadata check/write across processes as well as across threads.
        let project_lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join(".projects.lock"))?;
        project_lock.lock()?;
        let base = slug(workspace);
        let mut alternate = base.clone();
        alternate.truncate(MAX_SLUG_LEN - 9);
        alternate.push('-');
        alternate.push_str(&hash8(&normalized));
        for name in [base, alternate] {
            let dir = self.root.join(name);
            fs::create_dir_all(&dir)?;
            let path = dir.join("project.json");
            let now = chrono::Utc::now().to_rfc3339();
            let mut metadata = match fs::read(&path) {
                Ok(bytes) => serde_json::from_slice::<ProjectMetadata>(&bytes).map_err(|e| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("{}: {e}", path.display()),
                    )
                })?,
                Err(e) if e.kind() == io::ErrorKind::NotFound => ProjectMetadata {
                    workspace_root: workspace.to_string_lossy().into_owned(),
                    created_at: now.clone(),
                    last_opened_at: now.clone(),
                },
                Err(e) => return Err(e),
            };
            if normalize(Path::new(&metadata.workspace_root)) != normalized {
                continue;
            }
            metadata.last_opened_at = now;
            let tmp = dir.join(format!(".project-{}.tmp", uuid::Uuid::new_v4()));
            let result = (|| {
                fs::write(&tmp, serde_json::to_vec_pretty(&metadata)?)?;
                fs::rename(&tmp, &path)
            })();
            if result.is_err() {
                let _ = fs::remove_file(&tmp);
            }
            result?;
            return Ok(dir);
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "project slug and hash collision for {}",
                workspace.display()
            ),
        ))
    }

    pub fn unscoped(&self) -> io::Result<PathBuf> {
        let dir = self.root.join(UNSCOPED);
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// Only project directories, excluding loose files and the test Chat store.
    pub fn all(&self) -> io::Result<Vec<PathBuf>> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut projects = Vec::new();
        for entry in entries {
            let entry = entry?;
            if entry.file_type()?.is_dir()
                && (entry.file_name() == UNSCOPED || entry.path().join("project.json").is_file())
            {
                projects.push(entry.path());
            }
        }
        projects.sort();
        Ok(projects)
    }

    /// Locate an existing conversation. Missing IDs never get a default store.
    pub fn locate(&self, thread_id: &str) -> io::Result<Option<PathBuf>> {
        validate_thread_id(thread_id)?;
        let key = (self.root.clone(), thread_id.to_string());
        if let Some(dir) = LOCATIONS.get(&key) {
            if dir.join(thread_id).join("conversation.jsonl").is_file() {
                return Ok(Some(dir.clone()));
            }
        }
        LOCATIONS.remove(&key);
        for dir in self.all()? {
            if dir.join(thread_id).join("conversation.jsonl").is_file() {
                LOCATIONS.insert(key, dir.clone());
                return Ok(Some(dir));
            }
        }
        Ok(None)
    }
}

/// A thread ID is one portable filename component, never a path.
pub fn validate_thread_id(thread_id: &str) -> io::Result<()> {
    if thread_id.is_empty()
        || !thread_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid thread id",
        ));
    }
    Ok(())
}

pub fn projects() -> ProjectDirs {
    ProjectDirs::with_root(crate::paths::projects_dir())
}

pub fn open_or_create(workspace: &Path) -> io::Result<PathBuf> {
    projects().open_or_create(workspace)
}

pub fn locate(thread_id: &str) -> io::Result<Option<PathBuf>> {
    projects().locate(thread_id)
}

/// Clear cached locations in every registry when a conversation is removed.
pub fn forget(thread_id: &str) {
    LOCATIONS.retain(|(_, id), _| id != thread_id);
}

/// Exercise the real lookup from tool tests, using the isolated test root.
#[cfg(test)]
pub(crate) fn test_thread(thread_id: &str) -> super::session_store::SessionStore {
    let store = super::session_store::SessionStore::new_project(projects().unscoped().unwrap());
    store.ensure_thread(thread_id, None, None).unwrap();
    store
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_normalizes_case_separators_and_trailing_slashes() {
        assert_eq!(
            slug(Path::new(r"E:\VOID-EDITOR\Aurora")),
            "e--void-editor-aurora"
        );
        assert_eq!(
            slug(Path::new(r"E:\VOID-EDITOR\Aurora")),
            slug(Path::new("e:/void-editor/aurora/"))
        );
    }

    #[test]
    fn long_slugs_are_bounded_stable_and_distinct() {
        assert_eq!(hash8("abc"), "ba7816bf");
        let prefix = format!("E:/{}", "workspace/".repeat(30));
        let first = slug(Path::new(&format!("{prefix}one")));
        let second = slug(Path::new(&format!("{prefix}two")));
        assert_eq!(first.len(), MAX_SLUG_LEN);
        assert_ne!(first, second);
        assert!(first.ends_with(&hash8(&format!("{prefix}one").to_lowercase())));
    }

    #[test]
    fn colliding_workspaces_stay_separate_after_reopening() {
        let root = tempfile::tempdir().unwrap();
        let dirs = ProjectDirs::with_root(root.path().to_owned());
        let first = dirs.open_or_create(Path::new("a/b")).unwrap();
        let second = dirs.open_or_create(Path::new("a-b")).unwrap();
        assert_ne!(first, second);
        for (workspace, dir) in [("a/b", first), ("a-b", second)] {
            assert_eq!(dirs.open_or_create(Path::new(workspace)).unwrap(), dir);
            let meta: ProjectMetadata =
                serde_json::from_slice(&fs::read(dir.join("project.json")).unwrap()).unwrap();
            assert_eq!(meta.workspace_root, workspace);
        }
    }

    #[test]
    fn locate_handles_unknown_deleted_and_unscoped_threads() {
        let root = tempfile::tempdir().unwrap();
        let dirs = ProjectDirs::with_root(root.path().to_owned());
        let project = dirs.unscoped().unwrap();
        let thread = project.join("known");
        fs::create_dir(&thread).unwrap();
        fs::write(thread.join("conversation.jsonl"), "").unwrap();
        assert_eq!(dirs.locate("known").unwrap(), Some(project));
        assert_eq!(dirs.locate("missing").unwrap(), None);
        fs::remove_dir_all(thread).unwrap();
        assert_eq!(dirs.locate("known").unwrap(), None);
        assert!(dirs.locate("../outside").is_err());
    }

    #[test]
    fn equivalent_workspaces_keep_the_original_spelling() {
        let root = tempfile::tempdir().unwrap();
        let dirs = ProjectDirs::with_root(root.path().to_owned());
        let first = dirs.open_or_create(Path::new(r"E:\Project")).unwrap();
        assert_eq!(first, dirs.open_or_create(Path::new("e:/project")).unwrap());
        let meta: ProjectMetadata =
            serde_json::from_slice(&fs::read(first.join("project.json")).unwrap()).unwrap();
        assert_eq!(meta.workspace_root, r"E:\Project");
    }
}
