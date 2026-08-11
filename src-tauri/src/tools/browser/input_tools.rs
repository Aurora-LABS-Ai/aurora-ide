//! Real pointer and keyboard input for the Browser panel.
//!
//! Split from `devtools_tools` (emulation) because this half is where the
//! "script cannot do this" argument is sharpest:
//!
//! * `dispatchEvent(new KeyboardEvent("keydown", {key:"Tab"}))` runs the
//!   page's handlers and then **does nothing**. Focus does not move. A
//!   keyboard-navigation audit built on it walks zero stops and passes.
//! * `dispatchEvent(new MouseEvent("mouseover"))` fires JS handlers but never
//!   puts a pointer anywhere, so CSS `:hover` never paints and a screenshot
//!   taken afterwards shows the resting state.
//!
//! `Input.dispatchKeyEvent` and `Input.dispatchMouseEvent` go through the
//! browser's real input pipeline, so both actually happen.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::services::browser_runtime::BrowserManager;

use super::{ensure_agent_browser, require_string, AGENT_BROWSER_LABEL};

/// CDP needs more than a key name: `windowsVirtualKeyCode` is what actually
/// drives focus movement and editing commands, and `text` is what actually
/// inserts a character. Guessing either produces the silent no-op this module
/// exists to prevent, so the supported set is explicit.
///
/// Returns `(key, code, virtual_key_code, text)`.
fn resolve_key(name: &str) -> Option<(&'static str, &'static str, i64, &'static str)> {
    Some(match name {
        "Tab" => ("Tab", "Tab", 9, "\t"),
        "Enter" => ("Enter", "Enter", 13, "\r"),
        "Escape" => ("Escape", "Escape", 27, ""),
        "Space" => (" ", "Space", 32, " "),
        "Backspace" => ("Backspace", "Backspace", 8, ""),
        "Delete" => ("Delete", "Delete", 46, ""),
        "ArrowUp" => ("ArrowUp", "ArrowUp", 38, ""),
        "ArrowDown" => ("ArrowDown", "ArrowDown", 40, ""),
        "ArrowLeft" => ("ArrowLeft", "ArrowLeft", 37, ""),
        "ArrowRight" => ("ArrowRight", "ArrowRight", 39, ""),
        "Home" => ("Home", "Home", 36, ""),
        "End" => ("End", "End", 35, ""),
        "PageUp" => ("PageUp", "PageUp", 33, ""),
        "PageDown" => ("PageDown", "PageDown", 34, ""),
        _ => return None,
    })
}

/// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
fn modifier_mask(input: &Value) -> i64 {
    let flag = |key: &str, bit: i64| {
        if input.get(key).and_then(Value::as_bool) == Some(true) {
            bit
        } else {
            0
        }
    };
    flag("alt", 1) | flag("ctrl", 2) | flag("meta", 4) | flag("shift", 8)
}

/// Read the result of a `Runtime.evaluate` call, which nests the real value
/// under `result.value`.
fn evaluate_value(response: &Value) -> Value {
    response
        .get("result")
        .and_then(|r| r.get("value"))
        .cloned()
        .unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

pub struct BrowserPressKeyTool {
    manager: Arc<BrowserManager>,
}
impl BrowserPressKeyTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }

    /// Describe whatever is focused right now, including whether it has a
    /// visible focus indicator — the thing a keyboard audit is actually
    /// checking.
    ///
    /// A failure here is reported inline rather than failing the call: the
    /// key press already happened, and hiding that would be worse than an
    /// undescribed stop.
    async fn focused_element(&self) -> Value {
        const SCRIPT: &str = concat!(
            "(() => {",
            "  const el = document.activeElement;",
            "  if (!el || el === document.body) return { focused: null };",
            "  const s = getComputedStyle(el);",
            "  const r = el.getBoundingClientRect();",
            "  const label = (el.getAttribute('aria-label') || el.textContent || '').trim();",
            "  return {",
            "    tag: el.tagName.toLowerCase(),",
            "    id: el.id || undefined,",
            "    role: el.getAttribute('role') || undefined,",
            "    name: label ? label.slice(0, 80) : undefined,",
            "    visible: r.width > 0 && r.height > 0,",
            "    inViewport: r.top >= 0 && r.bottom <= innerHeight,",
            "    outline: s.outlineStyle !== 'none' ? (s.outlineWidth + ' ' + s.outlineColor) : 'none',",
            "    boxShadow: s.boxShadow !== 'none' ? s.boxShadow.slice(0, 60) : undefined",
            "  };",
            "})()"
        );
        match self
            .manager
            .call_devtools(
                AGENT_BROWSER_LABEL,
                "Runtime.evaluate",
                json!({ "expression": SCRIPT, "returnByValue": true }),
            )
            .await
        {
            Ok(value) => evaluate_value(&value),
            Err(err) => json!({ "focusReadFailed": err }),
        }
    }
}

