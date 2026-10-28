//! The window's Profile command. Written once in
//! [`crate::agent_runtime::stats::usage`].

use std::sync::Arc;

use tauri::State;

use crate::agent_runtime::host::AgentRegistry;
pub use crate::agent_runtime::stats::usage::*;

#[tauri::command]
pub async fn usage_stats_get(registry: State<'_, Arc<AgentRegistry>>) -> Result<UsageStats, String> {
    crate::agent_runtime::stats::usage::usage_stats_get(registry.inner().clone()).await
}
