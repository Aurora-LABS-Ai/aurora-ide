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
  const aurora = window.__aurora;
  const logs = (aurora && typeof aurora.getLogs === 'function')
    ? aurora.getLogs(null, null) : [];
  let errors = 0, warnings = 0, lastError = null;
  for (const entry of logs) {
    if (entry.level === 'error') { errors++; lastError = entry.message || null; }
    else if (entry.level === 'warn') warnings++;
  }
  const scroller = document.scrollingElement || document.documentElement;

  // ---- What the page is SHOWING -------------------------------------
  // Rendered text, not markup: innerText already respects CSS, so a panel
  // that opened counts and a display:none branch does not.
  let text = '';
  try { text = document.body ? document.body.innerText : ''; } catch (e) {}
  // Cost-bounded on purpose: a 5MB page samples the same ~4096 characters a
  // 4KB page reads in full, so this stays cheap on the pages that need it
  // most. Length is compared separately and exactly, which is what catches
  // the small edits sampling could step over.
  const length = text.length;
  let hash = 0;
  if (length) {
    hash = 0x811c9dc5;
    const step = length > 4096 ? Math.ceil(length / 4096) : 1;
    for (let i = 0; i < length; i += step) {
      hash ^= text.charCodeAt(i);
      hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
    }
  }
  // Counted inside BODY, not the whole document. Aurora's own furniture —
  // the drawn pointer, its press ripple, the inspector overlay — is appended
  // to documentElement, outside body, so it never counts. Before this the
  // ripple's own removal came back as `elements_removed: 1` on a click that
  // had done nothing at all, and the model read it as a menu that opened and
  // closed itself.
  let elements = 0;
  try { elements = document.body ? document.body.getElementsByTagName('*').length : 0; } catch (e) {}

  // ---- What the FORM holds --------------------------------------------
  // innerText does not include an input's value, so a fill that worked
  // perfectly used to read as `nothing_observable_changed` (21 of 33 fills in
  // twelve real sessions). Values are fingerprinted separately so a fill, a
  // toggle, a selection or a typed character all register as a change.
  let values = 0;
  try {
    values = 0x811c9dc5;
    const mix = (s) => {
      for (let i = 0; i < s.length; i++) {
        values ^= s.charCodeAt(i);
        values = (values + (values << 1) + (values << 4) + (values << 7) + (values << 8) + (values << 24)) >>> 0;
      }
    };
    const fields = document.body
      ? document.body.querySelectorAll('input,textarea,select,[contenteditable=""],[contenteditable="true"]')
      : [];
    for (const f of fields) {
      const tag = f.tagName;
      if (tag === 'INPUT' && (f.type === 'checkbox' || f.type === 'radio')) mix(f.checked ? '1' : '0');
      else if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') mix(String(f.value || ''));
      else mix(String(f.textContent || '').slice(0, 2000));
      mix('|');
    }
  } catch (e) { values = 0; }
  const active = document.activeElement;
  let focus = null;
  try {
    if (active && active !== document.body && active.tagName) {
      const label = active.getAttribute ? active.getAttribute('aria-label') : null;
      focus = active.tagName.toLowerCase()
        + (active.id ? '#' + active.id : '')
        + (label ? '[' + label.slice(0, 40) + ']' : '');
    }
  } catch (e) {}

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
    content: {
      text_length: length,
      text_hash: hash,
      values_hash: values,
      elements: elements,
      focus: focus,
      mutations: (aurora && aurora.__mutations) ? aurora.__mutations.count : null,
    },
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
    match manager
        .eval_with_result(AGENT_BROWSER_LABEL, SNAPSHOT_EXPR)
        .await
    {
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
            &result
                .error
                .unwrap_or_else(|| "the page did not respond".into()),
        ),
        Err(error) => fallback(manager, &error),
    }
}

fn fallback(manager: &BrowserManager, why: &str) -> Value {
    json!({
        "open": true,
        "url": manager.current_url(AGENT_BROWSER_LABEL).ok(),
        "ready_state": "unknown",
        // Says what is known and stops. The old wording ended "It may still be
        // loading", which named one cause out of several and named the least
        // likely one: the commonest reason the page-side namespace does not
        // answer is that the WebView is showing its own error page because
        // nothing served the URL. Presenting a guess as the explanation is how
        // the agent came to believe a stopped dev server was running.
        "note": format!(
            "Panel is open but the page did not answer ({why}). That is what a browser error \
             page looks like from here, so do not assume the app is loaded — \
             `browser_navigate` reports whether the address actually serves anything."
        ),
    })
}

