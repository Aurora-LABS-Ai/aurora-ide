//! Browser Runtime
//!
//! Owns the lifecycle of native Tauri WebView windows used as browser
//! previews and as targets for element-inspection / Stagewise-style
//! interaction.
//!
//! This module replaces the legacy iframe-only path. The iframe stays in
//! `BrowserTab.tsx` as a quick preview, but anything that needs script
//! injection (inspect-element, Stagewise toolbar, future agent-driven
//! browser tools) goes through here so we control the WebView at the
//! native layer instead of being blocked by the same-origin policy.
//!
//! ## Lifecycle
//!
//! * `create_window` → `WebviewWindowBuilder` builds a new window with
//!   the `BROWSER_INIT_SCRIPT` injected before page load. The window
//!   label is recorded in `windows`.
//! * `navigate` / `eval` / `refresh` → look up the window by label and
//!   forward to the WebView API.
//! * `activate_inspector` / `deactivate_inspector` → eval the inspector
//!   bundle. The script captures clicks and posts each pick back via
//!   `aurora_record_picked_element` (a Tauri command), which the
//!   `commands::browser` layer relays to the main window as
//!   `aurora:element-picked`.
//! * `activate_stagewise` / `deactivate_stagewise` → eval a floating
//!   toolbar that lets the user mark up the page (select +
//!   comment), backed by the same picked-element pipeline.
//! * The window's destroy listener cleans the entry from `windows` and
//!   emits `aurora:browser-window-closed` so the frontend tab can
//!   react.
//!
//! All scripts assume `withGlobalTauri = true` (set in
//! `tauri.conf.json`) so `window.__TAURI_INTERNALS__.invoke(...)` is
//! reachable in any window we create.

use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::sync::oneshot;
use uuid::Uuid;

/// Per-window state we track across IPC calls.
#[derive(Debug, Clone, Default)]
struct BrowserWindowState {
    inspector_active: bool,
    stagewise_active: bool,
    /// The last URL we asked the WebView to navigate to. Tauri's
    /// `WebviewWindow::url()` only reflects the *initial* URL, so we
    /// keep our own copy that the frontend can read back via
    /// `browser_get_url`.
    current_url: String,
}

/// Shared, app-managed state that owns every native browser WebView.
///
/// Every field is cheap to clone (the per-window state and the
/// pending-result router are both `Arc<DashMap>`), so cloning a
/// `BrowserManager` produces a second handle that shares all state
/// with the original. This lets us hand one clone to
/// `register_builtin_tools` (so the agent tool bucket holds an `Arc`
/// to the same map) and put a second clone into Tauri's managed
/// state (so the IPC commands see the same windows).
#[derive(Clone)]
pub struct BrowserManager {
    app: AppHandle,
    windows: Arc<DashMap<String, BrowserWindowState>>,
    /// Pending oneshot router for every two-way IPC call we send into
    /// a browser webview (eval, screenshot, get_dom, …). The injected
    /// page-side helper resolves these via the
    /// `aurora_record_browser_result` Tauri command.
    pending: Arc<DashMap<String, oneshot::Sender<BrowserResult>>>,
}

/// Default ceiling for two-way IPC waits. Long enough for a slow page
/// load (e.g. heavy SPA + screenshot), short enough that the agent
/// loop is never blocked indefinitely on a misbehaving page.
const DEFAULT_RESULT_TIMEOUT: Duration = Duration::from_secs(30);

