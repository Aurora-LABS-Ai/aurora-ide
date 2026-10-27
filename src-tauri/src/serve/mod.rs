//! `aurora serve`: Aurora's engine and its interface on an HTTP port, with no
//! window. Phase 6.1 of `DOCS/rust-core-extraction.md`.
//!
//! The process opens the database, starts the engine (`start_engine`) with an
//! [`hub::EventHub`] as its event sink, and serves the contract the
//! frontend's `WebRuntime` already speaks (the desktop app's browser host,
//! `web_host`, serves the same one):
//!
//! - `POST /api/invoke/{cmd}` with `{"args": {...}}` → `{"ok": true, "data"}`
//!   or `{"ok": false, "error"}`, run by [`crate::host_commands::dispatch`].
//!   Only the commands moved there exist here; the rest answer that they are
//!   not on this host yet (step 3 of the plan is moving them).
//! - `GET /api/events/stream`, `POST /api/events/subscribe|unsubscribe`.
//! - `GET /api/file?path=…` for pictures and videos from disk.
//! - Everything else: the built interface from `--dist` (`pnpm build`'s
//!   `dist/`), `index.html` for app addresses.
//!
//! Sign-in: a fresh token per start, printed as a link; opening it sets an
//! HttpOnly cookie. The token is also written to `<root>/web/token`, so
//! `pnpm dev`'s proxy reaches this server the same way it reaches the
//! desktop host. Loopback only unless `--host` says otherwise, and then it
//! warns: anyone with the link can run commands on this machine.

pub mod auth;
pub mod hub;
pub mod pages;

use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::Stream;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::host_commands::{dispatch, CommandContext, CommandError};
use hub::EventHub;

pub const DEFAULT_PORT: u16 = 3721;

/// What `aurora serve` was asked for.
#[derive(Debug, Clone)]
pub struct ServeOptions {
    pub port: u16,
    /// The address to listen on; 127.0.0.1 unless the user chose otherwise.
    pub host: IpAddr,
    /// The built interface; `None` serves the API only (use `pnpm dev`).
    pub dist: Option<PathBuf>,
}

pub(crate) struct ServeHost {
    ctx: CommandContext,
    hub: Arc<EventHub>,
    token: String,
    port: u16,
    /// Requests must name 127.0.0.1/localhost in `Host` (DNS rebinding).
    loopback_only: bool,
    dist: Option<PathBuf>,
}

/// Run the server until Ctrl+C. Returns the process exit code.
pub fn run(options: ServeOptions) -> i32 {
    crate::logging::init();
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Error: could not start the runtime: {error}");
            return 1;
        }
    };
    match runtime.block_on(serve(options)) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Error: {error}");
            crate::logging::log_error("serve", &error);
            1
        }
    }
}

async fn serve(options: ServeOptions) -> Result<(), String> {
    // This process owns the schema while it runs, as the desktop app does.
    let db = crate::db::Database::init().map_err(|e| {
        format!(
            "could not open Aurora's database at {}: {e}",
            crate::paths::db_file().display()
        )
    })?;
    let db: Arc<dyn crate::db::DatabaseAccess> = Arc::new(Mutex::new(db));
    let hub = Arc::new(EventHub::default());
    let events: crate::host_events::Events = hub.clone();
    let engine = crate::agent_runtime::host::start_engine(crate::agent_runtime::host::EngineHost {
        db: db.clone(),
        events: events.clone(),
        browser: None,
    })
    .map_err(|e| format!("could not start the engine: {e:#}"))?;

    let token = auth::new_token();
    if let Err(error) = auth::write_token(&token) {
        crate::logging::log_warn("serve", &format!("could not write the token file: {error}"));
    }
    let addr = SocketAddr::new(options.host, options.port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("could not listen on {addr}: {e}"))?;
    let host = Arc::new(ServeHost {
        ctx: CommandContext::new(&engine, events, db),
        hub,
        token: token.clone(),
        port: options.port,
        loopback_only: options.host.is_loopback(),
        dist: options.dist.clone(),
    });

    print_banner(&options, &token);
    crate::logging::log_info("serve", &format!("serving on http://{addr}"));
    axum::serve(listener, router(host))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| format!("the server stopped: {e}"))
}

fn print_banner(options: &ServeOptions, token: &str) {
    let shown = if options.host.is_unspecified() || options.host.is_loopback() {
        "127.0.0.1".to_string()
    } else {
        options.host.to_string()
    };
    println!("Aurora is serving on port {}.", options.port);
    println!();
    println!("  Sign in:  http://{shown}:{}/agent-window?token={token}", options.port);
    println!();
    match &options.dist {
        Some(dist) => println!("Interface: {}", dist.display()),
        None => println!(
            "No built interface (pass --dist <folder> after `pnpm build`). \
             With `pnpm dev` running, open http://localhost:5273/agent-window instead."
        ),
    }
    println!(
        "Commands served so far: {} (the rest of the interface answers \"unknown command\" until \
         they move to this host).",
        crate::host_commands::all_commands().count()
    );
    if !options.host.is_loopback() {
        println!();
        println!(
            "WARNING: listening on {} — anyone who has the sign-in link can run commands, \
             edit files and spend your API keys on this machine.",
            options.host
        );
    }
    println!("Ctrl+C stops it.");
}

