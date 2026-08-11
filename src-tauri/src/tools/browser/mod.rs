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

/// Accessibility-tree inspection (engine-computed, not DOM-derived).
mod a11y_tools;
/// Viewport and media emulation.
mod devtools_tools;
/// The doctrine text, compiled in.
mod guide;
/// Telling the user when the agent is driving the panel.
mod halo;
/// The visible cursor that makes a click look like a click.
mod pointer;
/// Real pointer and keyboard input.
mod input_tools;
/// Where the panel is, and what an action changed.
///
/// `pub(crate)` for one reason: `BrowserManager::navigate` drops the browser's
/// emulation overrides, and it has to drop Aurora's RECORD of them in the same
/// breath. When it didn't, a navigation left `browser_status` reporting a
/// viewport override that no longer existed and screenshots carrying a warning
/// about it — the tools describing a state the browser had already left.
pub(crate) mod state;
/// What is on screen, with verified selectors.
mod view;

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
/// → `a[href]` → tag + class — and when the element itself has no stable hook
/// (radios, tabs, repeated rows), a `:nth-of-type` child chain anchored to the
/// nearest uniquely-addressable ancestor (or `body`). Every candidate is
/// confirmed to match exactly one node via `querySelectorAll` before being
/// emitted; `null` remains only for elements nothing could address, because an
/// UNVERIFIED plausible-but-wrong selector is worse than an admitted gap. The
/// anchored chains are position-based, so they are correct for this render but
/// may go stale after a re-render — re-scan rather than reuse them across
/// navigations.
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

  const baseFor = (el) => {
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
    return null;
  };

  const selectorFor = (el) => {
    const direct = baseFor(el);
    if (direct) return direct;
    // No stable hook on the element itself (the common case for radios, tabs
    // and repeated rows). Walk up to the nearest uniquely-addressable ancestor
    // — or body — building a `>` chain of :nth-of-type steps down to the
    // element. Verified against querySelectorAll like every other candidate,
    // so what is emitted matches exactly one node in THIS render.
    let chain = '', node = el;
    for (let depth = 0; depth < 6 && node.parentElement; depth++) {
      const p = node.parentElement;
      const tag = node.tagName.toLowerCase();
      const sibs = Array.from(p.children).filter((c) => c.tagName === node.tagName);
      const step = sibs.length > 1 ? tag + ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')' : tag;
      chain = ' > ' + step + chain;
      const anchor = p === document.body ? 'body' : baseFor(p);
      if (anchor) {
        const s = anchor + chain;
        if (unique(s)) return s;
      }
      node = p;
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
    "browser_guidelines",
    "browser_status",
    "browser_navigate",
    "browser_view",
    "browser_screenshot",
    "browser_get_console_logs",
    "browser_page_outline",
    "browser_inspect_element",
    "browser_click",
    "browser_fill",
    "browser_scroll",
    // QA tools — driven through the DevTools channel rather than injected
    // script, because none of these can be done from inside the page.
    "browser_set_viewport",
    "browser_emulate_media",
    "browser_press_key",
    "browser_hover",
    "browser_a11y_tree",
];

/// Tools that opt into the Phase 4 permission gate.
pub const TOOLS_REQUIRING_PERMISSION: &[&str] = &[
    "browser_navigate",
    "browser_click",
    "browser_fill",
    "browser_scroll",
    "browser_set_viewport",
    "browser_emulate_media",
    "browser_press_key",
    "browser_hover",
    "browser_a11y_tree",
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
/// The rules the tools cannot enforce for themselves.
///
/// Registered inside this bucket rather than beside `design_guidelines`, so it
/// disappears with the rest when browser tools are switched off — a guide to
/// tools the model does not have is pure tax.
pub struct BrowserGuidelinesTool;

#[async_trait]
impl ToolExecutor for BrowserGuidelinesTool {
    fn name(&self) -> &str {
        "browser_guidelines"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_guidelines".into(),
            description: "Load the rules for driving Aurora's Browser panel. Call this BEFORE \
your first browser tool call in a conversation.

It covers the mistakes the tools cannot prevent on their own, all of which fail SILENTLY: \
guessing a CSS selector that matches the wrong element (the click then succeeds on the wrong \
thing), mistaking a sticky viewport override for a layout bug, re-navigating to a page already \
on screen and losing its state, and reading a viewport-scoped answer as if it covered the whole \
page."
                .into(),
            input_schema: json!({ "type": "object", "properties": {} }),
        }
    }
    async fn execute(&self, _input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        Ok(guide::BROWSER_GUIDE.to_string())
    }
}

pub fn register(reg: &mut ToolRegistry, manager: Arc<BrowserManager>) {
    // First, and NOT wrapped below: it returns compiled-in text and never
    // touches the panel, so raising the driving cue for it would be a lie in
    // the cheap direction — the indicator flashing while nothing happens.
    // Registration order is the advertised order and part of every request's
    // cacheable prefix (see `tools::register_builtin_tools`), so it stays here
    // rather than moving to the end for tidiness.
    reg.register(Arc::new(BrowserGuidelinesTool));

    // Everything that actually touches the panel goes on through `driven`,
    // which raises the panel's "agent is driving" cue for the length of the
    // call. See `halo` for why it is a wrapper and not sixteen call sites.
    let driven = |tool: Arc<dyn ToolExecutor>| {
        reg.register(halo::Driven::wrap(tool, manager.clone()));
    };

    driven(Arc::new(state::BrowserStatusTool::new(manager.clone())));
    driven(Arc::new(view::BrowserViewTool::new(manager.clone())));
    driven(Arc::new(BrowserNavigateTool::new(manager.clone())));
    driven(Arc::new(BrowserScreenshotTool::new(manager.clone())));
    driven(Arc::new(BrowserGetConsoleLogsTool::new(manager.clone())));
    driven(Arc::new(BrowserPageOutlineTool::new(manager.clone())));
    driven(Arc::new(BrowserInspectElementTool::new(manager.clone())));
    driven(Arc::new(BrowserClickTool::new(manager.clone())));
    driven(Arc::new(BrowserFillTool::new(manager.clone())));
    driven(Arc::new(BrowserScrollTool::new(manager.clone())));
    // QA tools. Everything below drives the BROWSER rather than the page, so
    // none of it can be built on script injection — see `services::
    // browser_devtools` for why the script versions silently report success.
    driven(Arc::new(devtools_tools::BrowserSetViewportTool::new(
        manager.clone(),
    )));
    driven(Arc::new(devtools_tools::BrowserEmulateMediaTool::new(
        manager.clone(),
    )));
    driven(Arc::new(input_tools::BrowserPressKeyTool::new(
        manager.clone(),
    )));
    driven(Arc::new(input_tools::BrowserHoverTool::new(
        manager.clone(),
    )));
    driven(Arc::new(a11y_tools::BrowserAccessibilityTreeTool::new(
        manager.clone(),
    )));
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

/// Do these two URLs address the same page?
///
/// Compared after trimming a trailing slash, because `/settings` and
/// `/settings/` are one page to everyone except a string comparison — and
/// treating them as different reintroduces the needless reload this exists to
/// prevent. The fragment is kept: `#section` is a different place on an anchor
/// page and an entirely different route under a hash router.
fn same_page(a: &str, b: &str) -> bool {
    let normalize = |url: &str| {
        let url = url.trim();
        let (head, fragment) = match url.split_once('#') {
            Some((head, fragment)) => (head, Some(fragment)),
            None => (url, None),
        };
        let head = head.strip_suffix('/').unwrap_or(head);
        match fragment {
            Some(fragment) => format!("{head}#{fragment}"),
            None => head.to_string(),
        }
    };
    normalize(a) == normalize(b)
}

/// Read the page once it has had a moment to react.
///
/// A click that triggers a route change, a fetch, or a re-render has not
/// finished when the call returns — snapshotting immediately reports the page
/// as it was, which is worse than not reporting it, because it looks like an
/// answer. This is a settle pause, not a wait-for: it never blocks a turn for
/// long, and a slow page simply shows up as still-loading in `ready_state`.
async fn settled_state(manager: &BrowserManager) -> Value {
    tokio::time::sleep(Duration::from_millis(350)).await;
    state::snapshot(manager).await
}

/// Ceiling on the settle pause an action may request.
///
/// Long enough for a route change or a fetch to land, short enough that a
/// mistaken `settle_ms: 30000` cannot hold a turn hostage. A page slower than
/// this shows up honestly as `ready_state: "loading"` rather than being waited
/// out.
const MAX_SETTLE_MS: u64 = 5_000;
const DEFAULT_SETTLE_MS: u64 = 350;

/// The shared tail of every acting tool: `act → settle → observe`.
///
/// Without this, "scroll, then look" is two tool calls and two round trips
/// through the model — and the model has to remember to make the second one.
/// The result of an action should already contain the state it produced, the
/// same way qg-probe re-dumps its tree after every input.
///
/// `see` decides how much looking is worth it:
/// - `"none"` — the change summary only. Cheapest, and right when you already
///   know what the action does.
/// - `"view"` — plus the visible elements and their verified selectors, so the
///   next action can be chosen from this same result.
///
/// `{"ok":true}` on its own cannot distinguish a click that navigated, a click
/// that threw, and a click that hit nothing. All three used to return the same
/// string.
async fn act_and_observe<F, Fut>(
    manager: &BrowserManager,
    input: &Value,
    action: F,
) -> Result<Value, ToolError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, ToolError>>,
{
    let settle_ms = input
        .get("settle_ms")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SETTLE_MS)
        .min(MAX_SETTLE_MS);
    let see = input.get("see").and_then(Value::as_str).unwrap_or("none");

    let before = state::snapshot(manager).await;
    let result = action().await?;
    tokio::time::sleep(Duration::from_millis(settle_ms)).await;
    let after = state::snapshot(manager).await;

    let mut out = serde_json::Map::new();
    out.insert("result".into(), result);
    out.insert(
        "changed".into(),
        state::change_between(&before, &after),
    );
    out.insert(
        "url".into(),
        after.get("url").cloned().unwrap_or(Value::Null),
    );

    if see == "view" {
        let scope = input
            .get("region")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty());
        out.insert("view".into(), view::read(manager, scope, true).await);
    }

    Ok(Value::Object(out))
}

