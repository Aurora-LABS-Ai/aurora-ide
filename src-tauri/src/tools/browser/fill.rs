//! `browser_fill` — one strategy per kind of field, and the value read back.
//!
//! The old fill was one JavaScript snippet: set `el.value` through the
//! prototype setter, dispatch `input` and `change`, done. It worked for a
//! plain React input and reported success for everything else — a Lexical
//! editor that ignores `textContent` writes, a masked phone field that
//! reformats on keystroke, a `<select>` handed the option's TEXT instead of
//! its value, a checkbox handed the string "true". Twelve real sessions
//! measured the other half of the problem: 21 of 33 fills answered
//! `nothing_observable_changed`, because a value is not rendered text and
//! nothing read the field back.
//!
//! Now the field decides the method:
//!
//! | field | how |
//! |---|---|
//! | text, search, email, url, tel, password, number, textarea, contenteditable | real click to focus, select all, `Input.insertText` — the browser's own edit path, so every framework and editor sees a real input |
//! | `<select>` | option matched by value, then by visible text; `input` + `change` dispatched |
//! | checkbox, radio | `"true"`/`"false"` compared with the current state; a real click when it differs |
//! | date, time, datetime-local, month, week, color, range | value setter + events (these cannot be typed into) |
//! | file | refused — a file input cannot be set from script |
//!
//! Every path ends by READING THE FIELD BACK and returning `value_after`.
//! When the typed path lands a different value than requested (a mask, a
//! formatter, a component that rewrites on input), the setter path is tried
//! and read back too, and a value the page insists on rewriting is reported
//! as such rather than as success.

use serde_json::{json, Value};

use crate::agent_runtime::tool_executor::ToolError;
use crate::services::browser_runtime::BrowserManager;

use super::{input_tools, locate_target, pointer, unwrap_browser_result, AGENT_BROWSER_LABEL};

/// What kind of field this is, from the page's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldKind {
    Text,
    Select,
    Checkable,
    Direct,
    File,
}

impl FieldKind {
    fn classify(tag: &str, input_type: Option<&str>, contenteditable: bool) -> Self {
        match tag {
            "select" => Self::Select,
            "textarea" => Self::Text,
            "input" => match input_type.unwrap_or("text") {
                "checkbox" | "radio" => Self::Checkable,
                "file" => Self::File,
                "date" | "time" | "datetime-local" | "month" | "week" | "color" | "range"
                | "hidden" => Self::Direct,
                _ => Self::Text,
            },
            _ if contenteditable => Self::Text,
            _ => Self::Direct,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Select => "select",
            Self::Checkable => "checkable",
            Self::Direct => "direct",
            Self::File => "file",
        }
    }
}

/// Everything the strategy needs to know about the field, in one read.
const DESCRIBE_JS: &str = r#"(() => {
  const el = document.querySelector(__SEL__);
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : null;
  const out = {
    tag, type,
    contenteditable: !!el.isContentEditable,
    disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
    readonly: !!el.readOnly,
    in_form: !!(el.form || el.closest('form')),
  };
  if (tag === 'select') {
    out.options = Array.from(el.options).slice(0, 200).map((o) => ({ value: o.value, text: (o.textContent || '').replace(/\s+/g, ' ').trim() }));
  }
  if (type === 'checkbox' || type === 'radio') out.checked = !!el.checked;
  return out;
})()"#;

/// The field's current value, as a string, in the same shape for every kind.
const READ_BACK_JS: &str = r#"(() => {
  const el = document.querySelector(__SEL__);
  if (!el) return null;
  if (el.isContentEditable) return String(el.innerText !== undefined ? el.innerText : el.textContent) || '';
  if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? 'true' : 'false';
  return typeof el.value === 'string' ? el.value : null;
})()"#;

/// Select everything in the focused field so the next insert replaces it.
const SELECT_ALL_JS: &str = r#"(() => {
  const el = document.querySelector(__SEL__);
  if (!el) return false;
  if (typeof el.select === 'function' && !el.isContentEditable) { el.select(); return 'select'; }
  const target = el.isContentEditable ? el : (document.activeElement && document.activeElement.isContentEditable ? document.activeElement : el);
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(target);
  selection.removeAllRanges();
  selection.addRange(range);
  return 'range';
})()"#;

