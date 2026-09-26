//! Tauri commands behind the Settings → Agent index panel.
//!
//! Local indexing runs in project-owned background jobs without a model.
//!
//! [`status`](code_index_status) deliberately does NOT build. A panel that
//! indexes the workspace merely by being opened would stall Settings on a large
//! repository and surprise someone who only wanted to look.

use std::path::PathBuf;

use crate::code_index::{
    jobs::{self, BuildStatus, IndexSettings},
};
use crate::code_index::{service, IndexProbe, IndexStatus};

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| format!("The indexing task stopped: {e}"))?
        .map_err(|e| format!("{e:#}"))
}

fn workspace(path: String) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("No workspace is open, so there is nothing to index.".into());
    }
    Ok(PathBuf::from(trimmed))
}

/// What is known right now, without building anything.
#[tauri::command]
pub async fn code_index_status(workspace_path: String) -> Result<IndexStatus, String> {
    let root = workspace(workspace_path)?;
    blocking(move || Ok(service().status(&root))).await
}

/// Is this workspace ready to answer, and if not, how big is the job?
///
/// Called when a project is opened, which is why it must never parse: it walks
/// the tree and adopts a matching cache, nothing more. The window uses the
/// answer to decide whether to offer an index — and a project that already has
/// a valid one is simply made usable here, one message earlier than it would
/// otherwise have been.
#[tauri::command]
pub async fn code_index_probe(workspace_path: String) -> Result<IndexProbe, String> {
    let root = workspace(workspace_path)?;
    blocking(move || Ok(service().probe(&root))).await
}

/// Parse the workspace from scratch and replace whatever was cached.
///
/// `async` so it runs off the main thread: a sync `#[tauri::command] pub fn`
/// executes on the UI thread in Tauri v2, and a multi-second parse there would
/// freeze the window (see the 2026-07-01 note in `.knowledge/lesson.md`).
#[tauri::command]
pub async fn code_index_rebuild(workspace_path: String) -> Result<IndexStatus, String> {
    let root = workspace(workspace_path)?;
    blocking(move || {
        service()
            .rebuild(&root)
            .map_err(|e| anyhow::anyhow!("Could not rebuild the code index: {e:#}"))?;
        Ok(service().status(&root))
    })
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSnapshot {
    index: IndexStatus,
    settings: IndexSettings,
    job: Option<BuildStatus>,
}

#[tauri::command]
pub async fn code_index_build_status(workspace_path: String) -> Result<BuildSnapshot, String> {
    let root = workspace(workspace_path)?;
    blocking(move || {
        let dir = service().project_index_dir(&root)?;
        Ok(BuildSnapshot {
            index: service().status(&root),
            settings: jobs::settings(&dir)?,
            job: jobs::manager().status(&dir)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn code_index_save_settings(
    workspace_path: String,
    settings: IndexSettings,
) -> Result<(), String> {
    let root = workspace(workspace_path)?;
    blocking(move || jobs::save_settings(&service().project_index_dir(&root)?, &settings)).await
}

#[tauri::command]
pub async fn code_index_start_build(
    workspace_path: String,
) -> Result<BuildStatus, String> {
    let root = workspace(workspace_path)?;
    blocking(move || {
        let dir = service().project_index_dir(&root)?;
        jobs::manager().start(root, dir)
    })
    .await
}

#[tauri::command]
pub async fn code_index_cancel_build(workspace_path: String) -> Result<(), String> {
    let root = workspace(workspace_path)?;
    blocking(move || jobs::manager().cancel(&service().project_index_dir(&root)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_empty_workspace_path_is_refused_in_words_a_person_can_act_on() {
        let err = code_index_status(String::new()).await.unwrap_err();
        assert!(err.contains("No workspace"), "{err}");
        assert!(
            !err.contains("Err") && !err.contains("None"),
            "the panel renders this string verbatim: {err}"
        );
    }

    #[tokio::test]
    async fn status_on_an_unbuilt_workspace_reports_not_built_rather_than_failing() {
        let dir = tempfile::tempdir().unwrap();
        let st = code_index_status(dir.path().display().to_string())
            .await
            .expect("status must succeed even with nothing indexed");
        assert!(!st.built);
        assert_eq!(st.symbols, 0);
    }
}

#[tauri::command]
pub async fn code_index_list_storage() -> Result<Vec<crate::code_index::inventory::StoredIndex>, String> {
    blocking(|| crate::code_index::inventory::list(&crate::agent_runtime::project_dir::projects())).await
}

#[tauri::command]
pub async fn code_index_delete_storage(project_id: String) -> Result<(), String> {
    blocking(move || crate::code_index::inventory::delete(&crate::agent_runtime::project_dir::projects(), &project_id)).await
}
