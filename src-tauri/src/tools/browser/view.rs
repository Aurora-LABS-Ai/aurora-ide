//! `browser_view` — what is on screen right now, with selectors that work.
//!
//! The gap this closes is selector guessing. Every acting tool takes a CSS
//! selector, and until now the agent had to invent one from source it had read
//! — which fails whenever the framework rewrote the class, the component
//! rendered a wrapper, or the source on disk is not the source in the browser.
//! A guessed selector that matches nothing produces a failed click, and a
//! guessed selector that matches the WRONG element produces something worse: a
//! click that succeeds on the wrong thing.
//!
//! So this returns elements the page HAS, each with a selector generated from
//! the live DOM and verified unique before it is handed over. The agent stops
//! inventing selectors and starts choosing from real ones.
//!
//! Second half: **the viewport is the default scope.** A full-page dump answers
//! "what exists"; when you are checking a layout you built, the question is
//! "what does someone actually SEE" — and those differ by everything below the
//! fold, everything in a collapsed panel, and everything a modal is covering.
//! The result also states the view range (`showing 0–812 of 3400`) so the agent
//! knows how much of the page it is NOT looking at, instead of quietly assuming
//! it saw all of it.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::services::browser_runtime::BrowserManager;

use super::AGENT_BROWSER_LABEL;

/// Hard ceiling on returned elements.
///
/// A design-system page can hold thousands of nodes. The cap is stated in the
/// result when it bites, because a silently truncated list is one the agent
/// treats as complete — the same class of lie as a failed call rendering green.
const MAX_ELEMENTS: usize = 120;

/// The page-side reader.
///
/// Selector generation order is deliberate, cheapest-and-most-stable first:
/// `id` → `data-testid` → `name` → a scoped path with `nth-of-type`. Every
/// candidate is verified with `querySelectorAll(...).length === 1` against the
/// live document before it is returned, so a selector that comes out of here
/// resolves to exactly the element described. Anything that cannot be made
/// unique is returned WITHOUT a selector rather than with a wrong one.
fn reader_expr(scope: &str, viewport_only: bool, include_text: bool, query: &str) -> String {
    format!(
        r#"(() => {{
  const SCOPE = {scope};
  const VIEWPORT_ONLY = {viewport_only};
  const WITH_TEXT = {include_text};
  const QUERY = {query};
  const MAX = {max};

  const root = SCOPE ? document.querySelector(SCOPE) : document.body;
  if (!root) return {{ error: 'no element matches ' + SCOPE }};

  const cssEscape = (v) => (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const unique = (sel) => {{
    try {{ return sel && document.querySelectorAll(sel).length === 1; }} catch (e) {{ return false; }}
  }};

  // Walk up from the element building a path, stopping as soon as the path is
  // unique. Short selectors are both cheaper to carry and less brittle than a
  // full root-to-leaf chain.
  const selectorFor = (el) => {{
    if (el.id && unique('#' + cssEscape(el.id))) return '#' + cssEscape(el.id);
    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'name', 'aria-label']) {{
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) {{
        const sel = el.tagName.toLowerCase() + '[' + attr + '="' + v.replace(/"/g, '\\"') + '"]';
        if (unique(sel)) return sel;
      }}
    }}
    let path = '';
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {{
      let step = node.tagName.toLowerCase();
      if (node.id) {{
        step = '#' + cssEscape(node.id);
        path = path ? step + ' > ' + path : step;
        if (unique(path)) return path;
        break;
      }}
      const parent = node.parentElement;
      if (parent) {{
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) step += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }}
      path = path ? step + ' > ' + path : step;
      if (unique(path)) return path;
      node = parent;
    }}
    return unique(path) ? path : null;
  }};

  const vw = window.innerWidth, vh = window.innerHeight;
  const visible = (el, r) => {{
    if (r.width <= 0 || r.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    if (VIEWPORT_ONLY && (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw)) return false;
    return true;
  }};

  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[onclick],[tabindex]';
  const LANDMARK = 'h1,h2,h3,h4,h5,h6,[role=dialog],[role=alert],[role=navigation],[role=main],form,label';

  const out = [];
  let seen = 0, skipped = 0;
  const q = QUERY ? String(QUERY).toLowerCase() : null;
  for (const el of root.querySelectorAll(INTERACTIVE + ',' + LANDMARK)) {{
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) {{ skipped++; continue; }}

    const tag = el.tagName.toLowerCase();
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder')
      || (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')).slice(0, 80);
    if (q && !(label.toLowerCase().includes(q) || (el.id || '').toLowerCase().includes(q)
      || (typeof el.value === 'string' && el.value.toLowerCase().includes(q)))) continue;
    seen++;
    if (out.length >= MAX) continue;

    const item = {{
      tag,
      selector: selectorFor(el),
      label: label || null,
      // Rounded: sub-pixel layout noise is not information, and these numbers
      // exist to be reasoned about ("that button is off the right edge").
      box: {{ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }},
    }};
    const role = el.getAttribute('role');
    if (role) item.role = role;
    if (el.disabled) item.disabled = true;
    if (typeof el.value === 'string' && el.value) item.value = el.value.slice(0, 120);
    if (el.checked === true) item.checked = true;
    if (tag === 'a' && el.getAttribute('href')) item.href = el.getAttribute('href');
    if (!item.selector) item.selector_note = 'no unique selector — act on a parent or use its text';
    if (WITH_TEXT && label.length >= 80) item.label_truncated = true;
    out.push(item);
  }}

  const scroller = document.scrollingElement || document.documentElement;
  const pageHeight = scroller ? scroller.scrollHeight : vh;
  return {{
    url: location.href,
    title: document.title || null,
    scope: SCOPE || 'body',
    query: QUERY || undefined,
    viewport_only: VIEWPORT_ONLY,
    viewport: {{ width: vw, height: vh }},
    // What this ANSWER covers, not what the viewport does. A whole-page scan
    // used to report the viewport's range beside elements it had returned
    // from past that range — a 42% claim next to a hit at Y 2357
    // (aurora-tool-findings.md, 2026-09-11, finding 4).
    view_range: VIEWPORT_ONLY ? {{
      from_y: Math.round(window.scrollY),
      to_y: Math.round(window.scrollY + vh),
      page_height: Math.round(pageHeight),
      // The honest headline: what fraction of the page this answer covers.
      covers_percent: pageHeight > 0 ? Math.min(100, Math.round((vh / pageHeight) * 100)) : 100,
    }} : {{
      from_y: 0,
      to_y: Math.round(pageHeight),
      page_height: Math.round(pageHeight),
      covers_percent: 100,
    }},
    elements: out,
    element_count: out.length,
    matched_total: seen,
    hidden_or_offscreen: skipped,
    truncated: seen > out.length,
  }};
}})()"#,
        scope = scope,
        viewport_only = viewport_only,
        include_text = include_text,
        query = query,
        max = MAX_ELEMENTS,
    )
}

