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
//! Every browser is an EMBEDDED child webview (see `create_window`) — it dies
//! with its host window, so cleanup runs through `close` rather than a
//! per-window destroy listener. Standalone browser windows, and the
//! `aurora:browser-window-closed` event that announced their demise, were
//! removed: Aurora has exactly one browser, the agent window's right-rail panel.
//!
//! All scripts assume `withGlobalTauri = true` (set in
//! `tauri.conf.json`) so `window.__TAURI_INTERNALS__.invoke(...)` is
//! reachable in any window we create.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl};
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
    /// Whether the frontend currently wants the webview on screen.
    ///
    /// The panel hides the native webview whenever another dock tab is
    /// active or a menu drops over it, because a child webview paints above
    /// every pixel of DOM. A screenshot used to call `show()` unconditionally
    /// to get a fresh frame — and left the page sitting on top of the Canvas
    /// tab the user had switched to. Tracking the frontend's intent lets the
    /// tools ask for the panel properly (`aurora:agent-open-browser`) instead
    /// of unhiding it behind the UI's back.
    hidden: bool,
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
/// One pending two-way IPC call. We track the `label` alongside the
/// sender so we can invalidate every in-flight call for a given window
/// when the page navigates or the window closes — without this, a
/// screenshot or DOM read that was issued just before a hot-reload
/// sits idle for the full 30s timeout because the page-side
/// `window.__aurora.respond` was wiped by the navigation.
struct PendingRequest {
    label: String,
    sender: oneshot::Sender<BrowserResult>,
}

#[derive(Clone)]
pub struct BrowserManager {
    app: AppHandle,
    windows: Arc<DashMap<String, BrowserWindowState>>,
    /// Pending oneshot router for every two-way IPC call we send into
    /// a browser webview (eval, screenshot, get_dom, …). The injected
    /// page-side helper resolves these via the
    /// `aurora_record_browser_result` Tauri command.
    pending: Arc<DashMap<String, PendingRequest>>,
    /// Last window the agent (or the IDE) successfully addressed.
    /// Tools accept `label` as optional and fall back to this so
    /// agents that omit/forget the label don't hit the "unknown
    /// window" error path.
    last_active_label: Arc<StdMutex<Option<String>>>,
    /// The frontend's latest show/hide decision per label, with its sequence
    /// number. See [`BrowserManager::set_visible`].
    visibility: Arc<StdMutex<VisibilityLedger>>,
}

/// Ordered show/hide decisions, keyed by browser label.
///
/// The frontend decides whether the page is on screen, but each decision
/// reaches Rust as its own IPC call and nothing orders two in-flight calls:
/// a "hide" sent on a tab switch could land before an earlier "show" and
/// leave the page painted over Files or the terminal. Every decision carries
/// a sequence number, and one older than the last accepted is dropped.
///
/// A decision is kept even when the webview does not exist yet, so a page
/// whose build finishes after the user switched away comes up hidden.
#[derive(Debug, Default)]
struct VisibilityLedger {
    latest: std::collections::HashMap<String, (u64, bool)>,
}

impl VisibilityLedger {
    /// Record `visible` for `label` if `seq` is newer than the last decision.
    /// Returns false for a stale decision, which must not be applied.
    fn accept(&mut self, label: &str, seq: u64, visible: bool) -> bool {
        match self.latest.get(label) {
            Some(&(last, _)) if seq <= last => false,
            _ => {
                self.latest.insert(label.to_string(), (seq, visible));
                true
            }
        }
    }

    /// The last decision for `label`; `None` when the frontend has not said.
    fn wanted(&self, label: &str) -> Option<bool> {
        self.latest.get(label).map(|&(_, visible)| visible)
    }
}

/// Default ceiling for two-way IPC waits. Long enough for a slow page
/// load (e.g. heavy SPA + screenshot), short enough that the agent
/// loop is never blocked indefinitely on a misbehaving page.
const DEFAULT_RESULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Defensively clean a CSS selector that came from an LLM tool call.
///
/// Some providers (notably Deepseek-style chat-completion proxies)
/// occasionally leak a stop-sequence fragment such as `</` or a
/// half-emitted closing XML tag into the tail of a selector
/// argument — the model "thinks" it's about to close a `<parameter>`
/// block and the substring ends up inside the JSON value. Browsers
/// reject the malformed selector and the agent's `Screenshot Page`
/// step fails repeatedly.
///
/// CSS selectors never legitimately contain `<`, so we truncate at
/// the first `<` and trim surrounding whitespace. This is a
/// best-effort guardrail: if the model also stops mid-token the
/// selector still won't match, but it will at least produce a
/// well-formed `querySelector` error rather than a parser exception.
fn sanitize_selector(raw: &str) -> String {
    raw.split('<').next().unwrap_or("").trim().to_string()
}

