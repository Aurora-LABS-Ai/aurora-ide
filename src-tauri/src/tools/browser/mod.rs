//! Browser tools bucket — one browser: the agent window's right-rail panel.
//!
//! The agent does NOT spawn standalone browser windows. Aurora's agent window
//! has a dedicated Browser panel in its right-hand dock (an embedded webview
//! labelled `browser-agentwin`). Every `browser_*` tool drives THAT panel:
//! calling one reveals the panel (if it isn't already open) and acts on it.
//! There is no `label` argument and no window management — a single, always-
//! reused browser, so the chat timeline reads like a recipe, not a debugger
//! session juggling windows.
//!
//! Six tools:
//! * **Read-only** (`requires_permission == false`): `browser_screenshot`,
//!   `browser_get_console_logs`.
//! * **Page interaction** (`requires_permission == true`): `browser_navigate`,
//!   `browser_click`, `browser_fill`, `browser_scroll`.
//!
//! `browser_navigate` is the entry point — it opens the right-rail panel and
//! loads a URL. The others operate on whatever the panel is currently showing.
//!
//! Deliberately not on the agent surface:
//! * `browser_open` / `browser_close` / `browser_list_windows` — window
//!   management is meaningless now that there is exactly one embedded browser.
//! * `browser_eval` — arbitrary JS in the page is a foot-gun. The Rust
//!   `BrowserManager` still uses it internally to implement the other tools.
//! * `browser_get_dom` — burned up to 200 KB of context; screenshot instead.
//! * `browser_get_url`, `browser_inspect_element`, `browser_wait_for` — folded
//!   into the tools that need them (`browser_click` auto-waits, etc.). The IDE
//!   still calls all of these via the Tauri IPC commands when the *user* drives
//!   a browser tab directly.
//!
//! `browser_screenshot` returns a structured string containing an
//! `<aurora_image media_type="image/png">BASE64</aurora_image>` marker
//! that the Anthropic API adapter rewrites into a vision content
//! block on the next turn so the model can actually *see* the page.
//! Other providers strip the marker and keep the textual caption.
//!
//! ## Opening the right-rail browser from a tool
//!
//! The embedded webview is built by the frontend (`BrowserPanel`) when its dock
//! tab is visible — Rust can't create it directly (it needs the host window's
//! live bounds). So [`ensure_agent_browser`] emits `aurora:agent-open-browser`,
//! which the agent window handles by opening the Browser tab; the tool then
//! polls until the webview exists before acting on it.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};
use crate::services::browser_runtime::{BrowserManager, BrowserResult, CreateBrowserWindow};

/// The one browser the agent drives: the agent window's right-dock panel.
const AGENT_BROWSER_LABEL: &str = "browser-agentwin";

/// Names of every tool this bucket registers, in roster order. Pinned
/// by the bucket-level test below.
///
/// Window-management tools (`browser_open`, `browser_close`,
/// `browser_list_windows`) were removed: the agent has a single embedded
/// right-rail browser, so there are no windows to open, close, or enumerate.
pub const TOOL_NAMES: &[&str] = &[
    "browser_navigate",
    "browser_screenshot",
    "browser_get_console_logs",
    "browser_click",
    "browser_fill",
    "browser_scroll",
];

/// Tools that opt into the Phase 4 permission gate.
pub const TOOLS_REQUIRING_PERMISSION: &[&str] = &[
    "browser_navigate",
    "browser_click",
    "browser_fill",
    "browser_scroll",
];

/// Tools whose result is an image (a vision content block on the next
/// turn). For models that don't declare vision support these are
/// filtered out of the per-turn registry, so the model is neither
/// advertised nor able to call a tool whose output it can't see. This
/// is the Rust-side port of the legacy frontend gate
/// (`VISION_REQUIRED_TOOLS` in `src/services/agent-service.ts`), which
/// became ineffective once the Rust registry — not the frontend list —
/// became the source of advertised native tools.
pub const VISION_REQUIRED_TOOLS: &[&str] = &["browser_screenshot"];