/// The `see` / `settle_ms` / `region` properties, identical on every acting
/// tool so the model learns them once.
fn observation_properties() -> Value {
    json!({
        "see": {
            "type": "string",
            "enum": ["none", "view"],
            "description": "What to return once the page has settled. \"view\" adds the visible elements and their verified CSS selectors, so you can choose the next action from this same result instead of calling browser_view separately. Default \"none\"."
        },
        "settle_ms": {
            "type": "number",
            "description": "How long to let the page react before observing, in milliseconds. Default 350, maximum 5000. Raise it for a route change or a slow fetch; a page still loading is reported as such rather than waited out."
        },
        "region": {
            "type": "string",
            "description": "With see: \"view\", a CSS selector to scope the observation to — the panel or list you changed, rather than the whole viewport."
        }
    })
}

/// Merge the observation properties into a tool's own property map.
fn with_observation(mut properties: Value) -> Value {
    if let (Some(target), Value::Object(extra)) =
        (properties.as_object_mut(), observation_properties())
    {
        for (key, value) in extra {
            target.insert(key, value);
        }
    }
    properties
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
        // Take Aurora's own cursor out of the page first. The capture
        // photographs the real webview surface, so anything Aurora drew in
        // there would come back looking like something the SITE rendered — in
        // the one job where that is least acceptable.
        let _ = self
            .manager
            .eval_with_result(label, &pointer::hide_expr())
            .await;
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
        // Under an override the panel now draws a device FRAME sized to the
        // emulation, so the capture is the page and nothing else — no band of
        // blank panel to mistake for a hole in the layout. What still has to be
        // said is that the width is not the real one: an override survives into
        // later turns, and a desktop layout judged at 390px is judged wrong.
        let emulation_note = match state::emulation() {
            None => String::new(),
            Some(e) => format!(
                "\n\nNOTE: this is an EMULATED {w}×{h}{mobile} viewport, not the real panel size. \
                 The image is the device frame only. The override stays until you clear it with \
                 `browser_set_viewport {{reset: true}}` — do that before judging a desktop layout.",
                w = e.width as i64,
                h = e.height as i64,
                mobile = if e.mobile { " (mobile)" } else { "" },
            ),
        };

        Ok(format!(
            "<aurora_image media_type=\"{mt}\" width=\"{w}\" height=\"{h}\"{src}>{b64}</aurora_image>\nScreenshot of {url}{sel} ({w}×{h} px){note}",
            mt = media_type,
            b64 = base64,
            src = src_attr,
            url = url,
            sel = selector
                .map(|s| format!(" — selector `{s}`"))
                .unwrap_or_default(),
            w = width,
            h = height,
            note = emulation_note,
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
                embedded panel, never a separate window.

The panel PERSISTS across turns, and the user opens it themselves too. If it is already showing \
the page you want, a navigate costs a reload: state is lost, forms clear, and a SPA route resets. \
Check `browser_status` first, or pass `reload: false` (the default) — this tool will report \
`already_there` and leave the page alone rather than reloading it silently. Pass `reload: true` \
when you have changed the source and genuinely need a fresh load."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to load (http:// or https://, or a local dev-server address)."},
                    "reload": {
                        "type": "boolean",
                        "description": "Reload even when the panel is already on this URL. Default false."
                    }
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
        let force_reload = input
            .get("reload")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // Was it already open, and on what? Read BEFORE touching anything —
        // afterwards there is no way to tell "I opened this" from "it was
        // already here", and that difference is exactly what the agent kept
        // burning a turn to rediscover.
        let was_open = self.manager.has_window(AGENT_BROWSER_LABEL);
        let before = if was_open {
            state::snapshot(&self.manager).await
        } else {
            Value::Null
        };
        let already_there = before
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|current| same_page(current, url));

        if already_there && !force_reload {
            // Deliberately does NOT reload. A reload here throws away scroll
            // position, form state and SPA route — invisibly, while reporting
            // success — for a page that was already the one asked for.
            return Ok(json!({
                "ok": true,
                "url": url,
                "already_there": true,
                "reloaded": false,
                "note": "The panel was already on this page, so it was left as it is. Pass `reload: true` to force a fresh load.",
                "state": before,
            })
            .to_string());
        }

        // Reveal + build the right-rail panel (hinting the URL), then drive it.
        ensure_agent_browser(&self.manager, Some(url)).await?;
        self.manager
            .navigate(AGENT_BROWSER_LABEL, url)
            .map_err(ToolError::Execution)?;

        let after = settled_state(&self.manager).await;
        Ok(json!({
            "ok": true,
            "url": url,
            "panel_was_already_open": was_open,
            "already_there": already_there,
            "reloaded": already_there && force_reload,
            "state": after,
        })
        .to_string())
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
                "properties": with_observation(json!({
                    "selector": {"type": "string"}
                })),
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
        // Draw the cursor onto the target and press, so the user watching the
        // panel sees a click happen instead of the page silently changing. Its
        // result is ignored on purpose: a pointer that could not be drawn must
        // never be the reason a click does not run.
        let _ = self
            .manager
            .eval_with_result(
                AGENT_BROWSER_LABEL,
                &pointer::point_at_selector_expr(selector, true),
            )
            .await;
        let manager = self.manager.clone();
        let selector = selector.to_string();
        let changed = act_and_observe(&self.manager, &input, || async move {
            let result = manager
                .click(AGENT_BROWSER_LABEL, &selector)
                .await
                .map_err(ToolError::Execution)?;
            unwrap_browser_result(result)
        })
        .await?;
        Ok(changed.to_string())
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
                "properties": with_observation(json!({
                    "selector": {"type": "string"},
                    "value": {"type": "string"},
                    "submit": {"type": "boolean", "default": false}
                })),
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
        // Point at the field, but no ripple: nothing is being clicked, and a
        // press animation would show an interaction that did not happen.
        let _ = self
            .manager
            .eval_with_result(
                AGENT_BROWSER_LABEL,
                &pointer::point_at_selector_expr(selector, false),
            )
            .await;
        let manager = self.manager.clone();
        let (selector, value) = (selector.to_string(), value.to_string());
        // `submit: true` is the case that most needs this: it can navigate, it
        // can fail validation, and it can silently do nothing — three outcomes
        // that returned the same string.
        let changed = act_and_observe(&self.manager, &input, || async move {
            let result = manager
                .fill(AGENT_BROWSER_LABEL, &selector, &value, submit)
                .await
                .map_err(ToolError::Execution)?;
            unwrap_browser_result(result)
        })
        .await?;
        Ok(changed.to_string())
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
                "properties": with_observation(json!({
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
                })),
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
        // Scroll is the action most often followed by "now look" — it exists
        // precisely to change what is on screen — so it routes through the same
        // act-settle-observe tail as click and fill.
        let manager = self.manager.clone();
        let (direction, selector) = (direction.map(str::to_string), selector.map(str::to_string));
        let changed = act_and_observe(&self.manager, &input, || async move {
            let result = manager
                .scroll(
                    AGENT_BROWSER_LABEL,
                    direction.as_deref(),
                    selector.as_deref(),
                    amount,
                )
                .await
                .map_err(ToolError::Execution)?;
            unwrap_browser_result(result)
        })
        .await?;
        Ok(changed.to_string())
    }
}

