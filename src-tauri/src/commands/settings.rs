use std::sync::Mutex;
use tauri::State;

use crate::db::{AppSettings, Database, LLMProvider, ToolSetting};

// ============================================================
// APP SETTINGS COMMANDS
// ============================================================

/// Get all app settings
#[tauri::command]
pub fn get_app_settings(db: State<'_, Mutex<Database>>) -> Result<AppSettings, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .get_app_settings()
        .map_err(|e| format!("Failed to get settings: {:?}", e))
}

/// Save all app settings
#[tauri::command]
pub fn save_app_settings(
    settings: AppSettings,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .save_app_settings(&settings)
        .map_err(|e| format!("Failed to save settings: {:?}", e))
}

#[tauri::command]
pub fn get_global_skills_path() -> Result<Option<String>, String> {
    Ok(dirs::home_dir().map(|home| {
        home.join(".agent")
            .join("skills")
            .to_string_lossy()
            .to_string()
    }))
}

/// Get a single setting by key
#[tauri::command]
pub fn get_setting(key: String, db: State<'_, Mutex<Database>>) -> Result<Option<String>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let setting = db
        .settings()
        .get_setting(&key)
        .map_err(|e| format!("Failed to get setting: {:?}", e))?;
    Ok(setting.map(|s| s.value))
}

/// Set a single setting
#[tauri::command]
pub fn set_setting(
    key: String,
    value: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .set_setting(&key, &value)
        .map_err(|e| format!("Failed to set setting: {:?}", e))
}

// ============================================================
// LLM PROVIDER COMMANDS
// ============================================================

/// Get all LLM providers
#[tauri::command]
pub fn get_all_providers(db: State<'_, Mutex<Database>>) -> Result<Vec<LLMProvider>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .get_all_providers()
        .map_err(|e| format!("Failed to get providers: {:?}", e))
}

/// Get a single provider by ID
#[tauri::command]
pub fn get_provider(
    id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Option<LLMProvider>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .get_provider(&id)
        .map_err(|e| format!("Failed to get provider: {:?}", e))
}

/// Save or update a provider
#[tauri::command]
pub fn save_provider(provider: LLMProvider, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .save_provider(&provider)
        .map_err(|e| format!("Failed to save provider: {:?}", e))
}

/// Delete a provider
#[tauri::command]
pub fn delete_provider(id: String, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .delete_provider(&id)
        .map_err(|e| format!("Failed to delete provider: {:?}", e))
}

/// Check if any providers exist
#[tauri::command]
pub fn has_providers(db: State<'_, Mutex<Database>>) -> Result<bool, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .has_providers()
        .map_err(|e| format!("Failed to check providers: {:?}", e))
}

/// Save multiple providers at once
#[tauri::command]
pub fn save_all_providers(
    providers: Vec<LLMProvider>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    for provider in providers {
        db.settings()
            .save_provider(&provider)
            .map_err(|e| format!("Failed to save provider: {:?}", e))?;
    }
    Ok(())
}

// ============================================================
// TOOL SETTINGS COMMANDS
// ============================================================

/// Get all tool settings
#[tauri::command]
pub fn get_all_tool_settings(db: State<'_, Mutex<Database>>) -> Result<Vec<ToolSetting>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .get_all_tool_settings()
        .map_err(|e| format!("Failed to get tool settings: {:?}", e))
}

/// Set tool approval mode
#[tauri::command]
pub fn set_tool_approval(
    tool_name: String,
    approval_mode: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .set_tool_setting(&tool_name, &approval_mode)
        .map_err(|e| format!("Failed to set tool approval: {:?}", e))
}

/// Save all tool settings at once
#[tauri::command]
pub fn save_all_tool_settings(
    settings: Vec<(String, String)>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings()
        .save_all_tool_settings(&settings)
        .map_err(|e| format!("Failed to save tool settings: {:?}", e))
}
