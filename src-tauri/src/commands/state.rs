use tauri::State;

use crate::db::{Database, DbResult, EditorState, ExplorerState, WorkspaceState};

/// Save workspace state
#[tauri::command]
pub fn save_workspace_state(
    state: WorkspaceState,
    db: State<Database>,
) -> DbResult<()> {
    db.workspace().save(&state)?;
    Ok(())
}

/// Get workspace state by path
#[tauri::command]
pub fn get_workspace_state(
    workspace_path: Option<String>,
    db: State<Database>,
) -> DbResult<Option<WorkspaceState>> {
    match workspace_path {
        Some(path) => db.workspace().get_by_path(&path),
        None => db.workspace().get_most_recent(),
    }
}

/// Save editor state for a file
#[tauri::command]
pub fn save_editor_state(
    state: EditorState,
    db: State<Database>,
) -> DbResult<()> {
    db.editor().save(&state)?;
    Ok(())
}

/// Get editor state for a file
#[tauri::command]
pub fn get_editor_state(
    file_path: String,
    db: State<Database>,
) -> DbResult<Option<EditorState>> {
    db.editor().get(&file_path)
}

/// Save explorer state for a workspace
#[tauri::command]
pub fn save_explorer_state(
    state: ExplorerState,
    db: State<Database>,
) -> DbResult<()> {
    db.explorer().save(&state)?;
    Ok(())
}

/// Get explorer state for a workspace
#[tauri::command]
pub fn get_explorer_state(
    workspace_path: String,
    db: State<Database>,
) -> DbResult<Option<ExplorerState>> {
    db.explorer().get(&workspace_path)
}
