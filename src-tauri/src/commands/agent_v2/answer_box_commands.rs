//! The window's two calls for answer boxes: read what a conversation's boxes
//! were left at, and save one box. Storage and its rules live in
//! [`crate::agent_runtime::answer_boxes`].

use super::*;
use std::sync::Arc;
use tauri::State;

use crate::agent_runtime::answer_boxes::{self, AnswerBoxes, BoxValues};

/// Every answer box value saved in a conversation. Empty for a conversation
/// that never changed one, or one that is not on disk.
#[tauri::command]
pub async fn agent_answer_boxes_get(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
) -> Result<AnswerBoxes, String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(store) = registry
            .store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(AnswerBoxes::default());
        };
        answer_boxes::read(&store, &thread_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save one box's values, or forget the box when `values` is empty. Returns
/// everything stored for the conversation. Fails for a conversation that is
/// not on disk rather than creating one.
#[tauri::command]
pub async fn agent_answer_box_set(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    key: String,
    values: BoxValues,
) -> Result<AnswerBoxes, String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = registry
            .store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                format!("conversation {thread_id} does not exist; its answer box was not saved")
            })?;
        answer_boxes::set(&store, &thread_id, &key, values).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
