//! How a browser page is being VIEWED: as a device, at a zoom level, with its
//! window rounded to a device screen's corners.
//!
//! The dock's browser tools (device, zoom) set these per page, and three other
//! places read them back:
//!
//! - `BrowserManager::navigate` re-applies a chosen device instead of clearing
//!   the emulation, so a phone view survives typing a new address — the same
//!   as DevTools' device mode.
//! - The agent's click tools (`tools/browser/input_tools.rs`) convert page
//!   coordinates with [`input_scale`]. A device shown shrunk to fit the panel,
//!   or a zoomed page, is PAINTED at a different size than its CSS pixels, and
//!   `Input.dispatchMouseEvent` takes painted coordinates. Measured against
//!   Chromium: with a 0.5 fit-scale, a click at a button's CSS centre hit empty
//!   page; the same click at centre × 0.5 hit the button.
//! - `BrowserManager::set_bounds` re-clips the page window's corners whenever
//!   the page moves or resizes ([`apply_corners`]).
//!
//! Settings live in a process-wide map keyed by page label, like the agent's
//! own emulation record in `tools/browser/state.rs`.

use std::sync::LazyLock;

use dashmap::DashMap;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Webview;

use crate::services::browser_devtools::call_devtools;

/// A device to show a page as. Built by the frontend from its presets
/// (`lib/browser/devices.ts`); every number is what the page will observe.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSpec {
    /// Viewport width the page sees, in CSS pixels.
    pub width: f64,
    /// Viewport height the page sees, in CSS pixels.
    pub height: f64,
    /// `window.devicePixelRatio` the page sees.
    pub device_scale_factor: f64,
    /// Mobile layout + touch input.
    pub mobile: bool,
    /// The device browser's identity, so sites serve their mobile pages.
    pub user_agent: String,
    /// Painted pixels per CSS pixel: how far the device is shrunk to fit its
    /// frame in the panel. 1 = actual size.
    pub scale: f64,
}

impl DeviceSpec {
    fn validate(&self) -> Result<(), String> {
        let in_range = |v: f64, lo: f64, hi: f64| v.is_finite() && (lo..=hi).contains(&v);
        if !in_range(self.width, 1.0, 10_000.0) || !in_range(self.height, 1.0, 10_000.0) {
            return Err(format!(
                "device size {}x{} is outside 1-10000 CSS pixels",
                self.width, self.height
            ));
        }
        if !in_range(self.device_scale_factor, 0.5, 5.0) {
            return Err(format!("device pixel ratio {} is outside 0.5-5", self.device_scale_factor));
        }
        if !in_range(self.scale, 0.05, 2.0) {
            return Err(format!("fit scale {} is outside 0.05-2", self.scale));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct ViewSettings {
    device: Option<DeviceSpec>,
    zoom: f64,
    /// Radius (logical px) of the page window's BOTTOM corners. The top edge
    /// stays square: in a device frame it meets the status bar, not a corner.
    corner_radius: f64,
}

impl Default for ViewSettings {
    fn default() -> Self {
        Self { device: None, zoom: 1.0, corner_radius: 0.0 }
    }
}

static VIEWS: LazyLock<DashMap<String, ViewSettings>> = LazyLock::new(DashMap::new);

pub const MIN_ZOOM: f64 = 0.25;
pub const MAX_ZOOM: f64 = 5.0;

/// Painted pixels per CSS pixel for a page: the device's fit-scale times the
/// zoom. Pure, so the rule is testable without a webview.
pub fn input_scale_of(device_scale: Option<f64>, zoom: f64) -> f64 {
    let scale = device_scale.unwrap_or(1.0) * zoom;
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// What to multiply a page (CSS) coordinate by to aim a DevTools input event
/// at it. 1 for a page shown at actual size.
pub fn input_scale(label: &str) -> f64 {
    VIEWS
        .get(label)
        .map(|v| input_scale_of(v.device.as_ref().map(|d| d.scale), v.zoom))
        .unwrap_or(1.0)
}

/// The device a page is shown as, if any.
pub fn device(label: &str) -> Option<DeviceSpec> {
    VIEWS.get(label).and_then(|v| v.device.clone())
}

/// Forget a page's device without touching the browser — the agent's own
/// viewport tool has just replaced the emulation with its own.
pub fn forget_device(label: &str) {
    if let Some(mut v) = VIEWS.get_mut(label) {
        v.device = None;
    }
}

/// The page is closed: drop everything recorded for it.
pub fn forget(label: &str) {
    VIEWS.remove(label);
}

async fn devtools(webview: &Webview, method: &str, params: Value) -> Result<Value, String> {
    call_devtools(webview, method, params)
        .await
        .map_err(|err| format!("{method}: {err}"))
}

async fn apply_device(webview: &Webview, d: &DeviceSpec) -> Result<(), String> {
    devtools(
        webview,
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": d.width.round() as i64,
            "height": d.height.round() as i64,
            "deviceScaleFactor": d.device_scale_factor,
            "mobile": d.mobile,
            "scale": d.scale,
        }),
    )
    .await?;
    // Metrics alone change layout, not input: without touch the page keeps
    // taking the mouse branch of every feature test.
    devtools(
        webview,
        "Emulation.setTouchEmulationEnabled",
        json!({ "enabled": d.mobile, "maxTouchPoints": if d.mobile { 5 } else { 0 } }),
    )
    .await?;
    devtools(webview, "Emulation.setUserAgentOverride", json!({ "userAgent": d.user_agent })).await?;
    Ok(())
}

async fn clear_device_overrides(webview: &Webview) -> Result<(), String> {
    devtools(webview, "Emulation.clearDeviceMetricsOverride", Value::Null).await?;
    devtools(webview, "Emulation.setTouchEmulationEnabled", json!({ "enabled": false })).await?;
    // An empty override restores the browser's own identity (checked against
    // Chromium: the default UA and 0 touch points come back).
    devtools(webview, "Emulation.setUserAgentOverride", json!({ "userAgent": "" })).await?;
    Ok(())
}

/// Show a page as `device`, or at its natural size with `None`.
///
/// The record is only updated once the browser has accepted the change, so
/// the click conversion never describes an emulation that did not happen.
pub async fn set_device(webview: &Webview, label: &str, device: Option<DeviceSpec>) -> Result<(), String> {
    match &device {
        Some(d) => {
            d.validate()?;
            apply_device(webview, d).await?;
        }
        None => clear_device_overrides(webview).await?,
    }
    VIEWS.entry(label.to_string()).or_default().device = device;
    Ok(())
}

/// After `navigate`: put the chosen device back, since navigation clears
/// emulation. `false` when the page has no device, so the caller clears.
pub fn reapply_after_navigate(webview: &Webview, label: &str) -> bool {
    let Some(d) = device(label) else {
        return false;
    };
    let handle = webview.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = apply_device(&handle, &d).await {
            eprintln!("[browser-view] could not re-apply the device on '{label}' after navigating: {err}");
        }
    });
    true
}

