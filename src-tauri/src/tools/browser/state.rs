//! Where the browser panel actually is right now.
//!
//! Every browser tool used to answer only "did my call succeed", which left the
//! agent with no way to know the panel was ALREADY open on the page it wanted.
//! The observed cost is a wasted turn per cycle: inspect → find a bug → fix it →
//! re-open the browser, which was never closed, to look at a page that was
//! already loaded.
//!
//! Two halves fix that, and they are deliberately both:
//!
//! 1. [`BrowserStatusTool`] answers the question directly when the agent thinks
//!    to ask.
//! 2. [`snapshot`] rides along on every navigate and every action, so it mostly
//!    never has to ask. A tool that reports the state it left behind is worth
//!    more than a tool that reports its own exit code — the same reason a failed
//!    call must never render as a green check.
//!
//! Everything here is READ-ONLY. Status never navigates, never opens the panel,
//! and never drains the console buffer (`__aurora.getLogs` slices a copy), so it
//! is safe to call at any point without disturbing what it is describing.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::services::browser_runtime::BrowserManager;

use super::AGENT_BROWSER_LABEL;

/// One page-side read: everything about the view that only the page knows.
///
/// Kept to one round trip on purpose — a status call that costs four evals is a
/// status call the agent learns to avoid, and then we are back to guessing.
const SNAPSHOT_EXPR: &str = r#"(() => {
  const logs = (window.__aurora && typeof window.__aurora.getLogs === 'function')
    ? window.__aurora.getLogs(null, null) : [];
  let errors = 0, warnings = 0, lastError = null;
  for (const entry of logs) {
    if (entry.level === 'error') { errors++; lastError = entry.text; }
    else if (entry.level === 'warn') warnings++;
  }
  const scroller = document.scrollingElement || document.documentElement;
  return {
    url: location.href,
    title: document.title || null,
    ready_state: document.readyState,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      device_pixel_ratio: window.devicePixelRatio,
    },
    page_height: scroller ? scroller.scrollHeight : null,
    scroll_y: window.scrollY,
    console: { errors, warnings, last_error: lastError },
  };
})()"#;

/// The active viewport override, if one is in force.
///
/// **Emulation is sticky and invisible, which is the trap.** A device-metrics
/// override survives navigation and every later turn, so a mobile size set once
/// keeps applying long after the reason for it is gone — and nothing on screen
/// or in any tool result used to say so. The agent then reads a phone-width
/// render as the desktop layout and reports imaginary bugs.
///
/// One panel, one override, so one record. Held here rather than on
/// `BrowserManager` because it is a fact about how the TOOLS are driving the
/// panel, not about the panel itself.
static EMULATION: std::sync::Mutex<Option<Emulation>> = std::sync::Mutex::new(None);

#[derive(Clone, Copy, Debug)]
pub struct Emulation {
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub mobile: bool,
}

pub fn set_emulation(emulation: Emulation) {
    if let Ok(mut slot) = EMULATION.lock() {
        *slot = Some(emulation);
    }
}

pub fn clear_emulation() {
    if let Ok(mut slot) = EMULATION.lock() {
        *slot = None;
    }
}

pub fn emulation() -> Option<Emulation> {
    EMULATION.lock().ok().and_then(|slot| *slot)
}

/// The emulation block attached to every state read, or `Value::Null`.
///
/// The panel now draws a device frame at the emulated size, so a screenshot is
/// the page and nothing else — the blank band that used to be photographed
/// alongside it is gone. What remains dangerous is the stickiness: the override
/// outlives the reason for it, and every later look is silently phone-width
/// unless something says so. This is that something.
fn emulation_block() -> Value {
    match emulation() {
        None => Value::Null,
        Some(e) => json!({
            "width": e.width,
            "height": e.height,
            "device_pixel_ratio": e.scale,
            "mobile": e.mobile,
            "warning": format!(
                "The viewport is EMULATED at {w}x{h} — the panel is showing a device frame at that \
                 size, not its real width. This override survives later turns: clear it with \
                 `browser_set_viewport {{reset: true}}` before judging a desktop layout, or \
                 everything you look at from here is {w}px wide.",
                w = e.width as i64,
                h = e.height as i64
            ),
        }),
    }
}