impl BrowserManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            windows: Arc::new(DashMap::new()),
            pending: Arc::new(DashMap::new()),
            last_active_label: Arc::new(StdMutex::new(None)),
            visibility: Arc::new(StdMutex::new(VisibilityLedger::default())),
        }
    }

    /// The last show/hide decision the frontend sent for `label`.
    fn wanted_visible(&self, label: &str) -> Option<bool> {
        self.visibility.lock().ok()?.wanted(label)
    }

    /// Resolve a two-way IPC result for a previously-issued request.
    /// Called from the `aurora_record_browser_result` Tauri command
    /// when the page-side helper posts a value back.
    pub fn resolve_result(&self, request_id: &str, result: BrowserResult) {
        if let Some((_, request)) = self.pending.remove(request_id) {
            let _ = request.sender.send(result);
        }
    }

    /// Last label any tool successfully addressed. Used as the fallback
    /// when an agent calls a browser tool without a `label` argument.
    pub fn last_active_label(&self) -> Option<String> {
        self.last_active_label.lock().ok()?.clone()
    }

    /// Record `label` as the most-recently-used window so subsequent
    /// label-less tool calls target it. Cheap; no-op when the lock
    /// can't be acquired (panic recovery).
    fn touch_active(&self, label: &str) {
        if let Ok(mut guard) = self.last_active_label.lock() {
            *guard = Some(label.to_string());
        }
    }

    /// Drain every pending request for `label` and reply with a
    /// synthetic `ok=false`. Called from `close()` and `navigate()`
    /// so a screenshot/get_dom that was waiting on the about-to-be-
    /// destroyed page fails fast with an actionable message rather
    /// than timing out at the 30s ceiling.
    fn drain_pending_for_label(&self, label: &str, reason: &str) {
        let mut to_drop = Vec::new();
        for entry in self.pending.iter() {
            if entry.value().label == label {
                to_drop.push(entry.key().clone());
            }
        }
        for id in to_drop {
            if let Some((_, request)) = self.pending.remove(&id) {
                let _ = request.sender.send(BrowserResult {
                    ok: false,
                    value: None,
                    error: Some(format!(
                        "browser request superseded — {reason} for '{label}'"
                    )),
                });
            }
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
            // Window already exists — focus and (optionally) re-embed / navigate.
            if let Ok(view) = self.window(&label) {
                let _ = view.set_focus();
                if let Some(embed) = &opts.embed {
                    let _ = view.set_position(LogicalPosition::new(embed.x, embed.y));
                    let _ = view.set_size(LogicalSize::new(
                        embed.width.max(1.0),
                        embed.height.max(1.0),
                    ));
                    // Only if the frontend has not since asked for it hidden.
                    if self.wanted_visible(&label) != Some(false) {
                        let _ = view.show();
                    }
                }
                if !opts.url.is_empty() {
                    self.navigate(&label, &opts.url)?;
                }
                return Ok(());
            }
            // The label was tracked but the window is gone — drop the
            // stale entry and fall through to a fresh build.
            self.windows.remove(&label);
        }

        // A file:// page cannot answer through the IPC bridge (capability
        // grants cover http/https origins only) — serve it through
        // aurora-page instead. See `services::local_page`.
        let load_url = crate::services::local_page::to_served_url(&opts.url)
            .unwrap_or_else(|| opts.url.clone());
        let url = WebviewUrl::External(
            load_url
                .parse()
                .map_err(|e| format!("invalid url '{load_url}': {e}"))?,
        );

        // Embedded ONLY. Aurora has exactly one browser — the agent window's
        // right-rail panel — so a browser is always a child webview pinned
        // inside a host window. The standalone `WebviewWindowBuilder` branch
        // that used to live here (and the IDE browser tab that drove it) was
        // removed: a floating OS window meant a second browser to keep in
        // sync, with its own lifecycle, adoption UI, and window registry.
        let embed = opts.embed.as_ref().ok_or_else(|| {
            format!("browser '{label}' must be embedded — standalone browser windows were removed")
        })?;

        // Shares the SAME init script + IPC pipeline the agent tools drive, so
        // inspector, screenshots, console capture and element-pick all work.
        let host = self
            .app
            .get_window(&embed.host_label)
            .ok_or_else(|| format!("embed host window '{}' not found", embed.host_label))?;
        let builder = WebviewBuilder::new(&label, url).initialization_script(BROWSER_INIT_SCRIPT);
        host.add_child(
            builder,
            LogicalPosition::new(embed.x, embed.y),
            LogicalSize::new(embed.width.max(1.0), embed.height.max(1.0)),
        )
        .map_err(|e| format!("failed to embed browser '{label}': {e}"))?;

        // The build takes a moment, and the user can switch tabs during it. A
        // "hide" that arrived meanwhile was recorded against this label; honour
        // it now, or the fresh page sits on top of whatever tab is showing.
        let start_hidden = self.wanted_visible(&label) == Some(false);
        if start_hidden {
            if let Ok(view) = self.window(&label) {
                let _ = view.hide();
            }
        }

        self.windows.insert(
            label.clone(),
            BrowserWindowState {
                current_url: opts.url.clone(),
                hidden: start_hidden,
                ..Default::default()
            },
        );

        // Tell the frontend a new window is now adoptable so the
        // TitleBar popover and any open BrowserTab selector can
        // refresh without polling.
        let _ = self.app.emit(
            "aurora:browser-window-opened",
            BrowserWindowOpenedPayload {
                label: label.clone(),
                url: opts.url.clone(),
                inspector_active: false,
                stagewise_active: false,
            },
        );

        self.touch_active(&label);
        Ok(())
    }

    /// Reposition / resize an embedded browser to track the tab body rect.
    pub fn set_bounds(
        &self,
        label: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        let view = self.window(label)?;
        // One call, not position-then-size: two calls paint an intermediate
        // rectangle (new position, old size) for a frame, and a burst of
        // them during a rail drag interleaves badly.
        view.set_bounds(tauri::Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
        })
        .map_err(|e| format!("set_bounds failed: {e}"))?;
        // A page shown in a device frame has rounded screen corners; its
        // window is re-clipped for the new size (a no-op when square).
        crate::services::browser_view::apply_corners(&view, label, width.max(1.0), height.max(1.0));
        Ok(())
    }

    /// Apply the frontend's decision to show or hide the embedded webview.
    ///
    /// `seq` orders decisions: one older than the last accepted is dropped and
    /// `Ok(false)` returned. The ledger lock is held across the show/hide so two
    /// decisions racing on different threads cannot apply out of order. A
    /// decision for a webview that is not built yet is recorded and applied by
    /// `create_window`, and also returns `Ok(false)`.
    pub fn set_visible(&self, label: &str, visible: bool, seq: u64) -> Result<bool, String> {
        let mut ledger = self
            .visibility
            .lock()
            .map_err(|_| "browser visibility lock poisoned".to_string())?;
        if !ledger.accept(label, seq, visible) {
            return Ok(false);
        }
        if self.window(label).is_err() {
            return Ok(false);
        }
        if visible {
            self.show(label)?;
        } else {
            self.hide(label)?;
        }
        drop(ledger);
        Ok(true)
    }

    /// Show the (embedded) browser webview.
    pub fn show(&self, label: &str) -> Result<(), String> {
        self.window(label)?
            .show()
            .map_err(|e| format!("show failed: {e}"))?;
        if let Some(mut entry) = self.windows.get_mut(label) {
            entry.hidden = false;
        }
        Ok(())
    }

    /// Hide the (embedded) browser webview without destroying it.
    pub fn hide(&self, label: &str) -> Result<(), String> {
        self.window(label)?
            .hide()
            .map_err(|e| format!("hide failed: {e}"))?;
        if let Some(mut entry) = self.windows.get_mut(label) {
            entry.hidden = true;
        }
        Ok(())
    }

    /// Does the frontend currently have this webview on screen?
    ///
    /// `false` while another dock tab is active or an overlay is up. The
    /// tools read this before touching the panel so they can ask the UI to
    /// reveal it rather than force it visible over whatever the user is on.
    #[must_use]
    pub fn is_visible(&self, label: &str) -> bool {
        self.windows
            .get(label)
            .map(|entry| !entry.hidden)
            .unwrap_or(false)
    }

    /// Is a browser webview with this label currently live? Used by the agent
    /// browser tools to tell whether the right-rail panel's embedded webview
    /// has been built yet.
    pub fn has_window(&self, label: &str) -> bool {
        self.window(label).is_ok()
    }

    /// Ask the agent-window frontend to reveal its right-dock Browser panel.
    /// The panel's React effect builds the embedded `browser-agentwin` webview,
    /// which is what the agent's `browser_*` tools then drive. Emitted globally;
    /// only the agent window listens for it. `url` is an optional hint.
    pub fn request_open_agent_browser(&self, url: Option<&str>) -> Result<(), String> {
        self.app
            .emit(
                "aurora:agent-open-browser",
                serde_json::json!({ "url": url }),
            )
            .map_err(|e| format!("failed to emit agent-open-browser: {e}"))
    }

    /// Ask the agent window to render its Browser panel's webview at a
    /// specific size — a device frame — or `None` to fill the panel again.
    ///
    /// `Emulation.setDeviceMetricsOverride` only changes what the PAGE thinks
    /// its viewport is; the webview stays panel-sized and the browser paints
    /// the leftover area blank. So a phone check left the page in a narrow
    /// column with a large white band beside and below it — inside the webview,
    /// where no Aurora styling can reach — and the native screenshot, which
    /// photographs the whole webview surface, captured the band as part of the
    /// picture. Physically resizing the webview is the only thing that removes
    /// it: the page then fills its own surface exactly, the panel's own
    /// background shows around the frame, and a screenshot contains the device
    /// and nothing else.
    pub fn request_browser_frame(&self, width: Option<f64>, height: Option<f64>) {
        let _ = self.app.emit(
            "aurora:agent-browser-frame",
            serde_json::json!({ "width": width, "height": height }),
        );
    }

    /// Tell the agent window that a browser tool has started or finished
    /// driving its Browser panel.
    ///
    /// This is the ONLY signal the panel has. The native webview paints above
    /// the React DOM, so the page can change under the user with nothing on
    /// screen saying who changed it — a click lands, a URL swaps, and it looks
    /// identical to the page doing it by itself. The panel draws its "agent is
    /// driving" cue from this pair of events and from nothing else, which is
    /// why the `false` half is sent from a drop guard rather than the happy
    /// path: an errored, cancelled or panicking tool must still turn the cue
    /// off, or the panel lies for the rest of the session.
    ///
    /// Fire-and-forget: a failed emit costs a missing indicator, never a failed
    /// tool call, so it must not surface as an error to the model.
    pub fn signal_panel_activity(&self, tool: &str, active: bool) {
        let _ = self.app.emit(
            "aurora:agent-browser-activity",
            serde_json::json!({ "tool": tool, "active": active }),
        );
    }

    pub fn navigate(&self, label: &str, url: &str) -> Result<(), String> {
        let window = self.window(label)?;
        // Same rewrite as `open`: a file:// page is deaf to the bridge, so it
        // is served through aurora-page instead. See `services::local_page`.
        let load_url =
            crate::services::local_page::to_served_url(url).unwrap_or_else(|| url.to_string());
        // `WebviewWindow::navigate` exists in Tauri 2 and tells the
        // underlying WebView to load a new URL without recreating the
        // window.
        let parsed = load_url
            .parse()
            .map_err(|e| format!("invalid url '{load_url}': {e}"))?;
        // Pre-emptively fail any pending request bound to this label.
        // The about-to-load page wipes the page-side `window.__aurora`
        // helper, so a screenshot/get_dom/eval that's already in
        // flight would otherwise wait the full 30s before timing out.
        self.drain_pending_for_label(label, "page navigated");
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
        // A device the USER chose in the panel is kept across navigation, the
        // way DevTools' device mode is: it is re-applied, not cleared.
        if crate::services::browser_view::reapply_after_navigate(&window, label) {
            self.touch_active(label);
            return Ok(());
        }
        Self::clear_emulation_overrides(&window);
        // The browser's overrides are gone, so Aurora's record of them and the
        // device frame drawn for them have to go too — otherwise `browser_status`
        // keeps reporting a 390px viewport that no longer exists, and the panel
        // stays pinned to a phone-width frame after the user typed a new URL.
        // Only for the AGENT's page: that record and frame describe it alone,
        // and another tab navigating must not wipe them.
        if label == crate::tools::browser::AGENT_BROWSER_LABEL {
            crate::tools::browser::state::clear_emulation();
            self.request_browser_frame(None, None);
        }
        self.touch_active(label);
        Ok(())
    }

    /// Drop any viewport / media emulation on a browser.
    ///
    /// These overrides live on the BROWSER, not on the page, so they survive
    /// a navigation: a 390px viewport set for a responsive check would keep
    /// applying to whatever you visit next, and the user would find their
    /// panel stuck at phone width with nothing on screen explaining why.
    /// Clearing on navigate matches the common intent — a caller that wants
    /// the override kept simply re-applies it, which is cheap and explicit.
    ///
    /// Fire-and-forget because `navigate` is synchronous and this is cleanup:
    /// a failure (no DevTools channel off Windows, or a webview already tearing
    /// down) must never block or fail the navigation itself.
    fn clear_emulation_overrides(webview: &Webview) {
        if !crate::services::browser_devtools::devtools_available() {
            return;
        }
        let handle = webview.clone();
        tauri::async_runtime::spawn(async move {
            for (method, params) in [
                ("Emulation.clearDeviceMetricsOverride", Value::Null),
                (
                    "Emulation.setTouchEmulationEnabled",
                    serde_json::json!({ "enabled": false }),
                ),
                (
                    "Emulation.setEmulatedMedia",
                    serde_json::json!({ "media": "", "features": [] }),
                ),
            ] {
                if let Err(err) =
                    crate::services::browser_devtools::call_devtools(&handle, method, params).await
                {
                    eprintln!("[browser] could not clear {method} on navigate: {err}");
                }
            }
        });
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
        window.eval(script).map_err(|e| format!("eval failed: {e}"))
    }

    pub fn close(&self, label: &str) -> Result<(), String> {
        // Drain before the OS-side close so the senders all wake up
        // with a clean error instead of dangling. Mirrors what the
        // `Destroyed` window-event handler would have done; doing it
        // here covers programmatic close (close button never fires).
        self.drain_pending_for_label(label, "window closed");
        if let Ok(view) = self.window(label) {
            let _ = view.close();
        }
        self.windows.remove(label);
        crate::services::browser_view::forget(label);
        // Clear `last_active_label` if it pointed at the window we
        // just killed — otherwise the next label-less tool call would
        // route to a dead label.
        if let Ok(mut guard) = self.last_active_label.lock() {
            if guard.as_deref() == Some(label) {
                *guard = None;
            }
        }
        Ok(())
    }

    /// The URL Aurora last RECORDED for this panel.
    ///
    /// Written when the window opens and by [`Self::navigate`], and by nothing
    /// else — so it is stale after any navigation the page performed itself: a
    /// link click, a form post, a JS redirect, history back/forward. Prefer
    /// [`Self::live_url`] anywhere the answer is shown to the agent.
    pub fn current_url(&self, label: &str) -> Result<String, String> {
        self.windows
            .get(label)
            .map(|entry| entry.current_url.clone())
            .ok_or_else(|| self.unknown_window_error(label))
    }

    /// The URL the page is ACTUALLY on, read from `location.href`.
    ///
    /// Aurora only learns about navigations it performed itself, so the
    /// recorded URL silently lags whenever the page moved on its own — which
    /// is most of the time during an audit, because `browser_click` on a link
    /// is a navigation Aurora never routed through [`Self::navigate`]. A
    /// screenshot captioned with the recorded URL then attributes the picture
    /// of one route to another, which is precisely the evidence a regression
    /// audit relies on.
    ///
    /// Reads through to the page and writes the answer back, so the recorded
    /// value self-heals for every later reader. Falls back to the recorded URL
    /// when the page cannot be read (mid-navigation, no injected helper): a
    /// slightly stale answer beats none, and the caller still gets a string.
    pub async fn live_url(&self, label: &str) -> Option<String> {
        let recorded = self.current_url(label).ok();
        let seen = self
            .eval_with_result(label, "location.href")
            .await
            .ok()
            .filter(|result| result.ok)
            .and_then(|result| result.value)
            .and_then(|value| value.as_str().map(str::to_owned))
            .filter(|url| !url.is_empty() && url != "about:blank");
        match seen {
            Some(url) => {
                if recorded.as_deref() != Some(url.as_str()) {
                    if let Some(mut entry) = self.windows.get_mut(label) {
                        entry.current_url = url.clone();
                    }
                }
                Some(url)
            }
            None => recorded,
        }
    }

    /// Format an "unknown window" error that lists the labels that
    /// *do* exist so the agent can self-correct on the next turn
    /// instead of hallucinating again. Cheap — DashMap iteration over
    /// what is at most a few entries.
    fn unknown_window_error(&self, label: &str) -> String {
        let mut available: Vec<String> = self.windows.iter().map(|e| e.key().clone()).collect();
        available.sort();
        if available.is_empty() {
            format!("unknown window '{label}' (no browser windows are open)")
        } else {
            format!(
                "unknown window '{label}' (available: {})",
                available.join(", ")
            )
        }
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

    /// Resolve a browser's live `Webview` handle by label. Works for BOTH a
    /// standalone browser window and a child webview embedded in the agent
    /// window's Browser tab — `get_webview` finds either; the `get_webview_window`
    /// fallback covers any window whose webview isn't directly registered.
    /// Every downstream op (navigate / eval / with_webview / set_focus / close)
    /// is a `Webview` method, so callers don't care which kind it is.
    /// The live webview for `label` — for the panel's view commands
    /// (`commands::browser`), which act on the page directly.
    pub fn webview(&self, label: &str) -> Result<Webview, String> {
        self.window(label)
    }

    fn window(&self, label: &str) -> Result<Webview, String> {
        // `get_webview` resolves from the app-wide webview registry, which holds
        // BOTH standalone window webviews and embedded child webviews under their
        // label — so one lookup serves a browser window and an in-tab browser.
        self.app
            .get_webview(label)
            .ok_or_else(|| self.unknown_window_error(label))
    }

    /// Send one DevTools Protocol method to a browser and return its result.
    ///
    /// This is the channel for everything the BROWSER does rather than
    /// everything the PAGE does — viewport and media emulation, real pointer
    /// and key input, the accessibility tree. Script injection cannot reach
    /// any of it: a synthetic `mouseover` never paints `:hover` and a
    /// synthetic `keydown` never moves focus, so a tool built that way would
    /// report success having verified nothing.
    ///
    /// Errors are returned verbatim, including "not supported on this
    /// platform", because a silent no-op here is exactly the false pass this
    /// channel exists to avoid.
    pub async fn call_devtools(
        &self,
        label: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let webview = self.window(label)?;
        // Bounded. The completion handler fires on the webview's UI thread;
        // a renderer that has hung (or a webview torn down between the
        // lookup above and the dispatch) would otherwise park the calling
        // tool forever, past every timeout the tool layer thinks it has.
        match tokio::time::timeout(
            DEFAULT_RESULT_TIMEOUT,
            crate::services::browser_devtools::call_devtools(&webview, method, params),
        )
        .await
        {
            Ok(result) => result.map_err(|err| err.to_string()),
            Err(_) => Err(format!(
                "{method} did not complete within {}s — the page is not responding. \
                 Call browser_status, or reload it with browser_navigate {{reload: true}}.",
                DEFAULT_RESULT_TIMEOUT.as_secs()
            )),
        }
    }

    /// Is the DevTools channel available for this build at all?
    ///
    /// Callers that can do the job two ways — a real pointer press through the
    /// browser, or a synthetic `el.click()` inside the page — use this to pick,
    /// and to say which one they used, because the two are not equivalent.
    #[must_use]
    pub fn devtools_available(&self) -> bool {
        crate::services::browser_devtools::devtools_available()
    }

    /// Evaluate `expression` through `Runtime.evaluate` and return its value.
    ///
    /// Different from [`Self::eval_with_result`] in two ways that matter for
    /// the tools that reach for it. It does not need the injected
    /// `window.__aurora` bridge, so it answers on pages where that bridge is
    /// absent (an error page, a page mid-navigation, a `file://` origin off
    /// Windows). And a thrown exception comes back with the browser's own
    /// `exceptionDetails` — the message AND the line/column it happened at —
    /// where the bridge only has `String(err)`.
    ///
    /// Promises are awaited; the result must be JSON-serialisable
    /// (`returnByValue`). A DOM node or a function comes back as `Value::Null`
    /// with its `type`/`className` in the error message rather than as `{}`.
    pub async fn devtools_evaluate(
        &self,
        label: &str,
        expression: &str,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        let response = self
            .call_devtools(
                label,
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "userGesture": true,
                    "timeout": timeout_ms,
                }),
            )
            .await?;
        if let Some(details) = response.get("exceptionDetails") {
            return Err(describe_exception(details));
        }
        let result = response.get("result").cloned().unwrap_or(Value::Null);
        if let Some(value) = result.get("value") {
            return Ok(value.clone());
        }
        // No `value` means the result was not serialisable by value. Say what
        // it was rather than handing back an empty object that reads as "the
        // expression returned nothing".
        let kind = result
            .get("subtype")
            .or_else(|| result.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("undefined");
        if kind == "undefined" {
            return Ok(Value::Null);
        }
        let class = result
            .get("className")
            .and_then(Value::as_str)
            .map(|c| format!(" ({c})"))
            .unwrap_or_default();
        Err(format!(
            "the expression returned a {kind}{class}, which cannot be sent back as JSON. Return \
             plain data instead: strings, numbers, arrays and objects — for a DOM node, return \
             its outerHTML, textContent or attributes."
        ))
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
    ///
    /// We bind each request to the `label` that originated it so
    /// `drain_pending_for_label` can short-circuit waits when the
    /// page navigates or the window closes — without that, a request
    /// issued just before a SPA hot-reload sits idle for the full
    /// 30s timeout because `window.__aurora.respond` was wiped.
    fn issue_request(&self, label: &str) -> (String, oneshot::Receiver<BrowserResult>) {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.insert(
            id.clone(),
            PendingRequest {
                label: label.to_string(),
                sender: tx,
            },
        );
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
    /// JSON-stringified result.
    ///
    /// On Windows this goes through the DevTools channel
    /// ([`Self::devtools_evaluate`]), and that choice is what keeps the
    /// browser tools from hanging. The injected bridge below answers by
    /// calling a Tauri command, and Tauri only injects IPC into origins the
    /// capability file names — `http://*` and `https://*`. On `about:blank`,
    /// on WebView2's own "can't reach this page" document, on anything
    /// `edge://`, the bridge's reply silently goes nowhere and Rust waited the
    /// full 30s. A navigate to a dead port did four such reads in a row and
    /// sat for the whole panel timeout while the user watched an empty panel
    /// ("hung so badly", 2026-09-11). `Runtime.evaluate` answers on every
    /// origin, and a page mid-navigation answers with an error rather than
    /// with silence.
    ///
    /// The bridge remains the path for platforms without a DevTools channel.
    pub async fn eval_with_result(
        &self,
        label: &str,
        expression: &str,
    ) -> Result<BrowserResult, String> {
        if self.devtools_available() {
            // The webview must exist; `devtools_evaluate` says so if not.
            return Ok(
                match self
                    .devtools_evaluate(label, expression, DEFAULT_RESULT_TIMEOUT.as_millis() as u64)
                    .await
                {
                    Ok(value) => BrowserResult {
                        ok: true,
                        value: Some(value),
                        error: None,
                    },
                    Err(error) => BrowserResult {
                        ok: false,
                        value: None,
                        error: Some(error),
                    },
                },
            );
        }
        let (request_id, rx) = self.issue_request(label);
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
        self.await_result(request_id, rx, DEFAULT_RESULT_TIMEOUT)
            .await
    }

    /// Capture an HTML snapshot of the page or a single selector.
    /// Limited to ~200 KB so a maximalist DOM doesn't trash the
    /// agent's context window.
    pub async fn get_dom(
        &self,
        label: &str,
        selector: Option<&str>,
    ) -> Result<BrowserResult, String> {
        let cleaned = selector.map(sanitize_selector);
        let expr = match cleaned.as_deref().filter(|s| !s.is_empty()) {
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
        let selector = sanitize_selector(selector);
        let expr = format!(
            r#"(() => {{
                const el = document.querySelector({s});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const cs = window.getComputedStyle(el);
                const attrs = {{}};
                for (const a of el.attributes) attrs[a.name] = a.value;
                const hasValue = 'value' in el;
                const selectedOptions = el.tagName === 'SELECT'
                    ? Array.from(el.selectedOptions || []).map((option) => ({{
                        value: String(option.value || '').slice(0, 400),
                        text: String(option.textContent || '').trim().slice(0, 400),
                    }}))
                    : null;
                return {{
                    tagName: el.tagName.toLowerCase(),
                    id: el.id || null,
                    className: typeof el.className === 'string' ? el.className : null,
                    text: String(el.innerText || el.textContent || '').trim().slice(0, 2000),
                    value: hasValue ? String(el.value ?? '').slice(0, 2000) : null,
                    checked: typeof el.checked === 'boolean' ? el.checked : null,
                    selected: typeof el.selected === 'boolean' ? el.selected : null,
                    selectedOptions,
                    disabled: typeof el.disabled === 'boolean' ? el.disabled : null,
                    readOnly: typeof el.readOnly === 'boolean' ? el.readOnly : null,
                    role: el.getAttribute('role'),
                    ariaLabel: el.getAttribute('aria-label'),
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
        let expr = format!(
            "window.__aurora.getLogs({lvl}, {since})",
            lvl = level_arg,
            since = since_arg
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
        let selector = sanitize_selector(selector);
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
        let selector = sanitize_selector(selector);
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
        let (request_id, rx) = self.issue_request(label);
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

    /// Scroll the page in a direction (`"up"`, `"down"`, `"top"`,
    /// `"bottom"`) or to an element by CSS selector. Returns the
    /// before/after scroll offsets plus a viewport summary so the
    /// chat-card view can render a meaningful "scrolled X to Y"
    /// status without a follow-up tool call.
    pub async fn scroll(
        &self,
        label: &str,
        direction: Option<&str>,
        selector: Option<&str>,
        amount_px: Option<i64>,
    ) -> Result<BrowserResult, String> {
        // Default delta for a relative scroll: ~80% viewport height,
        // matching how PageDown behaves in Chrome. Clamped to a sane
        // range so an agent that passes a wildly negative number can
        // still recover.
        let amount = amount_px.unwrap_or(0).clamp(-50_000, 50_000);
        let dir = direction.unwrap_or("down");
        let cleaned_selector = selector.map(sanitize_selector);
        let expr = if let Some(sel) = cleaned_selector.as_deref().filter(|s| !s.is_empty()) {
            format!(
                r#"(() => {{
                    const sel = {s};
                    const el = document.querySelector(sel);
                    if (!el) throw new Error('no element matches ' + sel);
                    const before = {{ x: window.scrollX, y: window.scrollY }};
                    el.scrollIntoView({{ behavior: 'instant', block: 'center', inline: 'center' }});
                    return {{
                        ok: true,
                        mode: 'to_selector',
                        selector: sel,
                        before,
                        after: {{ x: window.scrollX, y: window.scrollY }},
                        viewport: {{
                            width: window.innerWidth,
                            height: window.innerHeight,
                            documentHeight: document.documentElement.scrollHeight,
                        }},
                        atTop: window.scrollY <= 0,
                        atBottom: (window.innerHeight + window.scrollY) >= (document.documentElement.scrollHeight - 1),
                    }};
                }})()"#,
                s = json!(sel),
            )
        } else {
            format!(
                r#"(() => {{
                    const before = {{ x: window.scrollX, y: window.scrollY }};
                    const dir = {d};
                    const delta = {amt};
                    const vh = window.innerHeight;
                    let dy = 0;
                    if (dir === 'top') {{ window.scrollTo({{ top: 0, behavior: 'instant' }}); }}
                    else if (dir === 'bottom') {{ window.scrollTo({{ top: document.documentElement.scrollHeight, behavior: 'instant' }}); }}
                    else {{
                        dy = delta !== 0 ? delta : Math.round(vh * 0.8);
                        if (dir === 'up') dy = -Math.abs(dy);
                        else dy = Math.abs(dy);
                        window.scrollBy({{ top: dy, behavior: 'instant' }});
                    }}
                    const after = {{ x: window.scrollX, y: window.scrollY }};
                    return {{
                        ok: true,
                        mode: 'direction',
                        direction: dir,
                        deltaY: after.y - before.y,
                        before,
                        after,
                        viewport: {{
                            width: window.innerWidth,
                            height: window.innerHeight,
                            documentHeight: document.documentElement.scrollHeight,
                        }},
                        atTop: after.y <= 0,
                        atBottom: (window.innerHeight + after.y) >= (document.documentElement.scrollHeight - 1),
                    }};
                }})()"#,
                d = json!(dir),
                amt = amount,
            )
        };
        self.eval_with_result(label, &expr).await
    }

    /// Capture a PNG screenshot of the page (or one element).
    ///
    /// Native-first, and native for BOTH shapes:
    ///
    ///   1. On a platform with a WebView snapshot API (Windows via
    ///      `ICoreWebView2::CapturePreview`) the live surface is captured in
    ///      one COM call. An element screenshot is that same capture CROPPED
    ///      to the element's viewport rectangle — the rectangle the page
    ///      itself reports, in viewport coordinates, after scrolling the
    ///      element into view. That is what makes a portalled, `position:
    ///      fixed` dialog come back as the dialog: the old element path
    ///      re-rendered a CLONE of the element through an SVG
    ///      `foreignObject`, which paints a fixed element at its document
    ///      position on an otherwise empty canvas — a blank 576×457 picture
    ///      that read as "the dialog did not render"
    ///      (`reports/aurora-issues.md`, 2026-09-10). A crop of the real
    ///      pixels cannot be wrong in that way.
    ///   2. Otherwise — no native capture on this platform, or the native
    ///      call failed — the `foreignObject` SVG renderer below runs. It
    ///      has known holes (cross-origin images, canvas, shadow DOM) and is
    ///      the fallback for macOS/Linux only.
    ///
    /// Both paths capture PNG and both are re-encoded by
    /// [`Self::finalize_screenshot`], so this returns
    /// `{ ok, base64, mediaType: "image/jpeg", width, height,
    /// capturePath: "native"|"native-crop"|"svg" }`.
    pub async fn screenshot(
        &self,
        label: &str,
        selector: Option<&str>,
    ) -> Result<BrowserResult, String> {
        let cleaned = selector.map(sanitize_selector);
        let element_scope = cleaned.as_deref().filter(|s| !s.is_empty());

        if let Ok(window) = self.window(label) {
            // Where the element is on screen, BEFORE the capture, so the
            // crop is taken from the frame that shows it. Scrolling is
            // instant on purpose: a page with `scroll-behavior: smooth`
            // would otherwise still be gliding when the frame is taken.
            let clip = match element_scope {
                Some(sel) => Some(self.element_viewport_rect(label, sel).await?),
                None => None,
            };

            // Let the webview composite one frame before capturing.
            // `CapturePreview` grabs the *last painted* surface, and a
            // just-navigated webview otherwise returns a STALE frame — the
            // previous page. `show()` is only re-asserted when the frontend
            // wants the panel on screen anyway: the tools ask the UI to reveal
            // the panel (`ensure_agent_browser`) rather than unhiding it here
            // over the Canvas tab the user switched to.
            let hidden = !self.is_visible(label);
            if !hidden {
                let _ = window.show();
            }
            tokio::time::sleep(Duration::from_millis(180)).await;
            // A webview that has not painted its first frame yet (the panel
            // was just built) fails the capture; the same call succeeds once
            // the frame exists. Retry briefly — 100ms apart, 2s at most — before
            // falling back to a drawing that is not a real frame.
            let mut attempt =
                crate::services::browser_native_capture::capture_webview_png(&window).await;
            let retry_until = std::time::Instant::now() + Duration::from_secs(2);
            while attempt.is_err() && std::time::Instant::now() < retry_until {
                tokio::time::sleep(Duration::from_millis(100)).await;
                attempt =
                    crate::services::browser_native_capture::capture_webview_png(&window).await;
            }
            match attempt {
                Ok(Some(png_bytes)) => {
                    let mut result = match clip {
                        None => self.finalize_screenshot(png_bytes, "native"),
                        Some(rect) => {
                            let cropped = crop_png_to_viewport_rect(&png_bytes, &rect)?;
                            self.finalize_screenshot(cropped, "native-crop")
                        }
                    };
                    if hidden {
                        if let Some(value) = result.value.as_mut().and_then(Value::as_object_mut) {
                            value.insert(
                                "note".into(),
                                json!("The Browser panel was hidden behind another tab when this \
                                       was captured, so the frame may be stale. Open the Browser \
                                       tab (browser_navigate does) and capture again if it looks \
                                       wrong."),
                            );
                        }
                    }
                    return Ok(result);
                }
                Ok(None) => {
                    // Platform unsupported — fall through to SVG path
                    // without logging (this is expected on macOS/Linux).
                }
                Err(err) => {
                    // Native attempt failed for a real reason. Log and
                    // fall back so the agent still gets *some* image
                    // instead of an opaque error.
                    crate::logging::log_warn(
                        "browser.screenshot",
                        &format!(
                            "'{label}' native screenshot failed after retries, falling back to \
                             an HTML redraw of the viewport: {err}"
                        ),
                    );
                }
            }
        }

        let target = match element_scope {
            Some(sel) => format!("document.querySelector({s})", s = json!(sel)),
            None => "document.body".into(),
        };
        // A plain screenshot means "what is on screen". Drawing all of
        // `document.body` returned the WHOLE page — thousands of pixels the
        // panel was not showing — whenever the real capture failed. Without a
        // selector the drawing is clipped to the viewport at the current scroll.
        let viewport_only = element_scope.is_none();
        // The foreignObject technique inlines the live DOM into an
        // SVG, then rasterises that SVG via a hidden Image into a
        // canvas. It has known limits (cross-origin <img>, <canvas>
        // contents won't transfer) but works for the typical "show
        // me what the user is seeing" case without an external lib.
        let expr = format!(
            r#"(async () => {{
                const target = {target};
                if (!target) throw new Error('screenshot target not found');
                const viewportOnly = {viewport_only};
                const rect = target.getBoundingClientRect();
                const width = Math.max(1, Math.ceil(viewportOnly ? window.innerWidth : rect.width));
                const height = Math.max(1, Math.ceil(viewportOnly ? window.innerHeight : rect.height));
                // The body's box relative to the viewport (negative once
                // scrolled), so the drawing starts where the screen does.
                const shift = viewportOnly
                    ? `transform:translate(${{rect.left}}px,${{rect.top}}px);`
                    : '';
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
                    `<div xmlns='http://www.w3.org/1999/xhtml' style='${{shift}}'>${{xml}}</div>` +
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
                return {{ ok: true, base64, mediaType: 'image/png', width, height,
                    capturePath: viewportOnly ? 'svg-viewport' : 'svg' }};
            }})()"#,
            target = target,
            viewport_only = viewport_only
        );
        let result = self.eval_with_result(label, &expr).await?;
        // Route the page-produced PNG through the same downscale + on-disk save
        // path the native capture uses, so element screenshots also get bounded
        // base64 (model) + a `path` the tool card can render (UI).
        Ok(self.finalize_svg_result(result))
    }

    /// The element's rectangle in viewport CSS pixels, plus the viewport size
    /// the rectangle is measured against.
    ///
    /// Scrolls the element into view first (instantly), then re-reads the
    /// rectangle, so the answer describes where the element IS in the frame
    /// about to be captured rather than where it was before the scroll.
    async fn element_viewport_rect(
        &self,
        label: &str,
        selector: &str,
    ) -> Result<ViewportRect, String> {
        let expr = format!(
            r#"(() => {{
                const el = document.querySelector({s});
                if (!el) return {{ found: false }};
                try {{ el.scrollIntoView({{ behavior: 'instant', block: 'center', inline: 'center' }}); }} catch (e) {{}}
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                const hidden = cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0';
                return {{
                    found: true,
                    x: r.left, y: r.top, width: r.width, height: r.height,
                    viewport_width: window.innerWidth, viewport_height: window.innerHeight,
                    hidden,
                }};
            }})()"#,
            s = json!(selector)
        );
        let result = self.eval_with_result(label, &expr).await?;
        if !result.ok {
            return Err(result
                .error
                .unwrap_or_else(|| "the page could not locate the element".into()));
        }
        let value = result.value.unwrap_or(Value::Null);
        if value.get("found").and_then(Value::as_bool) != Some(true) {
            return Err(format!(
                "no element matches `{selector}`. Run browser_view to get selectors that exist on \
                 this page."
            ));
        }
        let f = |key: &str| value.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        let rect = ViewportRect {
            x: f("x"),
            y: f("y"),
            width: f("width"),
            height: f("height"),
            viewport_width: f("viewport_width"),
            viewport_height: f("viewport_height"),
        };
        if value.get("hidden").and_then(Value::as_bool) == Some(true)
            || rect.width <= 0.0
            || rect.height <= 0.0
        {
            return Err(format!(
                "`{selector}` exists but is not visible (no size on screen, or hidden by CSS), \
                 so there is nothing to capture."
            ));
        }
        Ok(rect)
    }

    /// Capture the WHOLE document, not just the viewport.
    ///
    /// Goes through `Page.captureScreenshot` with `captureBeyondViewport`,
    /// which renders the page at its full scroll height into one image — the
    /// one thing `CapturePreview` cannot do, since it photographs the surface
    /// as it is. Height is capped so a long feed does not produce a picture
    /// that downscales into an unreadable strip; the cap is reported so the
    /// caller knows the picture ends before the page does.
    ///
    /// DevTools-only. Off Windows, or if the browser refuses the method, the
    /// error names the alternative (scroll and capture the viewport).
    pub async fn screenshot_full_page(&self, label: &str) -> Result<BrowserResult, String> {
        use base64::Engine;
        const MAX_FULL_PAGE_HEIGHT: f64 = 6_000.0;

        if !self.devtools_available() {
            return Err("a full-page capture needs the DevTools channel, which exists on Windows \
                        only. Scroll with browser_scroll and capture the viewport instead."
                .into());
        }
        // Scroll through the page first, one screen at a time, then come back.
        //
        // A full-page capture renders everything below the fold WITHOUT ever
        // scrolling there, so sections that appear on scroll (reveal
        // animations, lazy images, IntersectionObserver content — most modern
        // landing pages) are photographed in their hidden "before" state: blank
        // bands the model then reported as a broken page. Walking the page
        // fires those triggers; the pause at the end lets the reveal
        // transitions finish before the frame is taken.
        let reveal_script = format!(
            "(async () => {{ \
                const se = document.scrollingElement || document.documentElement; \
                const startX = window.scrollX, startY = window.scrollY; \
                const step = Math.max(200, Math.floor(window.innerHeight * 0.8)); \
                const limit = Math.min(se.scrollHeight, {max}); \
                const pause = (ms) => new Promise((r) => setTimeout(r, ms)); \
                for (let y = 0; y < limit; y += step) {{ \
                    window.scrollTo({{ top: y, left: 0, behavior: 'instant' }}); \
                    await pause(120); \
                }} \
                window.scrollTo({{ top: limit, left: 0, behavior: 'instant' }}); \
                await pause(120); \
                window.scrollTo({{ top: startY, left: startX, behavior: 'instant' }}); \
                await pause(700); \
                return true; \
            }})()",
            max = MAX_FULL_PAGE_HEIGHT
        );
        let revealed = self.devtools_evaluate(label, &reveal_script, 15_000).await;
        if let Err(err) = &revealed {
            crate::logging::log_warn(
                "browser.screenshot",
                &format!("'{label}' full-page scroll-through failed, capturing anyway: {err}"),
            );
        }
        let metrics = self
            .devtools_evaluate(
                label,
                "({ width: Math.max(document.documentElement.scrollWidth, window.innerWidth), \
                    height: Math.max(document.documentElement.scrollHeight, window.innerHeight) })",
                5_000,
            )
            .await?;
        let width = metrics.get("width").and_then(Value::as_f64).unwrap_or(0.0);
        let height = metrics.get("height").and_then(Value::as_f64).unwrap_or(0.0);
        if width <= 0.0 || height <= 0.0 {
            return Err("the page reported no size, so there is nothing to capture".into());
        }
        let capped = height.min(MAX_FULL_PAGE_HEIGHT);

        let response = self
            .call_devtools(
                label,
                "Page.captureScreenshot",
                json!({
                    "format": "png",
                    "captureBeyondViewport": true,
                    "clip": { "x": 0, "y": 0, "width": width, "height": capped, "scale": 1 },
                }),
            )
            .await
            .map_err(|err| {
                format!(
                    "the browser refused a full-page capture ({err}). Scroll with browser_scroll \
                     and capture the viewport instead."
                )
            })?;
        let data = response
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| "the browser returned no image data for the full page".to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|err| format!("the full-page capture was not valid base64: {err}"))?;
        let mut result = self.finalize_screenshot(bytes, "native-full-page");
        if let Some(value) = result.value.as_mut().and_then(Value::as_object_mut) {
            value.insert("pageHeight".into(), json!(height.round()));
            // Said on every full-page capture: the page was scrolled through
            // first, but some content only renders WHILE it is on screen, and a
            // blank band here is not evidence of a broken page.
            let mut note = String::from(
                "A full-page capture renders parts of the page that are not on screen. The page \
                 was scrolled through first so scroll-triggered sections could appear, but \
                 content that only renders while visible can still show as a blank band. Before \
                 reporting missing content, scroll to it (browser_scroll) and capture the \
                 viewport.",
            );
            if revealed.is_err() {
                note.push_str(" The scroll-through failed on this page, so blank bands are likely.");
            }
            if height > capped {
                note.push_str(&format!(
                    " The page is {h}px tall; this capture stops at {c}px. Scroll and capture \
                     the viewport to see the rest.",
                    h = height.round(),
                    c = capped
                ));
            }
            value.insert("note".into(), json!(note));
        }
        Ok(result)
    }

    /// Bound a capture for delivery: decode → fit inside
    /// [`SCREENSHOT_MAX_EDGE`] → re-encode JPEG, base64 it for the model's
    /// vision block, and save a copy to the app cache dir so the tool card can
    /// render the image via the asset protocol (a `path`, never megabytes of
    /// base64, is what lands in the thread store). One artefact serves both:
    /// the card shows exactly the pixels the model was given.
    fn finalize_screenshot(&self, bytes: Vec<u8>, capture_path: &str) -> BrowserResult {
        use base64::Engine;
        let (jpeg, width, height) = encode_screenshot(bytes);
        let base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
        let path = self.save_screenshot(&jpeg);
        BrowserResult {
            ok: true,
            value: Some(json!({
                "base64": base64,
                "mediaType": "image/jpeg",
                "width": width,
                "height": height,
                "capturePath": capture_path,
                "path": path,
            })),
            error: None,
        }
    }

    /// Re-run a page-produced (SVG-path) screenshot result through
    /// [`Self::finalize_screenshot`] so both capture paths return the identical
    /// enriched shape. Non-ok / non-image results pass through untouched.
    fn finalize_svg_result(&self, result: BrowserResult) -> BrowserResult {
        use base64::Engine;
        if !result.ok {
            return result;
        }
        let Some(b64) = result
            .value
            .as_ref()
            .and_then(|v| v.get("base64"))
            .and_then(Value::as_str)
        else {
            return result;
        };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else {
            return result;
        };
        let path = result
            .value
            .as_ref()
            .and_then(|v| v.get("capturePath"))
            .and_then(Value::as_str)
            .unwrap_or("svg")
            .to_string();
        let mut finalized = self.finalize_screenshot(bytes, &path);
        // Say what this is: a redraw of the page's HTML, not a captured frame.
        // It can miss images, canvas, video and some styling, and the model
        // must not judge the design from it as if it were real pixels.
        if let Some(value) = finalized.value.as_mut().and_then(Value::as_object_mut) {
            value.insert(
                "note".into(),
                json!("The real screen capture failed, so this is a redraw of the page's HTML. \
                       Images, canvas, video and some styling may be missing — capture again \
                       before judging how the page looks."),
            );
        }
        finalized
    }

    /// Persist a screenshot under `<app_cache>/aurora-screenshots/` and
    /// return its absolute path (loadable by the frontend via `convertFileSrc`).
    /// Best-effort — returns `None` on any IO failure so the screenshot still
    /// works (the card just falls back to its caption). Prunes stale files first
    /// so the directory can't grow without bound.
    fn save_screenshot(&self, bytes: &[u8]) -> Option<String> {
        let dir = self
            .app
            .path()
            .app_cache_dir()
            .ok()?
            .join("aurora-screenshots");
        std::fs::create_dir_all(&dir).ok()?;
        prune_old_screenshots(&dir);
        // `.jpg` because that is what `encode_screenshot` writes. Older threads
        // still reference `.png` files here; nothing reads the extension, both
        // are served by the asset protocol, and the `media_type` recorded in
        // each `<aurora_image>` marker is what the request builder trusts.
        let file = dir.join(format!("shot-{}.jpg", Uuid::new_v4()));
        std::fs::write(&file, bytes).ok()?;
        Some(file.to_string_lossy().to_string())
    }
}

