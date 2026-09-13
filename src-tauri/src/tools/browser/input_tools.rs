//! Real pointer and keyboard input for the Browser panel.
//!
//! Split from `devtools_tools` (emulation) because this half is where the
//! "script cannot do this" argument is sharpest:
//!
//! * `el.click()` dispatches ONE `click` event. It fires no `pointerdown`,
//!   no `mousedown`, no `focus`. Every component library that opens on
//!   pointer-down — Radix, Headless UI, Base UI, MUI's menus — sees nothing,
//!   and the tool reports `ok: true` over a menu that never opened
//!   (`reports/aurora-issues.md`, 2026-09-11: the same button opened at once
//!   from a real Enter key).
//! * `dispatchEvent(new KeyboardEvent("keydown", {key:"Tab"}))` runs the
//!   page's handlers and then **does nothing**. Focus does not move. A
//!   keyboard-navigation audit built on it walks zero stops and passes.
//! * `dispatchEvent(new MouseEvent("mouseover"))` fires JS handlers but never
//!   puts a pointer anywhere, so CSS `:hover` never paints.
//!
//! `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` and
//! `Input.insertText` go through the browser's real input pipeline, so a
//! press is a press, focus really moves, and text really lands in the
//! focused field. The helpers here are shared by `browser_click`,
//! `browser_fill`, `browser_type` and `browser_press_key`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::services::browser_runtime::BrowserManager;

use super::{ensure_agent_browser, require_string, AGENT_BROWSER_LABEL};

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// CDP modifier bits.
pub(super) const MOD_ALT: i64 = 1;
pub(super) const MOD_CTRL: i64 = 2;
pub(super) const MOD_META: i64 = 4;
pub(super) const MOD_SHIFT: i64 = 8;

/// One key press, resolved to what CDP needs.
///
/// CDP needs more than a key name: `windowsVirtualKeyCode` is what actually
/// drives focus movement and editing commands, and `text` is what actually
/// inserts a character. Guessing either produces a silent no-op, so every
/// field is resolved here and nowhere else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct KeyChord {
    /// The `key` value the page sees (`"Enter"`, `"a"`, `"?"`).
    pub key: String,
    /// The `code` value (`"Enter"`, `"KeyA"`); empty when unknown.
    pub code: String,
    /// Windows virtual key code; 0 when unknown (text still inserts).
    pub vk: i64,
    /// Text inserted by the press, empty for keys that insert nothing.
    pub text: String,
    /// CDP modifier bitmask.
    pub modifiers: i64,
}

/// Named keys: `(canonical, code, vk, text)`.
const NAMED_KEYS: &[(&str, &str, i64, &str)] = &[
    ("Tab", "Tab", 9, "\t"),
    ("Enter", "Enter", 13, "\r"),
    ("Escape", "Escape", 27, ""),
    ("Space", "Space", 32, " "),
    ("Backspace", "Backspace", 8, ""),
    ("Delete", "Delete", 46, ""),
    ("Insert", "Insert", 45, ""),
    ("ArrowUp", "ArrowUp", 38, ""),
    ("ArrowDown", "ArrowDown", 40, ""),
    ("ArrowLeft", "ArrowLeft", 37, ""),
    ("ArrowRight", "ArrowRight", 39, ""),
    ("Home", "Home", 36, ""),
    ("End", "End", 35, ""),
    ("PageUp", "PageUp", 33, ""),
    ("PageDown", "PageDown", 34, ""),
    ("F1", "F1", 112, ""),
    ("F2", "F2", 113, ""),
    ("F3", "F3", 114, ""),
    ("F4", "F4", 115, ""),
    ("F5", "F5", 116, ""),
    ("F6", "F6", 117, ""),
    ("F7", "F7", 118, ""),
    ("F8", "F8", 119, ""),
    ("F9", "F9", 120, ""),
    ("F10", "F10", 121, ""),
    ("F11", "F11", 122, ""),
    ("F12", "F12", 123, ""),
];

