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
//! Eight tools:
//! * **Read-only** (`requires_permission == false`): `browser_screenshot`,
//!   `browser_get_console_logs`, `browser_page_outline`,
//!   `browser_inspect_element`.
//! * **Page interaction** (`requires_permission == true`): `browser_navigate`,
//!   `browser_click`, `browser_fill`, `browser_scroll`.
//!
//! `browser_navigate` is the entry point — it opens the right-rail panel and
//! loads a URL. The others operate on whatever the panel is currently showing.
//!
//! `browser_page_outline` is what makes the `selector`-taking tools usable. It
//! is the only way the agent can DISCOVER a selector: a screenshot is pixels,
//! and `browser_inspect_element` needs the selector before it can help. Without
//! it the model could only guess structural paths off an image, which is why
//! every model produced brittle `div > div:nth-of-type(2) > …` chains and then
//! looped retrying them.
//!
//! Removed, not merely hidden:
//! * `browser_open` / `browser_close` / `browser_list_windows` — window
//!   management is meaningless with exactly one embedded browser.
//! * `browser_eval` — arbitrary JS in the page is a foot-gun. `BrowserManager`
//!   still uses eval internally to implement the other tools.
//! * `browser_get_dom` — burned up to 200 KB of context against an 8 KiB
//!   result clamp (`conversation.rs::MAX_TOOL_RESULT_LENGTH`), so the model saw
//!   a snapshot truncated mid-tag. `browser_page_outline` covers the reason
//!   anyone wanted it (finding a selector) in a few KB.
//! * `browser_get_url`, `browser_wait_for` — folded into the tools that need
//!   them (`browser_click` auto-waits, etc.).
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
use crate::services::browser_runtime::{BrowserManager, BrowserResult};

/// The one browser the agent drives: the agent window's right-dock panel.
const AGENT_BROWSER_LABEL: &str = "browser-agentwin";

/// Page-outline scan. Collects the elements an agent can actually ACT on and
/// derives a *stable, verified-unique* CSS selector for each.
///
/// This exists because every other page tool takes a `selector` the model has
/// no way to obtain: a screenshot is pixels, and `browser_inspect_element`
/// needs the answer before it can help. Without this the model can only invent
/// structural paths off a picture — the
/// `div#root > div > div:nth-of-type(2) > main > …` guesses that fail on any
/// re-render, then get retried with another guess.
///
/// Selector priority is deliberate: `#id` → `data-testid`/`name`/`aria-label`
/// → `a[href]` → tag + class → an id-anchored `:nth-of-type` — and every
/// candidate is confirmed to match exactly one node via `querySelectorAll`
/// before being emitted. An element with no stable selector reports `null`
/// rather than a fragile path, because a plausible-but-wrong selector is worse
/// than an admitted gap: it sends the model down a retry loop.
///
/// Framework-generated class names (`css-`, `sc-`, `ng-`) are skipped — they
/// change on every build, so a selector built from one is stale immediately.
const PAGE_OUTLINE_JS: &str = r#"(() => {
  const LIMIT = __LIMIT__, SCOPE = __SCOPE__, QUERY = __QUERY__;
  const root = SCOPE ? document.querySelector(SCOPE) : document.body;
  if (!root) return null;

  const CAND = 'a[href],button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="option"],[contenteditable="true"],[data-testid],[onclick]';
  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/[^\w-]/g, '\\$&');
  const attr = (v) => '"' + String(v).replace(/["\\]/g, '\\$&') + '"';
  const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch (e) { return false; } };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };

  const selectorFor = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && unique('#' + esc(el.id))) return '#' + esc(el.id);
    for (const a of ['data-testid', 'data-test-id', 'data-test', 'name', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v) { const s = tag + '[' + a + '=' + attr(v) + ']'; if (unique(s)) return s; }
    }
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) { const s = 'a[href=' + attr(href) + ']'; if (unique(s)) return s; }
    }
    const cls = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).filter((c) => c && c.length < 30 && !/^(css-|sc-|ng-)/.test(c)).slice(0, 2)
      : [];
    if (cls.length) { const s = tag + '.' + cls.map(esc).join('.'); if (unique(s)) return s; }
    const p = el.parentElement;
    if (p && p.id) {
      const sibs = Array.from(p.children).filter((c) => c.tagName === el.tagName);
      const s = '#' + esc(p.id) + ' > ' + tag + ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
      if (unique(s)) return s;
    }
    return null;
  };

  const labelOf = (el) => {
    const t = (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
               el.getAttribute('title') || el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
    return t.length > 60 ? t.slice(0, 60) + '\u2026' : t;
  };

  const stateOf = (el) => {
    const bits = [], tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.type) bits.push('type=' + el.type);
      if (el.type === 'checkbox' || el.type === 'radio') bits.push(el.checked ? 'checked' : 'unchecked');
      else if (el.value) bits.push('value=' + attr(String(el.value).slice(0, 30)));
      if (el.required) bits.push('required');
    }
    if (el.disabled) bits.push('disabled');
    const role = el.getAttribute('role');
    if (role) bits.push('role=' + role);
    return bits.join(' ');
  };

  const q = QUERY ? QUERY.toLowerCase() : null;
  const out = [];
  let more = 0;
  for (const el of root.querySelectorAll(CAND)) {
    if (!visible(el)) continue;
    const text = labelOf(el);
    if (q && !(text.toLowerCase().includes(q) || (el.id || '').toLowerCase().includes(q))) continue;
    if (out.length >= LIMIT) { more++; continue; }
    const row = { tag: el.tagName.toLowerCase(), selector: selectorFor(el) };
    if (text) row.text = text;
    const st = stateOf(el);
    if (st) row.state = st;
    out.push(row);
  }
  return { url: location.href, title: document.title, shown: out.length, more, elements: out };
})()"#;

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
    "browser_page_outline",
    "browser_inspect_element",
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
/// Every tool defined in this module is registered — there is no
/// compiled-but-unadvertised tier any more. The window-management and
/// low-level structs that used to sit here unregistered
/// (`BrowserOpenTool`, `BrowserCloseTool`, `BrowserListWindowsTool`,
/// `BrowserGetUrlTool`, `BrowserGetDomTool`, `BrowserWaitForTool`,
/// `BrowserEvalTool`) were deleted along with the standalone browser
/// window they addressed: they resolved a `label`, and there is now exactly
/// one browser, addressed by [`AGENT_BROWSER_LABEL`].
pub fn register(reg: &mut ToolRegistry, manager: Arc<BrowserManager>) {
    reg.register(Arc::new(BrowserNavigateTool::new(manager.clone())));
    reg.register(Arc::new(BrowserScreenshotTool::new(manager.clone())));
    reg.register(Arc::new(BrowserGetConsoleLogsTool::new(manager.clone())));
    reg.register(Arc::new(BrowserPageOutlineTool::new(manager.clone())));
    reg.register(Arc::new(BrowserInspectElementTool::new(manager.clone())));
    reg.register(Arc::new(BrowserClickTool::new(manager.clone())));
    reg.register(Arc::new(BrowserFillTool::new(manager.clone())));
    reg.register(Arc::new(BrowserScrollTool::new(manager)));
}