/// An element's box in viewport CSS pixels, and the viewport it was measured in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewportRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
}

/// Cut `rect` out of a capture of the whole viewport.
///
/// The capture is in physical pixels and the rectangle in CSS pixels, and the
/// ratio between them is NOT simply `devicePixelRatio`: under a device-metrics
/// override the page reports the emulated ratio while the surface is painted
/// at the monitor's. So the scale is derived from the two things actually in
/// hand — the image's size and the viewport's — which is right in every case.
///
/// The rectangle is clipped to the viewport first. An element half off-screen
/// yields the visible half; one entirely off-screen is an error, because a
/// zero-size crop would come back as a blank picture that reads as "nothing
/// rendered".
fn crop_png_to_viewport_rect(png: &[u8], rect: &ViewportRect) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(png)
        .map_err(|err| format!("the native capture could not be decoded: {err}"))?;
    let (img_w, img_h) = (img.width() as f64, img.height() as f64);
    if rect.viewport_width <= 0.0 || rect.viewport_height <= 0.0 {
        return Err("the page reported a zero-size viewport".into());
    }
    let scale_x = img_w / rect.viewport_width;
    let scale_y = img_h / rect.viewport_height;

    let left = rect.x.max(0.0);
    let top = rect.y.max(0.0);
    let right = (rect.x + rect.width).min(rect.viewport_width);
    let bottom = (rect.y + rect.height).min(rect.viewport_height);
    if right - left < 1.0 || bottom - top < 1.0 {
        return Err(
            "the element is entirely outside the viewport, so a crop would be empty. Scroll it \
             into view (browser_scroll with its selector) and capture again."
                .into(),
        );
    }

    let x = (left * scale_x).floor().clamp(0.0, img_w - 1.0) as u32;
    let y = (top * scale_y).floor().clamp(0.0, img_h - 1.0) as u32;
    let w = ((right - left) * scale_x).ceil().max(1.0) as u32;
    let h = ((bottom - top) * scale_y).ceil().max(1.0) as u32;
    let w = w.min(img.width() - x);
    let h = h.min(img.height() - y);

    let cropped = image::imageops::crop_imm(&img, x, y, w, h).to_image();
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(cropped)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|err| format!("the cropped capture could not be encoded: {err}"))?;
    Ok(out)
}