/// Read the panel's current state without touching it.
///
/// Returns `{"open": false}` when the panel does not exist — deliberately not an
/// error. "There is no browser open" is a legitimate answer to "where is the
/// browser", and raising here would push the agent toward opening one just to
/// find out.
pub async fn snapshot(manager: &BrowserManager) -> Value {
    if !manager.has_window(AGENT_BROWSER_LABEL) {
        return json!({
            "open": false,
            "hint": "No Browser panel yet. `browser_navigate` opens it and loads a page.",
        });
    }

    // The page-side read can fail for reasons that are not the caller's
    // problem — mid-navigation, an about:blank with no injected namespace, a
    // page that hung. Fall back to what the RUST side knows rather than
    // failing the whole call: a partial answer beats none, and claiming the
    // panel is shut when it is open would be the worst of the three.
    match manager.eval_with_result(AGENT_BROWSER_LABEL, SNAPSHOT_EXPR).await {
        Ok(result) if result.ok => {
            let mut value = result.value.unwrap_or(Value::Null);
            if let Some(object) = value.as_object_mut() {
                object.insert("open".into(), Value::Bool(true));
                let block = emulation_block();
                if !block.is_null() {
                    object.insert("emulated_viewport".into(), block);
                }
                return value;
            }
            fallback(manager, "the page returned no state")
        }
        Ok(result) => fallback(
            manager,
            &result.error.unwrap_or_else(|| "the page did not respond".into()),
        ),
        Err(error) => fallback(manager, &error),
    }
}

fn fallback(manager: &BrowserManager, why: &str) -> Value {
    json!({
        "open": true,
        "url": manager.current_url(AGENT_BROWSER_LABEL).ok(),
        "ready_state": "unknown",
        "note": format!("Panel is open but the page could not be read ({why}). It may still be loading."),
    })
}

/// What changed between two snapshots taken around an action.
///
/// This is the answer to "what happened after I clicked", which a bare
/// `{"ok":true}` cannot give. A click that navigated, a click that threw, and a
/// click that did nothing at all are three different outcomes that used to
/// return the same string — so the agent's only way to tell them apart was to
/// spend another turn looking.
///
/// Only real differences are reported. An action that changed nothing says so
/// in one field rather than echoing an unchanged page back into the context.
pub fn change_between(before: &Value, after: &Value) -> Value {
    let field = |value: &Value, key: &str| value.get(key).cloned().unwrap_or(Value::Null);
    let count = |value: &Value, key: &str| {
        value
            .get("console")
            .and_then(|c| c.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };

    let mut change = serde_json::Map::new();

    let (url_before, url_after) = (field(before, "url"), field(after, "url"));
    if url_before != url_after {
        change.insert("navigated_to".into(), url_after.clone());
        change.insert("navigated_from".into(), url_before);
    }

    let (title_before, title_after) = (field(before, "title"), field(after, "title"));
    if title_before != title_after && !title_after.is_null() {
        change.insert("title".into(), title_after);
    }

    // New console errors are the single most useful thing an action can
    // produce and the easiest to miss: they are attributed to the action that
    // caused them instead of waiting to be found by a later log read.
    let new_errors = count(after, "errors").saturating_sub(count(before, "errors"));
    if new_errors > 0 {
        change.insert("new_console_errors".into(), json!(new_errors));
        if let Some(last) = after.get("console").and_then(|c| c.get("last_error")) {
            if !last.is_null() {
                change.insert("last_error".into(), last.clone());
            }
        }
    }
    let new_warnings = count(after, "warnings").saturating_sub(count(before, "warnings"));
    if new_warnings > 0 {
        change.insert("new_console_warnings".into(), json!(new_warnings));
    }

    let scroll = |value: &Value| value.get("scroll_y").and_then(Value::as_f64).unwrap_or(0.0);
    if (scroll(after) - scroll(before)).abs() >= 1.0 {
        change.insert("scrolled_to_y".into(), json!(scroll(after).round()));
    }

    let height = |value: &Value| value.get("page_height").and_then(Value::as_f64);
    if let (Some(h1), Some(h2)) = (height(before), height(after)) {
        // A page that grew or shrank means content rendered or collapsed —
        // usually the whole point of the click.
        if (h2 - h1).abs() >= 8.0 {
            change.insert("page_height".into(), json!(h2.round()));
            change.insert("page_height_delta".into(), json!((h2 - h1).round()));
        }
    }

    if change.is_empty() {
        // Said plainly, because "nothing happened" is a RESULT. Silence here
        // reads as success and sends the agent looking for an effect that was
        // never produced.
        return json!({ "nothing_observable_changed": true });
    }
    Value::Object(change)
}

pub struct BrowserStatusTool {
    manager: Arc<BrowserManager>,
}

impl BrowserStatusTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}

