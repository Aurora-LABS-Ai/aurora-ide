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
//! The roster is [`TOOL_NAMES`]; the permission-gated half is
//! [`TOOLS_REQUIRING_PERMISSION`].
//!
//! `browser_navigate` is the entry point — it opens the right-rail panel and
//! loads a URL. The others operate on whatever the panel is currently showing.
//!
//! `browser_view` / `browser_page_outline` are what make the `selector`-taking
//! tools usable. They are the only way the agent can DISCOVER a selector: a
//! screenshot is pixels, and `browser_inspect_element` needs the selector
//! before it can help. Without them the model could only guess structural
//! paths off an image, which is why every model produced brittle
//! `div > div:nth-of-type(2) > …` chains and then looped retrying them.
//!
//! ## Input is REAL input
//!
//! `browser_click`, `browser_fill`, `browser_type` and `browser_press_key`
//! drive the browser's own input pipeline through the DevTools channel
//! (`input_tools`). Twelve real sessions with `el.click()` measured the cost
//! of the synthetic version: a Radix menu trigger answered `ok: true` twice
//! while never opening (no `pointerdown` was ever dispatched), and 21 of 33
//! fills read as "nothing changed" because a value is not rendered text. A
//! click is now a press at the element's centre, checked first against
//! `elementFromPoint` so an overlay covering the target is reported instead of
//! silently receiving the click. Script-side `el.click()` remains only as the
//! fallback where there is no DevTools channel (macOS / Linux).
//!
//! ## Removed, not merely hidden
//! * `browser_open` / `browser_close` / `browser_list_windows` — window
//!   management is meaningless with exactly one embedded browser.
//! * `browser_get_dom` — burned up to 200 KB of context against an 8 KiB
//!   result clamp, so the model saw a snapshot truncated mid-tag.
//!   `browser_view` covers the reason anyone wanted it (finding a selector) in
//!   a few KB, and `browser_evaluate` can return any slice of the DOM on
//!   request.
//! * `browser_get_url` — folded into every result's `url`.
//!
//! `browser_evaluate` was once removed as "a foot-gun". It is back, gated by
//! the permission gate like every other acting tool, because the alternative
//! was worse: the model with no way to read a store, call a page function or
//! test a selector expression wrote shell scripts to fetch HTML instead.
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
/// Running script in the page and getting the answer back.
mod evaluate_tool;
/// One fill strategy per kind of field, with the value read back.
mod fill;
/// The doctrine text, compiled in.
mod guide;
/// Telling the user when the agent is driving the panel.
mod halo;
/// Real pointer and keyboard input.
mod input_tools;
/// The visible cursor that makes a click look like a click.
mod pointer;
/// Whether anything answers at a URL, asked over HTTP because the WebView
/// cannot be asked at all.
mod reachability;
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
/// Waiting for the page to reach a state, bounded.
mod wait_tools;

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
///
/// Coverage is two passes: the semantic candidate list, then a styled-
/// clickable sweep (`cursor: pointer` roots) for controls built from bare
/// divs/spans. What the scan still cannot see — a listener added by
/// `addEventListener` on an unstyled element — is admitted in the empty-result
/// note rather than silently returned as "no controls".
///
/// Executed under jsdom by `page-outline.test.ts` (frontend), which extracts
/// this constant from the Rust source — keep the `r#"(() => {` framing.
const PAGE_OUTLINE_JS: &str = r#"(() => {
  const LIMIT = __LIMIT__, SCOPE = __SCOPE__, QUERY = __QUERY__;
  const root = SCOPE ? document.querySelector(SCOPE) : document.body;
  if (!root) return null;

  // `a` deliberately without `[href]`: SPAs and mockups routinely style
  // href-less anchors as their nav — requiring href made a whole sidebar
  // invisible to this scan while browser_view showed it (self-test finding,
  // 2026-08-22). `[tabindex]` catches script-driven widgets; -1 is excluded
  // because it means "focusable only by script", not "operable by the user".
  const CAND = 'a,button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="option"],[contenteditable="true"],[data-testid],[onclick],[tabindex]:not([tabindex="-1"])';
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
    // textContent is the fallback for the odd node innerText cannot read
    // (display:contents; and jsdom in the test rig, which has no innerText).
    const t = (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
               el.getAttribute('title') || el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
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

  // Semantic candidates plus the styled-clickable sweep: an element a
  // stylesheet marks `cursor: pointer` is a control the page built out of divs
  // and spans, invisible to any tag/role query. cursor INHERITS, so only the
  // pointer ROOT is taken — the outermost pointer element whose parent is not
  // also pointer — or every child of a clickable card would be listed. A
  // pointer root that already contains a semantic candidate is a wrapper, not
  // a second control.
  const semantic = new Set(root.querySelectorAll(CAND));
  const isPointer = (el) => { try { return getComputedStyle(el).cursor === 'pointer'; } catch (e) { return false; } };
  const candidates = [];
  for (const el of root.querySelectorAll('*')) {
    if (semantic.has(el)) { candidates.push(el); continue; }
    const tag = el.tagName;
    if (tag === 'HTML' || tag === 'BODY') continue;
    if (!isPointer(el)) continue;
    if (el.parentElement && isPointer(el.parentElement)) continue;
    if (el.querySelector(CAND)) continue;
    candidates.push(el);
  }

  const q = QUERY ? QUERY.toLowerCase() : null;
  const out = [];
  let more = 0;
  for (const el of candidates) {
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
  const result = { url: location.href, title: document.title, shown: out.length, more, elements: out };
  if (!out.length) {
    // An empty list with no reason reads as "this page has no controls" and
    // sends the caller off to guess selectors from a screenshot. Say what the
    // scan can see and where to go next instead.
    result.note = q
      ? 'Nothing matched the query filter. Drop `query` to list every control the scan can see.'
      : 'No interactive elements found. The scan sees semantic controls (links, buttons, inputs, ARIA roles, tabindex, onclick) and elements styled clickable (cursor: pointer). If this page builds controls some other way, read it with browser_view and use browser_inspect_element to probe a selector built from its markup.';
  }
  return result;
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
    // Added 2026-09-11 after measuring twelve real sessions: keystroke typing,
    // waiting for a condition, and running script in the page.
    "browser_type",
    "browser_wait_for",
    "browser_evaluate",
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
    "browser_type",
    "browser_evaluate",
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

/// How long any one call may spend driving the panel.
///
/// Every page-side read is already bounded at 30s by
/// `BrowserManager::await_result`, but a single tool call can chain three of
/// them — act, settle, observe — and a WebView showing a dead server takes the
/// full 30s each time because the injected `window.__aurora` helper is not
/// there to answer. Two minutes sits clear of that worst case while still
/// ending a call that would otherwise sit forever.
///
/// Healthy calls land in single-digit seconds, so this is a backstop and not a
/// budget anyone should be tuning. It is deliberately NOT advertised as a
/// `timeout` property on fifteen schemas: a browser action that needs longer
/// than this is broken rather than slow, and the argument would cost tokens on
/// every request to say so. A model that passes `timeout` anyway is still
/// honoured — [`TimeoutPolicy::resolve`] reads the argument whether or not the
/// schema mentions it.
pub const PANEL_TIMEOUT: crate::tools::timeout::TimeoutPolicy =
    crate::tools::timeout::TimeoutPolicy::new(
        120_000,
        5_000,
        300_000,
        "The Browser panel stopped answering. Call `browser_status` to see where it is before          retrying the same action.",
    );

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
    driven(Arc::new(input_tools::BrowserTypeTool::new(manager.clone())));
    driven(Arc::new(wait_tools::BrowserWaitForTool::new(manager.clone())));
    driven(Arc::new(evaluate_tool::BrowserEvaluateTool::new(
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
        if manager.is_visible(AGENT_BROWSER_LABEL) {
            return Ok(());
        }
        // The webview exists but the user is on another dock tab (or a menu
        // is over the panel). Ask the UI to bring the Browser tab forward —
        // the agent is about to drive the page, and the person should see
        // that happen — and give it a moment. Not an error if it stays
        // hidden: the tools still work, screenshots say the frame may be
        // stale, and a modal the user has open must not be fought over.
        manager
            .request_open_agent_browser(initial_url)
            .map_err(ToolError::Execution)?;
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if manager.is_visible(AGENT_BROWSER_LABEL) {
                break;
            }
        }
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
        // A `file://` URL is loaded through Aurora's own scheme, so the page
        // reports `http://aurora-page.localhost/<path>` while the caller keeps
        // saying `file:///<path>`. Both name one file; comparing them raw
        // made every re-navigate to a local page a silent reload reported as
        // `reloaded: false` (aurora-tool-findings.md, 2026-09-11, finding 1).
        let served = crate::services::local_page::to_served_url(url);
        let url = served.as_deref().unwrap_or(url);
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

/// Starts watching for content that appears during an action's settle window.
///
/// A "before" and an "after" snapshot cannot see a toast that lives for one
/// second between them — observed live: a login form showed "enter a valid
/// email" for a moment, every observation tool then reported an unchanged
/// page, and the user had to read the screen to the agent. The observer
/// records the text of everything added (or rewritten) while the action
/// settles; [`TRANSIENT_WATCH_STOP`] then reports what has already vanished
/// again. Idempotent: a fresh start disconnects any previous watch.
const TRANSIENT_WATCH_START: &str = r#"(() => {
  try {
    const prev = window.__auroraTransients;
    if (prev && prev.observer) { try { prev.observer.disconnect(); } catch (e) {} }
    const clip = (t) => (t || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    // innerText is the CSS-aware read; textContent is the fallback for DOM
    // implementations without it (jsdom, where this logic is verified).
    const readText = (el) => clip(el.innerText !== undefined ? el.innerText : el.textContent);
    const state = { records: [], observer: null, readText };
    const note = (el) => {
      if (!el || state.records.length >= 24) return;
      let text = '';
      try { text = readText(el); } catch (e) {}
      if (!text) return;
      state.records.push({ node: el, text });
    };
    state.observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) { if (n.nodeType === 1) note(n); }
        } else if (m.type === 'characterData') {
          if (m.target) note(m.target.parentElement);
        }
      }
    });
    if (document.body) {
      state.observer.observe(document.body, {
        childList: true, subtree: true, characterData: true,
      });
      window.__auroraTransients = state;
      return true;
    }
    return false;
  } catch (e) { return false; }
})()"#;