#[async_trait]
impl ToolExecutor for BrowserPressKeyTool {
    fn name(&self) -> &str {
        "browser_press_key"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_press_key".into(),
            description: "Press a real key in the Browser panel. This is genuine input, so Tab \
                actually moves focus — use it to walk a page's keyboard path and check focus \
                order and visible focus rings, or to press Enter/Escape/arrows on a control. \
                Returns what ended up focused after each press (with its outline / box-shadow), \
                so the traversal can be judged without a screenshot per step. Windows only."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "enum": ["Tab", "Enter", "Escape", "Space", "Backspace", "Delete",
                                 "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
                                 "Home", "End", "PageUp", "PageDown"],
                        "description": "Which key to press."
                    },
                    "shift": { "type": "boolean", "description": "Hold Shift — with Tab this walks focus BACKWARDS." },
                    "ctrl": { "type": "boolean", "description": "Hold Ctrl." },
                    "alt": { "type": "boolean", "description": "Hold Alt." },
                    "meta": { "type": "boolean", "description": "Hold Meta / Windows key." },
                    "repeat": {
                        "type": "number",
                        "description": "Press this many times, 1-50. Use it to walk a whole tab order in one call and get the full focus trail back."
                    }
                },
                "required": ["key"]
            }),
        }
    }
    fn requires_permission(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;

        let name = require_string(&input, "key")?;
        let (key, code, vk, text) = resolve_key(name).ok_or_else(|| {
            ToolError::InvalidInput(format!(
                "`key` \"{name}\" is not supported. Use one of: Tab, Enter, Escape, Space, \
                 Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, \
                 PageUp, PageDown. To type text into a field, use browser_fill instead."
            ))
        })?;
        let modifiers = modifier_mask(&input);
        let repeat = input
            .get("repeat")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .clamp(1, 50);

        // The whole trail, not just the final stop: an audit needs the ORDER,
        // and per-press focus is the only way to see a focus trap or a control
        // the tab order skips.
        let mut trail: Vec<Value> = Vec::new();
        for _ in 0..repeat {
            ctx.bail_if_cancelled()?;
            for kind in ["rawKeyDown", "char", "keyUp"] {
                // `char` is what inserts a character. A key with no text
                // (Escape, arrows) must not send one, or the page sees a
                // phantom insertion.
                if kind == "char" && text.is_empty() {
                    continue;
                }
                let mut params = json!({
                    "type": kind,
                    "key": key,
                    "code": code,
                    "windowsVirtualKeyCode": vk,
                    "nativeVirtualKeyCode": vk,
                    "modifiers": modifiers,
                });
                if !text.is_empty() {
                    params["text"] = json!(text);
                }
                self.manager
                    .call_devtools(AGENT_BROWSER_LABEL, "Input.dispatchKeyEvent", params)
                    .await
                    .map_err(ToolError::Execution)?;
            }
            trail.push(self.focused_element().await);
        }

        Ok(json!({
            "key": name,
            "presses": repeat,
            "focusTrail": trail,
            "message": "Real key input — focus moved for real, so this is the page's actual \
                        keyboard path, not a simulation."
        })
        .to_string())
    }
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

pub struct BrowserHoverTool {
    manager: Arc<BrowserManager>,
}
impl BrowserHoverTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }

    async fn move_pointer(&self, x: f64, y: f64) -> Result<(), ToolError> {
        self.manager
            .call_devtools(
                AGENT_BROWSER_LABEL,
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0 }),
            )
            .await
            .map_err(ToolError::Execution)?;
        Ok(())
    }
}

