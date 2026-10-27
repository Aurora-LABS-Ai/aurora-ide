//! The window's thread commands. The bodies are written once in
//! `host_commands::threads`, which `aurora serve` serves too; these hand them
//! the managed registry and the app as the event sink. Only "Copy as
//! Markdown" adds anything: the desktop clipboard.

use std::sync::Arc;

use tauri::{AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::agent_runtime::host::AgentRegistry;
use crate::db::ThreadState;
use crate::host_commands::threads as core;
use crate::host_commands::threads::{ThreadSummary, ThreadUsageBreakdown, UpdateUsageRequest};
use crate::host_events::Events;
use crate::services::api_converter::ApiMessage;

fn events(app: AppHandle) -> Events {
    Arc::new(app)
}

#[tauri::command]
pub async fn thread_save(
    thread: ThreadState,
    workspace_root: Option<String>,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    core::thread_save(thread, workspace_root, registry.inner(), &events(app)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn thread_create(
    title: Option<String>,
    workspace_root: Option<String>,
    surface: Option<String>,
    deep_research: Option<bool>,
    model: Option<String>,
    execution_mode: Option<crate::agent_runtime::ipc::AgentExecutionMode>,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<ThreadState, String> {
    core::thread_create(
        title,
        workspace_root,
        surface,
        deep_research,
        model,
        execution_mode,
        registry.inner(),
        &events(app),
    )
    .await
}

#[tauri::command]
pub async fn thread_duplicate(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<ThreadSummary, String> {
    core::thread_duplicate(thread_id, registry.inner(), &events(app)).await
}

#[tauri::command]
pub async fn thread_folder(thread_id: String, registry: State<'_, Arc<AgentRegistry>>) -> Result<String, String> {
    core::thread_folder(thread_id, registry.inner()).await
}

#[tauri::command]
pub async fn thread_move_to_project(
    thread_id: String,
    workspace_root: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<ThreadSummary, String> {
    core::thread_move_to_project(thread_id, workspace_root, registry.inner()).await
}

/// Render the visible conversation as Markdown and write it to the native
/// clipboard. Clipboard ownership stays in Rust; the React layer only invokes
/// the command and presents feedback.
#[tauri::command]
pub async fn thread_copy_markdown(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    let markdown = core::thread_markdown(thread_id, registry.inner()).await?;
    app.clipboard()
        .write_text(markdown)
        .map_err(|error| format!("Failed to write chat to the clipboard: {error}"))
}

#[tauri::command]
pub async fn thread_usage_breakdown(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<Option<ThreadUsageBreakdown>, String> {
    core::thread_usage_breakdown(thread_id, registry.inner()).await
}

#[tauri::command]
pub async fn subagent_thread_load(
    parent_thread_id: String,
    agent_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<Option<ThreadState>, String> {
    core::subagent_thread_load(parent_thread_id, agent_id, registry.inner()).await
}

#[tauri::command]
pub async fn thread_load(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<Option<ThreadState>, String> {
    core::thread_load(thread_id, registry.inner(), &events(app)).await
}

#[tauri::command]
pub async fn thread_delete(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    core::thread_delete(thread_id, registry.inner(), &events(app)).await
}

#[tauri::command]
pub async fn thread_list_summaries(
    workspace_root: Option<String>,
    surface: Option<String>,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<Vec<ThreadSummary>, String> {
    core::thread_list_summaries(workspace_root, surface, registry.inner()).await
}

#[tauri::command]
pub async fn thread_update_title(
    thread_id: String,
    title: String,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    core::thread_update_title(thread_id, title, registry.inner(), &events(app)).await
}

#[tauri::command]
pub async fn thread_set_pinned(
    thread_id: String,
    pinned: bool,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<(), String> {
    core::thread_set_pinned(thread_id, pinned, registry.inner()).await
}

#[tauri::command]
pub async fn thread_set_archived(
    thread_id: String,
    archived: bool,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<(), String> {
    core::thread_set_archived(thread_id, archived, registry.inner()).await
}

#[tauri::command]
pub async fn thread_set_model(
    thread_id: String,
    model: Option<String>,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<(), String> {
    core::thread_set_model(thread_id, model, registry.inner()).await
}

#[tauri::command]
pub async fn thread_set_execution_mode(
    thread_id: String,
    mode: crate::agent_runtime::ipc::AgentExecutionMode,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<(), String> {
    core::thread_set_execution_mode(thread_id, mode, registry.inner()).await
}

#[tauri::command]
pub async fn thread_update_usage(
    request: UpdateUsageRequest,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    core::thread_update_usage(request, registry.inner(), &events(app)).await
}

#[tauri::command]
pub async fn thread_get_api_history(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<Vec<ApiMessage>, String> {
    core::thread_get_api_history(thread_id, registry.inner()).await
}

/// `_reason` is accepted for the window's existing call and not used.
#[tauri::command]
pub fn thread_cancel_current_turn(
    thread_id: String,
    _reason: Option<String>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    core::thread_cancel_current_turn(thread_id, &events(app))
}
