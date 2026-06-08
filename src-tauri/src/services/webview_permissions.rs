//! Auto-grant platform WebView permission prompts that Aurora gates
//! through its own in-app modals.
//!
//! The IDE owns a dedicated React permission modal (e.g.
//! `SpeechInputButton`'s "Allow microphone access" dialog) that gates
//! the call to `getUserMedia` — the user only sees the IDE-styled gate.
//! However, the underlying WebView still fires its OWN native browser
//! permission prompt the first time `navigator.mediaDevices
//! .getUserMedia()` is invoked, because the WebView treats
//! `localhost:5173` (and the bundled app's `tauri://` origin in
//! release) as an untrusted browsing context by default. That second
//! prompt is the ugly, redundant one the user sees on top of Aurora's
//! own modal.
//!
//! The fix is to intercept the WebView's permission-request callback
//! at the native layer and auto-grant the kinds Aurora itself has
//! already confirmed with the user. On Windows that's
//! `ICoreWebView2::add_PermissionRequested` + `args.SetState(ALLOW)`.
//! macOS and Linux fall back to no-ops for now — Aurora's macOS build
//! relies on the `NSMicrophoneUsageDescription` Info.plist entry which
//! makes WKWebView skip its own prompt, and the Linux webkit2gtk path
//! isn't a target user platform yet.
//!
//! Threading: the WebView2 callback must be registered on the WebView's
//! UI thread, which is exactly what `WebviewWindow::with_webview()`
//! gives us — it dispatches the closure to the right thread and
//! returns immediately. The callback itself also fires on the UI
//! thread, but it's synchronous: we read the permission kind and call
//! `SetState`, both of which complete immediately, no deferral
//! required.

use tauri::WebviewWindow;

/// Attach Aurora's auto-grant permission handler to a window's WebView.
///
/// This must be called once per WebView that may ever request
/// permission (currently just the main window — `getUserMedia` is
/// invoked from the chat input there). Subsequent calls on the same
/// window will stack additional handlers; WebView2 stops dispatching
/// to remaining handlers as soon as one sets a non-default state, so
/// double-registration is harmless but wasteful.
///
/// Returns `Ok(())` on success or if the platform has no
/// implementation. Errors only surface when `with_webview` itself
/// fails (e.g. the window has already been destroyed); the actual COM
/// registration is fire-and-forget because failure to wire up the
/// handler just falls back to the default browser prompt.
pub fn install_permission_handler(window: &WebviewWindow) -> Result<(), String> {
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
    use tauri::WebviewWindow;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    pub(super) fn install(window: &WebviewWindow) -> Result<(), String> {
        window
            .with_webview(|platform_webview| {
                // SAFETY: we're on the WebView UI thread; the COM
                // objects are not shared across threads.
                unsafe {
                    let controller = platform_webview.controller();
                    let webview2 = match controller.CoreWebView2() {
                        Ok(v) => v,
                        Err(err) => {
                            eprintln!(
                                "[aurora] CoreWebView2 unavailable, native mic prompt will fall through: {err}",
                            );
                            return;
                        }
                    };

                    // The handler closure runs synchronously on the UI
                    // thread. We check the permission kind and
                    // auto-allow the ones Aurora gates with its own
                    // in-app modal — anything else falls back to the
                    // default browser prompt, which is the safe choice
                    // (we never want to silently grant permissions the
                    // IDE doesn't already gate).
                    let handler =
                        PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
                            let Some(args) = args else { return Ok(()) };
                            // WebView2's `PermissionKind` is a COM
                            // property — the Rust binding spells it as
                            // an out-pointer + Result<()>. Read into a
                            // stack slot and compare against the
                            // constants we care about.
                            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                            args.PermissionKind(&mut kind)?;
                            // Only microphone is gated by Aurora's
                            // own modal (`SpeechInputButton`). Every
                            // other permission kind — camera,
                            // geolocation, notifications, clipboard
                            // read, etc. — falls through to the
                            // default browser prompt so we never
                            // silently grant something the IDE has
                            // not explicitly confirmed with the user.
                            if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                                // SetState replaces the default
                                // (which shows the prompt) with an
                                // explicit allow. WebView2 also caches
                                // the allow for the lifetime of the
                                // browsing instance.
                                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                            }
                            Ok(())
                        }));

                    // `add_PermissionRequested` writes the
                    // registration token into an `i64` out-param. We
                    // never need to detach the handler for the
                    // lifetime of the main window, so the token is
                    // discarded.
                    let mut token: i64 = 0;
                    if let Err(err) = webview2.add_PermissionRequested(&handler, &mut token) {
                        eprintln!(
                            "[aurora] add_PermissionRequested failed, native mic prompt will fall through: {err}",
                        );
                    }
                }
            })
            .map_err(|err| format!("with_webview dispatch failed: {err}"))
    }
}
