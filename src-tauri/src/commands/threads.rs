use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, State};

use crate::db::{ContextUsage, Database, Message, ThreadState, TokenUsage};
use crate::services::api_converter::ApiMessage;
use crate::services::thread_service::{ThreadService, ThreadSummary};

/// Save/update a full thread state to the database.
/// Used for bulk-persisting thread state (e.g., after streaming completes).
#[tauri::command]
pub fn thread_save(thread: ThreadState, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.threads()
        .save(&thread)
        .map_err(|e| format!("Failed to save thread: {:?}", e))
}

// ============================================================
// New service-based commands with event emission
// ============================================================

/// Create a new thread (emits thread-created event)
#[tauri::command]
pub fn thread_create(
    title: Option<String>,
    db: State<'_, Mutex<Database>>,
    thread_service: State<'_, ThreadService>,
    app: AppHandle,
) -> Result<ThreadState, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    thread_service.create_thread(&db, &app, title)
}

/// Load a thread by ID (emits thread-loaded event)
#[tauri::command]
pub fn thread_load(
    thread_id: String,
    db: State<'_, Mutex<Database>>,
    thread_service: State<'_, ThreadService>,
    app: AppHandle,
) -> Result<Option<ThreadState>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    thread_service.load_thread(&db, &app, &thread_id)
}

/// Delete a thread (emits thread-deleted event)
#[tauri::command]
pub fn thread_delete(
    thread_id: String,
    db: State<'_, Mutex<Database>>,
    thread_service: State<'_, ThreadService>,
    app: AppHandle,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    thread_service.delete_thread(&db, &app, &thread_id)
}

/// List all threads (summaries only for performance)
#[tauri::command]
pub fn thread_list_summaries(
    db: State<'_, Mutex<Database>>,
    thread_service: State<'_, ThreadService>,
) -> Result<Vec<ThreadSummary>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    thread_service.list_threads(&db)
}

/// Add request for adding user message
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddUserMessageRequest {
    pub thread_id: String,
    pub content: String,
    pub attachments: Option<Vec<Value>>,
}

/// Add a user message to thread (persists immediately, emits event)
#[tauri::command]
pub fn thread_add_user_message(
    request: AddUserMessageRequest,
    db: State<'_, Mutex<Database>>,
    thread_service: State<'_, ThreadService>,
    app: AppHandle,
) -> Result<Message, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    thread_service.add_user_message(
        &db,
        &app,
        &request.thread_id,
        &request.content,
        request.attachments,
    )
}

/// Start an assistant response stream (returns stream_id for tracking)
#[tauri::command]
pub fn thread_start_response(
    thread_id: String,
    thread_service: State<'_, ThreadService>,
    app: AppHandle,
) -> Result<String, String> {
    thread_service.start_assistant_response(&app, &thread_id)
}

/// Append token to streaming response
#[tauri::command]
pub fn thread_append_token(
    stream_id: String,
    token: String,
    thread_service: State<'_, ThreadService>,
    app: AppHandle,
) -> Result<(), String> {
    thread_service.append_token(&app, &stream_id, &token)
}

/// Append thinking content to streaming response
#[tauri::command]
pub fn thread_append_thinking(
    stream_id: String,
    thinking: String,
    thread_service: State<'_, ThreadService>,
    app: AppHandle,
) -> Result<(), String> {
    thread_service.append_thinking(&app, &stream_id, &thinking)
}

/// Add tool call to streaming response
#[tauri::command]
pub fn thread_add_tool_call(
    stream_id: String,
    tool_call: Value,
    thread_service: State<'_, ThreadService>,
    app: AppHandle,
) -> Result<(), String> {
    thread_service.add_tool_call(&app, &stream_id, tool_call)
}

/// Finalize response request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeResponseRequest {
    pub stream_id: String,
    pub timeline: Option<Value>,
}

/// Finalize assistant response (persists to database, emits event)
#[tauri::command]
pub fn thread_finalize_response(
    request: FinalizeResponseRequest,
    db: State<'_, Mutex<Database>>,
    thread_service: State<'_, ThreadService>,
    app: AppHandle,
) -> Result<Message, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    thread_service.finalize_response(&db, &app, &request.stream_id, request.timeline)
}

/// Update usage request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUsageRequest {
    pub thread_id: String,
    pub token_usage: TokenUsage,
    pub context_usage: ContextUsage,
}

/// Update thread token/context usage
#[tauri::command]
pub fn thread_update_usage(
    request: UpdateUsageRequest,
    db: State<'_, Mutex<Database>>,
    thread_service: State<'_, ThreadService>,
    app: AppHandle,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    thread_service.update_usage(
        &db,
        &app,
        &request.thread_id,
        request.token_usage,
        request.context_usage,
    )
}

/// Get API-formatted history for LLM requests
#[tauri::command]
pub fn thread_get_api_history(
    thread_id: String,
    db: State<'_, Mutex<Database>>,
    thread_service: State<'_, ThreadService>,
) -> Result<Vec<ApiMessage>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    thread_service.get_api_history(&db, &thread_id)
}

/// Update thread title
#[tauri::command]
pub fn thread_update_title(
    thread_id: String,
    title: String,
    db: State<'_, Mutex<Database>>,
    thread_service: State<'_, ThreadService>,
    app: AppHandle,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    thread_service.update_title(&db, &app, &thread_id, &title)
}
