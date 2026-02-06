use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// Chat state that's shared between all windows
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChatState {
    pub current_thread_id: Option<String>,
    pub is_loading: bool,
    pub pending_approval: Option<serde_json::Value>,
}

/// Wrapper for thread-safe chat state
pub struct SharedChatState(pub Mutex<ChatState>);

impl Default for SharedChatState {
    fn default() -> Self {
        Self(Mutex::new(ChatState::default()))
    }
}

/// Event payload for chat state updates
#[derive(Debug, Clone, Serialize)]
pub struct ChatStateEvent {
    pub state: ChatState,
    pub source: String, // "main" or "detached" - who triggered the update
}

// ============================================
// COMMANDS
// ============================================

/// Get current chat state
#[tauri::command]
pub fn get_chat_state(state: State<'_, SharedChatState>) -> Result<ChatState, String> {
    let chat = state.0.lock().map_err(|e| e.to_string())?;
    Ok(chat.clone())
}

/// Set loading state and broadcast to all windows
#[tauri::command]
pub fn set_chat_loading(
    app: AppHandle,
    is_loading: bool,
    source: String,
    state: State<'_, SharedChatState>,
) -> Result<(), String> {
    let mut chat = state.0.lock().map_err(|e| e.to_string())?;
    chat.is_loading = is_loading;
    
    // Broadcast to all windows
    let _ = app.emit("chat-state-changed", ChatStateEvent {
        state: chat.clone(),
        source,
    });
    
    Ok(())
}

/// Broadcast a generic chat event to all windows
#[tauri::command]
pub fn broadcast_chat_event(
    app: AppHandle,
    event_type: String,
    payload: String,
    source: String,
) -> Result<(), String> {
    // Broadcast to all windows
    let _ = app.emit("chat-broadcast", BroadcastEvent {
        event_type,
        payload,
        source,
    });
    
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BroadcastEvent {
    pub event_type: String,
    pub payload: String,
    pub source: String,
}

/// Set current thread ID and broadcast to all windows
#[tauri::command]
pub fn set_current_thread(
    app: AppHandle,
    thread_id: Option<String>,
    source: String,
    state: State<'_, SharedChatState>,
) -> Result<(), String> {
    let mut chat = state.0.lock().map_err(|e| e.to_string())?;
    chat.current_thread_id = thread_id;
    
    // Broadcast to all windows
    let _ = app.emit("chat-state-changed", ChatStateEvent {
        state: chat.clone(),
        source,
    });
    
    Ok(())
}

/// Set pending approval and broadcast to all windows
#[tauri::command]
pub fn set_pending_approval(
    app: AppHandle,
    approval: Option<serde_json::Value>,
    source: String,
    state: State<'_, SharedChatState>,
) -> Result<(), String> {
    let mut chat = state.0.lock().map_err(|e| e.to_string())?;
    chat.pending_approval = approval;
    
    // Broadcast to all windows
    let _ = app.emit("chat-state-changed", ChatStateEvent {
        state: chat.clone(),
        source,
    });
    
    Ok(())
}

/// Update entire chat state and broadcast
#[tauri::command]
pub fn update_chat_state(
    app: AppHandle,
    new_state: ChatState,
    source: String,
    state: State<'_, SharedChatState>,
) -> Result<(), String> {
    let mut chat = state.0.lock().map_err(|e| e.to_string())?;
    *chat = new_state;
    
    // Broadcast to all windows
    let _ = app.emit("chat-state-changed", ChatStateEvent {
        state: chat.clone(),
        source,
    });
    
    Ok(())
}

/// Clear chat state (new chat) and broadcast
#[tauri::command]
pub fn clear_chat_state(
    app: AppHandle,
    source: String,
    state: State<'_, SharedChatState>,
) -> Result<(), String> {
    let mut chat = state.0.lock().map_err(|e| e.to_string())?;
    *chat = ChatState::default();
    
    // Broadcast to all windows
    let _ = app.emit("chat-state-changed", ChatStateEvent {
        state: chat.clone(),
        source,
    });
    
    Ok(())
}
