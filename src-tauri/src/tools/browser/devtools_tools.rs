//! Browser QA tools driven by the DevTools Protocol.
//!
//! Everything here is a thing the BROWSER does, not a thing the page does,
//! which is exactly why none of it can be built on script injection:
//!
//! | tool | why script cannot do it |
//! |---|---|
//! | `browser_set_viewport` | resizing the window has no device pixel ratio, no mobile flag, and disturbs the window the user is looking at |
//! | `browser_emulate_media` | `prefers-color-scheme` / `prefers-reduced-motion` are read by the ENGINE; you cannot make CSS believe a lie from inside the page |
//! | `browser_press_key` | a synthetic `keydown` does not move focus, so `Tab` traversal does nothing at all |
//! | `browser_hover` | a synthetic `mouseover` fires the page's handlers but never paints CSS `:hover` |
//! | `browser_a11y_tree` | the accessibility tree is computed by the engine and is not reachable from the DOM |
//!
//! In every case the script version *reports success* while verifying
//! nothing — the worst possible outcome for a tool whose whole job is to
//! certify that a surface behaves. See `services::browser_devtools`.
//!
//! ## Emulation is sticky
//!
//! `Emulation.*` overrides persist for the life of the browser, not the life
//! of the call. A tool that sets a 390px viewport and never clears it leaves
//! the user's browser stuck at phone width — so both emulation tools take an
//! explicit `reset`, and `BrowserManager::navigate` clears them, because the
//! overwhelmingly common intent when you go to a new page is a clean one.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::services::browser_runtime::BrowserManager;

use super::{ensure_agent_browser, AGENT_BROWSER_LABEL};

/// Cap on how many accessibility nodes one call returns.
///
/// A real page yields thousands; the whole tree would blow the tool-result
/// budget and bury the handful of rows an audit needs. Truncation NAMES
/// itself and the recovery, per the house rule.
const MAX_AX_NODES: usize = 400;

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

/// What the PAGE says its viewport is, as opposed to what Aurora asked for.
///
/// The whole point of reading this back is that the two can disagree, and
/// until now only the request was ever reported.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Viewport {
    width: i64,
    height: i64,
    device_pixel_ratio: f64,
}

impl Viewport {
    fn to_json(&self) -> Value {
        json!({
            "width": self.width,
            "height": self.height,
            "device_pixel_ratio": self.device_pixel_ratio,
        })
    }
}

/// Read `window.innerWidth/innerHeight/devicePixelRatio` from the page.
const VIEWPORT_EXPR: &str = "(function(){return {width: window.innerWidth,      height: window.innerHeight, device_pixel_ratio: window.devicePixelRatio};})()";

/// How long to wait for the panel to resize before believing it will not.
///
/// Restoring the frame is a Rust → agent-window → Rust round trip through a
/// Tauri event and a React layout pass. Under a second in practice; the cap is
/// generous because the cost of giving up early is a FALSE failure report.
const RESTORE_TIMEOUT_MS: u64 = 1_500;
const RESTORE_POLL_MS: u64 = 100;

