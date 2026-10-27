//! Services shared across the app.
//!
//! Two kinds live here. `api_converter` and `token_service` are core: pure
//! work any host can do. The rest drive the desktop app's windows and
//! WebViews (the native browser, the local page server, the composer's file
//! drop, WebView permissions and recovery), so they exist only with the
//! `desktop` feature (`DOCS/rust-core-extraction.md`, Phase 1.9).

pub mod api_converter;
#[cfg(feature = "desktop")]
pub mod browser_devtools;
#[cfg(feature = "desktop")]
pub mod browser_native_capture;
#[cfg(feature = "desktop")]
pub mod browser_runtime;
#[cfg(feature = "desktop")]
pub mod browser_view;
#[cfg(feature = "browser")]
pub mod browser_search;
#[cfg(feature = "desktop")]
pub mod composer_drop;
#[cfg(feature = "desktop")]
pub mod local_page;
pub mod token_service;
#[cfg(feature = "desktop")]
pub mod webview_permissions;
#[cfg(feature = "desktop")]
pub mod webview_recovery;
