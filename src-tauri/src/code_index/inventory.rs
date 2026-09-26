//! App-owned cache inventory. Project IDs are directory names, never supplied paths.
use anyhow::{Context, Result};
use serde::Serialize;
use std::{fs, path::{Path, PathBuf}};
use crate::agent_runtime::project_dir::{ProjectDirs, validate_thread_id};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredIndex {
    pub project_id: String,
    pub workspace: String,
    pub bytes: u64,
    pub updated_at: Option<u64>,
    pub building: bool,
    pub workspace_exists: bool,
}

fn owned_project(dirs: &ProjectDirs, id: &str) -> Result<(PathBuf, String)> {
    validate_thread_id(id)?;
    let project = dirs.root().join(id);
    ensure_regular(&project)?;
    let root = dunce::canonicalize(dirs.root())?;
    anyhow::ensure!(dunce::canonicalize(&project)?.parent() == Some(root.as_path()), "Invalid project storage path.");
    ensure_regular(&project.join("project.json"))?;
    let meta: serde_json::Value = serde_json::from_slice(&fs::read(project.join("project.json"))?)?;
    let workspace = meta.get("workspaceRoot").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).context("Project has no workspace path")?.to_owned();
    Ok((project, workspace))
}

fn ensure_regular(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).with_context(|| format!("Reading {}", path.display()))?;
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt;
      anyhow::ensure!(meta.file_attributes() & 0x400 == 0, "Linked index storage is not supported: {}", path.display()); }
    anyhow::ensure!(!meta.file_type().is_symlink(), "Linked index storage is not supported: {}", path.display());
    Ok(())
}

fn cache_files(path: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
        Ok(_) => ensure_regular(path)?,
    }
    if path.is_dir() {
        for entry in fs::read_dir(path)? { cache_files(&entry?.path(), out)?; }
    } else if path.file_name().is_none_or(|name| name != "settings.json") {
        out.push(path.to_path_buf());
    }
    Ok(())
}

pub fn list(dirs: &ProjectDirs) -> Result<Vec<StoredIndex>> {
    let mut rows = Vec::new();
    for project in dirs.all()? {
        let id = project.file_name().context("Project has no ID")?.to_string_lossy().into_owned();
        if id == crate::agent_runtime::project_dir::UNSCOPED { continue; }
        let (project, workspace) = owned_project(dirs, &id)?;
        let mut files = Vec::new();
        cache_files(&project.join("code-index"), &mut files)?;
        cache_files(&project.join("code-index.json"), &mut files)?;
        let mut bytes = 0; let mut updated_at = None;
        for path in files {
            let meta = fs::metadata(path)?;
            bytes += meta.len();
            if let Ok(time) = meta.modified() {
                let ms = time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                updated_at = Some(updated_at.unwrap_or(0).max(ms));
            }
        }
        let building = super::jobs::manager().status(&project.join("code-index"))?.is_some_and(|job| job.phase.running());
        rows.push(StoredIndex { project_id: id, workspace_exists: Path::new(&workspace).is_dir(), workspace, bytes, updated_at, building });
    }
    rows.sort_by(|a,b| b.bytes.cmp(&a.bytes).then(a.workspace.cmp(&b.workspace)));
    Ok(rows)
}

pub fn delete(dirs: &ProjectDirs, id: &str) -> Result<()> {
    let (project, workspace) = owned_project(dirs, id)?;
    let directory = project.join("code-index");
    super::jobs::manager().delete_idle(&directory, || {
        super::service().remove_saved(Path::new(&workspace), || {
            let mut files = Vec::new();
            cache_files(&directory, &mut files)?;
            cache_files(&project.join("code-index.json"), &mut files)?;
            // Validate the entire tree first. Remove only collected cache files;
            // settings and conversation directories are never targets.
            for path in files { fs::remove_file(&path).with_context(|| format!("Deleting {}", path.display()))?; }
            Ok(())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lists_sizes_and_deletes_only_the_selected_cache_even_if_workspace_disappears() {
        let temp = tempfile::tempdir().unwrap();
        let dirs = ProjectDirs::with_root(temp.path().join("projects"));
        let mut ids = Vec::new();
        for name in ["a", "b"] {
            let project = dirs.open_or_create(&temp.path().join(name)).unwrap();
            fs::create_dir_all(project.join("code-index/summaries")).unwrap();
            fs::create_dir_all(project.join("conversation")).unwrap();
            fs::write(project.join("conversation/conversation.jsonl"), "keep").unwrap();
            fs::write(project.join("code-index/structural.json"), "12345").unwrap();
            fs::write(project.join("code-index/summaries/old.json"), "123").unwrap();
            fs::write(project.join("code-index/settings.json"), "{}").unwrap();
            fs::write(project.join("code-index.json"), "12").unwrap();
            ids.push(project.file_name().unwrap().to_string_lossy().into_owned());
        }
        assert_eq!(list(&dirs).unwrap()[0].bytes, 10);
        delete(&dirs, &ids[0]).unwrap();
        let rows = list(&dirs).unwrap();
        assert_eq!(rows.iter().find(|r| r.project_id == ids[0]).unwrap().bytes, 0);
        assert_eq!(rows.iter().find(|r| r.project_id == ids[1]).unwrap().bytes, 10);
        assert!(dirs.root().join(&ids[0]).join("conversation/conversation.jsonl").is_file());
        assert!(dirs.root().join(&ids[0]).join("code-index/settings.json").is_file());
        assert!(delete(&dirs, "../outside").is_err());
    }
}