pub struct BrowserSetViewportTool {
    manager: Arc<BrowserManager>,
}
impl BrowserSetViewportTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }

    /// The page's own viewport, once it has stopped being `previous`.
    ///
    /// Returns as soon as the size actually changes, so the common case costs
    /// one page read rather than the whole timeout. `None` means the page
    /// could not be read at all — reported as unknown rather than guessed.
    async fn settled_viewport(
        &self,
        previous: Option<super::state::Emulation>,
    ) -> Option<Viewport> {
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(RESTORE_TIMEOUT_MS);
        let mut last = None;
        loop {
            if let Some(seen) = self.read_viewport().await {
                last = Some(seen);
                let still_emulated = previous.is_some_and(|e| {
                    seen.width == e.width as i64 && seen.height == e.height as i64
                });
                if !still_emulated {
                    return Some(seen);
                }
            }
            if std::time::Instant::now() >= deadline {
                return last;
            }
            tokio::time::sleep(std::time::Duration::from_millis(RESTORE_POLL_MS)).await;
        }
    }

    async fn read_viewport(&self) -> Option<Viewport> {
        let result = self
            .manager
            .eval_with_result(AGENT_BROWSER_LABEL, VIEWPORT_EXPR)
            .await
            .ok()?;
        if !result.ok {
            return None;
        }
        let value = result.value?;
        Some(Viewport {
            width: value.get("width").and_then(Value::as_i64)?,
            height: value.get("height").and_then(Value::as_i64)?,
            device_pixel_ratio: value
                .get("device_pixel_ratio")
                .and_then(Value::as_f64)
                .unwrap_or(1.0),
        })
    }
}
#[async_trait]
impl ToolExecutor for BrowserSetViewportTool {
    fn name(&self) -> &str {
        "browser_set_viewport"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_set_viewport".into(),
            description: "Resize the Browser panel's VIEWPORT for responsive checks, without \
                touching the real window. Use before browser_screenshot to verify a layout at a \
                specific width — 390 (phone), 768 (tablet), 1440 (desktop) are the usual three. \
                Also sets device pixel ratio and the mobile flag, so media queries, `100vh`, and \
                touch layout all behave as they would on the real device. The override STAYS \
                until you pass reset: true or navigate. Windows only."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "width": { "type": "number", "description": "Viewport width in CSS pixels, e.g. 390." },
                    "height": { "type": "number", "description": "Viewport height in CSS pixels. Defaults to 900." },
                    "deviceScaleFactor": { "type": "number", "description": "Device pixel ratio. 1 = normal, 2 = retina. Defaults to 1." },
                    "mobile": { "type": "boolean", "description": "Emulate a mobile device (touch layout, mobile viewport meta). Defaults to false." },
                    "reset": { "type": "boolean", "description": "Clear the override and return to the real window size. Ignores every other field." }
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
            let was = super::state::emulation();
            self.manager
                .call_devtools(
                    AGENT_BROWSER_LABEL,
                    "Emulation.clearDeviceMetricsOverride",
                    Value::Null,
                )
                .await
                .map_err(ToolError::Execution)?;
            // Touch emulation is its own domain command, so clearing device
            // metrics leaves it switched on: the page keeps reporting touch
            // points and keeps taking the mobile branch of any feature test.
            // Clearing it is what makes "the override is gone" true rather
            // than only mostly true.
            let touch = self
                .manager
                .call_devtools(
                    AGENT_BROWSER_LABEL,
                    "Emulation.setTouchEmulationEnabled",
                    json!({ "enabled": false }),
                )
                .await;
            super::state::clear_emulation();
            // The agent's reset also ends a device the user picked in the
            // panel — the browser no longer shows it.
            crate::services::browser_view::forget_device(AGENT_BROWSER_LABEL);
            self.manager.request_browser_frame(None, None);

            // Restoring the panel is a ROUND TRIP — Rust cannot resize the
            // webview, it emits and the agent window measures its own layout
            // and sets the bounds back. Reporting success before that lands
            // would be reporting the request, not the result, so the page is
            // read back until it stops being the emulated size.
            let restored = self.settled_viewport(was).await;
            let cleared = was.is_none_or(|e| {
                restored
                    .as_ref()
                    .is_none_or(|v| v.width != e.width as i64 || v.height != e.height as i64)
            });

            if !cleared {
                // The house rule: a tool that could not do the thing says so,
                // and names the recovery. Claiming this one worked is what
                // sends a responsive audit on at phone width believing it is
                // back on desktop.
                return Ok(json!({
                    "viewport": "reset_failed",
                    "measured": restored.as_ref().map(Viewport::to_json),
                    "message": format!(
                        "The override was cleared in the browser, but the page is STILL rendering                          at {w}x{h} — the Browser panel has not resized back. Do not read anything                          from here as a desktop layout. Reopen or resize the Browser panel and                          call `browser_status` to confirm the width before judging any layout.",
                        w = restored.as_ref().map_or(0, |v| v.width),
                        h = restored.as_ref().map_or(0, |v| v.height),
                    )
                })
                .to_string());
            }

            let touch_note = match touch {
                Ok(_) => String::new(),
                Err(err) => format!(
                    "

Touch emulation could not be switched off ({err}), so the page may                      still report touch support even though the size is back to normal."
                ),
            };
            return Ok(json!({
                "viewport": "reset",
                "measured": restored.as_ref().map(Viewport::to_json),
                "message": format!(
                    "Viewport override cleared — the page fills the whole panel again{measured}.{touch_note}",
                    measured = restored
                        .as_ref()
                        .map(|v| format!(" and now measures {}x{}", v.width, v.height))
                        .unwrap_or_default(),
                )
            })
            .to_string());
        }

