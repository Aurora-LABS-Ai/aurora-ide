//! The settings database: app settings, providers and their models, tool
//! approval, and the saved workspace / editor / explorer state. Written once
//! here; the window's `#[tauri::command]`s (`commands/settings.rs`,
//! `commands/state.rs`) are wrappers that lock the managed database and call
//! these, and [`dispatch`] serves the same names to any other host.
//!
//! These are what the interface calls on load (`kernel/services/database.ts`),
//! so a browser on `aurora serve` cannot start without them.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::db::{
    AppSettings, Database, EditorState, ExplorerState, LLMProvider, ProviderModel, ToolSetting,
    WorkspaceState,
};

pub const COMMANDS: &[&str] = &[
    "get_app_settings",
    "save_app_settings",
    "save_app_settings_entries",
    "get_global_skills_path",
    "get_setting",
    "set_setting",
    "get_all_providers",
    "get_provider",
    "save_provider",
    "delete_provider",
    "has_providers",
    "save_all_providers",
    "list_provider_models",
    "list_provider_models_for",
    "upsert_provider_model",
    "delete_provider_model",
    "replace_provider_models",
    "get_all_tool_settings",
    "set_tool_approval",
    "save_all_tool_settings",
    "save_workspace_state",
    "get_workspace_state",
    "list_recent_workspaces",
    "save_editor_state",
    "get_editor_state",
    "save_explorer_state",
    "get_explorer_state",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    ctx: &CommandContext,
    name: &str,
    args: &Value,
) -> Option<Result<Value, CommandError>> {
    let n = name;
    Some(match name {
        "get_app_settings" => done(ctx.with_db(get_app_settings).await),
        "save_app_settings" => {
            let settings: AppSettings = match arg(n, args, "settings") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| save_app_settings(db, &settings)).await)
        }
        "save_app_settings_entries" => {
            let entries: Vec<(String, Value)> = match arg(n, args, "entries") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| save_app_settings_entries(db, &entries)).await)
        }
        "get_global_skills_path" => done(Ok(global_skills_path())),
        "get_setting" => {
            let key: String = match arg(n, args, "key") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| get_setting(db, &key)).await)
        }
        "set_setting" => {
            let key: String = match arg(n, args, "key") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            let value: String = match arg(n, args, "value") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| set_setting(db, &key, &value)).await)
        }
        "get_all_providers" => done(ctx.with_db(get_all_providers).await),
        "get_provider" => {
            let id: String = match arg(n, args, "id") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| get_provider(db, &id)).await)
        }
        "save_provider" => {
            let provider: LLMProvider = match arg(n, args, "provider") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| save_provider(db, &provider)).await)
        }
        "delete_provider" => {
            let id: String = match arg(n, args, "id") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| delete_provider(db, &id)).await)
        }
        "has_providers" => done(ctx.with_db(has_providers).await),
        "save_all_providers" => {
            let providers: Vec<LLMProvider> = match arg(n, args, "providers") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| save_all_providers(db, &providers)).await)
        }
        "list_provider_models" => done(ctx.with_db(list_provider_models).await),
        "list_provider_models_for" => {
            let provider_id: String = match arg(n, args, "providerId") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| list_provider_models_for(db, &provider_id)).await)
        }
        "upsert_provider_model" => {
            let model: ProviderModel = match arg(n, args, "model") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| upsert_provider_model(db, &model)).await)
        }
        "delete_provider_model" => {
            let provider_id: String = match arg(n, args, "providerId") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            let model_key: String = match arg(n, args, "modelKey") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| delete_provider_model(db, &provider_id, &model_key)).await)
        }
        "replace_provider_models" => {
            let provider_id: String = match arg(n, args, "providerId") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            let models: Vec<ProviderModel> = match arg(n, args, "models") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| replace_provider_models(db, &provider_id, &models)).await)
        }
        "get_all_tool_settings" => done(ctx.with_db(get_all_tool_settings).await),
        "set_tool_approval" => {
            let tool_name: String = match arg(n, args, "toolName") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            let mode: String = match arg(n, args, "approvalMode") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| set_tool_approval(db, &tool_name, &mode)).await)
        }
        "save_all_tool_settings" => {
            let settings: Vec<(String, String)> = match arg(n, args, "settings") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| save_all_tool_settings(db, &settings)).await)
        }
        "save_workspace_state" => {
            let state: WorkspaceState = match arg(n, args, "state") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| save_workspace_state(db, &state)).await)
        }
        "get_workspace_state" => {
            let path: Option<String> = match arg(n, args, "workspacePath") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| get_workspace_state(db, path.as_deref())).await)
        }
        "list_recent_workspaces" => {
            let limit: Option<usize> = match arg(n, args, "limit") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| list_recent_workspaces(db, limit)).await)
        }
        "save_editor_state" => {
            let state: EditorState = match arg(n, args, "state") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| save_editor_state(db, &state)).await)
        }
        "get_editor_state" => {
            let path: String = match arg(n, args, "filePath") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| get_editor_state(db, &path)).await)
        }
        "save_explorer_state" => {
            let state: ExplorerState = match arg(n, args, "state") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| save_explorer_state(db, &state)).await)
        }
        "get_explorer_state" => {
            let path: String = match arg(n, args, "workspacePath") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            done(ctx.with_db(move |db| get_explorer_state(db, &path)).await)
        }
        _ => return None,
    })
}