/// Read the visible elements, for a caller that already has a `BrowserManager`.
///
/// Shared with the acting tools so `see: "view"` returns byte-identical shape to
/// a standalone `browser_view` call — two spellings of the same answer is how a
/// model learns to distrust one of them.
///
/// Errors resolve to a note rather than failing the action: the click already
/// happened, and losing its result because the follow-up read stumbled would be
/// the worst of both.
pub async fn read(manager: &BrowserManager, scope: Option<&str>, viewport_only: bool) -> Value {
    read_filtered(manager, scope, viewport_only, None).await
}

/// [`read`], narrowed to elements whose label, id or value contains `query`.
pub async fn read_filtered(
    manager: &BrowserManager,
    scope: Option<&str>,
    viewport_only: bool,
    query: Option<&str>,
) -> Value {
    let scope_arg = match scope {
        Some(s) => json!(s).to_string(),
        None => "null".to_string(),
    };
    let query_arg = match query.map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => json!(q).to_string(),
        None => "null".to_string(),
    };
    match manager
        .eval_with_result(
            AGENT_BROWSER_LABEL,
            &reader_expr(&scope_arg, viewport_only, true, &query_arg),
        )
        .await
    {
        Ok(result) if result.ok => result.value.unwrap_or(Value::Null),
        Ok(result) => json!({
            "note": result.error.unwrap_or_else(|| "the page did not respond".into())
        }),
        Err(error) => json!({ "note": error }),
    }
}

pub struct BrowserViewTool {
    manager: Arc<BrowserManager>,
}

impl BrowserViewTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}

