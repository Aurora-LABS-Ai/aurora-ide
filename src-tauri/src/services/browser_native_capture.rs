//! Platform-native PNG capture of an Aurora browser preview window.
//!
//! This is the replacement for the page-injected SVG/`foreignObject`
//! screenshot that lives at the bottom of `browser_runtime.rs`. The SVG
//! technique works on trivial pages but silently fails on:
//!
//!   * pages with cross-origin `<img>` (canvas taint → `SecurityError`)
//!   * pages with `<canvas>` content (clone loses pixel buffers)
//!   * pages using shadow DOM (clone doesn't descend into shadow roots)
//!   * pages with `<iframe>` content (same-origin policy)
//!   * pages with strict CSP blocking `data:image/svg+xml`
//!
//! The native path goes through the platform's official "capture the
//! WebView" API. On Windows that's `ICoreWebView2::CapturePreview`,
//! which composes the live DirectComposition surface into a PNG
//! independent of page contents — it captures exactly what the user
//! sees. macOS (`WKWebView.takeSnapshot`) and Linux
//! (`webkit_web_view_get_snapshot`) implementations are not wired up
//! yet; callers should fall back to the SVG path when this returns
//! `Ok(None)`.
//!
//! The entry point [`capture_webview_png`] is async because the Windows
//! implementation calls a COM async API and waits for its completion
//! handler on the WebView's UI thread. The function itself can be
//! awaited from any tokio task.

use tauri::WebviewWindow;

/// Try a platform-native PNG capture of `window`'s WebView surface.
///
/// Returns:
///   * `Ok(Some(bytes))` — native capture succeeded, bytes are a
///     complete PNG file.
///   * `Ok(None)` — no native implementation on this platform yet
///     (macOS / Linux). Caller should fall back to the JS SVG path.
///   * `Err(message)` — native capture *was* attempted and failed; the
///     caller can either propagate the error or fall back to SVG.
pub async fn capture_webview_png(window: &WebviewWindow) -> Result<Option<Vec<u8>>, String> {
    #[cfg(windows)]
    {
        windows_impl::capture(window).await.map(Some)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(None)
    }
}

#[cfg(windows)]
mod windows_impl {
    //! Windows-specific implementation using `ICoreWebView2::CapturePreview`.
    //!
    //! The flow:
    //!   1. `Webview::with_webview` dispatches a closure to the UI
    //!      thread, giving us a `PlatformWebview` whose `controller()`
    //!      returns the `ICoreWebView2Controller`.
    //!   2. From the controller we get the `ICoreWebView2` itself.
    //!   3. We create an HGLOBAL-backed `IStream` to receive the PNG.
    //!   4. We call `CapturePreview(PNG, stream, handler)`; the handler
    //!      runs back on the UI thread when the bitmap is ready.
    //!   5. The handler reads the stream into a `Vec<u8>` and posts it
    //!      back to the caller via a tokio oneshot.
    //!   6. The caller (the async outer function) awaits the oneshot.
    //!
    //! Threading: `with_webview` posts the closure to the UI thread but
    //! returns immediately. The completion handler also fires on the UI
    //! thread; the only cross-thread hand-off is the final oneshot send,
    //! which is safe because `oneshot::Sender` is `Send`.

    use std::sync::Mutex;