/// Pick an option by value, then by visible text (exact, then contains).
const SELECT_OPTION_JS: &str = r#"(() => {
  const el = document.querySelector(__SEL__);
  if (!el) return { matched: null };
  const want = __VALUE__;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const lower = norm(want).toLowerCase();
  const options = Array.from(el.options);
  let opt = options.find((o) => o.value === want)
    || options.find((o) => norm(o.textContent).toLowerCase() === lower)
    || options.find((o) => norm(o.textContent).toLowerCase().includes(lower));
  if (!opt) return { matched: null };
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (setter && setter.set) setter.set.call(el, opt.value); else el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { matched: { value: opt.value, text: norm(opt.textContent) } };
})()"#;

/// Submit the field's form, if it has one. Says whether it did.
const SUBMIT_FORM_JS: &str = r#"(() => {
  const el = document.querySelector(__SEL__);
  const form = el && (el.form || el.closest('form'));
  if (!form) return { form: false };
  if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
  return { form: true };
})()"#;

/// Focus the field from script — the fallback when a real click is not
/// possible — so an Enter press afterwards lands in it.
const FOCUS_JS: &str = r#"(() => { const el = document.querySelector(__SEL__); if (el && el.focus) { el.focus(); return true; } return false; })()"#;

fn with_selector(script: &str, selector: &str) -> String {
    script.replace("__SEL__", &json!(selector).to_string())
}

async fn eval(manager: &BrowserManager, script: &str) -> Result<Value, ToolError> {
    let result = manager
        .eval_with_result(AGENT_BROWSER_LABEL, script)
        .await
        .map_err(ToolError::Execution)?;
    unwrap_browser_result(result)
}

async fn read_back(manager: &BrowserManager, selector: &str) -> Option<String> {
    eval(manager, &with_selector(READ_BACK_JS, selector))
        .await
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
}

/// Does what the field holds now match what was asked for?
///
/// Exact first. A contenteditable's `innerText` carries the editor's own
/// line breaks and trailing newline, so whitespace is collapsed for those.
fn value_matches(kind: FieldKind, wanted: &str, actual: &str) -> bool {
    if wanted == actual {
        return true;
    }
    let collapse = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    match kind {
        FieldKind::Text => collapse(wanted) == collapse(actual),
        _ => wanted.trim() == actual.trim(),
    }
}

/// `"true"` / `"false"` and the spellings people use for them.
fn parse_checked(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "on" | "checked" | "yes" | "1" | "check" => Some(true),
        "false" | "off" | "unchecked" | "no" | "0" | "uncheck" => Some(false),
        _ => None,
    }
}

