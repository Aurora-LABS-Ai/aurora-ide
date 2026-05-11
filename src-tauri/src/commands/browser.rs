//! Browser commands
//!
//! IPC surface for the native WebView browser. Every command delegates
//! to `crate::services::browser_runtime::BrowserManager` (registered as
//! managed state in `lib.rs`); this layer just unwraps the state and
//! emits the cross-window events.
//!
//! The companion command `aurora_record_picked_element` is what the
//! injected inspector / Stagewise scripts call back into. It relays
//! the payload to the main window via the `aurora:element-picked`
//! event so `BrowserTab.tsx` can append the picked element into the
//! chat input.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::services::browser_runtime::{
    BrowserManager, BrowserResultPayload, BrowserThemeTokens, BrowserWindowSummary,
    CreateBrowserWindow, PickedElementPayload,
};

#[tauri::command]
pub async fn create_browser_webview(
    state: State<'_, BrowserManager>,
    options: CreateBrowserWindow,
) -> Result<(), String> {
    state.create_window(options)
}

#[tauri::command]
pub async fn close_browser_webview(
    state: State<'_, BrowserManager>,
    label: String,
) -> Result<(), String> {
    state.close(&label)
}

/// List every live browser window the BrowserManager knows about.
/// Frontend uses this both as the initial hydrate for the live-windows
/// store and as a refresh fallback.
#[tauri::command]
pub async fn list_browser_windows(
    state: State<'_, BrowserManager>,
) -> Result<Vec<BrowserWindowSummary>, String> {
    Ok(state.list_windows())
}

#[tauri::command]
pub async fn browser_navigate(
    state: State<'_, BrowserManager>,
    label: String,
    url: String,
) -> Result<(), String> {
    state.navigate(&label, &url)
}

#[tauri::command]
pub async fn browser_refresh(
    state: State<'_, BrowserManager>,
    label: String,
) -> Result<(), String> {
    state.refresh(&label)
}

#[tauri::command]
pub async fn browser_eval(
    state: State<'_, BrowserManager>,
    label: String,
    script: String,
) -> Result<(), String> {
    state.eval(&label, &script)
}

#[tauri::command]
pub async fn browser_get_url(
    state: State<'_, BrowserManager>,
    label: String,
) -> Result<String, String> {
    state.current_url(&label)
}

#[tauri::command]
pub async fn browser_set_size(
    state: State<'_, BrowserManager>,
    label: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    state.set_size(&label, width, height)
}

#[tauri::command]
pub async fn browser_set_position(
    state: State<'_, BrowserManager>,
    label: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    state.set_position(&label, x, y)
}

#[tauri::command]
pub async fn browser_activate_inspector(
    state: State<'_, BrowserManager>,
    label: String,
) -> Result<(), String> {
    state.activate_inspector(&label)
}

#[tauri::command]
pub async fn browser_deactivate_inspector(
    state: State<'_, BrowserManager>,
    label: String,
) -> Result<(), String> {
    state.deactivate_inspector(&label)
}

#[tauri::command]
pub async fn browser_clear_selection(
    state: State<'_, BrowserManager>,
    label: String,
) -> Result<(), String> {
    state.clear_selection(&label)
}

#[tauri::command]
pub async fn browser_activate_stagewise(
    state: State<'_, BrowserManager>,
    label: String,
    theme: BrowserThemeTokens,
) -> Result<(), String> {
    state.activate_stagewise(&label, &theme)
}

#[tauri::command]
pub async fn browser_deactivate_stagewise(
    state: State<'_, BrowserManager>,
    label: String,
) -> Result<(), String> {
    state.deactivate_stagewise(&label)
}

/// Called *from inside the browser webview* when the inspector or
/// Stagewise script captures an element. The payload arrives over the
/// standard Tauri IPC bridge; we relay it to the main window via the
/// `aurora:element-picked` event.
#[tauri::command]
pub async fn aurora_record_picked_element(
    app: AppHandle,
    payload: PickedElementPayload,
) -> Result<(), String> {
    app.emit("aurora:element-picked", payload)
        .map_err(|e| format!("emit element-picked failed: {e}"))
}

/// Called *from inside the browser webview* by `__aurora.respond` to
/// resolve a pending two-way IPC request issued by an agent tool
/// (eval / screenshot / get_dom / …).
#[tauri::command]
pub async fn aurora_record_browser_result(
    state: State<'_, BrowserManager>,
    payload: BrowserResultPayload,
) -> Result<(), String> {
    let BrowserResultPayload { request_id, result } = payload;
    state.resolve_result(&request_id, result);
    Ok(())
}

/// Legacy helper kept for parity with the previous stub set. Returns
/// the inspector activation script as a string so any future callers
/// (e.g. tests) can introspect what the runtime injects.
#[tauri::command]
pub fn get_inspector_script() -> InspectorScriptInfo {
    InspectorScriptInfo {
        // The actual script lives inside `browser_runtime.rs` and is
        // injected via `WebviewWindow::eval`. This shim exists so the
        // frontend can detect that the runtime is present without
        // shipping the script blob across IPC.
        available: true,
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorScriptInfo {
    pub available: bool,
    pub version: String,
}
