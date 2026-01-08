use std::sync::Mutex;
use tauri::State;

use crate::undo_redo::{FileChange, UndoRedoService};
use crate::undo_redo::types::{FileUndoState, UndoRedoResponse};

/// State wrapper for undo/redo service
pub struct UndoRedoState {
    pub service: Mutex<UndoRedoService>,
}

impl UndoRedoState {
    pub fn new() -> Self {
        Self {
            service: Mutex::new(UndoRedoService::new()),
        }
    }
}

impl Default for UndoRedoState {
    fn default() -> Self {
        Self::new()
    }
}

/// Initialize tracking for a file (called when file is opened in editor)
#[tauri::command]
pub async fn undo_init_file(
    file_path: String,
    content: String,
    state: State<'_, UndoRedoState>,
) -> Result<(), String> {
    let service = state.service.lock().map_err(|e| e.to_string())?;
    service.init_file(&file_path, &content);
    Ok(())
}

/// Record a change to a file (called when content is modified)
#[tauri::command]
pub async fn undo_record_change(
    file_path: String,
    old_content: String,
    new_content: String,
    source: String,
    description: Option<String>,
    state: State<'_, UndoRedoState>,
) -> Result<FileUndoState, String> {
    let service = state.service.lock().map_err(|e| e.to_string())?;
    
    let mut change = FileChange::new(&file_path, &old_content, &new_content, &source);
    if let Some(desc) = description {
        change = change.with_description(desc);
    }
    
    service.record_change(change).map_err(|e| e.to_string())
}

/// Undo the last change for a file (in-memory only)
#[tauri::command]
pub async fn undo_file(
    file_path: String,
    state: State<'_, UndoRedoState>,
) -> Result<UndoRedoResponse, String> {
    let service = state.service.lock().map_err(|e| e.to_string())?;
    
    match service.undo(&file_path) {
        Ok((content, undo_state)) => Ok(UndoRedoResponse {
            success: true,
            content: Some(content),
            state: Some(undo_state),
            error: None,
        }),
        Err(e) => Ok(UndoRedoResponse {
            success: false,
            content: None,
            state: service.get_state(&file_path),
            error: Some(e.to_string()),
        }),
    }
}

/// Redo the last undone change for a file (in-memory only)
#[tauri::command]
pub async fn redo_file(
    file_path: String,
    state: State<'_, UndoRedoState>,
) -> Result<UndoRedoResponse, String> {
    let service = state.service.lock().map_err(|e| e.to_string())?;
    
    match service.redo(&file_path) {
        Ok((content, undo_state)) => Ok(UndoRedoResponse {
            success: true,
            content: Some(content),
            state: Some(undo_state),
            error: None,
        }),
        Err(e) => Ok(UndoRedoResponse {
            success: false,
            content: None,
            state: service.get_state(&file_path),
            error: Some(e.to_string()),
        }),
    }
}

/// Undo and save to disk
#[tauri::command]
pub async fn undo_file_and_save(
    file_path: String,
    state: State<'_, UndoRedoState>,
) -> Result<UndoRedoResponse, String> {
    let service = state.service.lock().map_err(|e| e.to_string())?;
    
    match service.undo_and_save(&file_path) {
        Ok((content, undo_state)) => Ok(UndoRedoResponse {
            success: true,
            content: Some(content),
            state: Some(undo_state),
            error: None,
        }),
        Err(e) => Ok(UndoRedoResponse {
            success: false,
            content: None,
            state: service.get_state(&file_path),
            error: Some(e.to_string()),
        }),
    }
}

/// Redo and save to disk
#[tauri::command]
pub async fn redo_file_and_save(
    file_path: String,
    state: State<'_, UndoRedoState>,
) -> Result<UndoRedoResponse, String> {
    let service = state.service.lock().map_err(|e| e.to_string())?;
    
    match service.redo_and_save(&file_path) {
        Ok((content, undo_state)) => Ok(UndoRedoResponse {
            success: true,
            content: Some(content),
            state: Some(undo_state),
            error: None,
        }),
        Err(e) => Ok(UndoRedoResponse {
            success: false,
            content: None,
            state: service.get_state(&file_path),
            error: Some(e.to_string()),
        }),
    }
}

/// Get undo/redo state for a file
#[tauri::command]
pub async fn undo_get_state(
    file_path: String,
    state: State<'_, UndoRedoState>,
) -> Result<Option<FileUndoState>, String> {
    let service = state.service.lock().map_err(|e| e.to_string())?;
    Ok(service.get_state(&file_path))
}

/// Clear undo/redo history for a file (e.g., when closing)
#[tauri::command]
pub async fn undo_clear_file(
    file_path: String,
    state: State<'_, UndoRedoState>,
) -> Result<(), String> {
    let service = state.service.lock().map_err(|e| e.to_string())?;
    service.clear_file(&file_path);
    Ok(())
}

/// Clear all undo/redo history
#[tauri::command]
pub async fn undo_clear_all(
    state: State<'_, UndoRedoState>,
) -> Result<(), String> {
    let service = state.service.lock().map_err(|e| e.to_string())?;
    service.clear_all();
    Ok(())
}

