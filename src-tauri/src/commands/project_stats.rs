//! The window's Project panel command. Written once in
//! [`crate::agent_runtime::stats::project`].

use std::sync::Arc;

use tauri::State;

use crate::agent_runtime::host::AgentRegistry;
use crate::agent_runtime::stats::project::{self, ProjectStats};

#[tauri::command]
pub async fn project_stats_get(
    registry: State<'_, Arc<AgentRegistry>>,
    workspace_root: String,
) -> Result<ProjectStats, String> {
    project::project_stats_get(registry.inner().clone(), workspace_root).await
}
