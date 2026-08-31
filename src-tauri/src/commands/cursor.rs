//! Tauri commands for the Cursor (subscription) provider.
//!
//! Thin wrappers over [`crate::api::cursor::auth`] — the credential logic is
//! Tauri-free; this layer only exposes it to the settings card.
//!
//! Every one of these reads a file or a SQLite database, so every one is
//! `async` + `spawn_blocking`: a sync `#[tauri::command] pub fn` runs on the
//! UI thread in Tauri v2 and would stutter the window (see
//! `commands::command_thread_safety`).

use std::sync::Mutex;

use tauri::State;

use crate::api::cursor::auth::{self, CursorAuthStatus};
use crate::api::cursor::usage::{self, CursorUsageSnapshot};
use crate::db::{CursorModel, Database};

/// Current sign-in state.
///
/// Reads Aurora's own credential store *and* the Cursor desktop install, and
/// reports whichever is newer — so signing in to the Cursor app is reflected
/// here without any action in Aurora.
#[tauri::command]
pub async fn cursor_auth_status() -> Result<CursorAuthStatus, String> {
    tokio::task::spawn_blocking(auth::status)
        .await
        .map_err(|err| format!("Status task failed: {err}"))?
}

/// How much of the Cursor plan is left.
///
/// Already `async` and network-bound, so unlike its neighbours it needs no
/// `spawn_blocking` — nothing here touches the disk on the UI thread.
#[tauri::command]
pub async fn cursor_usage_get() -> Result<CursorUsageSnapshot, String> {
    usage::fetch_usage().await
}

/// Adopt the Cursor desktop app's session into Aurora's own store.
///
/// Aurora can already read that session on demand; this exists so connecting
/// is something the user does deliberately rather than something that happens
/// silently the first time a turn runs.
#[tauri::command]
pub async fn cursor_auth_connect() -> Result<CursorAuthStatus, String> {
    tokio::task::spawn_blocking(auth::adopt_from_cursor_app)
        .await
        .map_err(|err| format!("Connect task failed: {err}"))?
}

/// Forget Aurora's copy of the session.
///
/// The Cursor app is untouched and stays signed in. Note this means a
/// subsequent [`cursor_auth_status`] will still report a detected install —
/// disconnecting Aurora is not a global sign-out, and the card says so.
#[tauri::command]
pub async fn cursor_auth_sign_out(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    tokio::task::spawn_blocking(move || {
        auth::sign_out()?;
        // Drop the catalogue too. A model list belonging to an account nobody
        // is signed in to still renders as selectable, which is worse than an
        // empty picker — the failure only shows up at the first request.
        let state = app.state::<Mutex<Database>>();
        let db = state.lock().map_err(|e| e.to_string())?;
        db.cursor_models().clear().map_err(|e| format!("{e:?}"))
    })
    .await
    .map_err(|err| format!("Sign-out task failed: {err}"))?
}

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

/// One model as the UI needs it: the stored row plus the facts derived from
/// its id.
///
/// `isFast`, `baseModelId` and `supportsVision` are computed rather than
/// stored, so they must be resolved here instead of in TypeScript — a second
/// implementation of "is this a fast variant" would be a second thing to keep
/// in sync with the catalogue.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorModelView {
    #[serde(flatten)]
    pub model: CursorModel,
    /// The model this is a variant of — the key the provider page groups on,
    /// so ~200 rows collapse to about half that.
    pub base_model_id: String,
    pub is_fast: bool,
    /// The vendor's own model id, for looking capability and pricing up in
    /// models.dev. `None` for `auto`, which routes rather than being a model.
    ///
    /// Cursor's wire carries no modality, context window, or price, so this is
    /// the join key that supplies them — the same catalogue every other Aurora
    /// provider already enriches from.
    pub catalog_key: Option<String>,
    /// An older generation, hidden from the default provider-page view.
    pub is_legacy: bool,
}

impl From<CursorModel> for CursorModelView {
    fn from(model: CursorModel) -> Self {
        Self {
            base_model_id: model.base_model_id().to_string(),
            is_fast: model.is_fast(),
            catalog_key: model.catalog_key(),
            is_legacy: model.is_legacy(),
            model,
        }
    }
}

fn to_views(models: Vec<CursorModel>) -> Vec<CursorModelView> {
    models.into_iter().map(CursorModelView::from).collect()
}