/// The whole fill: classify, act, read back, optionally submit.
pub(super) async fn fill_field(
    manager: &BrowserManager,
    selector: &str,
    value: &str,
    submit: bool,
) -> Result<Value, ToolError> {
    let info = eval(manager, &with_selector(DESCRIBE_JS, selector)).await?;
    if info.is_null() {
        return Err(ToolError::Execution(format!(
            "no element matches `{selector}` on the current page. Run browser_view to get \
             selectors that exist on this page."
        )));
    }
    let tag = info.get("tag").and_then(Value::as_str).unwrap_or("");
    let input_type = info.get("type").and_then(Value::as_str);
    let contenteditable = info.get("contenteditable").and_then(Value::as_bool) == Some(true);
    let kind = FieldKind::classify(tag, input_type, contenteditable);

    if info.get("disabled").and_then(Value::as_bool) == Some(true) {
        return Err(ToolError::Execution(format!(
            "`{selector}` is disabled, so it cannot take a value. Whatever enables it has not \
             happened yet."
        )));
    }
    if info.get("readonly").and_then(Value::as_bool) == Some(true) {
        return Err(ToolError::Execution(format!(
            "`{selector}` is read-only: the page sets its value, a person cannot. Look for the \
             control that drives it (a picker, a toggle, another field)."
        )));
    }
    if kind == FieldKind::File {
        return Err(ToolError::Execution(format!(
            "`{selector}` is a file input, which cannot be set from a page. There is no way to \
             attach a file through the Browser panel."
        )));
    }

    let mut out = serde_json::Map::new();
    out.insert("ok".into(), json!(true));
    out.insert("selector".into(), json!(selector));
    out.insert("field".into(), json!(kind.name()));
    if let Some(t) = input_type {
        out.insert("input_type".into(), json!(t));
    }

    match kind {
        FieldKind::Select => {
            let script = SELECT_OPTION_JS
                .replace("__SEL__", &json!(selector).to_string())
                .replace("__VALUE__", &json!(value).to_string());
            let picked = eval(manager, &script).await?;
            match picked.get("matched").filter(|m| !m.is_null()) {
                Some(matched) => {
                    out.insert("method".into(), json!("select_option"));
                    out.insert("matched_option".into(), matched.clone());
                }
                None => {
                    let options: Vec<String> = info
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|list| {
                            list.iter()
                                .take(20)
                                .map(|o| {
                                    format!(
                                        "{} ({})",
                                        o.get("text").and_then(Value::as_str).unwrap_or(""),
                                        o.get("value").and_then(Value::as_str).unwrap_or("")
                                    )
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    return Err(ToolError::Execution(format!(
                        "no option in `{selector}` matches \"{value}\" by value or text. Its \
                         options are: {}.",
                        options.join(", ")
                    )));
                }
            }
        }
        FieldKind::Checkable => {
            let desired = parse_checked(value).ok_or_else(|| {
                ToolError::InvalidInput(format!(
                    "`{selector}` is a {}; `value` must be \"true\" or \"false\", not \"{value}\".",
                    input_type.unwrap_or("checkbox")
                ))
            })?;
            let current = info.get("checked").and_then(Value::as_bool).unwrap_or(false);
            if current == desired {
                out.insert("method".into(), json!("already_set"));
            } else {
                click_field(manager, selector).await?;
                out.insert("method".into(), json!("real_click"));
            }
        }
        FieldKind::Direct => {
            set_by_setter(manager, selector, value).await?;
            out.insert("method".into(), json!("value_setter"));
        }
        FieldKind::Text => {
            let typed = if manager.devtools_available() {
                type_into(manager, selector, value).await
            } else {
                Err("no DevTools channel on this platform".to_string())
            };
            match typed {
                Ok(()) => {
                    out.insert("method".into(), json!("real_input"));
                }
                Err(why) => {
                    // The value still has to land. The setter path is what
                    // the old tool always did; it is the fallback, and the
                    // result says so.
                    set_by_setter(manager, selector, value).await?;
                    out.insert("method".into(), json!("value_setter"));
                    out.insert(
                        "note".into(),
                        json!(format!(
                            "Could not type into the field ({why}), so the value was set directly \
                             and input/change events dispatched. Editors that only listen to real \
                             keystrokes may not have taken it."
                        )),
                    );
                }
            }
        }
        FieldKind::File => unreachable!("refused above"),
    }

    // Read it back. This is the sentence the tool exists to say.
    let mut after = read_back(manager, selector).await;
    let wanted = match kind {
        FieldKind::Checkable => parse_checked(value).map(|b| b.to_string()).unwrap_or_default(),
        // A select filled by visible text holds the matched option's VALUE
        // afterwards, so the raw argument ("Pro") can never equal the field
        // ("pro"). Compare against the option that was actually chosen, or a
        // by-text fill — a documented, successful path — reads as the page
        // rejecting the input (aurora-tool-findings.md, 2026-09-11, finding 2).
        FieldKind::Select => out
            .get("matched_option")
            .and_then(|m| m.get("value"))
            .and_then(Value::as_str)
            .unwrap_or(value)
            .to_string(),
        _ => value.to_string(),
    };
    let mut matched = after
        .as_deref()
        .is_some_and(|actual| value_matches(kind, &wanted, actual));

    if !matched && kind == FieldKind::Text && out.get("method") == Some(&json!("real_input")) {
        // Typing landed something else — a mask, a formatter, or an editor
        // that transformed the input. Try the direct setter once and read
        // back again before reporting.
        set_by_setter(manager, selector, value).await?;
        after = read_back(manager, selector).await;
        matched = after
            .as_deref()
            .is_some_and(|actual| value_matches(kind, &wanted, actual));
        out.insert("method".into(), json!("real_input_then_value_setter"));
    }

    out.insert(
        "value_after".into(),
        after.clone().map(Value::String).unwrap_or(Value::Null),
    );
    out.insert("value_matches".into(), json!(matched));
    if !matched {
        out.insert(
            "note".into(),
            json!(format!(
                "The field now holds {} rather than what was sent. The page reformatted or \
                 rejected the value — read the field's own rules (a mask, a max length, a \
                 validator) before sending it again.",
                after
                    .as_deref()
                    .map(|a| format!("\"{}\"", a.chars().take(120).collect::<String>()))
                    .unwrap_or_else(|| "nothing readable".into())
            )),
        );
    }

    if submit {
        let submitted = eval(manager, &with_selector(SUBMIT_FORM_JS, selector)).await?;
        if submitted.get("form").and_then(Value::as_bool) == Some(true) {
            out.insert("submitted".into(), json!("form"));
        } else if manager.devtools_available() {
            // No form to submit: press Enter in the field, which is what a
            // person does and what a search box or a chat composer listens for.
            let _ = eval(manager, &with_selector(FOCUS_JS, selector)).await;
            let enter = input_tools::parse_chord("Enter").map_err(ToolError::InvalidInput)?;
            input_tools::press_chord(manager, &enter).await?;
            out.insert("submitted".into(), json!("enter_key"));
        } else {
            out.insert("submitted".into(), json!("none"));
            out.insert(
                "submit_note".into(),
                json!("The field is not inside a form and there is no DevTools channel to press \
                       Enter with, so nothing was submitted."),
            );
        }
    }

    Ok(Value::Object(out))
}

/// The real path: click to focus, select everything, replace it.
async fn type_into(manager: &BrowserManager, selector: &str, value: &str) -> Result<(), String> {
    let located = locate_target(manager, Some(selector), None, 2_000)
        .await
        .map_err(|e| e.to_string())?;
    let x = located.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = located.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    // The user watching the panel sees the cursor land on the field and a
    // press — because that is exactly what is about to happen.
    let _ = manager
        .eval_with_result(AGENT_BROWSER_LABEL, &pointer::point_at_xy_expr(x, y, true))
        .await;
    input_tools::real_click_at(manager, x, y, input_tools::MouseButton::Left, 1)
        .await
        .map_err(|e| e.to_string())?;
    eval(manager, &with_selector(SELECT_ALL_JS, selector))
        .await
        .map_err(|e| e.to_string())?;
    if value.is_empty() {
        // Inserting "" is a no-op; deleting the selection is how a field is
        // cleared through the real input path.
        let backspace = input_tools::parse_chord("Backspace")?;
        input_tools::press_chord(manager, &backspace)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        input_tools::insert_text(manager, value)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A real click on the field itself (checkbox / radio), or the script click
/// where there is no DevTools channel.
async fn click_field(manager: &BrowserManager, selector: &str) -> Result<(), ToolError> {
    if manager.devtools_available() {
        if let Ok(located) = locate_target(manager, Some(selector), None, 1_000).await {
            let x = located.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let y = located.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            let _ = manager
                .eval_with_result(AGENT_BROWSER_LABEL, &pointer::point_at_xy_expr(x, y, true))
                .await;
            return input_tools::real_click_at(manager, x, y, input_tools::MouseButton::Left, 1)
                .await;
        }
    }
    // Visually-hidden native checkboxes behind a styled label are common;
    // a script click on the input still toggles it and fires `change`.
    let script = format!(
        "(() => {{ const el = document.querySelector({s}); if (!el) throw new Error('no element'); \
         el.click(); return true; }})()",
        s = json!(selector)
    );
    eval(manager, &script).await.map(|_| ())
}

/// The old path, kept as the fallback: prototype setter + `input` + `change`.
async fn set_by_setter(manager: &BrowserManager, selector: &str, value: &str) -> Result<(), ToolError> {
    let result = manager
        .fill(AGENT_BROWSER_LABEL, selector, value, false)
        .await
        .map_err(ToolError::Execution)?;
    unwrap_browser_result(result).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_are_classified_by_what_can_be_typed_into() {
        assert_eq!(FieldKind::classify("input", Some("text"), false), FieldKind::Text);
        assert_eq!(FieldKind::classify("input", Some("email"), false), FieldKind::Text);
        assert_eq!(FieldKind::classify("input", None, false), FieldKind::Text);
        assert_eq!(FieldKind::classify("textarea", None, false), FieldKind::Text);
        assert_eq!(FieldKind::classify("div", None, true), FieldKind::Text);
        assert_eq!(FieldKind::classify("select", None, false), FieldKind::Select);
        assert_eq!(FieldKind::classify("input", Some("checkbox"), false), FieldKind::Checkable);
        assert_eq!(FieldKind::classify("input", Some("radio"), false), FieldKind::Checkable);
        assert_eq!(FieldKind::classify("input", Some("date"), false), FieldKind::Direct);
        assert_eq!(FieldKind::classify("input", Some("color"), false), FieldKind::Direct);
        assert_eq!(FieldKind::classify("input", Some("file"), false), FieldKind::File);
    }

    /// Finding 2: a select filled by visible text holds the option's VALUE,
    /// so the comparison has to be against the matched option, not the
    /// argument. Pinned on the helper the read-back uses.
    #[test]
    fn a_select_read_back_is_judged_against_the_chosen_option_value() {
        // "Pro" was sent, option value "pro" was chosen, the field holds "pro".
        assert!(value_matches(FieldKind::Select, "pro", "pro"));
        assert!(!value_matches(FieldKind::Select, "Pro", "pro"), "the raw text must not be the basis");
    }

    #[test]
    fn checkbox_values_accept_the_usual_spellings_and_refuse_the_rest() {
        assert_eq!(parse_checked("true"), Some(true));
        assert_eq!(parse_checked("Checked"), Some(true));
        assert_eq!(parse_checked("off"), Some(false));
        assert_eq!(parse_checked("0"), Some(false));
        assert_eq!(parse_checked("maybe"), None);
    }

    /// A contenteditable's innerText carries the editor's own line breaks and
    /// trailing newline; those are not a mismatch.
    #[test]
    fn contenteditable_read_back_is_compared_loosely_inputs_exactly() {
        assert!(value_matches(FieldKind::Text, "hello world", "hello  world\n"));
        assert!(!value_matches(FieldKind::Text, "hello world", "hello"));
        assert!(value_matches(FieldKind::Direct, "2030-12-31", "2030-12-31"));
        assert!(!value_matches(FieldKind::Direct, "2030-12-31", "2030-12-30"));
    }

    #[test]
    fn every_page_script_reads_the_selector_as_data() {
        // A selector carrying a quote must reach querySelector as a string,
        // never as source.
        let sel = "input[name=\"q\"]";
        for script in [DESCRIBE_JS, READ_BACK_JS, SELECT_ALL_JS, SUBMIT_FORM_JS, FOCUS_JS] {
            let filled = with_selector(script, sel);
            assert!(filled.contains(r#"document.querySelector("input[name=\"q\"]")"#), "{filled}");
            assert!(!filled.contains("__SEL__"));
        }
    }

    #[test]
    fn select_matching_prefers_value_then_exact_text_then_partial_text() {
        // Order is encoded in the script; a regression here would silently
        // pick "Other" for a value of "the".
        let value_at = SELECT_OPTION_JS.find("o.value === want").unwrap();
        let exact_at = SELECT_OPTION_JS.find("toLowerCase() === lower").unwrap();
        let partial_at = SELECT_OPTION_JS.find("includes(lower)").unwrap();
        assert!(value_at < exact_at && exact_at < partial_at);
    }
}
