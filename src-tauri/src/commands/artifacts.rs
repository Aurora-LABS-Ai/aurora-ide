//! Artifact Canvas commands for the window. The bodies are written once in
//! `host_commands::conversation`; the store is
//! [`crate::agent_runtime::artifacts`], which `commands::artifacts::*` keeps
//! re-exporting for existing callers.

use std::sync::Arc;

use tauri::State;

use super::agent_v2::AgentRegistry;
pub use crate::agent_runtime::artifacts::*;
use crate::host_commands::conversation;

#[tauri::command]
pub async fn thread_artifact_list(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<ThreadArtifactBundle, String> {
    conversation::artifact_list(registry.inner().clone(), thread_id).await
}

#[tauri::command]
pub async fn thread_artifact_upsert(
    request: ArtifactUpsertRequest,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<ThreadArtifactBundle, String> {
    conversation::artifact_upsert(registry.inner().clone(), request).await
}

#[tauri::command]
pub async fn thread_artifact_preview_patch(
    request: ArtifactUpsertRequest,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<String, String> {
    conversation::artifact_preview_patch(registry.inner().clone(), request).await
}

#[tauri::command]
pub async fn thread_artifact_select(
    request: ArtifactSelectRequest,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<ThreadArtifactBundle, String> {
    conversation::artifact_select(registry.inner().clone(), request).await
}