impl BrowserManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            windows: Arc::new(DashMap::new()),
            pending: Arc::new(DashMap::new()),
        }
    }

    /// Resolve a two-way IPC result for a previously-issued request.
    /// Called from the `aurora_record_browser_result` Tauri command
    /// when the page-side helper posts a value back.
    pub fn resolve_result(&self, request_id: &str, result: BrowserResult) {
        if let Some((_, sender)) = self.pending.remove(request_id) {
            let _ = sender.send(result);
        }
    }

    /// Create a new native WebView window for browsing/inspection.
    ///
    /// `label` must be unique. We prefix every browser-window label
    /// with `browser-` so the capability allowlist (and any future
    /// permission policy) can target this family with a wildcard.
    pub fn create_window(&self, opts: CreateBrowserWindow) -> Result<(), String> {
        let label = sanitize_label(&opts.label)?;

        if self.windows.contains_key(&label) {
            // Window already exists — focus and (optionally) navigate.
            if let Some(window) = self.app.get_webview_window(&label) {
                let _ = window.set_focus();
                if !opts.url.is_empty() {
                    self.navigate(&label, &opts.url)?;
                }
                return Ok(());
            }
            // The label was tracked but the window is gone — drop the
            // stale entry and fall through to a fresh build.
            self.windows.remove(&label);
        }

        let url = WebviewUrl::External(
            opts.url
                .parse()
                .map_err(|e| format!("invalid url '{}': {e}", opts.url))?,
        );

        let mut builder = WebviewWindowBuilder::new(&self.app, &label, url)
            .title(opts.title.as_deref().unwrap_or("Aurora Browser"))
            .inner_size(opts.width.unwrap_or(1280.0), opts.height.unwrap_or(800.0))
            .resizable(true)
            .focused(true)
            .initialization_script(BROWSER_INIT_SCRIPT);

        if let (Some(x), Some(y)) = (opts.x, opts.y) {
            builder = builder.position(x, y);
        }

        if let Some(true) = opts.always_on_top {
            builder = builder.always_on_top(true);
        }

        let window = builder
            .build()
            .map_err(|e| format!("failed to build browser window '{label}': {e}"))?;

        self.windows.insert(
            label.clone(),
            BrowserWindowState {
                current_url: opts.url.clone(),
                ..Default::default()
            },
        );

        // When the window is destroyed externally (X button, Alt-F4)
        // drop our state and tell the frontend so the tab can show a
        // closed-state badge.
        let app = self.app.clone();
        let windows = self.windows.clone();
        let label_for_close = label.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                windows.remove(&label_for_close);
                let _ = app.emit(
                    "aurora:browser-window-closed",
                    BrowserWindowClosedPayload {
                        label: label_for_close.clone(),
                    },
                );
            }
        });

        Ok(())
    }

    pub fn navigate(&self, label: &str, url: &str) -> Result<(), String> {
        let window = self.window(label)?;
        // `WebviewWindow::navigate` exists in Tauri 2 and tells the
        // underlying WebView to load a new URL without recreating the
        // window.
        let parsed = url
            .parse()
            .map_err(|e| format!("invalid url '{url}': {e}"))?;
        window
            .navigate(parsed)
            .map_err(|e| format!("navigate failed: {e}"))?;
        if let Some(mut entry) = self.windows.get_mut(label) {
            entry.current_url = url.to_string();
            // A fresh page load wipes any previously-injected inspector
            // overlay; mark the flags as inactive so the frontend can
            // re-arm if it wants to.
            entry.inspector_active = false;
            entry.stagewise_active = false;
        }
        Ok(())
    }

    pub fn refresh(&self, label: &str) -> Result<(), String> {
        let window = self.window(label)?;
        window
            .eval("window.location.reload();")
            .map_err(|e| format!("refresh failed: {e}"))?;
        if let Some(mut entry) = self.windows.get_mut(label) {
            entry.inspector_active = false;
            entry.stagewise_active = false;
        }
        Ok(())
    }

    pub fn eval(&self, label: &str, script: &str) -> Result<(), String> {
        let window = self.window(label)?;
        window
            .eval(script)
            .map_err(|e| format!("eval failed: {e}"))
    }

    pub fn close(&self, label: &str) -> Result<(), String> {
        if let Some(window) = self.app.get_webview_window(label) {
            let _ = window.close();
        }
        self.windows.remove(label);
        Ok(())
    }

    pub fn current_url(&self, label: &str) -> Result<String, String> {
        self.windows
            .get(label)
            .map(|entry| entry.current_url.clone())
            .ok_or_else(|| format!("unknown window '{label}'"))
    }

    pub fn set_size(&self, label: &str, width: f64, height: f64) -> Result<(), String> {
        let window = self.window(label)?;
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| format!("set_size failed: {e}"))
    }

    pub fn set_position(&self, label: &str, x: f64, y: f64) -> Result<(), String> {
        let window = self.window(label)?;
        window
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| format!("set_position failed: {e}"))
    }

    pub fn activate_inspector(&self, label: &str) -> Result<(), String> {
        self.eval(label, INSPECTOR_ACTIVATE_SCRIPT)?;
        if let Some(mut entry) = self.windows.get_mut(label) {
            entry.inspector_active = true;
        }
        Ok(())
    }

    pub fn deactivate_inspector(&self, label: &str) -> Result<(), String> {
        self.eval(label, INSPECTOR_DEACTIVATE_SCRIPT)?;
        if let Some(mut entry) = self.windows.get_mut(label) {
            entry.inspector_active = false;
        }
        Ok(())
    }

    pub fn clear_selection(&self, label: &str) -> Result<(), String> {
        self.eval(label, INSPECTOR_CLEAR_SCRIPT)
    }

    pub fn activate_stagewise(
        &self,
        label: &str,
        theme: &BrowserThemeTokens,
    ) -> Result<(), String> {
        let script = build_stagewise_script(theme);
        self.eval(label, &script)?;
        if let Some(mut entry) = self.windows.get_mut(label) {
            entry.stagewise_active = true;
        }
        Ok(())
    }

    pub fn deactivate_stagewise(&self, label: &str) -> Result<(), String> {
        self.eval(label, STAGEWISE_DEACTIVATE_SCRIPT)?;
        if let Some(mut entry) = self.windows.get_mut(label) {
            entry.stagewise_active = false;
        }
        Ok(())
    }

    fn window(&self, label: &str) -> Result<WebviewWindow, String> {
        self.app
            .get_webview_window(label)
            .ok_or_else(|| format!("unknown window '{label}'"))
    }

    // -----------------------------------------------------------------
    // Agent-facing methods (browser tools)
    // -----------------------------------------------------------------

    /// Snapshot of currently-known browser windows.
    pub fn list_windows(&self) -> Vec<BrowserWindowSummary> {
        self.windows
            .iter()
            .map(|entry| BrowserWindowSummary {
                label: entry.key().clone(),
                url: entry.value().current_url.clone(),
                inspector_active: entry.value().inspector_active,
                stagewise_active: entry.value().stagewise_active,
            })
            .collect()
    }

    /// Generate a fresh request-id and register a oneshot in `pending`.
    /// Caller eval's a script that ends in
    /// `__aurora.respond("<request_id>", value)`; the sender resolves
    /// when the page-side helper posts back via the
    /// `aurora_record_browser_result` Tauri command.
    fn issue_request(&self) -> (String, oneshot::Receiver<BrowserResult>) {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.insert(id.clone(), tx);
        (id, rx)
    }

    /// Park on a pending request with a deadline. On timeout / drop,
    /// also clean the entry from the router so we don't leak senders
    /// for browsers that crashed mid-call.
    async fn await_result(
        &self,
        request_id: String,
        rx: oneshot::Receiver<BrowserResult>,
        timeout: Duration,
    ) -> Result<BrowserResult, String> {
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => {
                self.pending.remove(&request_id);
                Err("browser result channel closed".into())
            }
            Err(_) => {
                self.pending.remove(&request_id);
                Err(format!(
                    "browser request '{request_id}' timed out after {}s",
                    timeout.as_secs()
                ))
            }
        }
    }

    /// Run an arbitrary JS expression in the page and return its
    /// JSON-stringified result. The expression is wrapped so anything
    /// it returns (or throws) is reported back through the result
    /// channel.
    pub async fn eval_with_result(
        &self,
        label: &str,
        expression: &str,
    ) -> Result<BrowserResult, String> {
        let (request_id, rx) = self.issue_request();
        let script = format!(
            r#"(async () => {{
                try {{
                    const value = await (async () => ({expr}))();
                    window.__aurora.respond({rid}, {{ ok: true, value }});
                }} catch (err) {{
                    window.__aurora.respond({rid}, {{ ok: false, error: String(err && err.message ? err.message : err) }});
                }}
            }})();"#,
            expr = expression,
            rid = json!(request_id),
        );
        self.eval(label, &script)?;
        self.await_result(request_id, rx, DEFAULT_RESULT_TIMEOUT).await
    }

    /// Capture an HTML snapshot of the page or a single selector.
    /// Limited to ~200 KB so a maximalist DOM doesn't trash the
    /// agent's context window.
    pub async fn get_dom(
        &self,
        label: &str,
        selector: Option<&str>,
    ) -> Result<BrowserResult, String> {
        let expr = match selector {
            Some(sel) => format!(
                "(() => {{ const el = document.querySelector({s}); return el ? (el.outerHTML || '').slice(0, 200000) : null; }})()",
                s = json!(sel)
            ),
            None => "(() => (document.documentElement.outerHTML || '').slice(0, 200000))()".into(),
        };
        self.eval_with_result(label, &expr).await
    }

    /// Inspect a single element and return tag, attributes, bounding
    /// rect, computed text, and a small subset of computed styles.
    pub async fn inspect_element(
        &self,
        label: &str,
        selector: &str,
    ) -> Result<BrowserResult, String> {
        let expr = format!(
            r#"(() => {{
                const el = document.querySelector({s});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const cs = window.getComputedStyle(el);
                const attrs = {{}};
                for (const a of el.attributes) attrs[a.name] = a.value;
                return {{
                    tagName: el.tagName.toLowerCase(),
                    id: el.id || null,
                    className: typeof el.className === 'string' ? el.className : null,
                    text: (el.textContent || '').trim().slice(0, 400),
                    boundingRect: {{ x: r.x, y: r.y, width: r.width, height: r.height }},
                    attributes: attrs,
                    visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
                    computedStyles: {{
                        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
                        color: cs.color, backgroundColor: cs.backgroundColor,
                        fontSize: cs.fontSize, fontWeight: cs.fontWeight,
                    }}
                }};
            }})()"#,
            s = json!(selector)
        );
        self.eval_with_result(label, &expr).await
    }

    /// Drain a slice of the rolling console buffer maintained by
    /// `BROWSER_INIT_SCRIPT`. `level` filters by severity, `since_ms`
    /// drops entries older than that wall-clock cutoff.
    pub async fn get_console_logs(
        &self,
        label: &str,
        level: Option<&str>,
        since_ms: Option<u64>,
    ) -> Result<BrowserResult, String> {
        let level_arg = level
            .map(|l| json!(l).to_string())
            .unwrap_or_else(|| "null".into());
        let since_arg = since_ms
            .map(|s| s.to_string())
            .unwrap_or_else(|| "null".into());
        let expr = format!("window.__aurora.getLogs({lvl}, {since})", lvl = level_arg, since = since_arg);
        self.eval_with_result(label, &expr).await
    }

    /// Click the first element matching `selector`. Returns `{ ok,
    /// selector, tagName }` on success.
    pub async fn click(&self, label: &str, selector: &str) -> Result<BrowserResult, String> {
        let expr = format!(
            r#"(() => {{
                const el = document.querySelector({s});
                if (!el) throw new Error('no element matches ' + {s});
                el.scrollIntoView({{ block: 'center', inline: 'center' }});
                el.click();
                return {{ ok: true, selector: {s}, tagName: el.tagName.toLowerCase() }};
            }})()"#,
            s = json!(selector)
        );
        self.eval_with_result(label, &expr).await
    }

    /// Set the value of an input / textarea / contentEditable matching
    /// `selector` and dispatch the `input` and `change` events so
    /// frameworks (React, Vue, Svelte) actually pick the change up.
    /// Optionally submits the enclosing `<form>`.
    pub async fn fill(
        &self,
        label: &str,
        selector: &str,
        value: &str,
        submit: bool,
    ) -> Result<BrowserResult, String> {
        let expr = format!(
            r#"(() => {{
                const el = document.querySelector({s});
                if (!el) throw new Error('no element matches ' + {s});
                const v = {v};
                if (el.isContentEditable) {{
                    el.textContent = v;
                }} else {{
                    const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value');
                    if (setter && setter.set) setter.set.call(el, v); else el.value = v;
                }}
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                if ({submit}) {{
                    const form = el.closest('form');
                    if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
                }}
                return {{ ok: true, selector: {s} }};
            }})()"#,
            s = json!(selector),
            v = json!(value),
            submit = if submit { "true" } else { "false" },
        );
        self.eval_with_result(label, &expr).await
    }

    /// Resolve when `selector` exists, is in the DOM, and has a
    /// non-zero bounding rect. Polls every 100 ms; bounded by
    /// `timeout_ms` (default 8 s).
    pub async fn wait_for(
        &self,
        label: &str,
        selector: &str,
        timeout_ms: Option<u64>,
    ) -> Result<BrowserResult, String> {
        let timeout = timeout_ms.unwrap_or(8000).min(60_000);
        let expr = format!(
            r#"(async () => {{
                const sel = {s};
                const deadline = Date.now() + {to};
                while (Date.now() < deadline) {{
                    const el = document.querySelector(sel);
                    if (el) {{
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {{
                            return {{ ok: true, selector: sel, found: true, waitedMs: Date.now() - (deadline - {to}) }};
                        }}
                    }}
                    await new Promise(r => setTimeout(r, 100));
                }}
                return {{ ok: false, selector: sel, found: false }};
            }})()"#,
            s = json!(selector),
            to = timeout
        );
        // Add a Rust-side buffer over the JS deadline so the channel
        // never times out before the page-side polling does.
        let (request_id, rx) = self.issue_request();
        let script = format!(
            r#"(async () => {{
                try {{
                    const value = await (async () => ({expr}))();
                    window.__aurora.respond({rid}, {{ ok: true, value }});
                }} catch (err) {{
                    window.__aurora.respond({rid}, {{ ok: false, error: String(err && err.message ? err.message : err) }});
                }}
            }})();"#,
            expr = expr,
            rid = json!(request_id),
        );
        self.eval(label, &script)?;
        let buffered = Duration::from_millis(timeout + 2000);
        self.await_result(request_id, rx, buffered).await
    }

    /// Capture a PNG screenshot of the page (or one element). Uses an
    /// inline foreignObject SVG renderer so we don't need to vendor
    /// html2canvas. Returns `{ ok, base64, mediaType: "image/png" }`.
    pub async fn screenshot(
        &self,
        label: &str,
        selector: Option<&str>,
    ) -> Result<BrowserResult, String> {
        let target = match selector {
            Some(sel) => format!("document.querySelector({s})", s = json!(sel)),
            None => "document.body".into(),
        };
        // The foreignObject technique inlines the live DOM into an
        // SVG, then rasterises that SVG via a hidden Image into a
        // canvas. It has known limits (cross-origin <img>, <canvas>
        // contents won't transfer) but works for the typical "show
        // me what the user is seeing" case without an external lib.
        let expr = format!(
            r#"(async () => {{
                const target = {target};
                if (!target) throw new Error('screenshot target not found');
                const rect = target.getBoundingClientRect();
                const width = Math.max(1, Math.ceil(rect.width));
                const height = Math.max(1, Math.ceil(rect.height));
                const dpr = window.devicePixelRatio || 1;

                const clone = target.cloneNode(true);
                // Inline computed styles for the cloned tree so SVG
                // foreignObject renders something close to the live
                // page. Cap depth to avoid pathological DOMs.
                const inlineStyles = (src, dst, depth) => {{
                    if (depth > 20) return;
                    const cs = window.getComputedStyle(src);
                    let css = '';
                    for (const prop of cs) css += prop + ':' + cs.getPropertyValue(prop) + ';';
                    dst.setAttribute('style', css);
                    const sChild = src.children, dChild = dst.children;
                    for (let i = 0; i < sChild.length && i < dChild.length; i++) {{
                        inlineStyles(sChild[i], dChild[i], depth + 1);
                    }}
                }};
                inlineStyles(target, clone, 0);

                const xml = new XMLSerializer().serializeToString(clone);
                const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${{width}}' height='${{height}}'>` +
                    `<foreignObject width='100%' height='100%'>` +
                    `<div xmlns='http://www.w3.org/1999/xhtml'>${{xml}}</div>` +
                    `</foreignObject></svg>`;
                const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

                const img = await new Promise((resolve, reject) => {{
                    const i = new Image();
                    i.onload = () => resolve(i);
                    i.onerror = (e) => reject(new Error('image load failed'));
                    i.src = url;
                }});

                const canvas = document.createElement('canvas');
                canvas.width = width * dpr;
                canvas.height = height * dpr;
                const ctx = canvas.getContext('2d');
                ctx.scale(dpr, dpr);
                ctx.fillStyle = window.getComputedStyle(document.body).backgroundColor || '#fff';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);

                const dataUrl = canvas.toDataURL('image/png');
                const base64 = dataUrl.split(',')[1] || '';
                return {{ ok: true, base64, mediaType: 'image/png', width, height }};
            }})()"#,
            target = target
        );
        self.eval_with_result(label, &expr).await
    }
}