/// Zoom a page, the browser's own zoom (Ctrl+/Ctrl- in a browser).
pub fn set_zoom(webview: &Webview, label: &str, zoom: f64) -> Result<f64, String> {
    if !zoom.is_finite() {
        return Err("zoom must be a number".into());
    }
    let zoom = zoom.clamp(MIN_ZOOM, MAX_ZOOM);
    webview.set_zoom(zoom).map_err(|err| format!("set zoom failed: {err}"))?;
    VIEWS.entry(label.to_string()).or_default().zoom = zoom;
    Ok(zoom)
}

/// Record the radius for a page's bottom corners (0 = square). Applied by the
/// next [`apply_corners`], which `set_bounds` runs on every move and resize.
pub fn set_corner_radius(label: &str, radius: f64) {
    let radius = if radius.is_finite() { radius.clamp(0.0, 200.0) } else { 0.0 };
    VIEWS.entry(label.to_string()).or_default().corner_radius = radius;
}

/// The region for a `width`×`height` (logical) window whose bottom corners are
/// rounded by `radius` (logical), in physical pixels:
/// `(left, top, right, bottom, ellipse)`. The top edge starts ABOVE the window
/// by one radius, so its rounded corners fall outside and the top stays square.
/// `None` means "no clipping".
pub fn corner_region(width: f64, height: f64, radius: f64, scale_factor: f64) -> Option<(i32, i32, i32, i32, i32)> {
    let s = if scale_factor.is_finite() && scale_factor > 0.0 { scale_factor } else { 1.0 };
    let r = (radius * s).round() as i32;
    if r <= 0 {
        return None;
    }
    let w = (width * s).round() as i32;
    let h = (height * s).round() as i32;
    // `CreateRoundRectRgn` excludes the right and bottom edges, hence the +1.
    Some((0, -r, w + 1, h + 1, r * 2))
}

/// Clip a page's window to its recorded corner radius at `width`×`height`.
///
/// Only the page's OWN container window is ever clipped: wry hosts each child
/// webview in a `WRY_WEBVIEW` child window, and the controller's parent is that
/// window. The class is checked before clipping, so a change in how wry hosts
/// pages can never round off Aurora's main window instead.
pub fn apply_corners(webview: &Webview, label: &str, width: f64, height: f64) {
    let radius = VIEWS.get(label).map(|v| v.corner_radius).unwrap_or(0.0);
    let scale = webview.window().scale_factor().unwrap_or(1.0);
    let region = corner_region(width, height, radius, scale);
    #[cfg(windows)]
    windows_impl::apply(webview, label, region);
    #[cfg(not(windows))]
    let _ = (webview, region);
}