#[async_trait]
impl ToolExecutor for BrowserHoverTool {
    fn name(&self) -> &str {
        "browser_hover"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_hover".into(),
            description: "Move the real pointer over an element in the Browser panel, so CSS \
                :hover actually paints. Use it to verify hover styling, open a hover menu, or \
                reveal hover-only content — then take a screenshot. The pointer STAYS there \
                until you hover something else or pass reset: true, which is what makes the \
                screenshot possible. Get selectors from browser_page_outline. Windows only."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "selector": { "type": "string", "description": "CSS selector of the element to hover." },
                    "reset": { "type": "boolean", "description": "Move the pointer off the page so nothing is hovered. Ignores `selector`." }
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

        if input.get("reset").and_then(Value::as_bool) == Some(true) {
            self.move_pointer(-1.0, -1.0).await?;
            // The real pointer left the page, so the drawn one must go with it
            // rather than sit there implying something is still hovered.
            let _ = self
                .manager
                .eval_with_result(AGENT_BROWSER_LABEL, &super::pointer::hide_expr())
                .await;
            return Ok(json!({
                "hover": "reset",
                "message": "Pointer moved off the page — nothing is hovered."
            })
            .to_string());
        }

        let selector = require_string(&input, "selector")?;
        // Centre of the element in viewport coordinates, AFTER scrolling it
        // into view: a pointer move to an off-screen point hovers whatever is
        // really at those coordinates, which is a quietly wrong answer rather
        // than an error.
        let encoded = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
        let script = format!(
            concat!(
                "(() => {{",
                "  const el = document.querySelector({sel});",
                "  if (!el) return {{ found: false }};",
                "  el.scrollIntoView({{ block: 'center', inline: 'center' }});",
                "  const r = el.getBoundingClientRect();",
                "  if (r.width === 0 || r.height === 0) return {{ found: true, visible: false }};",
                "  return {{ found: true, visible: true,",
                "            x: r.left + r.width / 2, y: r.top + r.height / 2 }};",
                "}})()"
            ),
            sel = encoded,
        );
        let response = self
            .manager
            .call_devtools(
                AGENT_BROWSER_LABEL,
                "Runtime.evaluate",
                json!({ "expression": script, "returnByValue": true }),
            )
            .await
            .map_err(ToolError::Execution)?;
        let located = evaluate_value(&response);

        if located.get("found").and_then(Value::as_bool) != Some(true) {
            return Err(ToolError::Execution(format!(
                "no element matches `{selector}`. Run browser_page_outline to get selectors that \
                 exist on this page."
            )));
        }
        if located.get("visible").and_then(Value::as_bool) != Some(true) {
            return Err(ToolError::Execution(format!(
                "`{selector}` exists but has no size on screen, so there is nothing to hover."
            )));
        }
        let x = located.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = located.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        self.move_pointer(x, y).await?;
        // Draw the cursor at the SAME coordinates the real pointer went to,
        // rather than re-deriving them from the selector — a drawn cursor that
        // disagrees with where the pointer actually is would be worse than
        // none. No ripple: hovering is not pressing.
        let _ = self
            .manager
            .eval_with_result(
                AGENT_BROWSER_LABEL,
                &super::pointer::point_at_xy_expr(x, y, false),
            )
            .await;

        Ok(json!({
            "hovered": selector,
            "at": { "x": x.round() as i64, "y": y.round() as i64 },
            "message": "Real pointer move — CSS :hover is painting now. Screenshot before you \
                        hover anything else."
        })
        .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_advertised_key_resolves() {
        // The schema's enum and `resolve_key` must not drift: a key the schema
        // advertises but the resolver rejects is a guaranteed dead call.
        for key in [
            "Tab",
            "Enter",
            "Escape",
            "Space",
            "Backspace",
            "Delete",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "PageUp",
            "PageDown",
        ] {
            assert!(
                resolve_key(key).is_some(),
                "{key} is advertised but unresolvable"
            );
        }
    }

    #[test]
    fn keys_with_no_text_send_no_character() {
        // Sending a `char` event for Escape or an arrow inserts a phantom
        // character into whatever is focused.
        for key in ["Escape", "ArrowUp", "Delete", "Backspace"] {
            let (_, _, _, text) = resolve_key(key).expect("resolvable");
            assert!(text.is_empty(), "{key} must not carry text");
        }
        assert_eq!(resolve_key("Tab").expect("resolvable").3, "\t");
    }

    #[test]
    fn unknown_keys_are_rejected_rather_than_guessed() {
        assert!(resolve_key("F13").is_none());
        assert!(resolve_key("a").is_none());
        assert!(resolve_key("").is_none());
    }

    #[test]
    fn modifiers_use_the_cdp_bitmask() {
        assert_eq!(modifier_mask(&json!({})), 0);
        assert_eq!(modifier_mask(&json!({ "shift": true })), 8);
        assert_eq!(modifier_mask(&json!({ "ctrl": true, "alt": true })), 3);
        assert_eq!(
            modifier_mask(&json!({ "alt": true, "ctrl": true, "meta": true, "shift": true })),
            15
        );
        // Explicit false is not "held".
        assert_eq!(modifier_mask(&json!({ "shift": false })), 0);
    }

    #[test]
    fn evaluate_value_unwraps_the_cdp_envelope() {
        let response = json!({ "result": { "type": "object", "value": { "tag": "button" } } });
        assert_eq!(evaluate_value(&response)["tag"], "button");
        // A shape we don't recognise yields null rather than panicking.
        assert!(evaluate_value(&json!({ "wat": 1 })).is_null());
    }
}
