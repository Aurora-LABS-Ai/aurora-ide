//! Read-only video catalog and task refresh. Never creates a task. The
//! refresh is written once in `host_commands::media`.
use crate::commands::agent_v2::AgentRegistry;
use crate::tools::{image::config::ImageProviderConfig, video};
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

/// The shared video roster. Named for what it returns rather than for one
/// vendor: it carries MiniMax and Qwen rows, each tagged with its service.
#[tauri::command]
pub fn video_model_catalog() -> video::catalog::VideoCatalog {
    video::catalog::catalog()
}

#[tauri::command]
pub async fn chat_video_refresh(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    job_id: String,
    provider: ImageProviderConfig,
) -> Result<Value, String> {
    crate::host_commands::media::video_refresh(&state, &thread_id, &job_id, provider).await
}