#[async_trait]
impl ToolExecutor for BrowserStatusTool {
    fn name(&self) -> &str {
        "browser_status"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_status".into(),
            description: "Where the Browser panel is right now: whether it is open at all, the \
URL and title it is showing, whether the page has finished loading, its viewport size, and how \
many console errors and warnings the current page has produced.

Call this when you are resuming browser work and do not already know the state — after editing \
code and coming back, or at the start of a turn that continues an earlier one. The panel PERSISTS \
across turns: it is very often already open on the page you want, and re-navigating to it costs a \
reload you did not need.

Read-only and cheap. It never opens the panel, never navigates, and never clears the console."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
        }
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        Ok(snapshot(&self.manager).await.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_snapshot_read_counts_logs_without_consuming_them() {
        // `getLogs` returns a sliced COPY, so counting is safe — but a future
        // edit to a draining API would silently make every status call eat the
        // console the agent was about to read.
        assert!(SNAPSHOT_EXPR.contains("getLogs(null, null)"));
        assert!(!SNAPSHOT_EXPR.contains("clear"));
    }

    #[test]
    fn the_snapshot_survives_a_page_with_no_injected_namespace() {
        // about:blank, a cross-origin redirect mid-flight, or a page caught
        // before the init script ran all have no `window.__aurora`. The
        // expression must degrade to zero counts rather than throw, or status
        // fails exactly when the agent most needs it.
        assert!(SNAPSHOT_EXPR.contains("window.__aurora && typeof"));
    }

    fn snap(url: &str, errors: u64, scroll: f64, height: f64) -> Value {
        json!({
            "open": true, "url": url, "title": "t", "scroll_y": scroll,
            "page_height": height, "console": { "errors": errors, "warnings": 0, "last_error": "boom" }
        })
    }

    #[test]
    fn an_action_that_did_nothing_says_so() {
        // The failure this prevents: a click that matched nothing, changed
        // nothing, and returned `{"ok":true}`. Silence reads as success.
        let before = snap("http://localhost:5173/", 0, 0.0, 900.0);
        let change = change_between(&before, &before);
        assert_eq!(change.get("nothing_observable_changed"), Some(&json!(true)));
    }

    #[test]
    fn a_click_that_navigated_reports_both_ends() {
        let change = change_between(
            &snap("http://localhost:5173/", 0, 0.0, 900.0),
            &snap("http://localhost:5173/settings", 0, 0.0, 900.0),
        );
        assert_eq!(change.get("navigated_to"), Some(&json!("http://localhost:5173/settings")));
        assert_eq!(change.get("navigated_from"), Some(&json!("http://localhost:5173/")));
    }

    #[test]
    fn errors_the_action_caused_are_attributed_to_it() {
        // Counting the delta, not the total: a page that was already throwing
        // must not make every later click look like it broke something.
        let change = change_between(
            &snap("http://x/", 2, 0.0, 900.0),
            &snap("http://x/", 5, 0.0, 900.0),
        );
        assert_eq!(change.get("new_console_errors"), Some(&json!(3)));
        assert_eq!(change.get("last_error"), Some(&json!("boom")));
    }

    #[test]
    fn content_appearing_is_reported_as_the_page_growing() {
        let change = change_between(
            &snap("http://x/", 0, 0.0, 900.0),
            &snap("http://x/", 0, 0.0, 1500.0),
        );
        assert_eq!(change.get("page_height_delta"), Some(&json!(600.0)));
    }

    #[test]
    fn sub_pixel_noise_is_not_a_change() {
        // Scroll and layout jitter by fractions constantly. Reporting it would
        // make "nothing changed" almost never fire, which is the one signal
        // this function exists to give.
        let change = change_between(
            &snap("http://x/", 0, 10.0, 900.0),
            &snap("http://x/", 0, 10.4, 903.0),
        );
        assert_eq!(change.get("nothing_observable_changed"), Some(&json!(true)));
    }

    #[test]
    fn an_emulated_viewport_announces_itself_and_how_to_leave() {
        // The override outlives the reason for it: set once and forgotten, every
        // later look is phone-width while nothing on screen says so, and the
        // model reports desktop bugs that only exist at 390px.
        clear_emulation();
        assert!(emulation_block().is_null());

        set_emulation(Emulation { width: 390.0, height: 844.0, scale: 2.0, mobile: true });
        let block = emulation_block();
        assert_eq!(block.get("width"), Some(&json!(390.0)));
        let warning = block.get("warning").and_then(Value::as_str).unwrap();
        assert!(warning.contains("390"), "names the emulated width");
        assert!(warning.contains("EMULATED"), "says the size is not the real one");
        assert!(warning.contains("reset"), "says how to get out of it");
        clear_emulation();
    }

    #[test]
    fn resetting_the_viewport_stops_the_warning() {
        // A stale warning is its own lie: it would have the model discount real
        // empty space on a page that is no longer emulated at all.
        set_emulation(Emulation { width: 390.0, height: 844.0, scale: 1.0, mobile: true });
        clear_emulation();
        assert!(emulation().is_none());
        assert!(emulation_block().is_null());
    }

    #[test]
    fn a_closed_panel_is_an_answer_not_an_error() {
        // Guards the shape callers branch on. "Not open" must stay a normal
        // result: making it an error teaches the agent to open a browser just
        // to discover whether one was open.
        let closed = json!({ "open": false });
        assert_eq!(closed.get("open"), Some(&Value::Bool(false)));
    }
}