        let width = input
            .get("width")
            .and_then(Value::as_f64)
            .ok_or_else(|| {
                ToolError::InvalidInput(
                    "`width` is required (in CSS pixels), or pass reset: true to clear the override"
                        .into(),
                )
            })?
            .round();
        let height = input
            .get("height")
            .and_then(Value::as_f64)
            .unwrap_or(900.0)
            .round();
        if !(1.0..=10_000.0).contains(&width) || !(1.0..=10_000.0).contains(&height) {
            return Err(ToolError::InvalidInput(
                "`width` and `height` must be between 1 and 10000 CSS pixels".into(),
            ));
        }
        let scale = input
            .get("deviceScaleFactor")
            .and_then(Value::as_f64)
            .unwrap_or(1.0);
        let mobile = input
            .get("mobile")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        self.manager
            .call_devtools(
                AGENT_BROWSER_LABEL,
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": width as i64,
                    "height": height as i64,
                    "deviceScaleFactor": scale,
                    "mobile": mobile,
                }),
            )
            .await
            .map_err(ToolError::Execution)?;

        // `mobile: true` in the metrics override changes LAYOUT, not input:
        // without this the page still reports zero touch points, so every
        // `ontouchstart`/`maxTouchPoints` feature test takes the desktop
        // branch and the touch layout the description promises never appears.
        // Best-effort — a page that renders at phone width without touch is
        // still worth having, so this does not fail the call.
        let _ = self
            .manager
            .call_devtools(
                AGENT_BROWSER_LABEL,
                "Emulation.setTouchEmulationEnabled",
                json!({ "enabled": mobile, "maxTouchPoints": if mobile { 5 } else { 0 } }),
            )
            .await;

        // Shrink the webview itself to the emulated size, so the page fills its
        // own surface instead of rendering in a column with a blank band beside
        // it. That band lives INSIDE the webview, where no Aurora styling can
        // reach, and the native screenshot photographs the whole surface — so
        // without this the picture is a phone layout plus a large white area
        // that looks exactly like a broken layout. The panel's own background
        // now shows around the frame instead, and a capture contains the device
        // and nothing else.
        self.manager
            .request_browser_frame(Some(width), Some(height));

        // Recorded so every later status read and action result can say the
        // page is being rendered narrower than the panel. Without this the
        // override is invisible from the next turn onward — see
        // `state::EMULATION`.
        // The agent's size replaces any device the user picked in the panel.
        crate::services::browser_view::forget_device(AGENT_BROWSER_LABEL);
        super::state::set_emulation(super::state::Emulation {
            width,
            height,
            scale,
            mobile,
        });

        Ok(json!({
            "viewport": { "width": width as i64, "height": height as i64,
                          "deviceScaleFactor": scale, "mobile": mobile },
            "message": format!(
                "Viewport is now {w}x{h} at {scale}x scale, and the panel now shows a {w}px-wide \
                 device frame rather than the page in a column with empty space beside it — so a \
                 screenshot from here is the device and nothing else.\n\nThe frame is capped at the \
                 panel's own size: if the panel is narrower than {w}px or shorter than {h}px, the \
                 rest of the emulated viewport is simply below the fold — scroll to reach it, the \
                 same as on a real device. `browser_status` reports what the page actually \
                 got.\n\nThis override survives navigation within the \
                 page and later turns. Clear it with `reset: true` before judging a desktop \
                 layout, or everything you look at from here is {w}px wide.",
                w = width as i64,
                h = height as i64,
                scale = scale
            )
        })
        .to_string())
    }
}

