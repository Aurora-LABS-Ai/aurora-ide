//! Artifact Canvas commands for the window. The store is
//! [`crate::agent_runtime::artifacts`]; `commands::artifacts::*` keeps
//! re-exporting it for existing callers.

use std::sync::Arc;

use tauri::State;

use super::agent_v2::AgentRegistry;
pub use crate::agent_runtime::artifacts::*;

// Every command below routes by the conversation's OWN store. An Aurora Chat
// conversation lives under `Chats/`, and reading its bundle from the Build
// store finds nothing — worse, `upsert` refuses with "conversation not saved"
// for a chat that is saved, just elsewhere. Phase 4 shipped this against
// `registry.store()` and was never watched running.

#[tauri::command]
pub async fn thread_artifact_list(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<ThreadArtifactBundle, String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(store) = registry
            .store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(ThreadArtifactBundle::empty(&thread_id));
        };
        let _guard = lock_artifacts()?;
        load_bundle_unlocked(&store, &thread_id)
    })
    .await
    .map_err(|e| format!("Artifact operation failed: {e}"))?
}

#[tauri::command]
pub async fn thread_artifact_upsert(
    request: ArtifactUpsertRequest,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<ThreadArtifactBundle, String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = registry
            .require_store_for_thread(&request.thread_id)
            .map_err(|e| e.to_string())?;
        upsert(&store, request)
    })
    .await
    .map_err(|e| format!("Artifact operation failed: {e}"))?
}

#[tauri::command]
pub async fn thread_artifact_preview_patch(
    request: ArtifactUpsertRequest,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<String, String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = registry
            .require_store_for_thread(&request.thread_id)
            .map_err(|e| e.to_string())?;
        preview_patch(&store, request)
    })
    .await
    .map_err(|e| format!("Artifact operation failed: {e}"))?
}

#[tauri::command]
pub async fn thread_artifact_select(
    request: ArtifactSelectRequest,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<ThreadArtifactBundle, String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = registry
            .require_store_for_thread(&request.thread_id)
            .map_err(|e| e.to_string())?;
        select(&store, request)
    })
    .await
    .map_err(|e| format!("Artifact operation failed: {e}"))?
}