/// One sentence from a `Runtime.evaluate` `exceptionDetails` object.
///
/// The browser's own account of a throw carries the message, and — when the
/// script threw rather than failed to parse — the line and column it happened
/// at. Both are kept: "ReferenceError: foo is not defined (line 3, column 12)"
/// tells the caller where to look; the bridge's `String(err)` only ever said
/// the first half.
fn describe_exception(details: &Value) -> String {
    let exception = details.get("exception");
    let message = exception
        .and_then(|e| e.get("description"))
        .and_then(Value::as_str)
        .map(|d| d.lines().next().unwrap_or(d).to_string())
        .or_else(|| {
            details
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "the script threw".into());
    let line = details.get("lineNumber").and_then(Value::as_u64);
    let column = details.get("columnNumber").and_then(Value::as_u64);
    match (line, column) {
        // CDP numbers are zero-based; people count from one.
        (Some(l), Some(c)) => format!("{message} (line {}, column {})", l + 1, c + 1),
        _ => message,
    }
}

/// Prepare a capture for the model: decode, bound the longest edge, re-encode
/// as JPEG. Returns `(jpeg_bytes, width, height)`.
///
/// The rules live in [`crate::api::aurora_image::encode_for_vision`], shared
/// with `file_read`'s image path so a screenshot and an opened PNG reach the
/// model at the same size and quality — one definition of "how big an image
/// Aurora sends", not two that drift.
fn encode_screenshot(bytes: Vec<u8>) -> (Vec<u8>, u32, u32) {
    crate::api::aurora_image::encode_for_vision(bytes)
}

/// Keep only the newest [`SCREENSHOT_KEEP`] screenshot files, deleting the
/// oldest beyond that. Count-based (not age-based) so a reloaded thread can
/// still show its screenshots days later, while a burst of captures can't grow
/// the directory without bound. Best-effort, silent — errors are ignored.
fn prune_old_screenshots(dir: &std::path::Path) {
    const SCREENSHOT_KEEP: usize = 300;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, std::path::PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, e.path()))
        })
        .collect();
    if files.len() <= SCREENSHOT_KEEP {
        return;
    }
    // Newest first, then drop everything past the keep count.
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(SCREENSHOT_KEEP) {
        let _ = std::fs::remove_file(path);
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
        return Err(format!(
            "browser window label '{label}' contains invalid characters"
        ));
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
    /// When present, build the browser as a child webview embedded in
    /// `host_label`'s content area instead of a standalone window.
    pub embed: Option<EmbedConfig>,
}

