//! Auto-recover a window when its WebView renderer process dies.
//!
//! WebView2's renderer can be killed out from under the app — a Chromium
//! CHECK failure (the `STATUS_BREAKPOINT` sad page), an out-of-memory
//! abort, or a runtime auto-update regression (the Evergreen runtime
//! updates silently, so a page that was stable yesterday can start
//! crashing today with zero app changes). When that happens WebView2
//! shows its own "This page is having a problem" error page and the
//! user has to find the Refresh button — in an agent IDE mid-run that
//! reads as the whole product breaking.
//!
//! The documented contract (`ICoreWebView2::add_ProcessFailed`) is that
//! the APP owns recovery: for `RENDER_PROCESS_EXITED` the host should
//! call `Reload()`. This module installs that handler. React state is
//! lost on reload, but every Aurora surface restores itself (threads
//! re-hydrate from the Rust session store, drafts from persisted
//! Zustand slices), so an automatic reload turns a hard crash into a
//! brief flicker.
//!
//! Reloads are rate-limited: a page that crashes the renderer
//! deterministically on load would otherwise reload-loop forever. After
//! `MAX_RELOADS` recoveries inside `WINDOW_SECS` we stop and let the
//! native error page show (the user can still refresh manually).
//!
//! Threading mirrors `webview_permissions`: `with_webview` dispatches
//! the registration to the WebView UI thread, and the ProcessFailed
//! callback also fires there, so calling `Reload()` from inside it is
//! safe and is exactly the pattern in Microsoft's WebView2 samples.

use tauri::WebviewWindow;

/// Attach the renderer-crash auto-reload handler to a window's WebView.
///
/// Safe to call repeatedly (it piggybacks on the agent window's
/// native-handler bootstrap command, which runs on window create, on
/// window boot, and before each mic use): the install is idempotent
/// per WebView instance, so repeated calls never stack duplicate
/// ProcessFailed handlers. A recreated window (same label, new
/// WebView) installs fresh.
pub fn install_crash_recovery_handler(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::install(window)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};
    use tauri::WebviewWindow;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows::core::Interface;

    /// Stop auto-reloading after this many recoveries inside `WINDOW_SECS`.
    const MAX_RELOADS: usize = 3;
    const WINDOW_SECS: u64 = 120;

    /// Which WebView instance (COM identity pointer) each window label
    /// already has a handler on. The bootstrap command that installs us
    /// is invoked repeatedly (window create, window boot, before each
    /// mic use) and WebView2 event handlers survive page reloads, so
    /// without this every call would stack another ProcessFailed
    /// handler. Keyed by label → raw `ICoreWebView2` pointer: a
    /// recreated window reuses the label but gets a NEW WebView object,
    /// which correctly reads as "not installed yet".
    fn installed() -> &'static Mutex<HashMap<String, usize>> {
        static INSTALLED: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
        INSTALLED.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn install(window: &WebviewWindow) -> Result<(), String> {
        let label = window.label().to_string();
        window
            .with_webview(move |platform_webview| {
                // SAFETY: we're on the WebView UI thread; the COM objects
                // are not shared across threads.
                unsafe {
                    let controller = platform_webview.controller();
                    let webview2 = match controller.CoreWebView2() {
                        Ok(v) => v,
                        Err(err) => {
                            eprintln!(
                                "[aurora] CoreWebView2 unavailable, renderer-crash recovery disabled: {err}",
                            );
                            return;
                        }
                    };

                    // Idempotence: skip if this exact WebView instance
                    // already has our handler. COM identity via the raw
                    // interface pointer is stable for the same
                    // `CoreWebView2()` property object.
                    let identity = webview2.as_raw() as usize;
                    {
                        let mut map = installed()
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        if map.get(&label) == Some(&identity) {
                            return;
                        }
                        map.insert(label.clone(), identity);
                    }

                    // Reload timestamps for the rate limiter. The handler
                    // is `Fn`, so interior mutability via Mutex; the
                    // callback always fires on the single UI thread, so
                    // the lock is never contended.
                    let recent_reloads: Mutex<Vec<Instant>> = Mutex::new(Vec::new());

                    let handler = ProcessFailedEventHandler::create(Box::new(
                        move |sender, args| {
                            let Some(args) = args else { return Ok(()) };
                            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                            args.ProcessFailedKind(&mut kind)?;

                            // Only the kinds where the top-level page is
                            // gone and Microsoft's contract says "call
                            // Reload()". Everything else (browser process
                            // exit tears the whole window down anyway;
                            // unresponsive pages usually recover on their
                            // own, and reloading one would kill a healthy
                            // long-running agent turn) is logged only.
                            let reloadable = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED;

                            eprintln!(
                                "[aurora] webview process failure on '{label}' (kind {}); {}",
                                kind.0,
                                if reloadable { "attempting auto-reload" } else { "not auto-reloading" }
                            );
                            if !reloadable {
                                return Ok(());
                            }

                            let now = Instant::now();
                            let allowed = {
                                let mut recent = recent_reloads
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                recent.retain(|t| now.duration_since(*t) < Duration::from_secs(WINDOW_SECS));
                                if recent.len() < MAX_RELOADS {
                                    recent.push(now);
                                    true
                                } else {
                                    false
                                }
                            };
                            if !allowed {
                                eprintln!(
                                    "[aurora] renderer on '{label}' crashed {MAX_RELOADS}+ times in {WINDOW_SECS}s; leaving the error page up",
                                );
                                return Ok(());
                            }

                            if let Some(webview) = sender {
                                if let Err(err) = webview.Reload() {
                                    eprintln!("[aurora] auto-reload after renderer crash failed: {err}");
                                }
                            }
                            Ok(())
                        },
                    ));

                    let mut token: i64 = 0;
                    if let Err(err) = webview2.add_ProcessFailed(&handler, &mut token) {
                        eprintln!(
                            "[aurora] add_ProcessFailed failed, renderer-crash recovery disabled: {err}",
                        );
                    }
                }
            })
            .map_err(|err| format!("with_webview dispatch failed: {err}"))
    }
}