    use tauri::WebviewWindow;
    use tokio::sync::oneshot;
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STREAM_SEEK_SET};

    pub(super) async fn capture(window: &WebviewWindow) -> Result<Vec<u8>, String> {
        let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
        // `with_webview` requires a Send + 'static closure, and the
        // closure can only fire once; wrap the sender in a Mutex<Option>
        // so we can pull it out from the completion handler.
        let tx_outer = std::sync::Arc::new(Mutex::new(Some(tx)));

        let dispatch_tx = tx_outer.clone();
        let dispatch = window.with_webview(move |platform_webview| {
            // SAFETY: all calls happen on the WebView's UI thread; the
            // COM objects are not shared across threads (only the bytes
            // they eventually produce are, via the oneshot).
            unsafe {
                let controller = platform_webview.controller();
                let webview2 = match controller.CoreWebView2() {
                    Ok(v) => v,
                    Err(err) => {
                        send_once(&dispatch_tx, Err(format!("CoreWebView2 unavailable: {err}")));
                        return;
                    }
                };

                // `HGLOBAL(null)` asks OLE to allocate a fresh growable
                // memory block; `true` hands ownership of that block to
                // the returned IStream so it's freed automatically when
                // the last AddRef drops.
                let stream: IStream =
                    match CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true) {
                        Ok(s) => s,
                        Err(err) => {
                            send_once(
                                &dispatch_tx,
                                Err(format!("CreateStreamOnHGlobal failed: {err}")),
                            );
                            return;
                        }
                    };

                // Clone the stream handle into the completion closure so
                // we can read from it after CapturePreview signals done.
                // IStream is a COM interface; `.clone()` just AddRef's.
                let stream_for_handler = stream.clone();
                let handler_tx = dispatch_tx.clone();
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                    // `result` is webview2-com's translation of the
                    // HRESULT delivered to the COM handler — it's
                    // already a `windows::core::Result<()>` so we can
                    // just propagate Errors.
                    let payload = match result {
                        Ok(()) => read_stream(&stream_for_handler),
                        Err(err) => Err(format!("CapturePreview reported failure: {err}")),
                    };
                    send_once(&handler_tx, payload);
                    Ok(())
                }));

                if let Err(err) = webview2.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &handler,
                ) {
                    send_once(
                        &dispatch_tx,
                        Err(format!("CapturePreview invocation failed: {err}")),
                    );
                }
            }
        });

        if let Err(err) = dispatch {
            // `with_webview` itself failed — the window is likely gone.
            // Pull the sender back out (if the closure never ran) and
            // surface a precise error.
            send_once(
                &tx_outer,
                Err(format!("with_webview dispatch failed: {err}")),
            );
        }

        match rx.await {
            Ok(Ok(bytes)) => Ok(bytes),
            Ok(Err(err)) => Err(err),
            Err(_) => Err(
                "WebView capture completion channel dropped (UI thread likely exited)".into(),
            ),
        }
    }

    /// Resolve the oneshot at most once. The closure form of
    /// `with_webview` can in principle be called or dropped before the
    /// handler fires, so guard against double-send.
    fn send_once(
        cell: &std::sync::Arc<Mutex<Option<oneshot::Sender<Result<Vec<u8>, String>>>>>,
        payload: Result<Vec<u8>, String>,
    ) {
        if let Ok(mut guard) = cell.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(payload);
            }
        }
    }

    /// Drain a CapturePreview result IStream into a freshly-allocated
    /// `Vec<u8>`. PNG output from WebView2 is typically under a couple
    /// of MB so reading the whole thing in one shot is fine.
    fn read_stream(stream: &IStream) -> Result<Vec<u8>, String> {
        unsafe {
            // First find out how big the stream is.
            let mut stat = std::mem::MaybeUninit::zeroed();
            stream
                .Stat(stat.as_mut_ptr(), STATFLAG_NONAME)
                .map_err(|e| format!("IStream::Stat failed: {e}"))?;
            let stat = stat.assume_init();
            let size = stat.cbSize as usize;
            if size == 0 {
                return Err("WebView2 returned an empty PNG stream".into());
            }

            // Rewind so we read from the start.
            stream
                .Seek(0, STREAM_SEEK_SET, None)
                .map_err(|e| format!("IStream::Seek failed: {e}"))?;

            let mut buf = vec![0u8; size];
            let mut bytes_read: u32 = 0;
            // `IStream::Read` returns a raw HRESULT (not a Result<()>)
            // because the COM contract treats partial reads on a memory
            // stream as informational, not errors. We treat anything
            // worse than S_FALSE as a hard failure.
            stream
                .Read(
                    buf.as_mut_ptr() as *mut std::ffi::c_void,
                    size as u32,
                    Some(&mut bytes_read),
                )
                .ok()
                .map_err(|e| format!("IStream::Read failed: {e}"))?;
            buf.truncate(bytes_read as usize);
            Ok(buf)
        }
    }
}