/// The catalogue plus the state the settings card renders around it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorModelCatalogue {
    pub models: Vec<CursorModelView>,
    /// RFC3339 of the last refresh, or `None` if never fetched.
    pub fetched_at: Option<String>,
    pub enabled_count: usize,
}

/// Every model on the account — what the **provider page** lists.
#[tauri::command(async)]
pub fn cursor_models_list(db: State<'_, Mutex<Database>>) -> Result<CursorModelCatalogue, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let repo = db.cursor_models();
    let models = repo.list().map_err(|e| format!("{e:?}"))?;
    let enabled_count = models.iter().filter(|m| m.enabled).count();
    Ok(CursorModelCatalogue {
        models: to_views(models),
        fetched_at: repo.fetched_at().map_err(|e| format!("{e:?}"))?,
        enabled_count,
    })
}

/// Only the models switched on — what the **model selector** offers.
///
/// A separate command rather than a filter on the frontend: an account reaches
/// ~200 models, and shipping all of them to the selector just to hide most is
/// wasted work on a list that opens constantly.
#[tauri::command(async)]
pub fn cursor_models_list_enabled(
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<CursorModel>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.cursor_models()
        .list_enabled()
        .map_err(|e| format!("{e:?}"))
}

/// Pull the catalogue from Cursor and store it.
///
/// The user's enable choices survive — see `CursorModelsRepository::replace_all`.
#[tauri::command]
pub async fn cursor_models_refresh(app: tauri::AppHandle) -> Result<CursorModelCatalogue, String> {
    use tauri::Manager;

    let token = auth::fresh_access(false).await?;
    let models = crate::api::cursor::models::fetch(&token).await?;
    let fetched_at = chrono::Utc::now().to_rfc3339();

    // Hop to a blocking thread for the write: a sync command body touching
    // SQLite would run on the UI thread.
    tokio::task::spawn_blocking(move || {
        let state = app.state::<Mutex<Database>>();
        let db = state.lock().map_err(|e| e.to_string())?;
        let repo = db.cursor_models();
        repo.replace_all(&models, &fetched_at)
            .map_err(|e| format!("{e:?}"))?;
        let stored = repo.list().map_err(|e| format!("{e:?}"))?;
        let enabled_count = stored.iter().filter(|m| m.enabled).count();
        Ok(CursorModelCatalogue {
            models: to_views(stored),
            fetched_at: repo.fetched_at().map_err(|e| format!("{e:?}"))?,
            enabled_count,
        })
    })
    .await
    .map_err(|err| format!("Refresh task failed: {err}"))?
}

/// Toggle one model's presence in the selector.
///
/// `false` means the id is no longer in the catalogue — a stale page toggling
/// a model a refresh removed, which the caller should surface rather than
/// leave looking successful.
#[tauri::command(async)]
pub fn cursor_model_set_enabled(
    model_id: String,
    enabled: bool,
    db: State<'_, Mutex<Database>>,
) -> Result<bool, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.cursor_models()
        .set_enabled(&model_id, enabled)
        .map_err(|e| format!("{e:?}"))
}

/// Enable or disable many at once — "enable all" and multi-select saves.
#[tauri::command(async)]
pub fn cursor_models_set_enabled_bulk(
    model_ids: Vec<String>,
    enabled: bool,
    db: State<'_, Mutex<Database>>,
) -> Result<usize, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.cursor_models()
        .set_enabled_bulk(&model_ids, enabled)
        .map_err(|e| format!("{e:?}"))
}

// Resolving a picked model plus effort, thinking and Fast into the id to send
// is deliberately NOT here. It is not a Fast-only question: Cursor puts effort
// and thinking in the id too, so the answer depends on controls the composer
// owns, and the send path that needs it is synchronous — an IPC round-trip in
// front of every turn to compose a string would be a poor trade. It lives in
// `services/providers/cursor-variants.ts`, checked against the same catalogue
// this file serves.

/// Where Aurora looked for the Cursor desktop install.
///
/// Surfaced so a user with a portable or relocated install can see the path
/// that came up empty and point `CURSOR_STATE_DB` at the right one, instead
/// of being told "not found" with nowhere to go.
#[tauri::command]
pub async fn cursor_state_db_path() -> Result<Option<String>, String> {
    let path = tokio::task::spawn_blocking(auth::cursor_state_db)
        .await
        .map_err(|err| format!("Path task failed: {err}"))?;
    Ok(path.map(|p| p.display().to_string()))
}