fn sanitize_label(label: &str) -> Result<String, String> {
    if label.is_empty() {
        return Err("label must not be empty".into());
    }
    if !label.starts_with("browser-") {
        return Err(format!(
            "browser window label '{label}' must start with 'browser-' (capability prefix)"
        ));
    }
    if !label
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("browser window label '{label}' contains invalid characters"));
    }
    Ok(label.to_string())
}

/// Options accepted by `BrowserManager::create_window`. Mirrors the
/// camelCase IPC payload from the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBrowserWindow {
    pub label: String,
    pub url: String,
    pub title: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub always_on_top: Option<bool>,
}

/// Payload emitted on `aurora:browser-window-closed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserWindowClosedPayload {
    label: String,
}

/// Payload posted by the inspector / Stagewise script via the
/// `aurora_record_picked_element` IPC command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedElementPayload {
    pub label: String,
    pub selector: String,
    pub tag_name: String,
    pub id: Option<String>,
    pub class_name: Option<String>,
    pub text: Option<String>,
    pub outer_html: Option<String>,
    pub url: Option<String>,
    pub bounding_rect: Option<BoundingRect>,
    pub attributes: Option<Vec<AttributePair>>,
    pub source: PickSource,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundingRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributePair {
    pub name: String,
    pub value: String,
}