#[async_trait]
impl ToolExecutor for BrowserViewTool {
    fn name(&self) -> &str {
        "browser_view"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_view".into(),
            description: "What is on screen in the Browser panel right now: every visible \
interactive element and heading, each with a CSS selector generated from the live DOM and \
verified to match exactly one element.

Use this INSTEAD OF guessing selectors from source. A selector you invent from a component file \
can miss (the framework rewrote the class) or hit the wrong node (a wrapper renders the same \
markup twice) — and a click on the wrong element succeeds, so you will not find out. Every \
selector this returns is checked against the live page before you get it.

Defaults to the VIEWPORT — what a person actually sees. That is the right scope for checking a \
layout you just built. Pass `viewport_only: false` for the whole page, or `scope` to narrow to \
one container. The result states its view range and what percentage of the page it covers, so you \
can tell how much you are NOT looking at.

Text and structure only. For how it LOOKS — spacing, alignment, colour, overflow — use \
`browser_screenshot`."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "description": "CSS selector to look inside. Omit for the whole page."
                    },
                    "selector": {
                        "type": "string",
                        "description": "Same as `scope`. Either spelling works."
                    },
                    "query": {
                        "type": "string",
                        "description": "Case-insensitive filter on an element's visible text, id or value — e.g. `save` to find the Save button."
                    },
                    "viewport_only": {
                        "type": "boolean",
                        "description": "Only elements currently in view. Default true."
                    }
                }
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        super::ensure_agent_browser(&self.manager, None).await?;

        let viewport_only = input
            .get("viewport_only")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        let value = read_filtered(
            &self.manager,
            input
                .get("scope")
                .or_else(|| input.get("selector"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty()),
            viewport_only,
            input.get("query").and_then(Value::as_str),
        )
        .await;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return Err(ToolError::Execution(format!(
                "{error}. Call `browser_view` with no `scope` to see what the page actually contains."
            )));
        }
        Ok(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_returned_selector_is_verified_unique_before_it_is_handed_over() {
        // The whole value of this tool. A selector that matches two elements is
        // worse than none: the click succeeds, on the wrong thing, silently.
        let js = reader_expr("null", true, true, "null");
        assert!(js.contains("querySelectorAll(sel).length === 1"));
        assert!(js.contains("selector_note"));
    }

    #[test]
    fn selector_preference_runs_stable_attributes_before_positional_paths() {
        let js = reader_expr("null", true, true, "null");
        let id_at = js.find("el.id && unique").expect("id first");
        let testid_at = js.find("data-testid").expect("test ids next");
        let nth_at = js.find("nth-of-type").expect("positional last");
        assert!(id_at < testid_at, "id before data-testid");
        assert!(testid_at < nth_at, "attributes before positional paths");
    }

    #[test]
    fn the_result_says_how_much_of_the_page_it_covers() {
        // Without this the agent reads a viewport answer as a whole-page one
        // and concludes a below-the-fold element does not exist.
        let js = reader_expr("null", true, true, "null");
        assert!(js.contains("covers_percent"));
        assert!(js.contains("page_height"));
        assert!(js.contains("truncated"));
    }

    #[test]
    fn a_scope_is_json_encoded_not_string_pasted() {
        // A selector carrying a quote would otherwise terminate the literal and
        // execute as script — the page controls neither, but the agent does.
        let js = reader_expr(
            &serde_json::json!("a[title=\"x\"]").to_string(),
            false,
            true,
            &serde_json::json!("sa\"ve").to_string(),
        );
        assert!(js.contains(r#"const SCOPE = "a[title=\"x\"]""#));
        assert!(js.contains(r#"const QUERY = "sa\"ve""#));
    }

    /// The reported confusion: models called `browser_view` with `query`
    /// (browser_page_outline's word) and were refused for the spelling.
    #[test]
    fn a_query_narrows_the_list_and_counts_only_what_matches() {
        let js = reader_expr("null", true, true, "\"save\"");
        assert!(js.contains("label.toLowerCase().includes(q)"));
        // The filter runs BEFORE `seen++`, so `matched_total` is the number
        // of matches, not the number of elements on the page.
        let filter_at = js.find("includes(q)").unwrap();
        let seen_at = js.find("seen++").unwrap();
        assert!(filter_at < seen_at);
    }

    /// A whole-page answer must describe itself as one. The finding: two
    /// back-to-back calls differing only in `viewport_only` returned a
    /// byte-identical `view_range`, one of them beside an element it placed
    /// outside that range.
    #[test]
    fn a_whole_page_scan_reports_the_whole_page_as_its_range() {
        let js = reader_expr("null", false, true, "null");
        assert!(js.contains("view_range: VIEWPORT_ONLY ?"));
        assert!(js.contains("covers_percent: 100"));
        assert!(js.contains("to_y: Math.round(pageHeight)"));
    }

    #[test]
    fn hidden_elements_are_counted_but_never_offered() {
        // `display:none` nodes have real selectors and are unclickable. Offering
        // them produces a click that fails for a reason the agent cannot see.
        let js = reader_expr("null", true, true, "null");
        assert!(js.contains("visibility === 'hidden'"));
        assert!(js.contains("hidden_or_offscreen"));
    }
}
