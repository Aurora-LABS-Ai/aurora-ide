//! The window's two calls for work cards: read which cards a conversation has
//! open, and open or close one. Written once in `host_commands::cards`.

use super::*;
use std::sync::Arc;
use tauri::State;

use crate::agent_runtime::work_cards::WorkCards;
use crate::host_commands::cards;

#[tauri::command]
pub async fn agent_work_cards_get(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
) -> Result<WorkCards, String> {
    cards::work_cards_get(state.inner().clone(), thread_id).await
}

#[tauri::command]
pub async fn agent_work_card_set(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    card_id: String,
    open: bool,
) -> Result<WorkCards, String> {
    cards::work_card_set(state.inner().clone(), thread_id, card_id, open).await
}