/// Bounds + host for an embedded (in-tab) browser webview.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedConfig {
    pub host_label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Payload emitted on `aurora:browser-window-opened` whenever
/// `BrowserManager::create_window` builds a new WebviewWindow.
/// Mirrors `BrowserWindowSummary` so the frontend's live-windows
/// store can use the same shape for list + opened deltas.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserWindowOpenedPayload {
    label: String,
    url: String,
    inspector_active: bool,
    stagewise_active: bool,
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
  // Prefer the WEBVIEW's own label, not the window's. For an embedded in-tab
  // browser the webview is a child of the host window, so `currentWindow.label`
  // is the HOST ('agent-window') — which makes picked-element events carry the
  // wrong label and get filtered out by the panel. `currentWebview.label` is
  // the child's own label ('browser-agentwin'); it also equals the label for a
  // standalone browser window, so this is correct in both modes.
  ns.label = (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata && (
    (window.__TAURI_INTERNALS__.metadata.currentWebview && window.__TAURI_INTERNALS__.metadata.currentWebview.label) ||
    (window.__TAURI_INTERNALS__.metadata.currentWindow && window.__TAURI_INTERNALS__.metadata.currentWindow.label)
  )) || '';

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
      // Errors FIRST. `JSON.stringify(new Error('boom'))` is '{}' — its own
      // properties are non-enumerable — so the single most common way to log
      // a failure (`console.error(err)`) used to record an empty object and
      // throw the message and stack away. That is the one log line anyone
      // actually needs.
      if (arg instanceof Error) {
        const head = (arg.name || 'Error') + ': ' + (arg.message || '');
        const stack = typeof arg.stack === 'string'
          ? arg.stack.split('\n').slice(1, 4).map((l) => l.trim()).join(' <- ')
          : '';
        return stack ? head + ' | ' + stack : head;
      }
      if (typeof arg === 'function') return '[function ' + (arg.name || 'anonymous') + ']';
      if (typeof arg === 'symbol' || typeof arg === 'bigint') return String(arg);
      // A DOM node stringifies to '{}' as well.
      if (typeof Node !== 'undefined' && arg instanceof Node) {
        const el = arg;
        return '<' + (el.nodeName || 'node').toLowerCase()
          + (el.id ? '#' + el.id : '')
          + (el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).join('.') : '')
          + '>';
      }
      try {
        const seen = new WeakSet();
        // A circular structure throws, which would fall through to
        // '[object Object]' and lose everything; the replacer keeps the rest.
        return JSON.stringify(arg, (_k, v) => {
          if (typeof v === 'object' && v !== null) {
            if (seen.has(v)) return '[circular]';
            seen.add(v);
          }
          return v;
        });
      } catch (_) { return String(arg); }
    };
    // ONE trim, used by every writer. The two error listeners below used to
    // push without trimming, so a page stuck in an error loop grew this array
    // without bound — a memory leak in the user's page, caused by our
    // debugging aid.
    const record = (level, message) => {
      try {
        ns.__logs.push({ ts: Date.now(), level, message });
        if (ns.__logs.length > MAX) ns.__logs.splice(0, ns.__logs.length - MAX);
      } catch (_) { /* never break the page */ }
    };
    const wrap = (level, original) => function (...args) {
      record(level, args.map(stringify).join(' '));
      return original.apply(console, args);
    };
    ['log', 'info', 'warn', 'error', 'debug', 'trace'].forEach((level) => {
      const fn = console[level];
      if (typeof fn === 'function') console[level] = wrap(level, fn);
    });
    // `console.assert` only speaks when the assertion FAILS, and it is the
    // one console method whose silence is the success case.
    if (typeof console.assert === 'function') {
      const originalAssert = console.assert;
      console.assert = function (condition, ...args) {
        if (!condition) record('error', '[assert] ' + args.map(stringify).join(' '));
        return originalAssert.apply(console, [condition, ...args]);
      };
    }
    window.addEventListener('error', (e) => {
      // Location and stack included: '[uncaught] undefined is not a function'
      // with no file or line is barely more useful than silence.
      const where = e.filename ? ' (' + e.filename + ':' + e.lineno + ':' + e.colno + ')' : '';
      const detail = e.error instanceof Error ? stringify(e.error) : (e.message || String(e));
      record('error', '[uncaught] ' + detail + where);
    });
    window.addEventListener('unhandledrejection', (e) => {
      record('error', '[unhandled-rejection] ' + stringify(e.reason));
    });
  }

  // ---- DOM change counter ------------------------------------------
  // "Did my click do anything" cannot be answered from URL, title and page
  // height alone. A label swapping to 'Dark detected', a button's pressed
  // state flipping, and an absolutely-positioned overlay mounting all leave
  // those three identical — so the action reported that nothing changed about
  // a page that had visibly changed, which is worse than reporting nothing.
  //
  // A counter is O(1) to read. The alternative, serialising the whole DOM
  // twice per action to compare it, is not.
  if (!ns.__mutations) {
    ns.__mutations = { count: 0, last: 0 };
    try {
      const observer = new MutationObserver(function (records) {
        ns.__mutations.count += records.length;
        ns.__mutations.last = Date.now();
      });
      const observe = function () {
        if (!document.documentElement) return;
        observer.observe(document.documentElement, {
          subtree: true, childList: true, attributes: true, characterData: true,
        });
      };
      // The init script runs before the first paint, so on most loads there is
      // no documentElement to observe yet.
      if (document.documentElement) observe();
      else document.addEventListener('DOMContentLoaded', observe, { once: true });
    } catch (e) { /* never break the page over a debugging aid */ }
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

#[cfg(test)]
mod screenshot_encoding_tests {
    use super::encode_screenshot;
    use crate::api::aurora_image::MAX_EDGE as SCREENSHOT_MAX_EDGE;
    use std::io::Cursor;

    /// Build a PNG of the given size to feed the encoder.
    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(w, h, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        });
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .expect("encode fixture");
        out
    }

    /// The cap is on the LONGEST edge, not on the width — a full-page capture is
    /// tall, and bounding width alone left the expensive axis free.
    #[test]
    fn tall_capture_is_bounded_by_its_height() {
        let (bytes, w, h) = encode_screenshot(png(1400, 2800));
        assert_eq!(h, SCREENSHOT_MAX_EDGE, "long edge is the bound");
        assert_eq!(w, SCREENSHOT_MAX_EDGE / 2, "aspect ratio held");
        assert!(!bytes.is_empty());
    }

    #[test]
    fn wide_capture_is_bounded_by_its_width() {
        let (_, w, h) = encode_screenshot(png(3000, 1000));
        assert_eq!(w, SCREENSHOT_MAX_EDGE);
        assert!(h < SCREENSHOT_MAX_EDGE);
    }

    /// An element capture is already small; upscaling it would invent detail and
    /// cost bytes for pixels that were never rendered.
    #[test]
    fn small_capture_is_never_upscaled() {
        let (_, w, h) = encode_screenshot(png(320, 200));
        assert_eq!((w, h), (320, 200));
    }

    /// Everything the model receives is JPEG — `\xFF\xD8\xFF` is the SOI marker.
    #[test]
    fn output_is_always_jpeg() {
        let (bytes, ..) = encode_screenshot(png(1200, 800));
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF], "JPEG magic bytes");
    }

    /// The reported dimensions have to describe the bytes actually returned —
    /// they are written into the `<aurora_image>` header, and the UI sizes the
    /// card from them.
    #[test]
    fn reported_dimensions_match_the_encoded_image() {
        let (bytes, w, h) = encode_screenshot(png(1400, 1500));
        let decoded = image::load_from_memory(&bytes).expect("output decodes");
        assert_eq!((decoded.width(), decoded.height()), (w, h));
        assert_eq!(h, SCREENSHOT_MAX_EDGE);
    }

    /// A capture we cannot decode still has to come back as an image rather than
    /// as nothing — the caller has no other copy.
    #[test]
    fn undecodable_bytes_pass_through() {
        let junk = b"not an image at all".to_vec();
        let (bytes, w, h) = encode_screenshot(junk.clone());
        assert_eq!(bytes, junk);
        assert_eq!((w, h), (0, 0));
    }
}

