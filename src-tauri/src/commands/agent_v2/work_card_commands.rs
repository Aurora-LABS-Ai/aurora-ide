//! The window's two calls for work cards: read which cards a conversation has
//! open, and open or close one. Storage and its rules live in
//! [`crate::agent_runtime::work_cards`].

use super::*;
use std::sync::Arc;
use tauri::State;

use crate::agent_runtime::work_cards::{self, WorkCards};

/// The work cards the reader opened in a conversation. Empty for a
/// conversation that never opened one, or one that is not on disk.
#[tauri::command]
pub async fn agent_work_cards_get(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
) -> Result<WorkCards, String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(store) = registry
            .store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(WorkCards::default());
        };
        work_cards::read(&store, &thread_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open or close one work card. Returns the conversation's open cards. Fails
/// for a conversation that is not on disk rather than creating one.
#[tauri::command]
pub async fn agent_work_card_set(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    card_id: String,
    open: bool,
) -> Result<WorkCards, String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = registry
            .store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                format!("conversation {thread_id} does not exist; the work card was not saved")
            })?;
        work_cards::set(&store, &thread_id, &card_id, open).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
