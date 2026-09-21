//! Profile reads permanent accounting, independent of retained conversations.

use crate::commands::agent_v2::AgentRegistry;
pub use crate::usage_ledger::stats::*;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn usage_stats_get(
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<UsageStats, String> {
    let ledger = registry
        .usage_ledger()
        .cloned()
        .ok_or_else(|| "Usage accounting is not initialized".to_string())?;
    tauri::async_runtime::spawn_blocking(move || ledger.stats().map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| format!("Usage stats task failed: {e}"))?
}