/// Mount every tool in this bucket onto `reg`. Idempotent.
///
/// The window-management (`BrowserOpenTool`, `BrowserCloseTool`,
/// `BrowserListWindowsTool`) and low-level (`BrowserGetUrlTool`,
/// `BrowserGetDomTool`, `BrowserInspectElementTool`, `BrowserWaitForTool`,
/// `BrowserEvalTool`) structs remain compiled but unregistered — the IPC layer
/// still calls the underlying manager methods so the human-driven browser tab
/// UI keeps every capability; the agent surface just doesn't advertise them.
pub fn register(reg: &mut ToolRegistry, manager: Arc<BrowserManager>) {
    reg.register(Arc::new(BrowserNavigateTool::new(manager.clone())));
    reg.register(Arc::new(BrowserScreenshotTool::new(manager.clone())));
    reg.register(Arc::new(BrowserGetConsoleLogsTool::new(manager.clone())));
    reg.register(Arc::new(BrowserClickTool::new(manager.clone())));
    reg.register(Arc::new(BrowserFillTool::new(manager.clone())));
    reg.register(Arc::new(BrowserScrollTool::new(manager)));
}

// ---------------------------------------------------------------------------
// Helpers shared by every tool in the bucket
// ---------------------------------------------------------------------------

/// Validate that `label` either looks like a `browser-*` window label
/// the manager owns, or is omitted (we'll synthesise one). Tools accept
/// both `label` and the legacy `windowLabel` key for ergonomics.
fn extract_label(input: &Value) -> Option<String> {
    input
        .get("label")
        .and_then(Value::as_str)
        .or_else(|| input.get("windowLabel").and_then(Value::as_str))
        .map(str::to_string)
}

/// Pick the label the tool should act on. Tries (in order):
///   1. `label` / `windowLabel` from the tool arguments
///   2. The manager's `last_active_label` (last opened or navigated)
///
/// Returns an `InvalidInput` error only when no window has ever been
/// opened — agents that don't track labels still work as long as
/// there is exactly one window open, which is the common case.
fn resolve_label(input: &Value, manager: &BrowserManager) -> Result<String, ToolError> {
    if let Some(label) = extract_label(input) {
        return Ok(label);
    }
    manager.last_active_label().ok_or_else(|| {
        ToolError::InvalidInput(
            "no browser window is open — call browser_open first or pass `label`".into(),
        )
    })
}

fn require_label(input: &Value) -> Result<String, ToolError> {
    extract_label(input).ok_or_else(|| ToolError::InvalidInput("`label` must be a string".into()))
}

fn require_string<'a>(input: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError::InvalidInput(format!("`{key}` must be a non-empty string")))
}

/// Make sure the agent window's right-rail Browser panel exists, then return.
///
/// If its embedded webview is already live, this is a no-op. Otherwise we ask
/// the frontend to open the Browser dock tab (which builds the webview) and poll
/// until it appears — up to ~6 s — so the caller can immediately drive it.
async fn ensure_agent_browser(
    manager: &BrowserManager,
    initial_url: Option<&str>,
) -> Result<(), ToolError> {
    if manager.has_window(AGENT_BROWSER_LABEL) {
        return Ok(());
    }
    manager
        .request_open_agent_browser(initial_url)
        .map_err(ToolError::Execution)?;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if manager.has_window(AGENT_BROWSER_LABEL) {
            return Ok(());
        }
    }
    Err(ToolError::Execution(
        "The agent window's right-rail Browser panel did not open in time. Make sure the agent \
         window is visible, then retry."
            .into(),
    ))
}

fn unwrap_browser_result(result: BrowserResult) -> Result<Value, ToolError> {
    if !result.ok {
        return Err(ToolError::Execution(result.error.unwrap_or_else(|| {
            "browser tool failed without an error message".into()
        })));
    }
    Ok(result.value.unwrap_or(Value::Null))
}

// ---------------------------------------------------------------------------
// Tier 1 — read-only
// ---------------------------------------------------------------------------

