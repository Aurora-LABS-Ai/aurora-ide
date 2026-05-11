//! Browser tools bucket — Phase 6.
//!
//! 13 native [`ToolExecutor`] impls that drive a Tauri WebView via the
//! [`crate::services::browser_runtime::BrowserManager`]. Tiered by
//! risk:
//!
//! * **Tier 1 (read-only, `requires_permission == false`)**:
//!   `browser_open`, `browser_close`, `browser_list_windows`,
//!   `browser_get_url`, `browser_get_dom`, `browser_inspect_element`,
//!   `browser_get_console_logs`, `browser_screenshot`.
//! * **Tier 2 (page interaction, `requires_permission == true`)**:
//!   `browser_navigate`, `browser_click`, `browser_fill`,
//!   `browser_wait_for`.
//! * **Tier 3 (powerful, `requires_permission == true`)**:
//!   `browser_eval`.
//!
//! `browser_close`'s `requires_permission` is `false` by design — it
//! *destroys* a window the agent itself opened, so leaving it gated
//! would force a permission prompt on every cleanup at the end of an
//! agent loop.
//!
//! `browser_screenshot` returns a structured string containing an
//! `<aurora_image media_type="image/png">BASE64</aurora_image>` marker
//! that the Anthropic API adapter rewrites into a vision content
//! block on the next turn so the model can actually *see* the page.
//! Other providers strip the marker and keep the textual caption.

#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};
use crate::services::browser_runtime::{BrowserManager, BrowserResult, CreateBrowserWindow};

/// Names of every tool this bucket registers, in roster order. Pinned
/// by the bucket-level test below.
pub const TOOL_NAMES: &[&str] = &[
    "browser_open",
    "browser_close",
    "browser_list_windows",
    "browser_get_url",
    "browser_get_dom",
    "browser_inspect_element",
    "browser_get_console_logs",
    "browser_screenshot",
    "browser_navigate",
    "browser_click",
    "browser_fill",
    "browser_wait_for",
    "browser_eval",
];

/// Tools that opt into the Phase 4 permission gate.
pub const TOOLS_REQUIRING_PERMISSION: &[&str] = &[
    "browser_navigate",
    "browser_click",
    "browser_fill",
    "browser_wait_for",
    "browser_eval",
];