/// What surfaced the pick — the inspector overlay, the Stagewise
/// toolbar, or some future channel. Lets the frontend route picks
/// differently if it wants to.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PickSource {
    Inspector,
    Stagewise,
}

/// Summary row returned by `browser_list_windows`. Mirrors what the
/// agent needs to reason about the active windows without exposing
/// internal flags.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWindowSummary {
    pub label: String,
    pub url: String,
    pub inspector_active: bool,
    pub stagewise_active: bool,
}

/// Wire shape for results posted back from the page-side helper. The
/// `aurora_record_browser_result` Tauri command deserialises the
/// payload and forwards it to `BrowserManager::resolve_result`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserResultPayload {
    pub request_id: String,
    #[serde(flatten)]
    pub result: BrowserResult,
}

/// Theme tokens forwarded from the IDE so the Stagewise toolbar can
/// match the app's look. The previewed page is on a different origin
/// and therefore cannot read Aurora's CSS variables, so the frontend
/// resolves them and we substitute them into the script template.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserThemeTokens {
    pub background: String,
    pub foreground: String,
    pub border: String,
    pub primary: String,
    pub primary_foreground: String,
    pub muted: String,
    pub shadow: String,
}

impl BrowserThemeTokens {
    fn fallback() -> Self {
        Self {
            background: "#0f1115".into(),
            foreground: "#e4e4e7".into(),
            border: "#27272a".into(),
            primary: "#6366f1".into(),
            primary_foreground: "#ffffff".into(),
            muted: "#a1a1aa".into(),
            shadow: "rgba(0, 0, 0, 0.45)".into(),
        }
    }
}