pub struct BrowserOpenTool {
    manager: Arc<BrowserManager>,
}
impl BrowserOpenTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserOpenTool {
    fn name(&self) -> &str {
        "browser_open"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_open".into(),
            description: "Open a native browser preview window pointing at `url`. \
                Returns the assigned `label` so subsequent browser_* calls can target it. \
                If `label` is omitted, a fresh `browser-agent-<n>` label is generated."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Initial URL to load (must start with http:// or https://)."},
                    "label": {"type": "string", "description": "Optional explicit window label, must start with 'browser-'."},
                    "title": {"type": "string"},
                    "width": {"type": "number"},
                    "height": {"type": "number"}
                },
                "required": ["url"]
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let url = require_string(&input, "url")?.to_string();
        let label =
            extract_label(&input).unwrap_or_else(|| format!("browser-agent-{}", uuid_short()));
        let opts = CreateBrowserWindow {
            label: label.clone(),
            url: url.clone(),
            title: input
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string),
            width: input.get("width").and_then(Value::as_f64),
            height: input.get("height").and_then(Value::as_f64),
            x: None,
            y: None,
            always_on_top: None,
            embed: None,
        };
        self.manager
            .create_window(opts)
            .map_err(ToolError::Execution)?;
        Ok(json!({ "ok": true, "label": label, "url": url }).to_string())
    }
}

pub struct BrowserCloseTool {
    manager: Arc<BrowserManager>,
}
impl BrowserCloseTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserCloseTool {
    fn name(&self) -> &str {
        "browser_close"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_close".into(),
            description: "Close a browser window opened by the agent. \
                `label` is optional — when omitted, closes the most \
                recently used window."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": { "label": {"type": "string"} },
                "required": []
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let label = resolve_label(&input, &self.manager)?;
        self.manager.close(&label).map_err(ToolError::Execution)?;
        Ok(json!({ "ok": true, "label": label }).to_string())
    }
}

pub struct BrowserListWindowsTool {
    manager: Arc<BrowserManager>,
}
impl BrowserListWindowsTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserListWindowsTool {
    fn name(&self) -> &str {
        "browser_list_windows"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_list_windows".into(),
            description: "List every browser preview window currently open, with its \
                label, URL, and inspector/stagewise state. Call this BEFORE \
                browser_open whenever the task is about a page that might already \
                be open (the user's running dev server, a previous turn's window, a \
                page the user opened via the IDE's '+ Browser' tab). If the URL you \
                want is already in the result, pass that label to browser_navigate / \
                browser_screenshot / browser_click instead of opening a new window."
                .into(),
            input_schema: json!({ "type": "object", "properties": {} }),
        }
    }
    async fn execute(&self, _input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let windows = self.manager.list_windows();
        Ok(json!({ "windows": windows }).to_string())
    }
}

pub struct BrowserGetUrlTool {
    manager: Arc<BrowserManager>,
}
impl BrowserGetUrlTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserGetUrlTool {
    fn name(&self) -> &str {
        "browser_get_url"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_get_url".into(),
            description: "Return the current URL of a browser window — including any \
                in-page navigation the runtime is aware of."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": { "label": {"type": "string"} },
                "required": ["label"]
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let label = require_label(&input)?;
        let url = self
            .manager
            .current_url(&label)
            .map_err(ToolError::Execution)?;
        Ok(json!({ "label": label, "url": url }).to_string())
    }
}

pub struct BrowserGetDomTool {
    manager: Arc<BrowserManager>,
}
impl BrowserGetDomTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserGetDomTool {
    fn name(&self) -> &str {
        "browser_get_dom"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_get_dom".into(),
            description: "Return the outerHTML of the page (or a single CSS selector if \
                provided). Capped at 200 KB to protect the context window."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "selector": {"type": "string", "description": "Optional CSS selector. Omit for full document."}
                },
                "required": ["label"]
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let label = require_label(&input)?;
        let selector = input.get("selector").and_then(Value::as_str);
        let result = self
            .manager
            .get_dom(&label, selector)
            .await
            .map_err(ToolError::Execution)?;
        let value = unwrap_browser_result(result)?;
        Ok(json!({
            "label": label,
            "selector": selector,
            "html": value,
        })
        .to_string())
    }
}

pub struct BrowserInspectElementTool {
    manager: Arc<BrowserManager>,
}
impl BrowserInspectElementTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserInspectElementTool {
    fn name(&self) -> &str {
        "browser_inspect_element"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_inspect_element".into(),
            description: "Inspect a single element by CSS selector. Returns tag, attributes, \
                bounding rect, computed text, visibility, and a small subset of computed \
                styles (display, visibility, opacity, color, background, font-size, \
                font-weight)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "selector": {"type": "string"}
                },
                "required": ["label", "selector"]
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let label = require_label(&input)?;
        let selector = require_string(&input, "selector")?;
        let result = self
            .manager
            .inspect_element(&label, selector)
            .await
            .map_err(ToolError::Execution)?;
        let value = unwrap_browser_result(result)?;
        Ok(json!({ "label": label, "selector": selector, "element": value }).to_string())
    }
}