/// Ends the watch and returns the messages that appeared and are gone again.
///
/// Content still on the page is NOT returned — `text_changed` and `view`
/// already cover it. What comes back is precisely the set nothing else can
/// see: text whose whole life happened inside the settle window.
const TRANSIENT_WATCH_STOP: &str = r#"(() => {
  try {
    const state = window.__auroraTransients;
    window.__auroraTransients = null;
    if (!state) return [];
    try { state.observer.disconnect(); } catch (e) {}
    const seen = new Set();
    const vanished = [];
    for (const r of state.records) {
      if (!r.text || seen.has(r.text)) continue;
      seen.add(r.text);
      let still = false;
      try {
        still = r.node && r.node.isConnected
          && state.readText(r.node).indexOf(r.text) !== -1;
      } catch (e) {}
      if (!still) {
        vanished.push(r.text);
        if (vanished.length >= 8) break;
      }
    }
    return vanished;
  } catch (e) { return []; }
})()"#;

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
    // Best-effort on purpose: a page that refuses the observer (about:blank,
    // mid-navigation) still gets its action; it just cannot report transients.
    let _ = manager
        .eval_with_result(AGENT_BROWSER_LABEL, TRANSIENT_WATCH_START)
        .await;
    let result = action().await?;
    tokio::time::sleep(Duration::from_millis(settle_ms)).await;
    let after = state::snapshot(manager).await;
    // A navigation tears the JS context down along with the observer; the
    // stop call then fails or answers empty, and that is correct — whatever
    // flashed by belonged to the page that no longer exists.
    let transients = match manager
        .eval_with_result(AGENT_BROWSER_LABEL, TRANSIENT_WATCH_STOP)
        .await
    {
        Ok(result) if result.ok => result.value.unwrap_or(Value::Null),
        _ => Value::Null,
    };

    let mut changed = state::change_between(&before, &after);
    if let Some(messages) = transients.as_array().filter(|list| !list.is_empty()) {
        if let Some(map) = changed.as_object_mut() {
            // Named for what it is: text that appeared during the action and
            // was gone again before the page was observed. Toasts live here.
            map.insert("transient_text".into(), json!(messages));
        }
    }

    let mut out = serde_json::Map::new();
    out.insert("result".into(), result);
    out.insert("changed".into(), changed);
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