pub(crate) fn router(host: Arc<ServeHost>) -> Router {
    Router::new()
        .route("/api/invoke/:command", post(invoke))
        .route("/api/events/stream", get(stream))
        .route("/api/events/subscribe", post(subscribe))
        .route("/api/events/unsubscribe", post(unsubscribe))
        .route("/api/file", get(file))
        .fallback(page)
        .layer(middleware::from_fn_with_state(host.clone(), guard))
        .with_state(host)
}

/// `Host` (when loopback only), then the token: bearer header, cookie, or a
/// sign-in link that sets the cookie and drops the token from the address.
async fn guard(State(host): State<Arc<ServeHost>>, request: Request<Body>, next: Next) -> Response {
    if host.loopback_only {
        let host_ok = request
            .headers()
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| auth::is_loopback_host(value, host.port));
        if !host_ok {
            return (StatusCode::FORBIDDEN, "this Aurora only answers 127.0.0.1 and localhost")
                .into_response();
        }
    }
    let token = host.token.as_bytes();
    if auth::is_signed_in(request.headers(), token) {
        return next.run(request).await;
    }
    if let Some(rest) = auth::sign_in(&request, token) {
        let mut response = Redirect::to(&rest).into_response();
        if let Ok(value) = auth::sign_in_cookie(&host.token).parse() {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
        return response;
    }
    if request.uri().path().starts_with("/api/") {
        return (StatusCode::UNAUTHORIZED, "missing or wrong Aurora token").into_response();
    }
    pages::signed_out(
        "This address needs the sign-in link <code>aurora serve</code> printed when it \
         started. A link from an earlier run stops working when the server restarts.",
    )
}

async fn invoke(
    State(host): State<Arc<ServeHost>>,
    UrlPath(command): UrlPath<String>,
    body: Option<Json<Value>>,
) -> Response {
    let mut args = body
        .and_then(|Json(body)| body.get("args").cloned())
        .unwrap_or_else(|| json!({}));
    stamp_web_client(&command, &mut args);
    let reply = match dispatch(&host.ctx, &command, args).await {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => {
            if !matches!(error, CommandError::Unknown(_)) {
                crate::logging::log_warn("serve", &format!("`{command}` failed: {error}"));
            }
            json!({ "ok": false, "error": error.to_string() })
        }
    };
    (StatusCode::OK, Json(reply)).into_response()
}

/// A turn started through this server comes from a browser
/// (`AgentChatRequest::client`), whatever the page put there.
fn stamp_web_client(command: &str, args: &mut Value) {
    if command != "agent_chat_v2" {
        return;
    }
    if let Some(request) = args.get_mut("request").and_then(Value::as_object_mut) {
        request.insert("client".into(), json!("web"));
    }
}

/// Closes the hub's stream when the page goes away.
struct StreamGuard {
    hub: Arc<EventHub>,
    id: String,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.hub.close(&self.id);
    }
}

async fn stream(State(host): State<Arc<ServeHost>>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (id, rx) = host.hub.open();
    let ready = Event::default()
        .event("ready")
        .data(json!({ "stream": id }).to_string());
    let guard = StreamGuard {
        hub: host.hub.clone(),
        id,
    };
    let messages = futures::stream::unfold((rx, guard), |(mut rx, guard)| async move {
        let message = rx.recv().await?;
        Some((Ok(Event::default().data(message)), (rx, guard)))
    });
    let stream = futures::StreamExt::chain(futures::stream::once(async { Ok(ready) }), messages);
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

#[derive(Deserialize)]
struct Subscription {
    stream: String,
    event: String,
}

async fn subscribe(State(host): State<Arc<ServeHost>>, Json(request): Json<Subscription>) -> StatusCode {
    if host.hub.subscribe(&request.stream, &request.event) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn unsubscribe(State(host): State<Arc<ServeHost>>, Json(request): Json<Subscription>) -> StatusCode {
    host.hub.unsubscribe(&request.stream, &request.event);
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct FileQuery {
    path: String,
}

async fn file(Query(query): Query<FileQuery>) -> Response {
    pages::local_file(&query.path).await
}

/// The interface: a file from `--dist`, or `index.html` for an app address.
async fn page(State(host): State<Arc<ServeHost>>, request: Request<Body>) -> Response {
    let path = request.uri().path().trim_start_matches('/');
    let Some(dist) = host.dist.as_deref() else {
        return (
            StatusCode::NOT_FOUND,
            Html(pages::message(
                "This server has no built interface",
                "Start it with <code>--dist &lt;folder&gt;</code> after <code>pnpm build</code>, \
                 or run <code>pnpm dev</code> and open \
                 <code>http://localhost:5273/agent-window</code>.",
            )),
        )
            .into_response();
    };
    let wanted = if path.is_empty() || !pages::has_extension(path) {
        "index.html"
    } else {
        path
    };
    let Some(file) = inside(dist, wanted) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    match tokio::fs::read(&file).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, pages::content_type(wanted)),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// `relative` under `root`, refusing anything that climbs out of it.
fn inside(root: &Path, relative: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests;