fn build_stagewise_script(theme: &BrowserThemeTokens) -> String {
    let safe = sanitize_color_token;
    STAGEWISE_ACTIVATE_TEMPLATE
        .replace("__BG__", &safe(&theme.background))
        .replace("__FG__", &safe(&theme.foreground))
        .replace("__BORDER__", &safe(&theme.border))
        .replace("__PRIMARY__", &safe(&theme.primary))
        .replace("__PRIMARY_FG__", &safe(&theme.primary_foreground))
        .replace("__MUTED__", &safe(&theme.muted))
        .replace("__SHADOW__", &safe(&theme.shadow))
}

/// Defensive: theme tokens land in JS string literals inside the
/// injected script, so reject anything that could break out of the
/// CSS context (quotes, semicolons, angle brackets, backslashes).
/// Unrecognised input falls back to the sane default.
fn sanitize_color_token(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return BrowserThemeTokens::fallback().foreground;
    }
    if trimmed
        .chars()
        .any(|c| matches!(c, '"' | '\'' | ';' | '<' | '>' | '\\' | '`'))
    {
        return BrowserThemeTokens::fallback().foreground;
    }
    trimmed.to_string()
}

// ---------------------------------------------------------------------------
// Injected scripts
// ---------------------------------------------------------------------------
//
// Everything below is JavaScript that runs inside the *browser
// webview*, not inside Aurora's main UI. It must be defensive about
// the page it lands in — pages can have weird CSS, broken event
// loops, framework-managed DOMs, etc.
//
// All three scripts share the `window.__aurora` namespace established
// by `BROWSER_INIT_SCRIPT`. If you change the namespace shape, update
// every script that touches it.