/// Spellings people use for the named keys.
fn canonical_key_name(name: &str) -> Option<&'static str> {
    let lowered = name.trim().to_ascii_lowercase();
    let canonical = match lowered.as_str() {
        "esc" => "Escape",
        "return" => "Enter",
        "spacebar" => "Space",
        "del" => "Delete",
        "ins" => "Insert",
        "up" | "arrowup" => "ArrowUp",
        "down" | "arrowdown" => "ArrowDown",
        "left" | "arrowleft" => "ArrowLeft",
        "right" | "arrowright" => "ArrowRight",
        "pgup" | "pageup" => "PageUp",
        "pgdn" | "pgdown" | "pagedown" => "PageDown",
        _ => "",
    };
    if !canonical.is_empty() {
        return Some(canonical);
    }
    NAMED_KEYS
        .iter()
        .find(|(k, ..)| k.eq_ignore_ascii_case(&lowered))
        .map(|(k, ..)| *k)
}

/// A single printable character on a US layout: `(code, vk, needs_shift)`.
///
/// Unknown characters get no code and vk 0 — CDP still inserts the `text`,
/// so typing works; only a page that inspects the raw key code would notice.
fn printable(ch: char) -> (String, i64, bool) {
    if ch.is_ascii_alphabetic() {
        let upper = ch.to_ascii_uppercase();
        return (format!("Key{upper}"), i64::from(upper as u8), ch.is_ascii_uppercase());
    }
    if ch.is_ascii_digit() {
        return (format!("Digit{ch}"), i64::from(ch as u8), false);
    }
    let (code, vk, shift) = match ch {
        ' ' => ("Space", 32, false),
        '-' => ("Minus", 189, false),
        '_' => ("Minus", 189, true),
        '=' => ("Equal", 187, false),
        '+' => ("Equal", 187, true),
        ',' => ("Comma", 188, false),
        '<' => ("Comma", 188, true),
        '.' => ("Period", 190, false),
        '>' => ("Period", 190, true),
        '/' => ("Slash", 191, false),
        '?' => ("Slash", 191, true),
        ';' => ("Semicolon", 186, false),
        ':' => ("Semicolon", 186, true),
        '\'' => ("Quote", 222, false),
        '"' => ("Quote", 222, true),
        '[' => ("BracketLeft", 219, false),
        '{' => ("BracketLeft", 219, true),
        ']' => ("BracketRight", 221, false),
        '}' => ("BracketRight", 221, true),
        '\\' => ("Backslash", 220, false),
        '|' => ("Backslash", 220, true),
        '`' => ("Backquote", 192, false),
        '~' => ("Backquote", 192, true),
        '!' => ("Digit1", 49, true),
        '@' => ("Digit2", 50, true),
        '#' => ("Digit3", 51, true),
        '$' => ("Digit4", 52, true),
        '%' => ("Digit5", 53, true),
        '^' => ("Digit6", 54, true),
        '&' => ("Digit7", 55, true),
        '*' => ("Digit8", 56, true),
        '(' => ("Digit9", 57, true),
        ')' => ("Digit0", 48, true),
        _ => ("", 0, false),
    };
    (code.to_string(), vk, shift)
}

