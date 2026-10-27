//! Settings, providers, provider models and tool approval. The bodies are
//! written once in `host_commands::settings`, which `aurora serve` serves too;
//! these lock the window's database and call them.

use std::sync::Mutex;
use tauri::State;

use crate::db::{AppSettings, Database, LLMProvider, ProviderModel, ToolSetting};
use crate::host_commands::settings as core;
use crate::launch_prefs::{self, LaunchSurface};

fn locked<T>(
    db: &State<'_, Mutex<Database>>,
    f: impl FnOnce(&Database) -> Result<T, String>,
) -> Result<T, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    f(&db)
}

// ============================================================
// APP SETTINGS COMMANDS
// ============================================================

#[tauri::command(async)]
pub fn get_app_settings(db: State<'_, Mutex<Database>>) -> Result<AppSettings, String> {
    locked(&db, core::get_app_settings)
}

#[tauri::command(async)]
pub fn save_app_settings(settings: AppSettings, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    locked(&db, |db| core::save_app_settings(db, &settings))
}

/// Only the given `[key, jsonValue]` pairs, in one transaction; each window
/// writes the keys it owns. Unknown keys are refused.
#[tauri::command(async)]
pub fn save_app_settings_entries(
    entries: Vec<(String, serde_json::Value)>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    locked(&db, |db| core::save_app_settings_entries(db, &entries))
}

#[tauri::command]
pub fn get_global_skills_path() -> Result<Option<String>, String> {
    Ok(core::global_skills_path())
}

#[tauri::command(async)]
pub fn get_setting(key: String, db: State<'_, Mutex<Database>>) -> Result<Option<String>, String> {
    locked(&db, |db| core::get_setting(db, &key))
}

#[tauri::command(async)]
pub fn set_setting(key: String, value: String, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    locked(&db, |db| core::set_setting(db, &key, &value))
}

// ============================================================
// LLM PROVIDER COMMANDS
// ============================================================

#[tauri::command(async)]
pub fn get_all_providers(db: State<'_, Mutex<Database>>) -> Result<Vec<LLMProvider>, String> {
    locked(&db, core::get_all_providers)
}

#[tauri::command(async)]
pub fn get_provider(id: String, db: State<'_, Mutex<Database>>) -> Result<Option<LLMProvider>, String> {
    locked(&db, |db| core::get_provider(db, &id))
}

#[tauri::command(async)]
pub fn save_provider(provider: LLMProvider, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    locked(&db, |db| core::save_provider(db, &provider))
}

#[tauri::command(async)]
pub fn delete_provider(id: String, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    locked(&db, |db| core::delete_provider(db, &id))
}

#[tauri::command(async)]
pub fn has_providers(db: State<'_, Mutex<Database>>) -> Result<bool, String> {
    locked(&db, core::has_providers)
}

#[tauri::command(async)]
pub fn save_all_providers(providers: Vec<LLMProvider>, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    locked(&db, |db| core::save_all_providers(db, &providers))
}

// ============================================================
// PROVIDER MODELS COMMANDS (v15+)
// ============================================================

#[tauri::command(async)]
pub fn list_provider_models(db: State<'_, Mutex<Database>>) -> Result<Vec<ProviderModel>, String> {
    locked(&db, core::list_provider_models)
}

#[tauri::command(async)]
pub fn list_provider_models_for(
    provider_id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<ProviderModel>, String> {
    locked(&db, |db| core::list_provider_models_for(db, &provider_id))
}

#[tauri::command(async)]
pub fn upsert_provider_model(model: ProviderModel, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    locked(&db, |db| core::upsert_provider_model(db, &model))
}

#[tauri::command(async)]
pub fn delete_provider_model(
    provider_id: String,
    model_key: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    locked(&db, |db| core::delete_provider_model(db, &provider_id, &model_key))
}

#[tauri::command(async)]
pub fn replace_provider_models(
    provider_id: String,
    models: Vec<ProviderModel>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    locked(&db, |db| core::replace_provider_models(db, &provider_id, &models))
}

// ============================================================
// TOOL SETTINGS COMMANDS
// ============================================================

#[tauri::command(async)]
pub fn get_all_tool_settings(db: State<'_, Mutex<Database>>) -> Result<Vec<ToolSetting>, String> {
    locked(&db, core::get_all_tool_settings)
}

#[tauri::command(async)]
pub fn set_tool_approval(
    tool_name: String,
    approval_mode: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    locked(&db, |db| core::set_tool_approval(db, &tool_name, &approval_mode))
}

#[tauri::command(async)]
pub fn save_all_tool_settings(settings: Vec<(String, String)>, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    locked(&db, |db| core::save_all_tool_settings(db, &settings))
}

// ============================================================
// LAUNCH SURFACE (boot config — NOT the database)
// ============================================================
//
// Which window a bare app-icon launch opens. Unlike every other setting on this
// page, this one is a JSON file rather than an `app_settings` row, because
// `run_with_args` must read it before `tauri::Builder` exists — long before the
// database is initialised. See `launch_prefs` for the full reasoning.

/// Read the surface a bare launch opens. Never fails; defaults to the IDE.
/// Off the main thread: both of these read or write a file.
#[tauri::command(async)]
pub fn get_launch_surface() -> LaunchSurface {
    launch_prefs::read()
}

/// Persist the surface a bare launch opens. Takes effect on the next launch.
#[tauri::command(async)]
pub fn set_launch_surface(surface: LaunchSurface) -> Result<(), String> {
    launch_prefs::write(surface)
}
