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
use crate::services::browser_view;
use crate::tools::browser::local_servers;

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
    // The panel polls this for its address bar, so it has to follow the page
    // rather than Aurora's record of where it last sent the page — otherwise
    // clicking a link inside the panel leaves the bar showing the old route.
    state
        .live_url(&label)
        .await
        .ok_or_else(|| format!("no browser window '{label}'"))
}

/// The page's `document.title`, for its tab in the dock. `None` while the page
/// has no title or is mid-navigation — the tab then keeps showing the address.
#[tauri::command]
pub async fn browser_page_title(
    state: State<'_, BrowserManager>,
    label: String,
) -> Result<Option<String>, String> {
    let result = state.eval_with_result(&label, "document.title").await?;
    Ok(result
        .value
        .filter(|_| result.ok)
        .and_then(|value| value.as_str().map(|title| title.trim().to_string()))
        .filter(|title| !title.is_empty()))
}

/// Local servers that background processes announced in their output, each
/// checked for an answer. Feeds "Running" on the dock's New tab page.
#[tauri::command]
pub async fn browser_local_servers() -> Result<Vec<local_servers::LocalServer>, String> {
    let processes = crate::commands::shell_background_processes()
        .into_iter()
        .map(|row| local_servers::ProcessLog {
            process_id: row.process_id,
            name: row.name,
            command: row.command,
            started_at_ms: row.started_at_ms,
            output_file: row.output_file,
        })
        .collect();
    Ok(local_servers::find(processes).await)
}

/// Show a page as a device (the panel's device buttons), or at its natural
/// size with `None`. On the agent's page the agent's own emulation record is
/// kept in step, so its tools report the size the page really has.
#[tauri::command]
pub async fn browser_set_device(
    state: State<'_, BrowserManager>,
    label: String,
    device: Option<browser_view::DeviceSpec>,
) -> Result<(), String> {
    let webview = state.webview(&label)?;
    browser_view::set_device(&webview, &label, device.clone()).await?;
    if label == crate::tools::browser::AGENT_BROWSER_LABEL {
        match device {
            Some(d) => crate::tools::browser::state::set_emulation(crate::tools::browser::state::Emulation {
                width: d.width,
                height: d.height,
                scale: d.device_scale_factor,
                mobile: d.mobile,
            }),
            None => crate::tools::browser::state::clear_emulation(),
        }
    }
    Ok(())
}

/// The browser's own zoom for a page. Returns the zoom actually applied
/// (clamped to 25%–500%).
#[tauri::command]
pub async fn browser_set_zoom(
    state: State<'_, BrowserManager>,
    label: String,
    zoom: f64,
) -> Result<f64, String> {
    let webview = state.webview(&label)?;
    browser_view::set_zoom(&webview, &label, zoom)
}

/// Round a page window's bottom corners (a device frame's screen), or square
/// them with 0. Applied now at the page's current size, and again by every
/// later move or resize.
#[tauri::command]
pub async fn browser_set_corner_radius(
    state: State<'_, BrowserManager>,
    label: String,
    radius: f64,
) -> Result<(), String> {
    let webview = state.webview(&label)?;
    browser_view::set_corner_radius(&label, radius);
    let scale = webview.window().scale_factor().unwrap_or(1.0);
    let size = webview.size().map_err(|err| format!("page size unavailable: {err}"))?;
    browser_view::apply_corners(
        &webview,
        &label,
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
    );
    Ok(())
}

/// A screenshot of a page as base64 PNG, for the composer — the page exactly
/// as painted in the panel.
///
/// Deliberately NOT DevTools' `Page.captureScreenshot` for a device, although
/// that one returns the phone's full resolution: with a fit-scale in force,
/// Chromium re-renders the view at full size for the capture and shrinks it
/// back, and the user watched the phone lurch in and out on every click
/// (2026-09-29). The page's own layout never changed (no resize reached it —
/// checked in Edge); it was the compositor. The native capture reads the
/// surface as it is and moves nothing, at the size the device is drawn.
#[tauri::command]
pub async fn browser_capture_screenshot(
    state: State<'_, BrowserManager>,
    label: String,
) -> Result<String, String> {
    use base64::Engine as _;
    let webview = state.webview(&label)?;
    match crate::services::browser_native_capture::capture_webview_png(&webview).await? {
        Some(png) => Ok(base64::engine::general_purpose::STANDARD.encode(png)),
        None => Err("screenshots are not available on this platform".into()),
    }
}

/// Evaluate `script` in a page and return its value — for the panel's find
/// bar, which needs the match count back.
#[tauri::command]
pub async fn browser_eval_value(
    state: State<'_, BrowserManager>,
    label: String,
    script: String,
) -> Result<serde_json::Value, String> {
    let result = state.eval_with_result(&label, &script).await?;
    if result.ok {
        Ok(result.value.unwrap_or(serde_json::Value::Null))
    } else {
        Err(result.error.unwrap_or_else(|| "the page could not run the script".into()))
    }
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

/// Position + size in one call — used by the embedded in-tab browser to track
/// its panel rect without two round-trips.
#[tauri::command]
pub async fn browser_set_bounds(
    state: State<'_, BrowserManager>,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    state.set_bounds(&label, x, y, width, height)
}

/// Show or hide the embedded browser. `seq` must grow with every decision;
/// a stale one is ignored (returns `false`). This is the only way the
/// frontend changes the page's visibility — see `BrowserManager::set_visible`.
#[tauri::command]
pub async fn browser_set_visible(
    state: State<'_, BrowserManager>,
    label: String,
    visible: bool,
    seq: u64,
) -> Result<bool, String> {
    state.set_visible(&label, visible, seq)
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
