//! Profile reads permanent accounting, independent of retained conversations.

use std::sync::Arc;

use crate::agent_runtime::host::AgentRegistry;
pub use crate::usage_ledger::stats::*;

pub async fn usage_stats_get(registry: Arc<AgentRegistry>) -> Result<UsageStats, String> {
    let ledger = registry
        .usage_ledger()
        .cloned()
        .ok_or_else(|| "Usage accounting is not initialized".to_string())?;
    tokio::task::spawn_blocking(move || ledger.stats().map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| format!("Usage stats task failed: {e}"))?
}
