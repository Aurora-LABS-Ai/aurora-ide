//! Tauri commands behind the Settings → Agent index panel.
//!
//! Two operations only, matching the owner's decision that there is no on/off
//! switch: the index costs well under a second to build, unlike the embedding
//! indexer it replaced, so a toggle would be a control whose only effect is to
//! make the agent worse. Status answers "is it built and how big", Rebuild
//! forces a fresh parse.
//!
//! [`status`](code_index_status) deliberately does NOT build. A panel that
//! indexes the workspace merely by being opened would stall Settings on a large
//! repository and surprise someone who only wanted to look.

use std::path::PathBuf;

use crate::code_index::{service, IndexProbe, IndexStatus};

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
    Ok(service().status(&root))
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
    Ok(service().probe(&root))
}

/// Parse the workspace from scratch and replace whatever was cached.
///
/// `async` so it runs off the main thread: a sync `#[tauri::command] pub fn`
/// executes on the UI thread in Tauri v2, and a multi-second parse there would
/// freeze the window (see the 2026-07-01 note in `.knowledge/lesson.md`).
#[tauri::command]
pub async fn code_index_rebuild(workspace_path: String) -> Result<IndexStatus, String> {
    let root = workspace(workspace_path)?;
    service()
        .rebuild(&root)
        .map_err(|e| format!("Could not rebuild the code index: {e:#}"))?;
    Ok(service().status(&root))
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