/// Find the element an action is about to touch, and the point to touch it at.
///
/// Resolves by `selector` or by visible `text`, scrolls the element into view
/// (instantly — a smooth-scrolling page would otherwise still be moving when
/// the pointer lands), takes the centre of its box, and asks the page what is
/// actually painted at that point. The answer is one of:
///
/// - `self` / `descendant` — the element is what a press there would hit.
/// - `ancestor` — the element has `pointer-events: none` or no painted box of
///   its own; the press hits its parent, which is what a person's press would
///   do too. Allowed, and reported.
/// - `covered` — something else is on top: a modal backdrop, a sticky header,
///   a toast, a cookie banner. This is the case that used to produce a click
///   that "registered" on the wrong thing and reported success.
///
/// Text matching: exact (case-insensitive, whitespace-collapsed) first, then
/// prefix, then substring, over the interactive elements a person could
/// press. Two equally good matches is an error that lists them, never a coin
/// toss.
///
/// Executed under jsdom by `locate-target.test.ts` (frontend), which extracts
/// this constant from the Rust source — keep the `r#"(() => {` framing.
const LOCATE_TARGET_JS: &str = r#"(() => {
  const SEL = __SEL__, TEXT = __TEXT__;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const describe = (el) => {
    if (!el || !el.tagName) return null;
    let d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) d += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    const role = el.getAttribute && el.getAttribute('role');
    if (role) d += '[role=' + role + ']';
    const t = norm(el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder')) || el.innerText || el.textContent || (typeof el.value === 'string' ? el.value : '')).slice(0, 60);
    return t ? d + ' "' + t + '"' : d;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };

  let el = null, ambiguous = null;
  if (SEL) {
    el = document.querySelector(SEL);
    if (!el) return { found: false, by: 'selector' };
  } else {
    const CAND = 'a,button,input,select,textarea,summary,label,option,li,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="treeitem"],[onclick],[tabindex]:not([tabindex="-1"])';
    const want = norm(TEXT).toLowerCase();
    const labelOf = (c) => norm(c.getAttribute('aria-label') || (c.tagName === 'INPUT' && (c.type === 'button' || c.type === 'submit') ? c.value : '') || c.innerText || c.textContent || c.getAttribute('title') || c.getAttribute('placeholder')).toLowerCase();
    const exact = [], prefix = [], partial = [];
    for (const c of document.body.querySelectorAll(CAND)) {
      if (!visible(c)) continue;
      const l = labelOf(c);
      if (!l) continue;
      if (l === want) exact.push(c);
      else if (l.startsWith(want)) prefix.push(c);
      else if (l.includes(want)) partial.push(c);
    }
    // A container whose text merely CONTAINS the target text loses to the
    // control inside it that IS the text, or every click on "Save" would
    // land on the form around the button.
    const tighten = (list) => list.filter((c) => !list.some((o) => o !== c && c.contains(o)));
    const pick = tighten(exact).length ? tighten(exact) : tighten(prefix).length ? tighten(prefix) : tighten(partial);
    if (!pick.length) return { found: false, by: 'text' };
    if (pick.length > 1) return { found: true, ambiguous: pick.slice(0, 8).map(describe), by: 'text' };
    el = pick[0];
  }

  try { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); } catch (e) {}
  const r = el.getBoundingClientRect();
  if (!visible(el)) return { found: true, visible: false, description: describe(el) };
  const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
  let hit = null;
  try { hit = document.elementFromPoint(x, y); } catch (e) {}
  // Shadow DOM: elementFromPoint stops at the host. Descend while the host
  // has an open shadow root with something at that point.
  let probe = hit;
  while (probe && probe.shadowRoot && typeof probe.shadowRoot.elementFromPoint === 'function') {
    const inner = probe.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === probe) break;
    probe = inner;
  }
  hit = probe || hit;
  let relation = 'covered';
  if (!hit) relation = 'unknown';
  else if (hit === el) relation = 'self';
  else if (el.contains(hit)) relation = 'descendant';
  else if (hit.contains(el)) relation = 'ancestor';
  else if (el.getRootNode && el.getRootNode() !== document && el.getRootNode().host && hit.contains(el.getRootNode().host)) relation = 'descendant';
  return {
    found: true,
    visible: true,
    x, y,
    tag: el.tagName.toLowerCase(),
    description: describe(el),
    disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
    hit: relation,
    covered_by: relation === 'covered' ? describe(hit) : undefined,
    box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
  };
})()"#;