/// Parse `"Enter"`, `"a"`, `"?"`, `"Control+a"`, `"Ctrl+Shift+P"`,
/// `"Meta+k"`, `"Shift+Tab"`.
///
/// Modifier words are case-insensitive and accept the common aliases. The
/// final token is the key: a named key, or exactly one character. A bare
/// `"+"` is the plus character, not an empty chord.
pub(super) fn parse_chord(spec: &str) -> Result<KeyChord, String> {
    // A lone space IS a key. Trimming first turned `browser_type " "` into
    // "`key` is empty" (aurora-tool-findings.md, gadget-and-power,
    // 2026-09-11), so whitespace-only text could not be typed at all.
    if spec == " " {
        return parse_chord("Space");
    }
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("`key` is empty".into());
    }
    let tokens: Vec<&str> = if spec == "+" {
        vec!["+"]
    } else if spec.ends_with('+') && spec.len() > 1 {
        // "Control++" or "Shift++": everything before the last '+' is
        // modifiers, the key is '+'.
        let head = &spec[..spec.len() - 1];
        let mut parts: Vec<&str> = head.trim_end_matches('+').split('+').collect();
        parts.push("+");
        parts
    } else {
        spec.split('+').collect()
    };

    let mut modifiers = 0;
    let (key_token, modifier_tokens) = tokens
        .split_last()
        .ok_or_else(|| "`key` is empty".to_string())?;
    for token in modifier_tokens {
        modifiers |= match token.trim().to_ascii_lowercase().as_str() {
            "control" | "ctrl" | "ctl" => MOD_CTRL,
            "shift" => MOD_SHIFT,
            "alt" | "option" | "opt" => MOD_ALT,
            "meta" | "cmd" | "command" | "win" | "windows" | "super" => MOD_META,
            other => {
                return Err(format!(
                    "\"{other}\" is not a modifier. Use Control, Shift, Alt or Meta, joined \
                     with '+', e.g. \"Control+a\" or \"Shift+Tab\"."
                ))
            }
        };
    }

    let key_token = key_token.trim();
    if let Some(name) = canonical_key_name(key_token) {
        let (_, code, vk, text) = NAMED_KEYS
            .iter()
            .find(|(k, ..)| *k == name)
            .copied()
            .expect("canonical names are in the table");
        let key = if name == "Space" { " " } else { name };
        return Ok(finish_chord(key, code, vk, text, modifiers));
    }

    let mut chars = key_token.chars();
    match (chars.next(), chars.next()) {
        (Some(ch), None) => {
            let (code, vk, shift) = printable(ch);
            let modifiers = if shift { modifiers | MOD_SHIFT } else { modifiers };
            Ok(finish_chord(
                &ch.to_string(),
                &code,
                vk,
                &ch.to_string(),
                modifiers,
            ))
        }
        _ => Err(format!(
            "\"{key_token}\" is not a key. Use a named key (Enter, Tab, Escape, Backspace, \
             Delete, arrows, Home, End, PageUp, PageDown, F1-F12), a single character (\"a\", \
             \"?\"), or a chord (\"Control+a\", \"Shift+Tab\"). To type a whole string, use \
             browser_type."
        )),
    }
}

fn finish_chord(key: &str, code: &str, vk: i64, text: &str, modifiers: i64) -> KeyChord {
    // A chord held with Control, Alt or Meta is a command, not a character:
    // Control+a must select all, not insert an "a". Shift alone still types
    // (that is how capitals and '?' are produced).
    let text = if modifiers & (MOD_CTRL | MOD_ALT | MOD_META) != 0 {
        String::new()
    } else {
        text.to_string()
    };
    KeyChord {
        key: key.to_string(),
        code: code.to_string(),
        vk,
        text,
        modifiers,
    }
}

/// Press and release one chord through the browser's input pipeline.
///
/// `keyDown` carries `text` for keys that insert a character — that is what
/// makes the browser insert it — and is a `rawKeyDown` otherwise, which is
/// how Puppeteer and Playwright drive the same protocol.
pub(super) async fn press_chord(manager: &BrowserManager, chord: &KeyChord) -> Result<(), ToolError> {
    let down_type = if chord.text.is_empty() {
        "rawKeyDown"
    } else {
        "keyDown"
    };
    for kind in [down_type, "keyUp"] {
        let mut params = json!({
            "type": kind,
            "key": chord.key,
            "code": chord.code,
            "windowsVirtualKeyCode": chord.vk,
            "nativeVirtualKeyCode": chord.vk,
            "modifiers": chord.modifiers,
        });
        if kind != "keyUp" && !chord.text.is_empty() {
            params["text"] = json!(chord.text);
            params["unmodifiedText"] = json!(chord.text);
        }
        manager
            .call_devtools(AGENT_BROWSER_LABEL, "Input.dispatchKeyEvent", params)
            .await
            .map_err(ToolError::Execution)?;
    }
    Ok(())
}

/// Type `text` as individual key presses, so the page's `keydown`/`keyup`
/// handlers fire for every character — what an autocomplete, a keyboard
/// shortcut, or a character counter listens to. A newline is an Enter press.
pub(super) async fn type_text(
    manager: &BrowserManager,
    text: &str,
    delay_ms: u64,
    ctx: &ToolContext,
) -> Result<usize, ToolError> {
    let mut pressed = 0;
    for ch in text.chars() {
        ctx.bail_if_cancelled()?;
        let chord = match ch {
            '\n' => parse_chord("Enter"),
            '\r' => continue,
            '\t' => parse_chord("Tab"),
            ' ' => parse_chord("Space"),
            other => parse_chord(&other.to_string()),
        }
        .map_err(ToolError::InvalidInput)?;
        press_chord(manager, &chord).await?;
        pressed += 1;
        if delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
    }
    Ok(pressed)
}