// ---------------------------------------------------------------------------
// Compiled-but-unregistered tools (kept for IPC-driven IDE features and
// for completeness; the agent surface no longer advertises them).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A name in the permission list that no tool answers to is a gate on
    /// nothing — it reads as protection while the tool runs unprompted.
    #[test]
    fn every_permission_gated_name_is_a_real_tool() {
        for name in TOOLS_REQUIRING_PERMISSION {
            assert!(
                TOOL_NAMES.contains(name),
                "{name} is permission-gated but is not a registered browser tool"
            );
        }
    }

    /// The roster is what the model is advertised; a duplicate would ship the
    /// same tool twice and a stale entry would advertise one that cannot run.
    #[test]
    fn the_browser_roster_has_no_duplicates() {
        let mut seen = std::collections::HashSet::new();
        for name in TOOL_NAMES {
            assert!(seen.insert(*name), "{name} appears twice in TOOL_NAMES");
        }
    }

    /// Every QA tool added for design/accessibility auditing is gated. They
    /// drive real input and change how the page renders, so none of them is a
    /// read-only observation the way a screenshot is.
    #[test]
    fn the_qa_tools_are_all_permission_gated() {
        for name in [
            "browser_set_viewport",
            "browser_emulate_media",
            "browser_press_key",
            "browser_hover",
            "browser_a11y_tree",
        ] {
            assert!(TOOL_NAMES.contains(&name), "{name} missing from the roster");
            assert!(
                TOOLS_REQUIRING_PERMISSION.contains(&name),
                "{name} must be permission-gated"
            );
        }
    }
}