/// Mount every tool in this bucket onto `reg`. Idempotent.
pub fn register(reg: &mut ToolRegistry, manager: Arc<BrowserManager>) {
    reg.register(Arc::new(BrowserOpenTool::new(manager.clone())));
    reg.register(Arc::new(BrowserCloseTool::new(manager.clone())));
    reg.register(Arc::new(BrowserListWindowsTool::new(manager.clone())));
    reg.register(Arc::new(BrowserGetUrlTool::new(manager.clone())));
    reg.register(Arc::new(BrowserGetDomTool::new(manager.clone())));
    reg.register(Arc::new(BrowserInspectElementTool::new(manager.clone())));
    reg.register(Arc::new(BrowserGetConsoleLogsTool::new(manager.clone())));
    reg.register(Arc::new(BrowserScreenshotTool::new(manager.clone())));
    reg.register(Arc::new(BrowserNavigateTool::new(manager.clone())));
    reg.register(Arc::new(BrowserClickTool::new(manager.clone())));
    reg.register(Arc::new(BrowserFillTool::new(manager.clone())));
    reg.register(Arc::new(BrowserWaitForTool::new(manager.clone())));
    reg.register(Arc::new(BrowserEvalTool::new(manager)));
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

fn unwrap_browser_result(result: BrowserResult) -> Result<Value, ToolError> {
    if !result.ok {
        return Err(ToolError::Execution(
            result
                .error
                .unwrap_or_else(|| "browser tool failed without an error message".into()),
        ));
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
    fn name(&self) -> &str { "browser_open" }
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
        let label = extract_label(&input)
            .unwrap_or_else(|| format!("browser-agent-{}", uuid_short()));
        let opts = CreateBrowserWindow {
            label: label.clone(),
            url: url.clone(),
            title: input.get("title").and_then(Value::as_str).map(str::to_string),
            width: input.get("width").and_then(Value::as_f64),
            height: input.get("height").and_then(Value::as_f64),
            x: None,
            y: None,
            always_on_top: None,
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
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserCloseTool {
    fn name(&self) -> &str { "browser_close" }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_close".into(),
            description: "Close a browser window opened by the agent. Cleans up state and \
                emits aurora:browser-window-closed to the IDE.".into(),
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
        self.manager.close(&label).map_err(ToolError::Execution)?;
        Ok(json!({ "ok": true, "label": label }).to_string())
    }
}

pub struct BrowserListWindowsTool {
    manager: Arc<BrowserManager>,
}
impl BrowserListWindowsTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserListWindowsTool {
    fn name(&self) -> &str { "browser_list_windows" }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_list_windows".into(),
            description: "List every browser preview window currently open, with its label, \
                URL, and inspector/stagewise state.".into(),
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
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserGetUrlTool {
    fn name(&self) -> &str { "browser_get_url" }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_get_url".into(),
            description: "Return the current URL of a browser window — including any \
                in-page navigation the runtime is aware of.".into(),
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
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserGetDomTool {
    fn name(&self) -> &str { "browser_get_dom" }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_get_dom".into(),
            description: "Return the outerHTML of the page (or a single CSS selector if \
                provided). Capped at 200 KB to protect the context window.".into(),
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
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserInspectElementTool {
    fn name(&self) -> &str { "browser_inspect_element" }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_inspect_element".into(),
            description: "Inspect a single element by CSS selector. Returns tag, attributes, \
                bounding rect, computed text, visibility, and a small subset of computed \
                styles (display, visibility, opacity, color, background, font-size, \
                font-weight).".into(),
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
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserGetConsoleLogsTool {
    fn name(&self) -> &str { "browser_get_console_logs" }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_get_console_logs".into(),
            description: "Read the rolling JS console buffer (max 500 entries, includes \
                console.log/info/warn/error/debug + uncaught errors + unhandled promise \
                rejections). Optional `level` filters by severity; `sinceMs` returns only \
                entries newer than this many milliseconds ago.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "level": {"type": "string", "enum": ["log","info","warn","error","debug"]},
                    "sinceMs": {"type": "number", "description": "Drop entries older than this (milliseconds)."}
                },
                "required": ["label"]
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let label = require_label(&input)?;
        let level = input.get("level").and_then(Value::as_str);
        let since = input.get("sinceMs").and_then(Value::as_u64);
        let result = self
            .manager
            .get_console_logs(&label, level, since)
            .await
            .map_err(ToolError::Execution)?;
        let value = unwrap_browser_result(result)?;
        Ok(json!({ "label": label, "logs": value }).to_string())
    }
}

pub struct BrowserScreenshotTool {
    manager: Arc<BrowserManager>,
}
impl BrowserScreenshotTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserScreenshotTool {
    fn name(&self) -> &str { "browser_screenshot" }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_screenshot".into(),
            description: "Capture a PNG screenshot of the page (or a CSS selector). The \
                image is returned as a vision content block on the next turn so \
                vision-capable models (Claude, GPT-4V) can SEE the page directly. Useful \
                for debugging visual bugs, verifying UI changes, or confirming a feature \
                works after edits.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "selector": {"type": "string", "description": "Optional CSS selector — captures just that element. Omit for full <body>."}
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
            .screenshot(&label, selector)
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
        let url = self.manager.current_url(&label).unwrap_or_default();
        // The `<aurora_image …>` marker is the contract with
        // `crate::api::provider_kernel_adapter` — when the tool result
        // is serialised for an Anthropic call, the adapter rewrites
        // this block into a multimodal `image` content block so the
        // model literally sees the page.
        Ok(format!(
            "<aurora_image media_type=\"{mt}\">{b64}</aurora_image>\nScreenshot of {url}{sel} ({w}×{h} px)",
            mt = media_type,
            b64 = base64,
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
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserNavigateTool {
    fn name(&self) -> &str { "browser_navigate" }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_navigate".into(),
            description: "Drive an existing browser window to a new URL.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "url": {"type": "string"}
                },
                "required": ["label", "url"]
            }),
        }
    }
    fn requires_permission(&self) -> bool { true }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let label = require_label(&input)?;
        let url = require_string(&input, "url")?;
        self.manager
            .navigate(&label, url)
            .map_err(ToolError::Execution)?;
        Ok(json!({ "ok": true, "label": label, "url": url }).to_string())
    }
}

pub struct BrowserClickTool {
    manager: Arc<BrowserManager>,
}
impl BrowserClickTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserClickTool {
    fn name(&self) -> &str { "browser_click" }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_click".into(),
            description: "Click the first element matching `selector`. Scrolls it into \
                view first. Errors if no element matches.".into(),
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
    fn requires_permission(&self) -> bool { true }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let label = require_label(&input)?;
        let selector = require_string(&input, "selector")?;
        let result = self
            .manager
            .click(&label, selector)
            .await
            .map_err(ToolError::Execution)?;
        Ok(unwrap_browser_result(result)?.to_string())
    }
}

pub struct BrowserFillTool {
    manager: Arc<BrowserManager>,
}
impl BrowserFillTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserFillTool {
    fn name(&self) -> &str { "browser_fill" }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_fill".into(),
            description: "Set the value of an input/textarea/contentEditable matching \
                `selector` and dispatch input + change events so frameworks (React, Vue, \
                Svelte, …) react to the change. If `submit` is true and the element is \
                inside a <form>, the form is submitted afterwards.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "selector": {"type": "string"},
                    "value": {"type": "string"},
                    "submit": {"type": "boolean", "default": false}
                },
                "required": ["label", "selector", "value"]
            }),
        }
    }
    fn requires_permission(&self) -> bool { true }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let label = require_label(&input)?;
        let selector = require_string(&input, "selector")?;
        let value = input
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`value` must be a string".into()))?;
        let submit = input.get("submit").and_then(Value::as_bool).unwrap_or(false);
        let result = self
            .manager
            .fill(&label, selector, value, submit)
            .await
            .map_err(ToolError::Execution)?;
        Ok(unwrap_browser_result(result)?.to_string())
    }
}

