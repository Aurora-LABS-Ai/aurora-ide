//! The window's prompt-refine and reply-suggestion commands. Written once in
//! [`crate::prompt_refine::commands`]; these hand them the managed state.

use std::sync::Arc;

use tauri::State;

use super::agent_v2::AgentRegistry;
use crate::prompt_refine::commands as core;
use crate::prompt_refine::{RefineConfig, RefineState, RefineValidation};
use crate::reply_suggest::log as suggest_log;

#[tauri::command]
pub fn prompt_refine_validate(config: RefineConfig) -> RefineValidation {
    core::prompt_refine_validate(config)
}

#[tauri::command]
pub async fn prompt_refine_run(
    state: State<'_, Arc<RefineState>>,
    request_id: String,
    text: String,
    config: RefineConfig,
) -> Result<String, String> {
    core::prompt_refine_run(state.inner().clone(), request_id, text, config).await
}

#[tauri::command]
pub async fn prompt_refine_cloud(
    state: State<'_, Arc<RefineState>>,
    request_id: String,
    text: String,
    config: crate::api::client::ProviderConfigSnapshot,
    model: String,
) -> Result<String, String> {
    core::prompt_refine_cloud(state.inner().clone(), request_id, text, config, model).await
}

#[tauri::command]
pub fn prompt_refine_cancel(state: State<'_, Arc<RefineState>>, request_id: String) -> bool {
    core::prompt_refine_cancel(&state, request_id)
}

#[tauri::command]
pub async fn prompt_refine_title(
    state: State<'_, Arc<RefineState>>,
    request_id: String,
    text: String,
    config: RefineConfig,
) -> Result<String, String> {
    core::prompt_refine_title(state.inner().clone(), request_id, text, config).await
}

#[tauri::command]
pub async fn prompt_refine_dictation(
    state: State<'_, Arc<RefineState>>,
    request_id: String,
    text: String,
    config: RefineConfig,
) -> Result<String, String> {
    core::prompt_refine_dictation(state.inner().clone(), request_id, text, config).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn prompt_refine_suggest(
    state: State<'_, Arc<RefineState>>,
    registry: State<'_, Arc<AgentRegistry>>,
    request_id: String,
    user_text: String,
    text: String,
    config: RefineConfig,
    thread_id: Option<String>,
    run_id: Option<String>,
) -> Result<Vec<String>, String> {
    core::prompt_refine_suggest(
        state.inner().clone(),
        registry.inner().clone(),
        request_id,
        user_text,
        text,
        config,
        thread_id,
        run_id,
    )
    .await
}

#[tauri::command]
pub async fn reply_suggest_cloud(
    registry: State<'_, Arc<AgentRegistry>>,
    config: crate::api::client::ProviderConfigSnapshot,
    model: String,
    thread_id: String,
    run_id: String,
) -> Result<Vec<String>, String> {
    core::reply_suggest_cloud(registry.inner().clone(), config, model, thread_id, run_id).await
}

#[tauri::command]
pub async fn reply_suggest_outcome(
    registry: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    outcome: suggest_log::OutcomeInput,
) -> Result<(), String> {
    core::reply_suggest_outcome(registry.inner().clone(), thread_id, outcome).await
}