/// Insert `text` at the current selection of the focused field in one go.
///
/// Fires `beforeinput`/`input` like a paste does, but no per-key events —
/// the fast path for `browser_fill`, where the value is the point and the
/// keystrokes are not.
pub(super) async fn insert_text(manager: &BrowserManager, text: &str) -> Result<(), ToolError> {
    manager
        .call_devtools(
            AGENT_BROWSER_LABEL,
            "Input.insertText",
            json!({ "text": text }),
        )
        .await
        .map_err(ToolError::Execution)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MouseButton {
    Left,
    Right,
    Middle,
}

impl MouseButton {
    pub(super) fn parse(name: Option<&str>) -> Result<Self, ToolError> {
        match name.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            None | Some("") | Some("left") => Ok(Self::Left),
            Some("right") => Ok(Self::Right),
            Some("middle") => Ok(Self::Middle),
            Some(other) => Err(ToolError::InvalidInput(format!(
                "`button` must be \"left\", \"right\" or \"middle\"; you sent \"{other}\""
            ))),
        }
    }
    fn cdp_name(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Middle => "middle",
        }
    }
    fn mask(self) -> i64 {
        match self {
            Self::Left => 1,
            Self::Right => 2,
            Self::Middle => 4,
        }
    }
}

/// Move the real pointer to `(x, y)` in viewport CSS pixels.
pub(super) async fn move_pointer(manager: &BrowserManager, x: f64, y: f64) -> Result<(), ToolError> {
    manager
        .call_devtools(
            AGENT_BROWSER_LABEL,
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0 }),
        )
        .await
        .map_err(ToolError::Execution)?;
    Ok(())
}

/// A real click at `(x, y)`: move, press, release — `click_count` times, with
/// the count rising so the browser recognises a double-click as one.
///
/// This produces the whole sequence a person's click does — `pointerdown`,
/// `mousedown`, focus, `pointerup`, `mouseup`, `click` — which is exactly the
/// part `el.click()` leaves out.
pub(super) async fn real_click_at(
    manager: &BrowserManager,
    x: f64,
    y: f64,
    button: MouseButton,
    click_count: u32,
) -> Result<(), ToolError> {
    move_pointer(manager, x, y).await?;
    for count in 1..=click_count.max(1) {
        for (kind, buttons) in [("mousePressed", button.mask()), ("mouseReleased", 0)] {
            manager
                .call_devtools(
                    AGENT_BROWSER_LABEL,
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": kind,
                        "x": x,
                        "y": y,
                        "button": button.cdp_name(),
                        "buttons": buttons,
                        "clickCount": count,
                    }),
                )
                .await
                .map_err(ToolError::Execution)?;
        }
    }
    Ok(())
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