#[cfg(windows)]
mod windows_impl {
    use tauri::Webview;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;

    fn is_page_container(hwnd: HWND) -> bool {
        let mut buf = [0u16; 64];
        // SAFETY: `buf` outlives the call and its length is passed in.
        let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        len > 0 && String::from_utf16_lossy(&buf[..len as usize]) == "WRY_WEBVIEW"
    }

    pub(super) fn apply(webview: &Webview, label: &str, region: Option<(i32, i32, i32, i32, i32)>) {
        let label = label.to_string();
        let dispatched = webview.with_webview(move |platform| {
            // SAFETY: runs on the webview's UI thread; the handles are used
            // only inside this closure.
            unsafe {
                let mut parent = windows::Win32::Foundation::HWND::default();
                if let Err(err) = platform.controller().ParentWindow(&mut parent) {
                    eprintln!("[browser-view] '{label}': no page window to round ({err})");
                    return;
                }
                let hwnd = parent.0 as HWND;
                if !is_page_container(hwnd) {
                    eprintln!("[browser-view] '{label}': page window is not a WRY_WEBVIEW container; not clipping");
                    return;
                }
                match region {
                    None => {
                        SetWindowRgn(hwnd, std::ptr::null_mut(), 1);
                    }
                    Some((l, t, r, b, e)) => {
                        let rgn = CreateRoundRectRgn(l, t, r, b, e, e);
                        if rgn.is_null() {
                            eprintln!("[browser-view] '{label}': could not create the corner region");
                            return;
                        }
                        // On success the system owns the region; on failure it is ours.
                        if SetWindowRgn(hwnd, rgn, 1) == 0 {
                            DeleteObject(rgn);
                            eprintln!("[browser-view] '{label}': could not clip the page window");
                        }
                    }
                }
            }
        });
        if let Err(err) = dispatched {
            eprintln!("[browser-view] could not reach the page window: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_at_actual_size_is_aimed_at_its_css_coordinates() {
        assert_eq!(input_scale_of(None, 1.0), 1.0);
    }

    #[test]
    fn a_shrunk_device_and_a_zoom_multiply() {
        assert!((input_scale_of(Some(0.5), 1.0) - 0.5).abs() < 1e-9);
        assert!((input_scale_of(Some(0.5), 1.5) - 0.75).abs() < 1e-9);
        assert!((input_scale_of(None, 1.25) - 1.25).abs() < 1e-9);
    }

    #[test]
    fn a_nonsense_scale_falls_back_to_actual_size() {
        assert_eq!(input_scale_of(Some(0.0), 1.0), 1.0);
        assert_eq!(input_scale_of(Some(f64::NAN), 1.0), 1.0);
    }

    #[test]
    fn corners_round_only_the_bottom_and_scale_with_the_display() {
        // 200x400 logical at 150% with a 20px radius → 300x600 physical, r=30.
        assert_eq!(corner_region(200.0, 400.0, 20.0, 1.5), Some((0, -30, 301, 601, 60)));
        assert_eq!(corner_region(200.0, 400.0, 0.0, 1.5), None);
    }

    #[test]
    fn device_sizes_outside_the_browsers_range_are_refused() {
        let ok = DeviceSpec {
            width: 393.0,
            height: 782.0,
            device_scale_factor: 3.0,
            mobile: true,
            user_agent: "x".into(),
            scale: 0.45,
        };
        assert!(ok.validate().is_ok());
        assert!(DeviceSpec { width: 0.0, ..ok.clone() }.validate().is_err());
        assert!(DeviceSpec { scale: 0.0, ..ok.clone() }.validate().is_err());
        assert!(DeviceSpec { device_scale_factor: 9.0, ..ok }.validate().is_err());
    }

    #[test]
    fn the_input_scale_follows_the_recorded_device_and_zoom() {
        let label = "browser-test-input-scale";
        VIEWS.insert(
            label.into(),
            ViewSettings {
                device: Some(DeviceSpec {
                    width: 393.0,
                    height: 782.0,
                    device_scale_factor: 3.0,
                    mobile: true,
                    user_agent: "x".into(),
                    scale: 0.4,
                }),
                zoom: 1.0,
                corner_radius: 0.0,
            },
        );
        assert!((input_scale(label) - 0.4).abs() < 1e-9);
        forget_device(label);
        assert_eq!(input_scale(label), 1.0);
        forget(label);
        assert_eq!(input_scale("browser-never-seen"), 1.0);
    }
}
