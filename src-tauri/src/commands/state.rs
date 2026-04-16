use std::sync::Mutex;
use tauri::State;

use crate::db::{Database, EditorState, ExplorerState, WorkspaceState};

/// Save workspace state
#[tauri::command]
pub fn save_workspace_state(
    state: WorkspaceState,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.workspace()
        .save(&state)
        .map_err(|e| format!("Failed to save workspace state: {:?}", e))
}

/// Get workspace state by path
#[tauri::command]
pub fn get_workspace_state(
    workspace_path: Option<String>,
    db: State<'_, Mutex<Database>>,
) -> Result<Option<WorkspaceState>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    match workspace_path {
        Some(path) => db
            .workspace()
            .get_by_path(&path)
            .map_err(|e| format!("Failed to get workspace state: {:?}", e)),
        None => db
            .workspace()
            .get_most_recent()
            .map_err(|e| format!("Failed to get workspace state: {:?}", e)),
    }
}

/// Get recently opened workspaces ordered by last_opened_at desc
#[tauri::command]
pub fn list_recent_workspaces(
    limit: Option<usize>,
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<WorkspaceState>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let max_items = limit.unwrap_or(3);

    db.workspace()
        .get_all()
        .map(|states| {
            states
                .into_iter()
                .filter(|state| state.workspace_path.is_some())
                .take(max_items)
                .collect()
        })
        .map_err(|e| format!("Failed to list recent workspaces: {:?}", e))
}

/// Save editor state for a file
#[tauri::command]
pub fn save_editor_state(state: EditorState, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.editor()
        .save(&state)
        .map_err(|e| format!("Failed to save editor state: {:?}", e))
}

/// Get editor state for a file
#[tauri::command]
pub fn get_editor_state(
    file_path: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Option<EditorState>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.editor()
        .get(&file_path)
        .map_err(|e| format!("Failed to get editor state: {:?}", e))
}

/// Save explorer state for a workspace
#[tauri::command]
pub fn save_explorer_state(
    state: ExplorerState,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.explorer()
        .save(&state)
        .map_err(|e| format!("Failed to save explorer state: {:?}", e))
}

/// Get explorer state for a workspace
#[tauri::command]
pub fn get_explorer_state(
    workspace_path: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Option<ExplorerState>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.explorer()
        .get(&workspace_path)
        .map_err(|e| format!("Failed to get explorer state: {:?}", e))
}
