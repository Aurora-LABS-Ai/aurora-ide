//! The interface in a browser: an HTTP host inside the desktop app.
//!
//! Off unless `AURORA_WEB=1` (port 3721, or `AURORA_WEB_PORT`). It binds
//! 127.0.0.1 only and speaks the contract `src/kernel/lib/ipc/runtime.ts`
//! (`WebRuntime`) already uses:
//!
//! - `POST /api/invoke/{cmd}` with `{"args": {...}}` → `{"ok": true, "data": …}`
//!   or `{"ok": false, "error": "…"}`. The call goes through Tauri's own
//!   command handler ([`invoke`]), so every registered command works with its
//!   state, app handle and window injected exactly as for the window.
//! - `GET /api/events/stream` plus `POST /api/events/subscribe|unsubscribe`:
//!   one SSE stream per page carrying every event it subscribed to
//!   ([`events`]). One stream, not one per event name: a browser allows six
//!   HTTP/1.1 connections per host and the window listens to dozens of events.
//!
//! This is the first step of `DOCS/rust-core-extraction.md` Phase 6: the
//! desktop process is the host for now, so commands that need a window run
//! against the IDE window. A headless host replaces it once the core no
//! longer needs Tauri.
//!
//! Every request must carry `Authorization: Bearer <token>` and a loopback
//! `Host`, because any page open in the user's browser can reach a localhost
//! port and these commands run shells. The token is `AURORA_WEB_TOKEN` or a
//! fresh random one, written to `<root>/web/token` for the dev proxy in
//! `vite.config.ts` to read. It is never put in the page.

mod events;
mod file;
mod invoke;
mod page;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::Router;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const DEFAULT_PORT: u16 = 3721;

/// Sent to every window whenever the host starts or stops, with its status.
pub const WEB_HOST_CHANGED_EVENT: &str = "web_host_changed";

/// The cookie a browser holds after opening the sign-in link.
const COOKIE: &str = "aurora_web";

pub(crate) struct WebHost {
    app: AppHandle,
    token: String,
    port: u16,
    streams: events::Streams,
}

struct Running {
    port: u16,
    token: String,
    stop: tokio::sync::oneshot::Sender<()>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

/// What the window shows about the host.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebHostStatus {
    pub running: bool,
    pub port: u16,
    /// `http://127.0.0.1:<port>/agent-window`, without the token.
    pub url: Option<String>,
    /// The same address with the one-time token: opening it signs a browser in.
    pub sign_in_url: Option<String>,
}

pub fn status() -> WebHostStatus {
    match RUNNING.lock().as_ref() {
        Some(running) => WebHostStatus {
            running: true,
            port: running.port,
            url: Some(format!("http://127.0.0.1:{}/agent-window", running.port)),
            sign_in_url: Some(format!(
                "http://127.0.0.1:{}/agent-window?token={}",
                running.port, running.token
            )),
        },
        None => WebHostStatus {
            running: false,
            port: DEFAULT_PORT,
            url: None,
            sign_in_url: None,
        },
    }
}

/// Start the host when `AURORA_WEB=1` (port `AURORA_WEB_PORT`). Logs and
/// returns on any failure; the desktop app runs the same either way.
pub fn start_if_enabled(app: &AppHandle) {
    if std::env::var("AURORA_WEB").ok().as_deref() != Some("1") {
        return;
    }
    let port = std::env::var("AURORA_WEB_PORT").ok().and_then(|value| value.parse().ok());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = start(&app, port).await {
            crate::logging::log_error("web", &error);
        }
    });
}

/// Start serving on 127.0.0.1 (`port`, else 3721). Already running: returns
/// its status unchanged. A fresh token every start, so a link from an earlier
/// run stops working.
pub async fn start(app: &AppHandle, port: Option<u16>) -> Result<WebHostStatus, String> {
    if RUNNING.lock().is_some() {
        return Ok(status());
    }
    let port = port.unwrap_or(DEFAULT_PORT);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("could not listen on {addr}: {e}"))?;
    let token = std::env::var("AURORA_WEB_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
        .unwrap_or_else(|| format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()));
    if let Err(error) = write_token(&token) {
        crate::logging::log_warn("web", &format!("could not write the token file: {error}"));
    }
    let host = Arc::new(WebHost {
        app: app.clone(),
        token: token.clone(),
        port,
        streams: events::Streams::default(),
    });
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    {
        let mut running = RUNNING.lock();
        if running.is_some() {
            return Ok(status());
        }
        *running = Some(Running { port, token, stop });
    }
    let mine = host.token.clone();
    let router = router(host);
    let changed = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::logging::log_info("web", &format!("serving the interface on http://{addr}"));
        let served = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
        if let Err(error) = served {
            crate::logging::log_error("web", &format!("web host stopped: {error}"));
        }
        // `stop` already cleared the slot; a server that ended on its own
        // clears it here. Only its own entry: a host started again before
        // this one finished shutting down must stay.
        {
            let mut running = RUNNING.lock();
            if running.as_ref().is_some_and(|r| r.token == mine) {
                running.take();
            }
        }
        let _ = changed.emit(WEB_HOST_CHANGED_EVENT, status());
    });
    let now = status();
    let _ = app.emit(WEB_HOST_CHANGED_EVENT, &now);
    Ok(now)
}

