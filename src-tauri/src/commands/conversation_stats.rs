//! The window's session-details command. Written once in
//! [`crate::agent_runtime::stats::conversation`].

use std::sync::Arc;

use tauri::State;

use crate::agent_runtime::host::AgentRegistry;
use crate::agent_runtime::stats::conversation::{self, ConversationStats};

#[tauri::command]
pub async fn conversation_stats_get(
    registry: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
) -> Result<ConversationStats, String> {
    conversation::conversation_stats_get(registry.inner().clone(), thread_id).await
}
