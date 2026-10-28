//! The window's two calls for answer boxes: read what a conversation's boxes
//! were left at, and save one box. Written once in `host_commands::cards`.

use super::*;
use std::sync::Arc;
use tauri::State;

use crate::agent_runtime::answer_boxes::{AnswerBoxes, BoxValues};
use crate::host_commands::cards;

#[tauri::command]
pub async fn agent_answer_boxes_get(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
) -> Result<AnswerBoxes, String> {
    cards::answer_boxes_get(state.inner().clone(), thread_id).await
}

#[tauri::command]
pub async fn agent_answer_box_set(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    key: String,
    values: BoxValues,
) -> Result<AnswerBoxes, String> {
    cards::answer_box_set(state.inner().clone(), thread_id, key, values).await
}