/// Stop serving. Open browser tabs lose their connection; the window says so
/// through [`WEB_HOST_CHANGED_EVENT`].
pub fn stop() {
    if let Some(running) = RUNNING.lock().take() {
        let _ = running.stop.send(());
    }
}

fn write_token(token: &str) -> std::io::Result<()> {
    let dir = crate::paths::root().join("web");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("token"), token)
}

fn router(host: Arc<WebHost>) -> Router {
    Router::new()
        .route("/api/invoke/:command", post(invoke::handle))
        .route("/api/events/stream", get(events::stream))
        .route("/api/events/subscribe", post(events::subscribe))
        .route("/api/events/unsubscribe", post(events::unsubscribe))
        .route("/api/file", get(file::handle))
        // Everything else is the interface itself, from the files built into
        // the app (`page.rs`).
        .fallback(page::handle)
        .layer(middleware::from_fn_with_state(host.clone(), guard))
        .with_state(host)
}

/// Loopback `Host`, then who is asking: the bearer token (the dev proxy), the
/// sign-in cookie (a browser), or a sign-in link (`?token=`), which sets the
/// cookie and reloads the address without the token in it.
async fn guard(State(host): State<Arc<WebHost>>, request: Request<Body>, next: Next) -> Response {
    let host_ok = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| is_loopback_host(value, host.port));
    if !host_ok {
        return (StatusCode::FORBIDDEN, "Aurora's web host only answers 127.0.0.1 and localhost").into_response();
    }
    let token = host.token.as_bytes();
    let bearer_ok = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| constant_time_eq(value.as_bytes(), token));
    let cookie_ok = request
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .any(|(name, value)| name == COOKIE && constant_time_eq(value.as_bytes(), token));
    if bearer_ok || cookie_ok {
        return next.run(request).await;
    }
    if let Some(rest) = sign_in(&request, token) {
        let cookie = format!("{COOKIE}={}; Path=/; HttpOnly; SameSite=Strict", host.token);
        let mut response = Redirect::to(&rest).into_response();
        if let Ok(value) = cookie.parse() {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
        return response;
    }
    if request.uri().path().starts_with("/api/") {
        return (StatusCode::UNAUTHORIZED, "missing or wrong Aurora web token").into_response();
    }
    page::signed_out()
}

/// A valid `?token=` on a page address: where to send the browser next (the
/// same address without the token).
fn sign_in(request: &Request<Body>, token: &[u8]) -> Option<String> {
    let uri = request.uri();
    let query = uri.query()?;
    let mut matched = false;
    let rest: Vec<&str> = query
        .split('&')
        .filter(|pair| match pair.split_once('=') {
            Some(("token", value)) => {
                matched = constant_time_eq(value.as_bytes(), token);
                false
            }
            _ => true,
        })
        .collect();
    matched.then(|| {
        if rest.is_empty() {
            uri.path().to_string()
        } else {
            format!("{}?{}", uri.path(), rest.join("&"))
        }
    })
}

fn is_loopback_host(value: &str, port: u16) -> bool {
    let value = value.trim().to_ascii_lowercase();
    ["127.0.0.1", "localhost"]
        .iter()
        .any(|name| value == *name || value == format!("{name}:{port}"))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_hosts_on_our_port_pass() {
        assert!(is_loopback_host("127.0.0.1:3721", 3721));
        assert!(is_loopback_host("localhost:3721", 3721));
        assert!(is_loopback_host("LOCALHOST", 3721));
        // DNS rebinding: an attacker's name resolving to 127.0.0.1.
        assert!(!is_loopback_host("evil.example:3721", 3721));
        assert!(!is_loopback_host("127.0.0.1:9999", 3721));
        assert!(!is_loopback_host("127.0.0.1.evil.example", 3721));
    }

    fn request(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    #[test]
    fn a_sign_in_link_sends_the_browser_on_without_the_token() {
        let token = b"secret";
        assert_eq!(
            sign_in(&request("/agent-window?token=secret"), token).as_deref(),
            Some("/agent-window")
        );
        assert_eq!(
            sign_in(&request("/agent-window/p/e--repo?ws=x&token=secret"), token).as_deref(),
            Some("/agent-window/p/e--repo?ws=x")
        );
        assert_eq!(sign_in(&request("/agent-window?token=wrong"), token), None);
        assert_eq!(sign_in(&request("/agent-window"), token), None);
    }

    #[test]
    fn token_comparison_needs_the_whole_token() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"ab", b"abc"));
        assert!(!constant_time_eq(b"", b"abc"));
    }
}