/// Describe whatever is focused right now, including whether it has a
/// visible focus indicator — the thing a keyboard audit is actually
/// checking.
///
/// A failure here is reported inline rather than failing the call: the key
/// press already happened, and hiding that would be worse than an
/// undescribed stop.
pub(super) async fn focused_element(manager: &BrowserManager) -> Value {
    const SCRIPT: &str = concat!(
        "(() => {",
        "  const el = document.activeElement;",
        "  if (!el || el === document.body) return { focused: null };",
        "  const s = getComputedStyle(el);",
        "  const r = el.getBoundingClientRect();",
        "  const label = (el.getAttribute('aria-label') || el.textContent || '').trim();",
        "  const out = {",
        "    tag: el.tagName.toLowerCase(),",
        "    id: el.id || undefined,",
        "    role: el.getAttribute('role') || undefined,",
        "    name: label ? label.slice(0, 80) : undefined,",
        "    visible: r.width > 0 && r.height > 0,",
        "    inViewport: r.top >= 0 && r.bottom <= innerHeight,",
        "    outline: s.outlineStyle !== 'none' ? (s.outlineWidth + ' ' + s.outlineColor) : 'none',",
        "    boxShadow: s.boxShadow !== 'none' ? s.boxShadow.slice(0, 60) : undefined",
        "  };",
        "  if (typeof el.value === 'string') out.value = el.value.slice(0, 200);",
        "  return out;",
        "})()"
    );
    match manager
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

/// Put real focus on `selector` by clicking its centre.
///
/// Used by the typing tools when a target is named: `el.focus()` from script
/// does move DOM focus, but a click is what a person does, and it is the only
/// way to also land the caret where a click would (end of the text) and to
/// wake components that open on pointer-down.
pub(super) async fn focus_by_click(manager: &BrowserManager, selector: &str) -> Result<Value, ToolError> {
    let located = super::locate_target(manager, Some(selector), None, 4_000).await?;
    let x = located.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = located.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    let _ = manager
        .eval_with_result(
            AGENT_BROWSER_LABEL,
            &super::pointer::point_at_xy_expr(x, y, false),
        )
        .await;
    real_click_at(manager, x, y, MouseButton::Left, 1).await?;
    Ok(located)
}

// ---------------------------------------------------------------------------
// browser_press_key
// ---------------------------------------------------------------------------

pub struct BrowserPressKeyTool {
    manager: Arc<BrowserManager>,
}
impl BrowserPressKeyTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
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
            description: "Press a real key or key combination in the Browser panel. Genuine \
                input: Tab actually moves focus, Enter actually submits, Escape actually closes \
                a menu, Control+a actually selects all. Accepts a named key (Enter, Tab, Escape, \
                Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12), a \
                single character (\"a\", \"/\", \"?\"), or a chord joined with '+' (\"Control+a\", \
                \"Shift+Tab\", \"Control+Shift+p\", \"Meta+k\"). Pass `selector` to click a field \
                first so the key lands there. Returns what ended up focused after each press \
                (with its outline / box-shadow and value), so a keyboard path can be judged \
                without a screenshot per step. To type a whole string, use browser_type. \
                Windows only."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "The key or chord to press, e.g. \"Enter\", \"Escape\", \"a\", \"Control+a\", \"Shift+Tab\"."
                    },
                    "selector": {
                        "type": "string",
                        "description": "Optional CSS selector of an element to click first, so the key goes to it."
                    },
                    "shift": { "type": "boolean", "description": "Hold Shift (same as writing Shift+ in `key`)." },
                    "ctrl": { "type": "boolean", "description": "Hold Control." },
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
        let mut chord = parse_chord(name).map_err(ToolError::InvalidInput)?;
        // Boolean modifier flags are the older spelling; both work together.
        let flag = |key: &str, bit: i64| {
            if input.get(key).and_then(Value::as_bool) == Some(true) {
                bit
            } else {
                0
            }
        };
        let extra = flag("alt", MOD_ALT) | flag("ctrl", MOD_CTRL) | flag("meta", MOD_META)
            | flag("shift", MOD_SHIFT);
        if extra != 0 {
            chord = finish_chord(&chord.key, &chord.code, chord.vk, &chord.text, chord.modifiers | extra);
        }
        let repeat = input
            .get("repeat")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .clamp(1, 50);

        let mut out = serde_json::Map::new();
        if let Some(selector) = input.get("selector").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
            let located = focus_by_click(&self.manager, selector).await?;
            out.insert("focused_first".into(), json!({
                "selector": selector,
                "tag": located.get("tag").cloned().unwrap_or(Value::Null),
            }));
        }

        // The whole trail, not just the final stop: an audit needs the ORDER,
        // and per-press focus is the only way to see a focus trap or a control
        // the tab order skips.
        let mut trail: Vec<Value> = Vec::new();
        for _ in 0..repeat {
            ctx.bail_if_cancelled()?;
            press_chord(&self.manager, &chord).await?;
            trail.push(focused_element(&self.manager).await);
        }

        out.insert("key".into(), json!(name));
        out.insert("presses".into(), json!(repeat));
        out.insert("focusTrail".into(), json!(trail));
        out.insert(
            "message".into(),
            json!("Real key input — the browser handled it exactly as a keyboard would."),
        );
        Ok(Value::Object(out).to_string())
    }
}

// ---------------------------------------------------------------------------
// browser_type
// ---------------------------------------------------------------------------