// ---------------------------------------------------------------------------
// Media emulation
// ---------------------------------------------------------------------------

pub struct BrowserEmulateMediaTool {
    manager: Arc<BrowserManager>,
}
impl BrowserEmulateMediaTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}
#[async_trait]
impl ToolExecutor for BrowserEmulateMediaTool {
    fn name(&self) -> &str {
        "browser_emulate_media"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_emulate_media".into(),
            description: "Force the Browser panel's media preferences so you can verify a page in \
                light mode, dark mode, reduced motion, forced colours, or print layout — without \
                changing any OS setting. The page's CSS media queries genuinely re-evaluate, so a \
                screenshot taken after this shows the real alternate rendering. The override \
                STAYS until you pass reset: true or navigate. Windows only."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "colorScheme": {
                        "type": "string",
                        "enum": ["light", "dark"],
                        "description": "Force `prefers-color-scheme`. Omit to leave it alone."
                    },
                    "reducedMotion": {
                        "type": "boolean",
                        "description": "true forces `prefers-reduced-motion: reduce`, false forces `no-preference`."
                    },
                    "forcedColors": {
                        "type": "boolean",
                        "description": "true emulates Windows high-contrast mode (`forced-colors: active`)."
                    },
                    "media": {
                        "type": "string",
                        "enum": ["screen", "print"],
                        "description": "Render as screen or print. Defaults to screen."
                    },
                    "reset": { "type": "boolean", "description": "Clear every media override. Ignores the other fields." }
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
            // An empty `features` array is how CDP clears them; passing no
            // media string restores the page's own default.
            self.manager
                .call_devtools(
                    AGENT_BROWSER_LABEL,
                    "Emulation.setEmulatedMedia",
                    json!({ "media": "", "features": [] }),
                )
                .await
                .map_err(ToolError::Execution)?;
            return Ok(json!({
                "media": "reset",
                "message": "Media overrides cleared — the page follows the real system preferences again."
            })
            .to_string());
        }

        let mut features: Vec<Value> = Vec::new();
        if let Some(scheme) = input.get("colorScheme").and_then(Value::as_str) {
            if !matches!(scheme, "light" | "dark") {
                return Err(ToolError::InvalidInput(
                    "`colorScheme` must be \"light\" or \"dark\"".into(),
                ));
            }
            features.push(json!({ "name": "prefers-color-scheme", "value": scheme }));
        }
        if let Some(reduced) = input.get("reducedMotion").and_then(Value::as_bool) {
            features.push(json!({
                "name": "prefers-reduced-motion",
                "value": if reduced { "reduce" } else { "no-preference" }
            }));
        }
        if let Some(forced) = input.get("forcedColors").and_then(Value::as_bool) {
            features.push(json!({
                "name": "forced-colors",
                "value": if forced { "active" } else { "none" }
            }));
        }
        let media = input
            .get("media")
            .and_then(Value::as_str)
            .unwrap_or("screen");

        if features.is_empty() && media == "screen" {
            return Err(ToolError::InvalidInput(
                "nothing to emulate: set colorScheme, reducedMotion, forcedColors or media, \
                 or pass reset: true to clear existing overrides"
                    .into(),
            ));
        }

        self.manager
            .call_devtools(
                AGENT_BROWSER_LABEL,
                "Emulation.setEmulatedMedia",
                json!({ "media": media, "features": features }),
            )
            .await
            .map_err(ToolError::Execution)?;

        Ok(json!({
            "media": media,
            "features": features,
            "message": "Media preferences forced. The page's media queries have re-evaluated — \
                        screenshot now. This stays until you reset it or navigate."
        })
        .to_string())
    }
}
