//! DevTools Protocol bridge for the embedded browser.
//!
//! Sibling of [`super::browser_native_capture`], reached the same way: the
//! `with_webview` escape hatch hands us the platform `ICoreWebView2`, and on
//! Windows that object exposes `CallDevToolsProtocolMethod` — the exact
//! channel Chrome's own DevTools speaks over. No second browser, no bundled
//! Chromium, no debugging port.
//!
//! ## Why this exists rather than `eval`-ing JavaScript
//!
//! Aurora can already run script in the page, and for anything the PAGE does
//! that is enough. It is NOT enough for anything the BROWSER does, and the
//! difference is silent:
//!
//! * `dispatchEvent(new MouseEvent("mouseover"))` runs the page's JS handlers
//!   but does not put the pointer anywhere, so CSS `:hover` never paints. A
//!   hover check built on it reports success having rendered nothing.
//! * `dispatchEvent(new KeyboardEvent("keydown", {key:"Tab"}))` does not move
//!   focus. Tab traversal does nothing at all, so a keyboard-navigation audit
//!   passes without testing a single stop.
//! * Resizing the window is not viewport emulation: no device pixel ratio, no
//!   mobile flag, and it disturbs the window the user is looking at.
//!
//! In every one of those cases the naive implementation *succeeds* and
//! certifies work it never performed. That is strictly worse than not having
//! the tool, which is why this module exists.
//!
//! `Input.*` and `Emulation.*` go through the browser's own input and
//! rendering pipeline, so hover really paints, focus really moves, and media
//! queries really re-evaluate.
//!
//! ## Platform
//!
//! WebView2 is Windows-only. Elsewhere [`call_devtools`] returns
//! [`DevToolsError::Unsupported`] and callers MUST surface that — a silent
//! no-op would recreate the false-pass problem the module exists to prevent.

use serde_json::Value;
use tauri::Webview;

/// Why a DevTools call could not be completed.
///
/// `Unsupported` is constructed only in the non-Windows build, so a Windows
/// compile flags it as dead. It is NOT dead — deleting it would leave the
/// other platforms with no way to say "there is no channel here", which is
/// precisely the message that must never be silently swallowed.
#[cfg_attr(windows, allow(dead_code))]
#[derive(Debug, Clone)]
pub enum DevToolsError {
    /// No DevTools channel on this platform (macOS / Linux).
    Unsupported,
    /// The channel exists but the call failed.
    Failed(String),
}

impl std::fmt::Display for DevToolsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported => write!(
                f,
                "browser emulation and synthetic input need the WebView2 DevTools channel, \
                 which exists only on Windows. This tool cannot run on this platform"
            ),
            Self::Failed(message) => write!(f, "{message}"),
        }
    }
}

/// Call one DevTools Protocol method against `webview` and return its result.
///
/// `method` is a CDP method name (`"Emulation.setDeviceMetricsOverride"`),
/// `params` its parameter object. The returned `Value` is the method's result
/// object, or `Value::Null` for methods that return nothing.
pub async fn call_devtools(
    webview: &Webview,
    method: &str,
    params: Value,
) -> Result<Value, DevToolsError> {
    #[cfg(windows)]
    {
        windows_impl::call(webview, method, params).await
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, method, params);
        Err(DevToolsError::Unsupported)
    }
}

/// Is there a DevTools channel at all on this build?
///
/// Lets a caller answer "can I even try?" without making a call.
#[must_use]
pub const fn devtools_available() -> bool {
    cfg!(windows)
}

#[cfg(windows)]
mod windows_impl {
    //! `ICoreWebView2::CallDevToolsProtocolMethod`.
    //!
    //! Threading mirrors `browser_native_capture`: `with_webview` posts the
    //! closure to the WebView's UI thread, the COM completion handler fires
    //! there too, and only the resulting JSON string crosses back over a
    //! oneshot.

    use std::sync::{Arc, Mutex};

    use serde_json::Value;
    use tauri::Webview;
    use tokio::sync::oneshot;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    use super::DevToolsError;

    type Reply = Result<Value, DevToolsError>;