pub struct BrowserGetConsoleLogsTool {
    manager: Arc<BrowserManager>,
}
impl BrowserGetConsoleLogsTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserGetConsoleLogsTool {
    fn name(&self) -> &str {
        "browser_get_console_logs"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_get_console_logs".into(),
            description: "Read the JS console of the agent window's right-rail Browser panel \
                (rolling buffer, max 500 entries: console.log/info/warn/error/debug + uncaught \
                errors + unhandled promise rejections). Optional `level` filters by severity; \
                `sinceMs` returns only entries newer than this many milliseconds ago."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "level": {"type": "string", "enum": ["log","info","warn","error","debug"]},
                    "sinceMs": {"type": "number", "description": "Drop entries older than this (milliseconds)."}
                },
                "required": []
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;
        let level = input.get("level").and_then(Value::as_str);
        let since = input.get("sinceMs").and_then(Value::as_u64);
        let result = self
            .manager
            .get_console_logs(AGENT_BROWSER_LABEL, level, since)
            .await
            .map_err(ToolError::Execution)?;
        let value = unwrap_browser_result(result)?;
        Ok(json!({ "logs": value }).to_string())
    }
}

pub struct BrowserScreenshotTool {
    manager: Arc<BrowserManager>,
}
impl BrowserScreenshotTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserScreenshotTool {
    fn name(&self) -> &str {
        "browser_screenshot"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_screenshot".into(),
            description: "Capture a PNG screenshot of the agent window's right-rail Browser panel \
                (or a CSS selector within it). The image is returned as a vision content block on \
                the next turn so vision-capable models (Claude, GPT-4V) can SEE the page directly. \
                Useful for debugging visual bugs, verifying UI changes, or confirming a feature \
                works after edits."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "Optional CSS selector — captures just that element. Omit for full <body>."}
                },
                "required": []
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;
        let label = AGENT_BROWSER_LABEL;
        let selector = input.get("selector").and_then(Value::as_str);
        let result = self
            .manager
            .screenshot(label, selector)
            .await
            .map_err(ToolError::Execution)?;
        let value = unwrap_browser_result(result)?;
        let base64 = value
            .get("base64")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Execution("screenshot returned no base64 data".into()))?;
        let media_type = value
            .get("mediaType")
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        let width = value.get("width").and_then(Value::as_u64).unwrap_or(0);
        let height = value.get("height").and_then(Value::as_u64).unwrap_or(0);
        // Absolute path of the on-disk PNG copy (asset-protocol loadable by the
        // tool card). Carried in the header as `src`; the model never sees it
        // (the whole `<aurora_image>` block becomes a vision block), and the UI
        // strip in `conversation.rs` parses it back out for rendering.
        let src_attr = value
            .get("path")
            .and_then(Value::as_str)
            .map(|p| format!(" src=\"{}\"", p.replace('&', "&amp;").replace('"', "&quot;")))
            .unwrap_or_default();
        let url = self.manager.current_url(label).unwrap_or_default();
        // The `<aurora_image …>` marker is the contract with
        // `crate::api::provider_kernel_adapter` — when the tool result
        // is serialised for an Anthropic call, the adapter rewrites
        // this block into a multimodal `image` content block so the
        // model literally sees the page. `width`/`height`/`src` are extra
        // header attributes the adapter ignores (it only reads `media_type`).
        Ok(format!(
            "<aurora_image media_type=\"{mt}\" width=\"{w}\" height=\"{h}\"{src}>{b64}</aurora_image>\nScreenshot of {url}{sel} ({w}×{h} px)",
            mt = media_type,
            b64 = base64,
            src = src_attr,
            url = url,
            sel = selector
                .map(|s| format!(" — selector `{s}`"))
                .unwrap_or_default(),
            w = width,
            h = height,
        ))
    }
}