/// Cap on one typing call. Per-character round trips are cheap, but a model
/// that pastes a whole document through the keyboard is using the wrong tool.
const MAX_TYPED_CHARS: usize = 4_000;

pub struct BrowserTypeTool {
    manager: Arc<BrowserManager>,
}
impl BrowserTypeTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}

#[async_trait]
impl ToolExecutor for BrowserTypeTool {
    fn name(&self) -> &str {
        "browser_type"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_type".into(),
            description: "Type text into the Browser panel as real keystrokes, one key event per \
                character, into whatever is focused — or into `selector`, which is clicked first. \
                Use this when the page reacts to typing itself: an autocomplete or search-as-you-\
                type box, a command palette, a rich-text editor, a keyboard-shortcut listener, a \
                character counter. It APPENDS at the caret; it does not clear the field. To set a \
                field's whole value (the common form-filling case) browser_fill is faster and \
                replaces what was there. A newline in `text` presses Enter. Windows only."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": super::with_observation(json!({
                    "text": { "type": "string", "description": "What to type. A newline presses Enter." },
                    "selector": { "type": "string", "description": "Optional CSS selector to click first so the text lands there. Omit to type into whatever is already focused." },
                    "delay_ms": { "type": "number", "description": "Pause between keystrokes in milliseconds, 0-200. Raise it for a page that debounces input. Default 0." },
                    "submit": { "type": "boolean", "description": "Press Enter after the text. Default false." }
                })),
                "required": ["text"]
            }),
        }
    }
    fn requires_permission(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;
        if !self.manager.devtools_available() {
            return Err(ToolError::Execution(
                "browser_type needs the DevTools channel, which exists on Windows only. Use \
                 browser_fill to set a field's value instead."
                    .into(),
            ));
        }
        let text = input
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`text` must be a string".into()))?;
        if text.chars().count() > MAX_TYPED_CHARS {
            return Err(ToolError::InvalidInput(format!(
                "`text` is {} characters; browser_type stops at {MAX_TYPED_CHARS}. Use \
                 browser_fill to set a long value in one go.",
                text.chars().count()
            )));
        }
        let delay = input
            .get("delay_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(200);
        let submit = input.get("submit").and_then(Value::as_bool).unwrap_or(false);
        let selector = input
            .get("selector")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string);

        let manager = self.manager.clone();
        let typed = text.to_string();
        let changed = super::act_and_observe(&self.manager, &input, || async move {
            let mut result = serde_json::Map::new();
            if let Some(selector) = selector.as_deref() {
                let located = focus_by_click(&manager, selector).await?;
                result.insert("focused".into(), json!({
                    "selector": selector,
                    "tag": located.get("tag").cloned().unwrap_or(Value::Null),
                }));
            }
            let pressed = type_text(&manager, &typed, delay, ctx).await?;
            if submit {
                press_chord(&manager, &parse_chord("Enter").map_err(ToolError::InvalidInput)?).await?;
            }
            result.insert("typed_chars".into(), json!(pressed));
            result.insert("submitted".into(), json!(submit));
            result.insert("focused_after".into(), focused_element(&manager).await);
            Ok(Value::Object(result))
        })
        .await?;
        Ok(changed.to_string())
    }
}

// ---------------------------------------------------------------------------
// browser_hover
// ---------------------------------------------------------------------------