/// How long [`locate_target`] keeps re-checking a covered or missing target.
///
/// Overlays fade, menus animate shut, and async-rendered buttons arrive late.
/// Retrying briefly turns a race into a wait; the bound keeps a genuinely
/// covered element from stalling the turn.
const LOCATE_POLL_MS: u64 = 150;

/// Resolve the element for an action, retrying up to `wait_ms` while it is
/// missing, invisible, or covered. Returns the page's answer (see
/// [`LOCATE_TARGET_JS`]) once it is actionable, or the most useful error.
pub(super) async fn locate_target(
    manager: &BrowserManager,
    selector: Option<&str>,
    text: Option<&str>,
    wait_ms: u64,
) -> Result<Value, ToolError> {
    let (selector, text) = match (
        selector.map(str::trim).filter(|s| !s.is_empty()),
        text.map(str::trim).filter(|t| !t.is_empty()),
    ) {
        (Some(s), _) => (Some(s), None),
        (None, Some(t)) => (None, Some(t)),
        (None, None) => {
            return Err(ToolError::InvalidInput(
                "give either `selector` (from browser_view) or `text` (the visible label of the \
                 control to act on)."
                    .into(),
            ))
        }
    };
    let script = LOCATE_TARGET_JS
        .replace("__SEL__", &json!(selector).to_string())
        .replace("__TEXT__", &json!(text).to_string());
    let named = selector
        .map(|s| format!("`{s}`"))
        .or_else(|| text.map(|t| format!("text \"{t}\"")))
        .unwrap_or_default();

    let deadline = std::time::Instant::now() + Duration::from_millis(wait_ms);
    let last: Value;
    loop {
        let result = manager
            .eval_with_result(AGENT_BROWSER_LABEL, &script)
            .await
            .map_err(ToolError::Execution)?;
        let current = unwrap_browser_result(result)?;
        let found = current.get("found").and_then(Value::as_bool) == Some(true);
        let visible = current.get("visible").and_then(Value::as_bool) == Some(true);
        let ambiguous = current.get("ambiguous").is_some();
        let covered = current.get("hit").and_then(Value::as_str) == Some("covered");
        let settled = ambiguous || (found && visible && !covered);
        if settled || std::time::Instant::now() >= deadline {
            last = current;
            break;
        }
        tokio::time::sleep(Duration::from_millis(LOCATE_POLL_MS)).await;
    }

    if let Some(list) = last.get("ambiguous").and_then(Value::as_array) {
        let listed: Vec<String> = list
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        return Err(ToolError::Execution(format!(
            "{named} matches {} visible controls: {}. Use a selector from browser_view to say \
             which one.",
            listed.len(),
            listed.join("; ")
        )));
    }
    if last.get("found").and_then(Value::as_bool) != Some(true) {
        return Err(ToolError::Execution(format!(
            "no element matches {named} on the current page (waited {wait_ms}ms). Run \
             browser_view to get selectors that exist on this page, or browser_wait_for if it \
             renders later."
        )));
    }
    if last.get("visible").and_then(Value::as_bool) != Some(true) {
        return Err(ToolError::Execution(format!(
            "{named} exists but is not visible (hidden by CSS or has no size), so it cannot be \
             acted on. If it appears after another action, do that first."
        )));
    }
    if last.get("hit").and_then(Value::as_str) == Some("covered") {
        let cover = last
            .get("covered_by")
            .and_then(Value::as_str)
            .unwrap_or("another element");
        return Err(ToolError::Execution(format!(
            "{named} is covered by {cover} at the point where it would be pressed, so a press \
             would land on that instead. Dismiss it first (browser_press_key Escape, or click \
             its close control) — or, if the covering element is what you meant, click that."
        )));
    }
    Ok(last)
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
            description: "List the interactive elements on the current page — links (with or \
                without href), buttons, inputs, selects, tabs, anything with a role, tabindex, or \
                data-testid, plus elements a stylesheet marks clickable (cursor: pointer) — each \
                with a READY-TO-USE CSS selector verified to match exactly one element, plus its \
                visible text and form state. This is where selectors come from: call it before \
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
                    "scope": {
                        "type": "string",
                        "description": "Same as `selector` — the region to scan. Either spelling works."
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
        // `scope` is browser_view's name for the same thing; models carry it
        // over, and a rejected call for a spelling is a wasted request.
        let scope = input
            .get("selector")
            .or_else(|| input.get("scope"))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty());
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
            description: "Capture what the Browser panel shows, as an image you can see on the \
                next turn. Default: the viewport, exactly as the user sees it. `selector`: just \
                that element, cropped from the real frame after scrolling it into view — works \
                for fixed and portalled elements like dialogs. `full_page: true`: the whole \
                document top to bottom in one image (downscaled to fit, so use the viewport \
                capture for detail). This is the only tool that answers visual questions — \
                spacing, alignment, colour, overflow, whether something rendered at all."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "Optional CSS selector — captures just that element. Omit for the viewport."},
                    "full_page": {"type": "boolean", "description": "Capture the entire scrollable page, not just the viewport. Ignored when `selector` is given. Default false."}
                },
                "required": []
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;
        let label = AGENT_BROWSER_LABEL;
        let selector = input
            .get("selector")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let full_page = selector.is_none()
            && input.get("full_page").and_then(Value::as_bool) == Some(true);
        // Take Aurora's own cursor out of the page first. The capture
        // photographs the real webview surface, so anything Aurora drew in
        // there would come back looking like something the SITE rendered — in
        // the one job where that is least acceptable.
        let _ = self
            .manager
            .eval_with_result(label, &pointer::hide_expr())
            .await;
        let result = if full_page {
            self.manager.screenshot_full_page(label).await
        } else {
            self.manager.screenshot(label, selector).await
        }
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
            .map(|p| format!(" src=\"{}\"", crate::api::aurora_image::escape_attr(p)))
            .unwrap_or_default();
        // Read the URL from the PAGE, not from Aurora's record of where it sent
        // the page. A click that followed a link is a navigation Aurora never
        // performed, so the recorded URL still names the previous route and the
        // caption would attribute this picture to it — the one failure a visual
        // regression audit cannot survive.
        let url = self.manager.live_url(label).await.unwrap_or_default();
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

        let page_note = value
            .get("note")
            .and_then(Value::as_str)
            .map(|n| format!("\n\n{n}"))
            .unwrap_or_default();
        Ok(format!(
            "<aurora_image media_type=\"{mt}\" width=\"{w}\" height=\"{h}\"{src}>{b64}</aurora_image>\nScreenshot of {url}{sel}{scope} ({w}×{h} px){page_note}{note}",
            mt = media_type,
            b64 = base64,
            src = src_attr,
            url = url,
            sel = selector
                .map(|s| format!(" — selector `{s}`"))
                .unwrap_or_default(),
            scope = if full_page { " — full page" } else { "" },
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
when you have changed the source and genuinely need a fresh load.

The address is checked before the panel is driven. If nothing is listening the call FAILS and \
names the address, so a stopped dev server is never mistaken for a loaded page; if the server \
answers, its `http_status` comes back with the result and a 4xx/5xx is reported rather than \
treated as a failure."
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

        // Does anything answer at this address? Asked BEFORE the shortcut
        // below and before the panel is driven. Page reads now go through the
        // DevTools channel, which answers on WebView2's own error page as
        // readily as on a real one — so "the page answered a moment ago" no
        // longer proves anything about the server. Only the probe does, and
        // against localhost it costs about a millisecond. See `reachability`.
        let reach = reachability::probe(url).await;

        // The shortcut, and the condition that makes it honest.
        //
        // `already_there` alone used to be Aurora citing its own previous visit
        // as proof the page was fine, when the previous visit was the one that
        // failed. The probe is what turns it into evidence: something is
        // listening there right now, so what the panel shows is that server's
        // page and not the browser's error document.
        if already_there && !force_reload && !reach.is_unreachable() {
            // Deliberately does NOT reload. A reload here throws away scroll
            // position, form state and SPA route — invisibly, while reporting
            // success — for a page that was already the one asked for.
            return Ok(json!({
                "ok": true,
                "url": url,
                "already_there": true,
                "reloaded": false,
                "note": "The panel was already on this page, so it was left as it is. Pass `reload: true` to force a fresh load.",
                "state": state::presentable(before),
            })
            .to_string());
        }

        // Reveal + build the right-rail panel (hinting the URL), then drive it.
        ensure_agent_browser(&self.manager, Some(url)).await?;
        // The document that is there NOW, so the load wait below can tell a
        // new document from the old one still answering — the only way a
        // same-URL reload is distinguishable from "nothing happened yet".
        let previous_document = document_origin(&self.manager).await;
        self.manager
            .navigate(AGENT_BROWSER_LABEL, url)
            .map_err(ToolError::Execution)?;

        if let reachability::Reach::Unreachable { reason } = &reach {
            // The navigate above already ran, on purpose. The user is watching
            // this panel; leaving it on the old page while reporting a failure
            // would hide the very state being described. The error page IS the
            // honest picture, and the model gets told not to read it.
            return Err(ToolError::Execution(format!(
                "{url} did not load: {reason}. The Browser panel is showing its error page, not \
                 your app, so nothing on it is worth inspecting. Start whatever serves this \
                 address, then navigate again."
            )));
        }

        // Wait for the NEW document to finish loading, bounded, then settle.
        // A flat 350ms pause used to be the whole wait, so on any real app the
        // snapshot said `loading` and the next screenshot was a blank page
        // read as a broken one.
        let load = wait_for_load(&self.manager, previous_document).await;
        let after = settled_state(&self.manager).await;
        let status = http_status(&reach);
        Ok(json!({
            "ok": true,
            "url": url,
            "panel_was_already_open": was_open,
            "already_there": already_there,
            "reloaded": already_there && force_reload,
            "load_ms": load.waited_ms,
            "load_complete": load.complete,
            "load_note": (!load.complete).then(|| format!(
                "The page had not finished loading after {}ms (readyState {}). It may still \
                 be rendering — browser_wait_for a selector or text you expect before reading \
                 it.",
                load.waited_ms, load.ready_state
            )),
            // The server answered — with what, is the model's call. A 404 on a
            // route you are debugging is the answer you came for; a 500 you did
            // not expect is worth knowing before you start reading the DOM.
            "http_status": status,
            "note": status
                .filter(|code| *code >= 400)
                .map(|code| format!(
                    "The server answered {code}. The page below is whatever it serves for that \
                     status, which may not be your app."
                )),
            "state": state::presentable(after),
        })
        .to_string())
    }
}