/// Runs once before the first page load via
/// `WebviewWindowBuilder::initialization_script`. Sets up the shared
/// helpers. Must be idempotent because Tauri re-runs initialization
/// scripts on every navigation.
const BROWSER_INIT_SCRIPT: &str = r#"
(function () {
  if (window.__aurora && window.__aurora.__bootstrapped) return;

  const ns = window.__aurora || (window.__aurora = {});
  ns.__bootstrapped = true;
  ns.label = (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata && window.__TAURI_INTERNALS__.metadata.currentWindow && window.__TAURI_INTERNALS__.metadata.currentWindow.label) || '';

  ns.invoke = function (cmd, args) {
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        return window.__TAURI_INTERNALS__.invoke(cmd, args);
      }
    } catch (e) {
      console.warn('[aurora] invoke failed', e);
    }
    return Promise.resolve();
  };

  ns.cssPath = function (el) {
    if (!(el instanceof Element)) return '';
    const path = [];
    while (el && el.nodeType === Node.ELEMENT_NODE && path.length < 12) {
      let selector = el.nodeName.toLowerCase();
      if (el.id) {
        selector += '#' + CSS.escape(el.id);
        path.unshift(selector);
        break;
      }
      let sibling = el;
      let nth = 1;
      while ((sibling = sibling.previousElementSibling) != null) {
        if (sibling.nodeName.toLowerCase() === selector) nth++;
      }
      if (nth > 1) selector += ':nth-of-type(' + nth + ')';
      path.unshift(selector);
      el = el.parentElement;
    }
    return path.join(' > ');
  };

  ns.describe = function (el, source) {
    if (!(el instanceof Element)) return null;
    const rect = el.getBoundingClientRect();
    const attrs = [];
    for (const attr of el.attributes) {
      attrs.push({ name: attr.name, value: attr.value });
      if (attrs.length >= 24) break;
    }
    let outer = el.outerHTML || '';
    if (outer.length > 4000) outer = outer.slice(0, 4000) + '... [truncated]';
    let text = (el.textContent || '').trim();
    if (text.length > 400) text = text.slice(0, 400) + '...';
    return {
      label: ns.label,
      selector: ns.cssPath(el),
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className : null,
      text: text || null,
      outerHtml: outer,
      url: location.href,
      boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      attributes: attrs,
      source: source || 'inspector',
      note: null,
    };
  };

  ns.report = function (payload) {
    return ns.invoke('aurora_record_picked_element', { payload });
  };

  // ---- Two-way IPC --------------------------------------------------
  // The Rust side eval's expressions that end with
  // `__aurora.respond(requestId, { ok, value | error })`. We forward
  // the payload through `aurora_record_browser_result` so the
  // BrowserManager can resolve its oneshot channel.
  ns.respond = function (requestId, payload) {
    try {
      const wrapped = Object.assign({ requestId }, payload || {});
      return ns.invoke('aurora_record_browser_result', { payload: wrapped });
    } catch (e) {
      console.warn('[aurora] respond failed', e);
    }
  };

  // ---- Console buffer ----------------------------------------------
  // Rolling capture of console.* calls so `browser_get_console_logs`
  // can return what the agent is debugging without needing to keep a
  // devtools panel open. Cap is small enough not to leak memory.
  if (!ns.__logs) {
    ns.__logs = [];
    const MAX = 500;
    const stringify = (arg) => {
      if (arg === null || arg === undefined) return String(arg);
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch (_) { return String(arg); }
    };
    const wrap = (level, original) => function (...args) {
      try {
        ns.__logs.push({
          ts: Date.now(),
          level,
          message: args.map(stringify).join(' '),
        });
        if (ns.__logs.length > MAX) ns.__logs.splice(0, ns.__logs.length - MAX);
      } catch (_) { /* never break the page */ }
      return original.apply(console, args);
    };
    ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
      const fn = console[level];
      if (typeof fn === 'function') console[level] = wrap(level, fn);
    });
    window.addEventListener('error', (e) => {
      ns.__logs.push({
        ts: Date.now(),
        level: 'error',
        message: '[uncaught] ' + (e.message || String(e.error || e)),
      });
    });
    window.addEventListener('unhandledrejection', (e) => {
      ns.__logs.push({
        ts: Date.now(),
        level: 'error',
        message: '[unhandled-rejection] ' + stringify(e.reason),
      });
    });
  }

  ns.getLogs = function (level, sinceMs) {
    let logs = ns.__logs.slice();
    if (level) logs = logs.filter((l) => l.level === level);
    if (typeof sinceMs === 'number') {
      const cutoff = Date.now() - sinceMs;
      logs = logs.filter((l) => l.ts >= cutoff);
    }
    return logs;
  };
})();
"#;

