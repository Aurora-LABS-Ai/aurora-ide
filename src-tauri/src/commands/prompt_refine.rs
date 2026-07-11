//! Tauri IPC for the composer's prompt-refine feature.
//!
//! Thin wrappers over [`crate::prompt_refine`]. `run` does the ~1s model call on
//! a blocking thread and returns the refined text; `cancel` kills an in-flight
//! child by request id; `validate` powers the Preferences "Validate" button.

use std::sync::Arc;

use tauri::State;

use crate::prompt_refine::{self, RefineConfig, RefineState, RefineValidation};

/// Check that the llama.cpp binary + model are present and usable.
#[tauri::command]
pub fn prompt_refine_validate(config: RefineConfig) -> RefineValidation {
    prompt_refine::validate(&config)
}

/// Refine `text` once and return the rewritten prompt. `request_id` lets the
/// frontend cancel this run. Never blocks the async runtime — the child process
/// I/O runs on a blocking thread.
#[tauri::command]
pub async fn prompt_refine_run(
    state: State<'_, Arc<RefineState>>,
    request_id: String,
    text: String,
    config: RefineConfig,
) -> Result<String, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        prompt_refine::refine(&st, &request_id, &text, &config)
    })
    .await
    .map_err(|e| format!("refine task failed: {e}"))?
}

/// Cancel an in-flight refine (kills the llama-completion child).
#[tauri::command]
pub fn prompt_refine_cancel(state: State<'_, Arc<RefineState>>, request_id: String) -> bool {
    state.cancel(&request_id)
}