#[cfg(test)]
mod visibility_ledger_tests {
    use super::VisibilityLedger;

    /// The race this exists for: "show" (seq 1) and "hide" (seq 2) both in
    /// flight, and the show lands second. It must be ignored.
    #[test]
    fn a_decision_older_than_the_last_one_is_dropped() {
        let mut ledger = VisibilityLedger::default();
        assert!(ledger.accept("browser-agentwin", 2, false));
        assert!(!ledger.accept("browser-agentwin", 1, true));
        assert_eq!(ledger.wanted("browser-agentwin"), Some(false));
    }

    #[test]
    fn a_repeated_sequence_number_is_not_applied_twice() {
        let mut ledger = VisibilityLedger::default();
        assert!(ledger.accept("b", 5, true));
        assert!(!ledger.accept("b", 5, false));
        assert_eq!(ledger.wanted("b"), Some(true));
    }

    /// A hide sent before the webview exists is remembered, so the build
    /// that finishes afterwards can start hidden.
    #[test]
    fn a_decision_is_kept_per_label_before_any_window_exists() {
        let mut ledger = VisibilityLedger::default();
        assert_eq!(ledger.wanted("b"), None);
        assert!(ledger.accept("b", 7, false));
        assert!(ledger.accept("other", 1, true));
        assert_eq!(ledger.wanted("b"), Some(false));
        assert_eq!(ledger.wanted("other"), Some(true));
    }
}