// ---------------------------------------------------------------------------
// Tier 2 — page interaction (requires permission)
// ---------------------------------------------------------------------------

pub struct BrowserNavigateTool {
    manager: Arc<BrowserManager>,
}
impl BrowserNavigateTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserNavigateTool {
    fn name(&self) -> &str {
        "browser_navigate"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_navigate".into(),
            description: "Open the Browser panel in the agent window's right dock (if it isn't \
                already open) and load `url` in it. This is the agent's ONE browser — a single \
                embedded panel, never a separate window — and this is the tool to start any \
                browser task with. Use it to preview and verify running pages (dev servers, \
                local HTML), then screenshot / click / read console on the same panel."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to load (http:// or https://, or a local dev-server address)."}
                },
                "required": ["url"]
            }),
        }
    }
    fn requires_permission(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let url = require_string(&input, "url")?;
        // Reveal + build the right-rail panel (hinting the URL), then drive it.
        ensure_agent_browser(&self.manager, Some(url)).await?;
        self.manager
            .navigate(AGENT_BROWSER_LABEL, url)
            .map_err(ToolError::Execution)?;
        Ok(json!({ "ok": true, "url": url }).to_string())
    }
}

pub struct BrowserClickTool {
    manager: Arc<BrowserManager>,
}
impl BrowserClickTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserClickTool {
    fn name(&self) -> &str {
        "browser_click"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_click".into(),
            description: "Click the first element matching `selector` in the agent window's \
                right-rail Browser panel. Automatically scrolls it into view and waits up to 4 \
                seconds for it to appear, so most async-rendered buttons don't need a separate \
                wait step."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "selector": {"type": "string"}
                },
                "required": ["selector"]
            }),
        }
    }
    fn requires_permission(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;
        let selector = require_string(&input, "selector")?;
        // Built-in auto-wait: poll for the element for up to 4 seconds
        // before clicking. This subsumes the dropped `browser_wait_for`
        // tool for the 95% case (waiting just before clicking).
        let _ = self
            .manager
            .wait_for(AGENT_BROWSER_LABEL, selector, Some(4_000))
            .await;
        let result = self
            .manager
            .click(AGENT_BROWSER_LABEL, selector)
            .await
            .map_err(ToolError::Execution)?;
        Ok(unwrap_browser_result(result)?.to_string())
    }
}

pub struct BrowserFillTool {
    manager: Arc<BrowserManager>,
}
impl BrowserFillTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserFillTool {
    fn name(&self) -> &str {
        "browser_fill"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_fill".into(),
            description: "In the agent window's right-rail Browser panel, set the value of an \
                input/textarea/contentEditable matching `selector` and dispatch input + change \
                events so frameworks (React, Vue, Svelte, …) react to the change. If `submit` is \
                true and the element is inside a <form>, the form is submitted afterwards."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "value": {"type": "string"},
                    "submit": {"type": "boolean", "default": false}
                },
                "required": ["selector", "value"]
            }),
        }
    }
    fn requires_permission(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;
        let selector = require_string(&input, "selector")?;
        let value = input
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`value` must be a string".into()))?;
        let submit = input
            .get("submit")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let result = self
            .manager
            .fill(AGENT_BROWSER_LABEL, selector, value, submit)
            .await
            .map_err(ToolError::Execution)?;
        Ok(unwrap_browser_result(result)?.to_string())
    }
}

pub struct BrowserWaitForTool {
    manager: Arc<BrowserManager>,
}
impl BrowserWaitForTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserWaitForTool {
    fn name(&self) -> &str {
        "browser_wait_for"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_wait_for".into(),
            description: "Block until `selector` is present and visible (non-zero bounding \
                rect). Returns `{ ok, found, waitedMs }`. `timeoutMs` defaults to 8000, \
                capped at 60000."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "selector": {"type": "string"},
                    "timeoutMs": {"type": "number"}
                },
                "required": ["label", "selector"]
            }),
        }
    }
    fn requires_permission(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let label = require_label(&input)?;
        let selector = require_string(&input, "selector")?;
        let timeout = input.get("timeoutMs").and_then(Value::as_u64);
        let result = self
            .manager
            .wait_for(&label, selector, timeout)
            .await
            .map_err(ToolError::Execution)?;
        Ok(unwrap_browser_result(result)?.to_string())
    }
}