const INSPECTOR_ACTIVATE_SCRIPT: &str = r#"
(function () {
  const ns = window.__aurora;
  if (!ns) return;
  if (ns.__inspector && ns.__inspector.active) return;

  const overlay = document.createElement('div');
  overlay.setAttribute('data-aurora-inspector', 'overlay');
  Object.assign(overlay.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483646',
    background: 'rgba(99, 102, 241, 0.18)',
    border: '2px solid rgba(99, 102, 241, 0.85)',
    boxShadow: '0 0 0 1px rgba(255,255,255,0.4)',
    borderRadius: '2px',
    transition: 'all 60ms linear',
    display: 'none',
    boxSizing: 'border-box',
  });
  document.documentElement.appendChild(overlay);

  const tag = document.createElement('div');
  tag.setAttribute('data-aurora-inspector', 'tag');
  Object.assign(tag.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483647',
    padding: '2px 6px',
    background: '#4f46e5',
    color: '#fff',
    font: '600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
    borderRadius: '3px',
    display: 'none',
    boxSizing: 'border-box',
  });
  document.documentElement.appendChild(tag);

  let last = null;

  const onMove = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.hasAttribute && target.hasAttribute('data-aurora-inspector')) return;
    if (target === last) return;
    last = target;
    const rect = target.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    tag.style.display = 'block';
    tag.textContent = target.tagName.toLowerCase() + (target.id ? '#' + target.id : '') +
      (target.className && typeof target.className === 'string' ? '.' + target.className.split(/\s+/).slice(0, 2).join('.') : '');
    const tagTop = Math.max(0, rect.top - 22);
    tag.style.top = tagTop + 'px';
    tag.style.left = rect.left + 'px';
  };

  const onClick = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.hasAttribute && target.hasAttribute('data-aurora-inspector')) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const payload = ns.describe(target, 'inspector');
    if (payload) ns.report(payload);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      ns.invoke('browser_deactivate_inspector', { label: ns.label });
    }
  };

  ns.__inspector = {
    active: true,
    overlay, tag,
    detach: () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      tag.remove();
    },
  };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
})();
"#;

const INSPECTOR_DEACTIVATE_SCRIPT: &str = r#"
(function () {
  const ns = window.__aurora;
  if (!ns || !ns.__inspector) return;
  ns.__inspector.detach();
  ns.__inspector.active = false;
  ns.__inspector = null;
})();
"#;

const INSPECTOR_CLEAR_SCRIPT: &str = r#"
(function () {
  const ns = window.__aurora;
  if (!ns || !ns.__inspector) return;
  ns.__inspector.overlay.style.display = 'none';
  ns.__inspector.tag.style.display = 'none';
})();
"#;