#[cfg(test)]
mod element_crop_tests {
    use super::{crop_png_to_viewport_rect, describe_exception, ViewportRect};
    use std::io::Cursor;

    /// A capture whose pixel colour encodes its position, so a crop can be
    /// checked by reading one pixel back.
    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(w, h, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 0, 255])
        });
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .expect("encode fixture");
        out
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> ViewportRect {
        ViewportRect {
            x,
            y,
            width: w,
            height: h,
            viewport_width: 400.0,
            viewport_height: 300.0,
        }
    }

    /// The reported bug: a fixed-position dialog captured as a blank picture.
    /// A crop of the real frame at the element's VIEWPORT rectangle has to
    /// contain the pixels at that rectangle, whatever the document scroll is.
    #[test]
    fn the_crop_is_taken_at_the_viewport_rectangle() {
        let cropped = crop_png_to_viewport_rect(&png(400, 300), &rect(100.0, 50.0, 40.0, 20.0))
            .expect("crop");
        let img = image::load_from_memory(&cropped).expect("decode").to_rgba8();
        assert_eq!((img.width(), img.height()), (40, 20));
        // Top-left pixel of the crop is pixel (100, 50) of the capture.
        assert_eq!(img.get_pixel(0, 0).0[..2], [100, 50]);
    }

    /// Under an emulated viewport the page's devicePixelRatio lies about the
    /// surface; the scale must come from the capture's own size.
    #[test]
    fn the_scale_is_derived_from_the_capture_not_assumed() {
        // 800×600 capture of a 400×300 viewport: 2× in both axes.
        let cropped = crop_png_to_viewport_rect(&png(800, 600), &rect(10.0, 20.0, 30.0, 40.0))
            .expect("crop");
        let img = image::load_from_memory(&cropped).expect("decode").to_rgba8();
        assert_eq!((img.width(), img.height()), (60, 80));
        assert_eq!(img.get_pixel(0, 0).0[..2], [20, 40]);
    }

    #[test]
    fn an_element_half_off_screen_yields_the_visible_half() {
        let cropped = crop_png_to_viewport_rect(&png(400, 300), &rect(380.0, 0.0, 100.0, 50.0))
            .expect("crop");
        let img = image::load_from_memory(&cropped).expect("decode");
        assert_eq!((img.width(), img.height()), (20, 50));
    }

    /// A zero-size crop would come back as a blank image — the exact false
    /// evidence this path exists to stop producing.
    #[test]
    fn an_element_entirely_off_screen_is_an_error_not_a_blank_picture() {
        let err = crop_png_to_viewport_rect(&png(400, 300), &rect(0.0, 900.0, 50.0, 50.0))
            .expect_err("nothing visible to crop");
        assert!(err.contains("outside the viewport"), "{err}");
        assert!(err.contains("browser_scroll"), "names the recovery: {err}");
    }

    #[test]
    fn a_thrown_exception_names_where_it_happened() {
        let details = serde_json::json!({
            "text": "Uncaught",
            "lineNumber": 2,
            "columnNumber": 11,
            "exception": { "description": "ReferenceError: foo is not defined\n    at <anonymous>:3:12" }
        });
        assert_eq!(
            describe_exception(&details),
            "ReferenceError: foo is not defined (line 3, column 12)"
        );
    }

    #[test]
    fn a_syntax_error_without_an_exception_object_still_has_a_message() {
        let details = serde_json::json!({ "text": "SyntaxError: Unexpected token '}'" });
        assert_eq!(
            describe_exception(&details),
            "SyntaxError: Unexpected token '}'"
        );
    }
}