/// How long `browser_navigate` waits for the new document to finish loading.
///
/// Generous for a dev server doing a cold compile, short enough that a page
/// which never settles (a long-polling spinner) is reported as still loading
/// rather than waited on forever.
const LOAD_TIMEOUT_MS: u64 = 10_000;

/// A page's `performance.timeOrigin`: the instant its document was created.
///
/// Strictly increases with every navigation, including a reload of the same
/// URL — which URL and readyState cannot tell apart from "the old page is
/// still here". `None` when nothing answered (no page, an error page).
async fn document_origin(manager: &BrowserManager) -> Option<f64> {
    manager
        .eval_with_result(AGENT_BROWSER_LABEL, "performance.timeOrigin")
        .await
        .ok()
        .filter(|r| r.ok)
        .and_then(|r| r.value)
        .and_then(|v| v.as_f64())
}

struct LoadWait {
    waited_ms: u64,
    complete: bool,
    ready_state: String,
}

/// Wait until a document NEWER than `previous` reports `readyState complete`.
///
/// A read that fails is the old page being torn down or the new one not yet
/// scriptable; both mean "keep waiting". `about:blank` is never accepted as
/// the destination — it is what the panel shows before its first real load.
async fn wait_for_load(manager: &BrowserManager, previous: Option<f64>) -> LoadWait {
    let started = std::time::Instant::now();
    let deadline = started + Duration::from_millis(LOAD_TIMEOUT_MS);
    let mut ready_state = "unknown".to_string();
    loop {
        if let Ok(result) = manager
            .eval_with_result(
                AGENT_BROWSER_LABEL,
                "({ url: location.href, ready: document.readyState, origin: performance.timeOrigin })",
            )
            .await
        {
            if result.ok {
                let value = result.value.unwrap_or(Value::Null);
                let origin = value.get("origin").and_then(Value::as_f64).unwrap_or(0.0);
                let url = value.get("url").and_then(Value::as_str).unwrap_or("");
                ready_state = value
                    .get("ready")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let is_new_document = previous.is_none_or(|p| origin > p + 0.5);
                if is_new_document && !url.starts_with("about:") && ready_state == "complete" {
                    return LoadWait {
                        waited_ms: started.elapsed().as_millis() as u64,
                        complete: true,
                        ready_state,
                    };
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return LoadWait {
                waited_ms: started.elapsed().as_millis() as u64,
                complete: false,
                ready_state,
            };
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The status the probe saw, when it ran at all.
fn http_status(reach: &reachability::Reach) -> Option<u16> {
    match reach {
        reachability::Reach::Answered { status } => Some(*status),
        _ => None,
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
            description: "Click an element in the Browser panel with a REAL pointer press — the \
                browser dispatches pointerdown, mousedown, focus, pointerup, mouseup and click, \
                exactly as a person's click does, so menus, dropdowns, tabs and switches built \
                on pointer events open. Name the target by `selector` (from browser_view) or by \
                its visible `text` (\"Save\", \"Log in\"). Scrolls it into view, waits up to 4 \
                seconds for it to appear, and checks what is actually painted at the press point: \
                if a modal, banner or sticky bar covers it, the call FAILS and names the covering \
                element instead of clicking that. Returns what changed afterwards."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": with_observation(json!({
                    "selector": {"type": "string", "description": "CSS selector of the element to click. Get one from browser_view."},
                    "text": {"type": "string", "description": "Alternative to `selector`: the visible text of the button, link, tab or menu item to click. Exact match wins; two equal matches is an error that lists them."},
                    "button": {"type": "string", "enum": ["left", "right", "middle"], "description": "Mouse button. Default left. Use right for a context menu."},
                    "double": {"type": "boolean", "description": "Double-click instead of a single click. Default false."}
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
        let selector = input.get("selector").and_then(Value::as_str);
        let text = input.get("text").and_then(Value::as_str);
        let button = input_tools::MouseButton::parse(input.get("button").and_then(Value::as_str))?;
        let click_count = if input.get("double").and_then(Value::as_bool) == Some(true) {
            2
        } else {
            1
        };

        let manager = self.manager.clone();
        let (selector, text) = (selector.map(str::to_string), text.map(str::to_string));
        // Everything from locating onward runs INSIDE the observed action, so
        // the "before" snapshot is taken before the target is scrolled into
        // view. Located first and observed second, the scroll a click performs
        // to reach a below-the-fold element vanished from `changed` — three
        // clicks that moved the page 0→710 reported it standing still
        // (aurora-tool-findings.md, 2026-09-11, finding 3).
        let changed = act_and_observe(&self.manager, &input, || async move {
            // Where is it, is it visible, and is it actually the thing painted
            // at its own centre. Waits up to 4s for an async-rendered control,
            // which covers the common "click right after navigate" case.
            let located =
                locate_target(&manager, selector.as_deref(), text.as_deref(), 4_000).await?;
            let description = located
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("element")
                .to_string();
            if located.get("disabled").and_then(Value::as_bool) == Some(true) {
                return Err(ToolError::Execution(format!(
                    "{description} is disabled, so a click would do nothing. Whatever enables \
                     it has not happened yet."
                )));
            }
            let x = located.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let y = located.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            let hit = located
                .get("hit")
                .and_then(Value::as_str)
                .unwrap_or("self")
                .to_string();

            // Draw the cursor onto the target and press, so the user watching
            // the panel sees a click happen instead of the page silently
            // changing. Its result is ignored on purpose: a pointer that could
            // not be drawn must never be the reason a click does not run.
            let _ = manager
                .eval_with_result(AGENT_BROWSER_LABEL, &pointer::point_at_xy_expr(x, y, true))
                .await;

            let method = if manager.devtools_available() {
                input_tools::real_click_at(&manager, x, y, button, click_count).await?;
                "real_pointer"
            } else {
                // No DevTools channel on this platform: the best available is
                // the page-side click on whatever is painted at the point.
                let expr = format!(
                    "(() => {{ const el = document.elementFromPoint({x}, {y}); \
                     if (!el) throw new Error('nothing at the click point'); el.click(); \
                     return true; }})()"
                );
                let result = manager
                    .eval_with_result(AGENT_BROWSER_LABEL, &expr)
                    .await
                    .map_err(ToolError::Execution)?;
                unwrap_browser_result(result)?;
                "synthetic_click"
            };
            let mut result = json!({
                "ok": true,
                "clicked": description,
                "at": { "x": x.round() as i64, "y": y.round() as i64 },
                "method": method,
            });
            if hit == "ancestor" {
                result["note"] = json!(
                    "The element itself is not what is painted at its centre (it has no box of \
                     its own or pointer-events: none), so the press landed on its parent — the \
                     same place a person's press would land."
                );
            }
            if method == "synthetic_click" {
                result["note"] = json!(
                    "No DevTools channel on this platform, so this was a script click (a `click` \
                     event only). Components that open on pointer-down may not react."
                );
            }
            Ok(result)
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
            description: "Set a form field's value in the Browser panel and read it back. Text \
                inputs, textareas and rich-text editors are focused with a real click, cleared, \
                and the value is typed through the browser's input pipeline, so React, Vue, \
                Svelte, Lexical, ProseMirror and every input/beforeinput listener see a real \
                edit. A <select> is set by option value or visible text; a checkbox or radio \
                takes \"true\"/\"false\"; date, time, colour and range inputs are set directly. \
                The result carries `value_after` — what the field actually holds now — so a \
                masked or formatted field cannot silently disagree with what was sent. `submit: \
                true` submits the enclosing form afterwards (or presses Enter when there is no \
                form). To append keystrokes without clearing, or to drive an autocomplete, use \
                browser_type."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": with_observation(json!({
                    "selector": {"type": "string", "description": "CSS selector of the field. Get one from browser_view."},
                    "value": {"type": "string", "description": "The value to set. For a checkbox or radio: \"true\" or \"false\". For a select: an option's value or its visible text."},
                    "submit": {"type": "boolean", "description": "Submit the field's form afterwards (press Enter when it has no form). Default false."}
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
        let selector = require_string(&input, "selector")?.to_string();
        let value = input
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`value` must be a string".into()))?
            .to_string();
        let submit = input
            .get("submit")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let manager = self.manager.clone();
        // `submit: true` is the case that most needs this: it can navigate, it
        // can fail validation, and it can silently do nothing — three outcomes
        // that returned the same string.
        let changed = act_and_observe(&self.manager, &input, || async move {
            fill::fill_field(&manager, &selector, &value, submit).await
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

    /// A local file is loaded through `aurora-page`, so the page names itself
    /// by the served URL while the caller keeps the `file://` one. Both are
    /// one page, or every re-navigate to a local file is a silent reload.
    #[cfg(windows)]
    #[test]
    fn a_file_url_and_its_served_form_are_the_same_page() {
        assert!(same_page(
            "file:///E:/proj/fixture.html",
            "http://aurora-page.localhost/E:/proj/fixture.html"
        ));
        assert!(same_page(
            "file:///E:/proj/fixture.html#top",
            "http://aurora-page.localhost/E:/proj/fixture.html#top"
        ));
        assert!(!same_page(
            "file:///E:/proj/fixture.html",
            "http://aurora-page.localhost/E:/proj/other.html"
        ));
    }

    #[test]
    fn a_trailing_slash_does_not_make_a_different_page_but_a_fragment_does() {
        assert!(same_page("http://x/settings", "http://x/settings/"));
        assert!(!same_page("http://x/#a", "http://x/#b"));
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