/// Stagewise-style floating toolbar. Built from `build_stagewise_script`
/// at activation time so the IDE's live theme tokens replace the
/// `__TOKEN__` placeholders below — keeps the floating UI on the
/// previewed page visually consistent with Aurora.
const STAGEWISE_ACTIVATE_TEMPLATE: &str = r#"
(function () {
  const ns = window.__aurora;
  if (!ns) return;
  if (ns.__stagewise && ns.__stagewise.active) return;

  const T = {
    bg: '__BG__',
    fg: '__FG__',
    border: '__BORDER__',
    primary: '__PRIMARY__',
    primaryFg: '__PRIMARY_FG__',
    muted: '__MUTED__',
    shadow: '__SHADOW__',
  };

  const root = document.createElement('div');
  root.setAttribute('data-aurora-stagewise', 'root');
  Object.assign(root.style, {
    position: 'fixed',
    bottom: '18px',
    right: '18px',
    zIndex: '2147483647',
    background: T.bg,
    color: T.fg,
    font: '500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    padding: '10px 12px',
    borderRadius: '10px',
    border: '1px solid ' + T.border,
    boxShadow: '0 18px 40px ' + T.shadow,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minWidth: '260px',
    backdropFilter: 'blur(12px)',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '8px', fontWeight: '600', fontSize: '11px', letterSpacing: '0.06em',
    textTransform: 'uppercase', color: T.muted,
  });
  const headerLabel = document.createElement('span');
  headerLabel.textContent = 'Aurora Stagewise';
  const headerClose = document.createElement('button');
  headerClose.textContent = '×';
  Object.assign(headerClose.style, {
    border: '0', background: 'transparent', color: T.muted,
    fontSize: '16px', lineHeight: '1', cursor: 'pointer', padding: '0 4px',
  });
  header.appendChild(headerLabel);
  header.appendChild(headerClose);
  root.appendChild(header);

  const note = document.createElement('input');
  note.placeholder = 'Optional note for the agent…';
  Object.assign(note.style, {
    background: 'transparent', color: T.fg,
    border: '1px solid ' + T.border, borderRadius: '6px',
    padding: '6px 8px', font: 'inherit', outline: 'none',
  });
  note.addEventListener('focus', () => { note.style.borderColor = T.primary; });
  note.addEventListener('blur', () => { note.style.borderColor = T.border; });
  root.appendChild(note);

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '6px' });
  root.appendChild(row);

  const mkBtn = (label, primary) => {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      flex: '1', cursor: 'pointer', font: 'inherit', fontWeight: '500',
      padding: '6px 10px', borderRadius: '6px',
      border: primary ? '0' : '1px solid ' + T.border,
      background: primary ? T.primary : 'transparent',
      color: primary ? T.primaryFg : T.fg,
      transition: 'background 120ms ease',
    });
    b.addEventListener('mouseenter', () => {
      b.style.opacity = '0.9';
    });
    b.addEventListener('mouseleave', () => {
      b.style.opacity = '1';
    });
    return b;
  };

  const pickBtn = mkBtn('Pick element', true);
  const cancelBtn = mkBtn('Cancel', false);
  row.appendChild(pickBtn);
  row.appendChild(cancelBtn);

  const status = document.createElement('div');
  Object.assign(status.style, {
    fontSize: '11px', color: T.muted, minHeight: '14px',
  });
  root.appendChild(status);

  document.documentElement.appendChild(root);

  let pickArmed = false;

  const overlay = document.createElement('div');
  overlay.setAttribute('data-aurora-stagewise', 'overlay');
  Object.assign(overlay.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
    background: 'color-mix(in srgb, ' + T.primary + ' 20%, transparent)',
    border: '2px solid ' + T.primary, borderRadius: '2px',
    display: 'none', boxSizing: 'border-box', transition: 'all 60ms linear',
  });
  document.documentElement.appendChild(overlay);

  const setArmed = (next) => {
    pickArmed = next;
    pickBtn.textContent = next ? 'Click anywhere on the page…' : 'Pick element';
    pickBtn.style.background = next ? T.border : T.primary;
    pickBtn.style.color = next ? T.fg : T.primaryFg;
    if (!next) overlay.style.display = 'none';
    status.textContent = next ? 'Pick mode active — Esc to cancel' : '';
  };

  const onMove = (e) => {
    if (!pickArmed) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-aurora-stagewise]')) return;
    const rect = target.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  };

  const onClick = (e) => {
    if (!pickArmed) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-aurora-stagewise]')) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    setArmed(false);
    const payload = ns.describe(target, 'stagewise');
    if (payload) {
      payload.note = (note.value || '').trim() || null;
      ns.report(payload);
      note.value = '';
      status.textContent = 'Sent to Aurora ✓';
      setTimeout(() => { if (status.textContent === 'Sent to Aurora ✓') status.textContent = ''; }, 1200);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Escape' && pickArmed) {
      setArmed(false);
    }
  };

  pickBtn.addEventListener('click', () => setArmed(!pickArmed));
  cancelBtn.addEventListener('click', () => setArmed(false));
  headerClose.addEventListener('click', () => {
    ns.invoke('browser_deactivate_stagewise', { label: ns.label });
  });

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  ns.__stagewise = {
    active: true,
    detach: () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      overlay.remove();
    },
  };
})();
"#;

const STAGEWISE_DEACTIVATE_SCRIPT: &str = r#"
(function () {
  const ns = window.__aurora;
  if (!ns || !ns.__stagewise) return;
  ns.__stagewise.detach();
  ns.__stagewise.active = false;
  ns.__stagewise = null;
})();
"#;