/// Scroll the page in a cardinal direction or bring a specific
/// element into view. Replaces the only legitimate use-case agents
/// had for `browser_eval` — programmatic scrolling — without exposing
/// the broader eval foot-gun.
pub struct BrowserScrollTool {
    manager: Arc<BrowserManager>,
}
impl BrowserScrollTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserScrollTool {
    fn name(&self) -> &str {
        "browser_scroll"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_scroll".into(),
            description: "Scroll the agent window's right-rail Browser panel up, down, to top, to \
                bottom, or until a specific element is visible. Returns the before/after scroll \
                position and whether the page is now at the top/bottom — so a follow-up \
                screenshot isn't needed just to confirm the scroll landed."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "direction": {
                        "type": "string",
                        "enum": ["up", "down", "top", "bottom"],
                        "description": "Vertical scroll direction. Ignored when `selector` is supplied."
                    },
                    "selector": {
                        "type": "string",
                        "description": "CSS selector to scroll into view. Takes priority over `direction`."
                    },
                    "amountPx": {
                        "type": "number",
                        "description": "Pixels for relative scroll (up/down). Defaults to ~80% of the viewport height."
                    }
                },
                "required": []
            }),
        }
    }
    fn requires_permission(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;
        let direction = input.get("direction").and_then(Value::as_str);
        let selector = input.get("selector").and_then(Value::as_str);
        let amount = input
            .get("amountPx")
            .or_else(|| input.get("amount_px"))
            .and_then(Value::as_i64);
        let result = self
            .manager
            .scroll(AGENT_BROWSER_LABEL, direction, selector, amount)
            .await
            .map_err(ToolError::Execution)?;
        let value = unwrap_browser_result(result)?;
        Ok(json!({ "scroll": value }).to_string())
    }
}

// ---------------------------------------------------------------------------
// Compiled-but-unregistered tools (kept for IPC-driven IDE features and
// for completeness; the agent surface no longer advertises them).
// ---------------------------------------------------------------------------

pub struct BrowserEvalTool {
    manager: Arc<BrowserManager>,
}
impl BrowserEvalTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserEvalTool {
    fn name(&self) -> &str {
        "browser_eval"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_eval".into(),
            description: "DANGEROUS — evaluate an arbitrary JS expression in the page and \
                return the JSON-stringified result. The expression runs with full page \
                privileges, so it can read storage, mutate the DOM, call APIs, exfiltrate \
                cookies, etc. Always require explicit user approval — never auto-approve."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "expression": {"type": "string", "description": "JS expression. May be async/return a promise."}
                },
                "required": ["label", "expression"]
            }),
        }
    }
    fn requires_permission(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let label = require_label(&input)?;
        let expression = require_string(&input, "expression")?;
        let result = self
            .manager
            .eval_with_result(&label, expression)
            .await
            .map_err(ToolError::Execution)?;
        let value = unwrap_browser_result(result)?;
        Ok(json!({ "label": label, "value": value }).to_string())
    }
}

fn uuid_short() -> String {
    let raw = uuid::Uuid::new_v4().to_string();
    raw.split('-').next().unwrap_or(&raw).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_name_roster_count() {
        // Six tools: one embedded right-rail browser, no window management.
        assert_eq!(TOOL_NAMES.len(), 6);
    }

    #[test]
    fn dangerous_tools_are_unregistered() {
        // Explicitly assert the foot-gun and now-obsolete window-management
        // tools are not exposed to the agent surface. Catches accidental
        // re-registration.
        for hidden in [
            "browser_open",
            "browser_close",
            "browser_list_windows",
            "browser_eval",
            "browser_get_dom",
            "browser_get_url",
            "browser_inspect_element",
            "browser_wait_for",
        ] {
            assert!(
                !TOOL_NAMES.contains(&hidden),
                "{hidden} must not be advertised to the agent"
            );
        }
    }

    #[test]
    fn permission_required_set_matches_constants() {
        let names: std::collections::HashSet<_> = TOOL_NAMES.iter().copied().collect();
        for &n in TOOLS_REQUIRING_PERMISSION {
            assert!(names.contains(n), "permission tool {n} not in roster");
        }
    }
}