// ---------------------------------------------------------------------------
// Helpers shared by every tool in the bucket
// ---------------------------------------------------------------------------

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
            description: "Read the current state of one element in the agent browser by CSS \
                selector. Returns exact text, attributes, form value/checked/selected/disabled \
                state, visibility, bounds, and key computed styles. Read-only and bounded."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                        "description": "CSS selector for the element to inspect."
                    }
                },
                "required": ["selector"]
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let selector = require_string(&input, "selector")?;
        ensure_agent_browser(&self.manager, None).await?;
        let result = self
            .manager
            .inspect_element(AGENT_BROWSER_LABEL, selector)
            .await
            .map_err(ToolError::Execution)?;
        let value = unwrap_browser_result(result)?;
        if value.is_null() {
            return Err(ToolError::Execution(format!(
                "No element matches `{selector}` in the current page. Inspect the latest UI and retry with a current CSS selector."
            )));
        }
        Ok(json!({ "selector": selector, "element": value }).to_string())
    }
}

pub struct BrowserPageOutlineTool {
    manager: Arc<BrowserManager>,
}
impl BrowserPageOutlineTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserPageOutlineTool {
    fn name(&self) -> &str {
        "browser_page_outline"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_page_outline".into(),
            description: "List the interactive elements on the current page — links, buttons, \
                inputs, selects, tabs, and anything with a role or data-testid — each with a \
                READY-TO-USE CSS selector verified to match exactly one element, plus its visible \
                text and form state. This is where selectors come from: call it before \
                browser_click / browser_fill / browser_inspect_element instead of guessing a \
                selector from a screenshot. Read-only and bounded (no raw DOM dump)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                        "description": "Optional CSS selector to scope the scan to one region (e.g. `main`, `#sidebar`). Omit to scan the whole page."
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional case-insensitive filter on the element's visible text or id — e.g. `save` to find the Save button."
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum elements to return (default 60, max 200). Any beyond this are reported as a `more` count."
                    }
                },
                "required": []
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;
        let scope = input.get("selector").and_then(Value::as_str);
        let query = input.get("query").and_then(Value::as_str);
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(60)
            .clamp(1, 200);

        // `replace` rather than `format!` — the script is mostly braces, and
        // escaping every one of them for a format string is how a working
        // selector scanner turns into an unreadable one.
        let script = PAGE_OUTLINE_JS
            .replace("__LIMIT__", &limit.to_string())
            .replace("__SCOPE__", &json!(scope).to_string())
            .replace("__QUERY__", &json!(query).to_string());

        let result = self
            .manager
            .eval_with_result(AGENT_BROWSER_LABEL, &script)
            .await
            .map_err(ToolError::Execution)?;
        let value = unwrap_browser_result(result)?;
        if value.is_null() {
            return Err(ToolError::Execution(format!(
                "No element matches the scope selector `{}` — outline nothing to scan. Omit \
                 `selector` to scan the whole page.",
                scope.unwrap_or("")
            )));
        }
        Ok(value.to_string())
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
            .map(|p| {
                format!(
                    " src=\"{}\"",
                    p.replace('&', "&amp;").replace('"', "&quot;")
                )
            })
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