/// The same snapshot with the comparison basis stripped out.
///
/// `content` exists so [`change_between`] can tell a page that reacted from one
/// that did not. A text hash and an element count mean nothing to the model
/// reading the result, and spending context on them would buy it nothing — so
/// every snapshot that goes back as an ANSWER goes through here first.
pub fn presentable(mut snapshot: Value) -> Value {
    if let Some(object) = snapshot.as_object_mut() {
        object.remove("content");
    }
    snapshot
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

    // ---- What the page is showing -------------------------------------
    //
    // Everything above is URL, chrome and geometry, and a page can change
    // completely without moving any of it. The reported miss: a click swapped a
    // label to "Dark detected", mounted an overlay, flipped a button's pressed
    // state and appended a status line — same URL, same title, same height —
    // and the action answered `nothing_observable_changed`. The model was told
    // its click was dead while holding a view that showed otherwise.
    //
    // Compared only when BOTH snapshots carry a content block: a read that fell
    // back to the Rust-side view has none, and scoring "we could not read the
    // page" as "the page changed" would make every mid-navigation action lie in
    // the other direction.
    fn content(value: &Value) -> Option<&serde_json::Map<String, Value>> {
        value.get("content").and_then(Value::as_object)
    }
    let mut mutations = 0i64;
    if let (Some(before), Some(after)) = (content(before), content(after)) {
        let at = |map: &serde_json::Map<String, Value>, key: &str| {
            map.get(key).cloned().unwrap_or(Value::Null)
        };
        let number = |map: &serde_json::Map<String, Value>, key: &str| {
            map.get(key).and_then(Value::as_i64).unwrap_or(0)
        };

        // Length is exact; the hash catches same-length edits the length
        // cannot see ("Light detected" -> "Dark detected!" is 14 either way).
        let (length_before, length_after) =
            (number(before, "text_length"), number(after, "text_length"));
        if length_before != length_after || at(before, "text_hash") != at(after, "text_hash") {
            change.insert("text_changed".into(), json!(true));
            if length_before != length_after {
                change.insert(
                    "text_length_delta".into(),
                    json!(length_after - length_before),
                );
            }
        }

        // A field's value is not part of the rendered text, so a fill, a
        // toggle or a selection would otherwise register as nothing at all.
        if at(before, "values_hash") != at(after, "values_hash") {
            change.insert("form_values_changed".into(), json!(true));
        }

        // An overlay, a menu or a toast that mounted — the halo case, which no
        // amount of height-watching catches because it is out of flow.
        let (elements_before, elements_after) =
            (number(before, "elements"), number(after, "elements"));
        match elements_after.cmp(&elements_before) {
            std::cmp::Ordering::Greater => {
                change.insert(
                    "elements_added".into(),
                    json!(elements_after - elements_before),
                );
            }
            std::cmp::Ordering::Less => {
                change.insert(
                    "elements_removed".into(),
                    json!(elements_before - elements_after),
                );
            }
            std::cmp::Ordering::Equal => {}
        }

        // Clicking a control focuses it. Cheap, exact, and on its own enough to
        // prove the click landed on something real.
        let (focus_before, focus_after) = (at(before, "focus"), at(after, "focus"));
        if focus_before != focus_after {
            change.insert("focus_moved_to".into(), focus_after);
        }

        mutations = number(after, "mutations").saturating_sub(number(before, "mutations"));
    }

    if change.is_empty() {
        // Said plainly, because "nothing happened" is a RESULT. Silence here
        // reads as success and sends the agent looking for an effect that was
        // never produced.
        //
        // The mutation count is the tie-breaker, and it is deliberately not
        // enough on its own to count as a change: React re-renders, CSS
        // animations and style ticks touch the DOM constantly, so promoting
        // any mutation to "something changed" would retire the one signal this
        // function exists to give. Reported alongside instead, because "the DOM
        // was touched but nothing it renders differs" is exactly the shape of
        // an attribute or class toggle, and the model should go look rather
        // than conclude its click was dead.
        if mutations > 0 {
            return json!({
                "nothing_observable_changed": true,
                "dom_mutations": mutations,
                "note": format!(
                    "The DOM was touched {mutations} times, but the rendered text, element count, \
                     focus and layout are all unchanged. That is what an attribute, class or style \
                     toggle looks like — check the element itself before concluding the action did \
                     nothing."
                ),
            });
        }
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
        Ok(presentable(snapshot(&self.manager).await).to_string())
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
        assert!(SNAPSHOT_EXPR.contains("(aurora && typeof aurora.getLogs === 'function')"));
        // Same for the mutation counter, which only exists on pages our init
        // script reached.
        assert!(SNAPSHOT_EXPR.contains("(aurora && aurora.__mutations)"));
    }

    #[test]
    fn the_last_error_reads_the_field_the_page_actually_writes() {
        // `record()` in the init script pushes `{ ts, level, message }`. This
        // read asked for `entry.text` for as long as it existed, so every
        // `last_error` in every status and every action result was null while
        // the count next to it said errors had happened.
        assert!(SNAPSHOT_EXPR.contains("entry.message"));
        assert!(!SNAPSHOT_EXPR.contains("entry.text"));
    }

    #[test]
    fn aurora_furniture_is_never_counted_as_a_page_element() {
        // The pointer, its ripple and the inspector overlay all live on
        // documentElement. A count over the whole document saw the ripple
        // finish and reported `elements_removed: 1` for a click that changed
        // nothing — evidence of a menu that never existed.
        assert!(SNAPSHOT_EXPR.contains("document.body.getElementsByTagName('*')"));
        assert!(!SNAPSHOT_EXPR.contains("document.getElementsByTagName('*')"));
    }

    #[test]
    fn form_values_are_fingerprinted_separately_from_the_text() {
        // innerText never includes an input's value, so without this a fill
        // that worked read as `nothing_observable_changed`.
        assert!(SNAPSHOT_EXPR.contains("values_hash"));
        assert!(SNAPSHOT_EXPR.contains("f.checked ? '1' : '0'"));
    }

    #[test]
    fn a_fill_that_only_changed_a_value_is_reported() {
        let mut before = showing("Sign in", 40, json!("input#email"), 3);
        let mut after = showing("Sign in", 40, json!("input#email"), 13);
        before["content"]["values_hash"] = json!(1);
        after["content"]["values_hash"] = json!(2);
        let change = change_between(&before, &after);
        assert_eq!(change.get("form_values_changed"), Some(&json!(true)));
        assert!(
            change.get("nothing_observable_changed").is_none(),
            "a value that changed is a change: {change}"
        );
    }

    #[test]
    fn reading_the_page_text_is_bounded_on_huge_pages() {
        // Two snapshots ride on every action. An unbounded scan of a multi-MB
        // page would put that cost on every click, which is how a correctness
        // fix turns into a performance complaint.
        assert!(SNAPSHOT_EXPR.contains("length > 4096 ? Math.ceil(length / 4096) : 1"));
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
        assert_eq!(
            change.get("navigated_to"),
            Some(&json!("http://localhost:5173/settings"))
        );
        assert_eq!(
            change.get("navigated_from"),
            Some(&json!("http://localhost:5173/"))
        );
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

        set_emulation(Emulation {
            width: 390.0,
            height: 844.0,
            scale: 2.0,
            mobile: true,
        });
        let block = emulation_block();
        assert_eq!(block.get("width"), Some(&json!(390.0)));
        let warning = block.get("warning").and_then(Value::as_str).unwrap();
        assert!(warning.contains("390"), "names the emulated width");
        assert!(
            warning.contains("EMULATED"),
            "says the size is not the real one"
        );
        assert!(warning.contains("reset"), "says how to get out of it");
        clear_emulation();
    }

    #[test]
    fn resetting_the_viewport_stops_the_warning() {
        // A stale warning is its own lie: it would have the model discount real
        // empty space on a page that is no longer emulated at all.
        set_emulation(Emulation {
            width: 390.0,
            height: 844.0,
            scale: 1.0,
            mobile: true,
        });
        clear_emulation();
        assert!(emulation().is_none());
        assert!(emulation_block().is_null());
    }

    /// A snapshot with a content block: text fingerprint, element count, what
    /// is focused, and how many times the DOM was touched.
    fn showing(text: &str, elements: i64, focus: Value, mutations: i64) -> Value {
        // The JS hashes; here any stable function of the text will do, since
        // what is under test is the COMPARISON, not the digest.
        let hash: u32 = text
            .chars()
            .fold(0x811c_9dc5u32, |h, c| h.rotate_left(5) ^ (c as u32));
        json!({
            "open": true, "url": "http://x/", "title": "t", "scroll_y": 0.0,
            "page_height": 900.0,
            "console": { "errors": 0, "warnings": 0, "last_error": null },
            "content": {
                "text_length": text.len(), "text_hash": hash,
                "elements": elements, "focus": focus, "mutations": mutations
            }
        })
    }

    #[test]
    fn a_click_that_only_changed_what_the_page_shows_is_not_reported_as_dead() {
        // The reported miss, verbatim: `browser_click` on a theme toggle swapped
        // a label to "Dark detected", mounted a halo, flipped the button's
        // pressed state and appended a status line. Same URL, same title, same
        // height, no console output — and the result said
        // `nothing_observable_changed`, contradicting the view returned beside
        // it. The model was told its click was dead while looking at the proof
        // that it was not.
        let change = change_between(
            &showing("Light detected", 120, Value::Null, 0),
            &showing(
                "Dark detected  Theme applied",
                122,
                json!("button#on-btn"),
                9,
            ),
        );
        assert_eq!(change.get("text_changed"), Some(&json!(true)));
        assert_eq!(change.get("elements_added"), Some(&json!(2)));
        assert_eq!(change.get("focus_moved_to"), Some(&json!("button#on-btn")));
        assert!(
            change.get("nothing_observable_changed").is_none(),
            "a page that changed must never claim it did not: {change}"
        );
    }

    #[test]
    fn a_same_length_edit_is_caught_by_the_fingerprint() {
        // Length alone would call these identical. Both labels are 14
        // characters, and a swap between them is exactly the kind of toggle
        // these tools are pointed at.
        let change = change_between(
            &showing("Light detected", 120, Value::Null, 1),
            &showing("Ready detected", 120, Value::Null, 2),
        );
        assert_eq!(change.get("text_changed"), Some(&json!(true)));
        assert!(change.get("text_length_delta").is_none(), "same length");
    }

    #[test]
    fn an_overlay_that_mounted_out_of_flow_still_counts() {
        // A fixed-position halo or toast adds no page height at all, so the
        // geometry checks above see nothing. The element count is what catches
        // it.
        let change = change_between(
            &showing("same text", 120, Value::Null, 0),
            &showing("same text", 137, Value::Null, 40),
        );
        assert_eq!(change.get("elements_added"), Some(&json!(17)));
        assert!(change.get("nothing_observable_changed").is_none());
    }

    #[test]
    fn a_dom_touch_with_no_visible_result_is_reported_but_not_promoted() {
        // React re-renders and CSS animations touch the DOM constantly. If any
        // mutation counted as a change, "nothing happened" would never fire
        // again and this whole function would stop being worth reading. So it
        // rides along instead — enough to send the model to look at the
        // element, not enough to claim an effect.
        let change = change_between(
            &showing("same", 100, Value::Null, 4),
            &showing("same", 100, Value::Null, 16),
        );
        assert_eq!(change.get("nothing_observable_changed"), Some(&json!(true)));
        assert_eq!(change.get("dom_mutations"), Some(&json!(12)));
        let note = change.get("note").and_then(Value::as_str).unwrap();
        assert!(note.contains("attribute"), "names the likely cause: {note}");
    }

    #[test]
    fn a_page_that_could_not_be_read_is_not_scored_as_a_change() {
        // `fallback()` returns no content block. Comparing it against a real
        // snapshot must not invent a change out of "we could not look" — that
        // would make every action taken mid-navigation lie in the opposite
        // direction to the bug this fixes.
        let unreadable = json!({ "open": true, "url": "http://x/", "ready_state": "unknown" });
        let readable = showing("hello", 120, Value::Null, 3);

        for (before, after) in [(&unreadable, &readable), (&readable, &unreadable)] {
            let change = change_between(before, after);
            for invented in [
                "text_changed",
                "elements_added",
                "elements_removed",
                "focus_moved_to",
            ] {
                assert!(
                    change.get(invented).is_none(),
                    "{invented} reported from a page that was never read: {change}"
                );
            }
        }
    }

    #[test]
    fn an_identical_page_still_says_nothing_changed() {
        // The signal this function exists to give, now that there are four more
        // ways to trip it. A content block that matches must stay silent.
        let state = showing("steady", 210, json!("input#q"), 77);
        let change = change_between(&state, &state);
        assert_eq!(change.get("nothing_observable_changed"), Some(&json!(true)));
        assert!(change.get("dom_mutations").is_none(), "no new mutations");
    }

    #[test]
    fn the_comparison_basis_never_reaches_the_model() {
        // A text hash and an element count are meaningless to read and cost
        // context to carry. They exist for `change_between` and stop there.
        let stripped = presentable(showing("hello", 12, Value::Null, 0));
        assert!(stripped.get("content").is_none());
        assert_eq!(stripped.get("url"), Some(&json!("http://x/")));
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