pub struct BrowserWaitForTool {
    manager: Arc<BrowserManager>,
}
impl BrowserWaitForTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserWaitForTool {
    fn name(&self) -> &str { "browser_wait_for" }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_wait_for".into(),
            description: "Block until `selector` is present and visible (non-zero bounding \
                rect). Returns `{ ok, found, waitedMs }`. `timeoutMs` defaults to 8000, \
                capped at 60000.".into(),
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
    fn requires_permission(&self) -> bool { true }
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

// ---------------------------------------------------------------------------
// Tier 3 — eval (requires permission, dangerous)
// ---------------------------------------------------------------------------

pub struct BrowserEvalTool {
    manager: Arc<BrowserManager>,
}
impl BrowserEvalTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self { Self { manager } }
}
#[async_trait]
impl ToolExecutor for BrowserEvalTool {
    fn name(&self) -> &str { "browser_eval" }
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
    fn requires_permission(&self) -> bool { true }
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
        assert_eq!(TOOL_NAMES.len(), 13);
    }

    #[test]
    fn permission_required_set_matches_constants() {
        let names: std::collections::HashSet<_> =
            TOOL_NAMES.iter().copied().collect();
        for &n in TOOLS_REQUIRING_PERMISSION {
            assert!(names.contains(n), "permission tool {n} not in roster");
        }
    }
}