// ── App settings ────────────────────────────────────────────────────────

pub fn get_app_settings(db: &Database) -> Result<AppSettings, String> {
    db.settings()
        .get_app_settings()
        .map_err(|e| format!("Failed to get settings: {:?}", e))
}

pub fn save_app_settings(db: &Database, settings: &AppSettings) -> Result<(), String> {
    db.settings()
        .save_app_settings(settings)
        .map_err(|e| format!("Failed to save settings: {:?}", e))
}

/// Save only the given settings (`[key, jsonValue]` pairs), in one
/// transaction. Each window writes the keys it owns through this, so neither
/// overwrites the other's settings with a stale copy. Unknown keys are refused.
pub fn save_app_settings_entries(db: &Database, entries: &[(String, Value)]) -> Result<(), String> {
    db.settings()
        .save_app_setting_entries(entries)
        .map_err(|e| format!("Failed to save settings: {e}"))
}

/// `~/.agents/skills` (plural): the workspace convention
/// (`WORKSPACE_SKILL_FOLDERS`) and the cross-agent shared-skills layout used by
/// other tooling. It once pointed at `.agent` (singular), so the user's real
/// global skills were never discovered.
pub fn global_skills_path() -> Option<String> {
    dirs::home_dir().map(|home| {
        home.join(".agents")
            .join("skills")
            .to_string_lossy()
            .to_string()
    })
}

pub fn get_setting(db: &Database, key: &str) -> Result<Option<String>, String> {
    let setting = db
        .settings()
        .get_setting(key)
        .map_err(|e| format!("Failed to get setting: {:?}", e))?;
    Ok(setting.map(|s| s.value))
}

pub fn set_setting(db: &Database, key: &str, value: &str) -> Result<(), String> {
    db.settings()
        .set_setting(key, value)
        .map_err(|e| format!("Failed to set setting: {:?}", e))
}

// ── Providers ───────────────────────────────────────────────────────────

pub fn get_all_providers(db: &Database) -> Result<Vec<LLMProvider>, String> {
    db.settings()
        .get_all_providers()
        .map_err(|e| format!("Failed to get providers: {:?}", e))
}

pub fn get_provider(db: &Database, id: &str) -> Result<Option<LLMProvider>, String> {
    db.settings()
        .get_provider(id)
        .map_err(|e| format!("Failed to get provider: {:?}", e))
}

pub fn save_provider(db: &Database, provider: &LLMProvider) -> Result<(), String> {
    db.settings()
        .save_provider(provider)
        .map_err(|e| format!("Failed to save provider: {:?}", e))
}

pub fn delete_provider(db: &Database, id: &str) -> Result<(), String> {
    db.settings()
        .delete_provider(id)
        .map_err(|e| format!("Failed to delete provider: {:?}", e))
}

pub fn has_providers(db: &Database) -> Result<bool, String> {
    db.settings()
        .has_providers()
        .map_err(|e| format!("Failed to check providers: {:?}", e))
}