pub struct BrowserHoverTool {
    manager: Arc<BrowserManager>,
}
impl BrowserHoverTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
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
                screenshot possible. Get selectors from browser_view. Windows only."
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
            move_pointer(&self.manager, -1.0, -1.0).await?;
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
        let located = super::locate_target(&self.manager, Some(selector), None, 2_000).await?;
        let x = located.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = located.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        move_pointer(&self.manager, x, y).await?;
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
    fn every_named_key_resolves() {
        for (name, ..) in NAMED_KEYS {
            let chord = parse_chord(name).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(chord.modifiers, 0);
        }
    }

    #[test]
    fn keys_with_no_text_send_no_character() {
        // Sending text for Escape or an arrow inserts a phantom character into
        // whatever is focused.
        for key in ["Escape", "ArrowUp", "Delete", "Backspace", "F5"] {
            assert!(parse_chord(key).unwrap().text.is_empty(), "{key} must not carry text");
        }
        assert_eq!(parse_chord("Tab").unwrap().text, "\t");
        assert_eq!(parse_chord("Enter").unwrap().text, "\r");
    }

    /// The reported gap: `browser_press_key {"key": "d"}` was refused. Letters
    /// are keys.
    #[test]
    fn a_single_character_is_a_key() {
        let d = parse_chord("d").unwrap();
        assert_eq!((d.key.as_str(), d.code.as_str(), d.vk, d.text.as_str()), ("d", "KeyD", 68, "d"));
        assert_eq!(d.modifiers, 0);

        let upper = parse_chord("D").unwrap();
        assert_eq!(upper.text, "D");
        assert_eq!(upper.modifiers, MOD_SHIFT, "a capital is Shift + the letter");

        let q = parse_chord("?").unwrap();
        assert_eq!((q.code.as_str(), q.vk, q.modifiers), ("Slash", 191, MOD_SHIFT));
        assert_eq!(q.text, "?");
    }

    #[test]
    fn chords_carry_modifiers_and_drop_their_text() {
        let select_all = parse_chord("Control+a").unwrap();
        assert_eq!(select_all.modifiers, MOD_CTRL);
        assert_eq!(select_all.vk, 65);
        assert!(select_all.text.is_empty(), "Control+a must not insert an 'a'");

        let back_tab = parse_chord("shift+tab").unwrap();
        assert_eq!(back_tab.modifiers, MOD_SHIFT);
        assert_eq!(back_tab.key, "Tab");

        let palette = parse_chord("Ctrl+Shift+P").unwrap();
        assert_eq!(palette.modifiers, MOD_CTRL | MOD_SHIFT);
        assert_eq!(palette.vk, 80);

        let cmd_k = parse_chord("Meta+k").unwrap();
        assert_eq!(cmd_k.modifiers, MOD_META);
    }

    /// `browser_type " "` was refused with "`key` is empty": the parser
    /// trimmed the spec before looking at it. A space is a character.
    #[test]
    fn a_lone_space_is_the_space_key_not_an_empty_spec() {
        let space = parse_chord(" ").unwrap();
        assert_eq!(space.key, " ");
        assert_eq!(space.text, " ");
        assert_eq!(space.vk, 32);
    }

    #[test]
    fn the_plus_character_itself_can_be_pressed() {
        assert_eq!(parse_chord("+").unwrap().text, "+");
        let chord = parse_chord("Control++").unwrap();
        assert_eq!(chord.modifiers, MOD_CTRL | MOD_SHIFT);
        assert_eq!(chord.key, "+");
    }

    #[test]
    fn aliases_and_case_are_forgiven() {
        assert_eq!(parse_chord("esc").unwrap().key, "Escape");
        assert_eq!(parse_chord("RETURN").unwrap().key, "Enter");
        assert_eq!(parse_chord("down").unwrap().key, "ArrowDown");
        assert_eq!(parse_chord("space").unwrap().key, " ");
        assert_eq!(parse_chord("f12").unwrap().vk, 123);
    }

    #[test]
    fn nonsense_is_refused_with_the_alternatives_named() {
        let err = parse_chord("F13").unwrap_err();
        assert!(err.contains("browser_type"), "{err}");
        assert!(parse_chord("").is_err());
        assert!(parse_chord("Hyper+a").unwrap_err().contains("not a modifier"));
    }

    #[test]
    fn evaluate_value_unwraps_the_cdp_envelope() {
        let response = json!({ "result": { "type": "object", "value": { "tag": "button" } } });
        assert_eq!(evaluate_value(&response)["tag"], "button");
        // A shape we don't recognise yields null rather than panicking.
        assert!(evaluate_value(&json!({ "wat": 1 })).is_null());
    }

    #[test]
    fn mouse_buttons_parse_and_mask() {
        assert_eq!(MouseButton::parse(None).unwrap(), MouseButton::Left);
        assert_eq!(MouseButton::parse(Some("Right")).unwrap(), MouseButton::Right);
        assert_eq!(MouseButton::Middle.mask(), 4);
        let err = MouseButton::parse(Some("back")).unwrap_err().to_string();
        assert!(err.contains("back"), "names what was sent: {err}");
    }
}
