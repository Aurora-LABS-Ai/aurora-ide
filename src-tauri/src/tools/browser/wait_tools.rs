//! `browser_wait_for` — wait until the page reaches a state, bounded.
//!
//! The acting tools already wait a little (`settle_ms`, up to five seconds)
//! and `browser_click` waits up to four for its target to appear. What was
//! missing is waiting for a CONDITION: the spinner to go, the row to be
//! added, the toast to say "Saved", the route to change. Without it the
//! model screenshots a loading state, reads it as the finished page, and
//! reports a bug that is really a race.
//!
//! Polled from Rust in short page-side reads rather than one long page-side
//! loop, so a navigation in the middle of the wait (which tears the page's
//! script context down) is survived: the read fails, the next one lands on
//! the new page, and the wait continues.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::services::browser_runtime::BrowserManager;

use super::{ensure_agent_browser, AGENT_BROWSER_LABEL};

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MAX_TIMEOUT_MS: u64 = 30_000;
const POLL_MS: u64 = 150;

/// One check of every condition, in one page read.
const CHECK_JS: &str = r#"(() => {
  const SEL = __SEL__, TEXT = __TEXT__, URL_PART = __URL__, STATE = __STATE__;
  const out = { url: location.href, ready: document.readyState };
  if (SEL) {
    let el = null;
    try { el = document.querySelector(SEL); } catch (e) { out.selector_error = String(e && e.message || e); }
    let visible = false;
    if (el) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    }
    out.selector_attached = !!el;
    out.selector_visible = visible;
    out.selector_ok = STATE === 'hidden' ? !visible : STATE === 'attached' ? !!el : visible;
  }
  if (TEXT) {
    let body = '';
    try { body = document.body ? (document.body.innerText || document.body.textContent || '') : ''; } catch (e) {}
    out.text_ok = body.toLowerCase().includes(String(TEXT).toLowerCase());
    out.text_length = body.length;
  }
  if (URL_PART) out.url_ok = location.href.includes(URL_PART);
  return out;
})()"#;

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
            description: "Wait until the page in the Browser panel reaches a state, then \
                return — instead of screenshotting a spinner and reading it as the finished \
                page. Conditions (give at least one; all given must hold): `selector` exists and \
                is visible (or `state: \"hidden\"` for it to go away, `\"attached\"` for it to \
                exist at all), `text` appears anywhere on the page, `url_contains` matches the \
                address. Also waits for the document to finish loading. Bounded: fails after \
                `timeout_ms` (default 10s, max 30s) saying which condition never held and what \
                the page showed instead. Read-only."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "selector": { "type": "string", "description": "CSS selector to wait for." },
                    "state": { "type": "string", "enum": ["visible", "hidden", "attached"], "description": "What `selector` must be. Default visible." },
                    "text": { "type": "string", "description": "Text that must appear on the page (case-insensitive)." },
                    "url_contains": { "type": "string", "description": "A fragment the page URL must contain — for a route change or a redirect." },
                    "timeout_ms": { "type": "number", "description": "Give up after this many milliseconds. Default 10000, maximum 30000." }
                },
                "required": []
            }),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;

        let field = |key: &str| {
            input
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let selector = field("selector");
        let text = field("text");
        let url_part = field("url_contains");
        let state = field("state").unwrap_or_else(|| "visible".into());
        if !matches!(state.as_str(), "visible" | "hidden" | "attached") {
            return Err(ToolError::InvalidInput(format!(
                "`state` must be \"visible\", \"hidden\" or \"attached\"; you sent \"{state}\""
            )));
        }
        if selector.is_none() && text.is_none() && url_part.is_none() {
            return Err(ToolError::InvalidInput(
                "give at least one condition: `selector`, `text` or `url_contains`.".into(),
            ));
        }
        let timeout_ms = input
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(100, MAX_TIMEOUT_MS);

        let script = CHECK_JS
            .replace("__SEL__", &json!(selector).to_string())
            .replace("__TEXT__", &json!(text).to_string())
            .replace("__URL__", &json!(url_part).to_string())
            .replace("__STATE__", &json!(state).to_string());

        let started = Instant::now();
        let deadline = started + Duration::from_millis(timeout_ms);
        let mut last = Value::Null;
        loop {
            ctx.bail_if_cancelled()?;
            // A failed read is a page mid-navigation, not a verdict: keep
            // polling and let the next read land on the new document.
            if let Ok(result) = self
                .manager
                .eval_with_result(AGENT_BROWSER_LABEL, &script)
                .await
            {
                if result.ok {
                    last = result.value.unwrap_or(Value::Null);
                    let flag = |key: &str| last.get(key).and_then(Value::as_bool);
                    let selector_ok = selector.is_none() || flag("selector_ok") == Some(true);
                    let text_ok = text.is_none() || flag("text_ok") == Some(true);
                    let url_ok = url_part.is_none() || flag("url_ok") == Some(true);
                    let loaded = last.get("ready").and_then(Value::as_str) == Some("complete");
                    if selector_ok && text_ok && url_ok && loaded {
                        return Ok(json!({
                            "satisfied": true,
                            "waited_ms": started.elapsed().as_millis() as u64,
                            "url": last.get("url").cloned().unwrap_or(Value::Null),
                            "state": super::state::presentable(super::state::snapshot(&self.manager).await),
                        })
                        .to_string());
                    }
                    if let Some(err) = last.get("selector_error").and_then(Value::as_str) {
                        return Err(ToolError::InvalidInput(format!(
                            "`selector` is not a valid CSS selector: {err}"
                        )));
                    }
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        }

        // Say which condition never held, and what was seen instead.
        let mut unmet: Vec<String> = Vec::new();
        let flag = |key: &str| last.get(key).and_then(Value::as_bool);
        if let Some(sel) = &selector {
            if flag("selector_ok") != Some(true) {
                let attached = flag("selector_attached") == Some(true);
                let visible = flag("selector_visible") == Some(true);
                unmet.push(format!(
                    "`{sel}` never became {state} (at the end it was {})",
                    match (attached, visible) {
                        (false, _) => "not in the DOM".to_string(),
                        (true, false) => "in the DOM but not visible".to_string(),
                        (true, true) => "visible".to_string(),
                    }
                ));
            }
        }
        if let Some(t) = &text {
            if flag("text_ok") != Some(true) {
                unmet.push(format!(
                    "\"{t}\" never appeared (the page shows {} characters of text)",
                    last.get("text_length").and_then(Value::as_u64).unwrap_or(0)
                ));
            }
        }
        if let Some(u) = &url_part {
            if flag("url_ok") != Some(true) {
                unmet.push(format!(
                    "the URL never contained \"{u}\" (it is {})",
                    last.get("url").and_then(Value::as_str).unwrap_or("unreadable")
                ));
            }
        }
        if last.get("ready").and_then(Value::as_str) != Some("complete") {
            unmet.push(format!(
                "the document never finished loading (readyState {})",
                last.get("ready").and_then(Value::as_str).unwrap_or("unknown")
            ));
        }
        Err(ToolError::Execution(format!(
            "waited {timeout_ms}ms: {}. Check browser_get_console_logs for an error, or \
             browser_view for what the page shows instead.",
            unmet.join("; ")
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_check_reads_every_condition_as_data() {
        let script = CHECK_JS
            .replace("__SEL__", &json!(Some("a[href=\"x\"]")).to_string())
            .replace("__TEXT__", &json!(Some("Saved")).to_string())
            .replace("__URL__", &json!(None::<String>).to_string())
            .replace("__STATE__", &json!("visible").to_string());
        assert!(script.contains(r#"const SEL = "a[href=\"x\"]""#));
        assert!(script.contains(r#"TEXT = "Saved""#));
        assert!(script.contains("URL_PART = null"));
        assert!(!script.contains("__SEL__"));
    }

    #[test]
    fn hidden_means_not_visible_and_attached_means_merely_present() {
        assert!(CHECK_JS.contains("STATE === 'hidden' ? !visible"));
        assert!(CHECK_JS.contains("STATE === 'attached' ? !!el"));
    }
}