    pub(super) async fn call(webview: &Webview, method: &str, params: Value) -> Reply {
        let (tx, rx) = oneshot::channel::<Reply>();
        // `with_webview` needs a Send + 'static closure and the completion
        // handler can only resolve once — same Mutex<Option<Sender>> shape the
        // capture path uses.
        let tx_outer = Arc::new(Mutex::new(Some(tx)));

        // CDP takes its parameters as a JSON *string*, and an empty object is
        // the correct encoding of "no parameters" — passing an empty string
        // makes WebView2 reject the call.
        let params_json = if params.is_null() {
            "{}".to_string()
        } else {
            params.to_string()
        };
        let method_owned = method.to_string();
        let method_for_error = method.to_string();

        let dispatch_tx = tx_outer.clone();
        let dispatch = webview.with_webview(move |platform_webview| {
            // SAFETY: every COM call here runs on the WebView's UI thread;
            // nothing but the resulting String crosses a thread boundary.
            unsafe {
                let controller = platform_webview.controller();
                let webview2 = match controller.CoreWebView2() {
                    Ok(v) => v,
                    Err(err) => {
                        send_once(
                            &dispatch_tx,
                            Err(DevToolsError::Failed(format!(
                                "CoreWebView2 unavailable: {err}"
                            ))),
                        );
                        return;
                    }
                };

                let handler_tx = dispatch_tx.clone();
                let handler_method = method_owned.clone();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result, returned: String| {
                        let payload = match result {
                            // `webview2-com`'s callback macro has already
                            // copied WebView2's wide string into an owned
                            // `String`, so there is no raw buffer to outlive.
                            Ok(()) => parse_result(&handler_method, &returned),
                            Err(err) => Err(DevToolsError::Failed(format!(
                                "{handler_method} failed: {err}"
                            ))),
                        };
                        send_once(&handler_tx, payload);
                        Ok(())
                    },
                ));

                if let Err(err) = webview2.CallDevToolsProtocolMethod(
                    &HSTRING::from(method_owned.as_str()),
                    &HSTRING::from(params_json.as_str()),
                    &handler,
                ) {
                    send_once(
                        &dispatch_tx,
                        Err(DevToolsError::Failed(format!(
                            "{method_owned} could not be dispatched: {err}"
                        ))),
                    );
                }
            }
        });

        if let Err(err) = dispatch {
            // The webview is gone, so the closure will never run — resolve the
            // channel ourselves rather than hanging the caller forever.
            send_once(
                &tx_outer,
                Err(DevToolsError::Failed(format!(
                    "the browser is not available ({err})"
                ))),
            );
        }

        match rx.await {
            Ok(reply) => reply,
            Err(_) => Err(DevToolsError::Failed(format!(
                "{method_for_error} never completed (the browser's UI thread exited)"
            ))),
        }
    }

    /// Decode the JSON string WebView2 hands back.
    ///
    /// An empty payload means "no result", which is normal for the `Input.*`
    /// and `Emulation.*` setters — it is a success, not a failure.
    ///
    /// A protocol-level failure is NOT signalled through `errorCode`:
    /// `CallDevToolsProtocolMethod` completes successfully whenever the
    /// message reached the browser, and the browser's own rejection comes back
    /// inside the payload as `{"error": {"code": …, "message": …}}`. Returning
    /// that as `Ok` is how `browser_set_viewport {reset:true}` came to report
    /// "Viewport override cleared" while the override was still in force — the
    /// exact false-pass this module's own header says must never happen. So
    /// the error object is unwrapped here, once, for every caller.
    fn parse_result(method: &str, returned: &str) -> Result<Value, DevToolsError> {
        if returned.trim().is_empty() {
            return Ok(Value::Null);
        }
        let value = serde_json::from_str::<Value>(returned).map_err(|err| {
            DevToolsError::Failed(format!(
                "{method} returned a result that is not valid JSON: {err}"
            ))
        })?;
        if let Some(error) = value.get("error").filter(|e| e.is_object()) {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("no message");
            return Err(DevToolsError::Failed(match error.get("code") {
                Some(code) => format!("{method} was rejected by the browser: {message} ({code})"),
                None => format!("{method} was rejected by the browser: {message}"),
            }));
        }
        Ok(value)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn an_empty_payload_is_success() {
            assert!(matches!(
                parse_result("Emulation.x", "   "),
                Ok(Value::Null)
            ));
        }

        #[test]
        fn a_protocol_error_payload_is_a_failure_not_a_result() {
            let err = parse_result(
                "Emulation.clearDeviceMetricsOverride",
                r#"{"error":{"code":-32000,"message":"Not supported"}}"#,
            )
            .expect_err("a rejected CDP call must not read as success");
            let text = err.to_string();
            assert!(text.contains("Not supported"), "{text}");
            assert!(text.contains("-32000"), "{text}");
        }

        #[test]
        fn a_result_that_merely_contains_the_word_error_still_succeeds() {
            // `error` has to be an OBJECT to count — a page-supplied string
            // field of that name is data, not a protocol rejection.
            let value = parse_result("Runtime.evaluate", r#"{"error":"not an object"}"#)
                .expect("a string field named error is not a protocol failure");
            assert_eq!(
                value.get("error").and_then(Value::as_str),
                Some("not an object")
            );
        }
    }

    fn send_once(cell: &Arc<Mutex<Option<oneshot::Sender<Reply>>>>, payload: Reply) {
        if let Ok(mut guard) = cell.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(payload);
            }
        }
    }
}