pub fn save_all_providers(db: &Database, providers: &[LLMProvider]) -> Result<(), String> {
    for provider in providers {
        save_provider(db, provider)?;
    }
    Ok(())
}

// ── Provider models (schema v15+) ───────────────────────────────────────
//
// Per-model capabilities (vision, thinking, tool-stream) and per-model
// context/output overrides live in `provider_models`, not on the provider row.

pub fn list_provider_models(db: &Database) -> Result<Vec<ProviderModel>, String> {
    db.models()
        .list_all()
        .map_err(|e| format!("Failed to list provider models: {:?}", e))
}

pub fn list_provider_models_for(db: &Database, provider_id: &str) -> Result<Vec<ProviderModel>, String> {
    db.models()
        .list_by_provider(provider_id)
        .map_err(|e| format!("Failed to list provider models: {:?}", e))
}

pub fn upsert_provider_model(db: &Database, model: &ProviderModel) -> Result<(), String> {
    db.models()
        .upsert(model)
        .map_err(|e| format!("Failed to upsert provider model: {:?}", e))
}

pub fn delete_provider_model(db: &Database, provider_id: &str, model_key: &str) -> Result<(), String> {
    db.models()
        .delete(provider_id, model_key)
        .map_err(|e| format!("Failed to delete provider model: {:?}", e))
}

/// Replace a provider's whole model list in one transaction: the Providers
/// hub finishing an edit, or accepting a Discover Local Servers result.
pub fn replace_provider_models(
    db: &Database,
    provider_id: &str,
    models: &[ProviderModel],
) -> Result<(), String> {
    db.models()
        .replace_for_provider(provider_id, models)
        .map_err(|e| format!("Failed to replace provider models: {:?}", e))
}

// ── Tool approval ───────────────────────────────────────────────────────

pub fn get_all_tool_settings(db: &Database) -> Result<Vec<ToolSetting>, String> {
    db.settings()
        .get_all_tool_settings()
        .map_err(|e| format!("Failed to get tool settings: {:?}", e))
}

pub fn set_tool_approval(db: &Database, tool_name: &str, approval_mode: &str) -> Result<(), String> {
    db.settings()
        .set_tool_setting(tool_name, approval_mode)
        .map_err(|e| format!("Failed to set tool approval: {:?}", e))
}

pub fn save_all_tool_settings(db: &Database, settings: &[(String, String)]) -> Result<(), String> {
    db.settings()
        .save_all_tool_settings(settings)
        .map_err(|e| format!("Failed to save tool settings: {:?}", e))
}

// ── Saved workspace / editor / explorer state ──────────────────────────

pub fn save_workspace_state(db: &Database, state: &WorkspaceState) -> Result<(), String> {
    db.workspace()
        .save(state)
        .map_err(|e| format!("Failed to save workspace state: {:?}", e))
}

/// By path, or the most recent workspace when none is given.
pub fn get_workspace_state(db: &Database, workspace_path: Option<&str>) -> Result<Option<WorkspaceState>, String> {
    match workspace_path {
        Some(path) => db.workspace().get_by_path(path),
        None => db.workspace().get_most_recent(),
    }
    .map_err(|e| format!("Failed to get workspace state: {:?}", e))
}

/// Recently opened workspaces, newest first (3 unless `limit` says otherwise).
pub fn list_recent_workspaces(db: &Database, limit: Option<usize>) -> Result<Vec<WorkspaceState>, String> {
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

pub fn save_editor_state(db: &Database, state: &EditorState) -> Result<(), String> {
    db.editor()
        .save(state)
        .map_err(|e| format!("Failed to save editor state: {:?}", e))
}

pub fn get_editor_state(db: &Database, file_path: &str) -> Result<Option<EditorState>, String> {
    db.editor()
        .get(file_path)
        .map_err(|e| format!("Failed to get editor state: {:?}", e))
}

pub fn save_explorer_state(db: &Database, state: &ExplorerState) -> Result<(), String> {
    db.explorer()
        .save(state)
        .map_err(|e| format!("Failed to save explorer state: {:?}", e))
}

pub fn get_explorer_state(db: &Database, workspace_path: &str) -> Result<Option<ExplorerState>, String> {
    db.explorer()
        .get(workspace_path)
        .map_err(|e| format!("Failed to get explorer state: {:?}", e))
}
