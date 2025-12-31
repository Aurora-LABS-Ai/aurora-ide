use tauri::State;
use std::sync::Mutex;

use crate::db::{Database, CustomTheme};

// ============================================================
// THEME COMMANDS
// ============================================================

/// Get all custom themes
#[tauri::command]
pub fn get_custom_themes(db: State<'_, Mutex<Database>>) -> Result<Vec<CustomTheme>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.themes()
        .get_all()
        .map_err(|e| format!("Failed to get themes: {:?}", e))
}

/// Save a custom theme
#[tauri::command]
pub fn save_custom_theme(
    theme: CustomTheme,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.themes()
        .save(&theme)
        .map_err(|e| format!("Failed to save theme: {:?}", e))
}

/// Delete a custom theme
#[tauri::command]
pub fn delete_custom_theme(id: String, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.themes()
        .delete(&id)
        .map_err(|e| format!("Failed to delete theme: {:?}", e))
}

/// Set active theme ID preference
#[tauri::command]
pub fn set_active_theme_id(
    theme_id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .set_setting("active_theme_id", &theme_id)
        .map_err(|e| format!("Failed to set active theme: {:?}", e))
}

/// Get active theme ID preference
#[tauri::command]
pub fn get_active_theme_id(db: State<'_, Mutex<Database>>) -> Result<Option<String>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let setting = db.settings()
        .get_setting("active_theme_id")
        .map_err(|e| format!("Failed to get active theme: {:?}", e))?;
    
    Ok(setting.map(|s| s.value))
}
