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
//! It listens on 127.0.0.1 and nothing else, ever (Alvan, 2026-10-28: "only
//! accessible via localhost, not over the internet"): there is no option to
//! bind another address. Other machines reach it through an SSH tunnel, which
//! is where the access list belongs.
//!
//! Sign-in: a fresh token per start, printed as a link (also written to
//! `<root>/web/token` for `pnpm dev`'s proxy); and, once the owner sets one
//! with `aurora serve password`, a password page. Either signs the browser
//! into a 30-day session that survives restarts (`access`).

pub mod access;
pub mod auth;
pub mod discovery;
pub mod hub;
pub mod pages;

use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
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
    /// The built interface; `None` serves the API only (use `pnpm dev`).
    pub dist: Option<PathBuf>,
}

/// The only address this server listens on.
const LISTEN: Ipv4Addr = Ipv4Addr::LOCALHOST;

pub(crate) struct ServeHost {
    ctx: CommandContext,
    hub: Arc<EventHub>,
    token: String,
    port: u16,
    access: access::Access,
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
    // One engine per machine: a second server would run a second copy of
    // every turn and every MCP server against the same chats.
    if let Some(running) = discovery::find() {
        println!(
            "Aurora is already serving on port {} (process {}). Open it in a browser:",
            running.port, running.pid
        );
        println!();
        println!("  {}", running.sign_in_url());
        return Ok(());
    }
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
    let addr = SocketAddr::new(LISTEN.into(), options.port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("could not listen on {addr}: {e}"))?;
    let access = access::Access::open();
    let password = access.password_set();
    let host = Arc::new(ServeHost {
        ctx: CommandContext::new(&engine, events, db),
        hub,
        token: token.clone(),
        port: options.port,
        access,
        dist: options.dist.clone(),
    });

    // Held until the server stops; dropping it removes the note.
    let _announced = discovery::announce(options.port, &token)
        .map_err(|e| crate::logging::log_warn("serve", &format!("could not write the engine note: {e}")))
        .ok();
    print_banner(&options, &token, password);
    crate::logging::log_info("serve", &format!("serving on http://{addr}"));
    axum::serve(listener, router(host))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| format!("the server stopped: {e}"))
}

/// `aurora serve password [--clear]`: set (asked twice, not echoed) or remove
/// the sign-in password on this machine. A running server picks it up.
pub fn password_command(clear: bool) -> i32 {
    let dir = crate::paths::root().join("web");
    if clear {
        return match access::clear_password(&dir) {
            Ok(()) => {
                println!("Password removed. Browsers are signed out; the printed link still works.");
                0
            }
            Err(error) => {
                eprintln!("Error: {error}");
                1
            }
        };
    }
    let first = match rpassword::prompt_password("New Aurora password: ") {
        Ok(text) => text,
        Err(error) => {
            eprintln!("Error: could not read the password from this terminal: {error}");
            return 1;
        }
    };
    if first.chars().count() < 8 {
        eprintln!("Error: use at least 8 characters.");
        return 1;
    }
    match rpassword::prompt_password("Type it again: ") {
        Ok(second) if second == first => {}
        Ok(_) => {
            eprintln!("Error: the two passwords are different. Nothing changed.");
            return 1;
        }
        Err(error) => {
            eprintln!("Error: could not read the password from this terminal: {error}");
            return 1;
        }
    }
    match access::set_password(&dir, &first) {
        Ok(()) => {
            println!(
                "Password saved (as a hash in {}). Browsers signed in before must sign in again; \
                 a signed-in browser stays signed in for {} days.",
                dir.join("config.json").display(),
                access::SESSION_DAYS
            );
            0
        }
        Err(error) => {
            eprintln!("Error: {error}");
            1
        }
    }
}

fn print_banner(options: &ServeOptions, token: &str, password: bool) {
    println!("Aurora is serving on 127.0.0.1:{} (this machine only).", options.port);
    println!();
    println!("  Sign in:  http://127.0.0.1:{}/agent-window?token={token}", options.port);
    if password {
        println!("  or open   http://127.0.0.1:{}/agent-window and type the password.", options.port);
    } else {
        println!("  Set a password to sign in without this link: aurora serve password");
    }
    println!();
    match &options.dist {
        Some(dist) => println!("Interface: {}", dist.display()),
        None => println!(
            "No built interface (pass --dist <folder> after `pnpm build`). \
             With `pnpm dev` running, open http://localhost:5273/agent-window instead."
        ),
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
        .route("/api/logout", post(logout))
        .fallback(page)
        .layer(middleware::from_fn_with_state(host.clone(), guard))
        .with_state(host)
}

/// `Host` must name 127.0.0.1/localhost (DNS rebinding), then one of: the
/// token (bearer header or the old token cookie), a session cookie, the
/// sign-in link, or the password form. A signed-out page gets the password
/// page when a password is set.
async fn guard(State(host): State<Arc<ServeHost>>, request: Request<Body>, next: Next) -> Response {
    let host_ok = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| auth::is_loopback_host(value, host.port));
    if !host_ok {
        return (StatusCode::FORBIDDEN, "this Aurora only answers 127.0.0.1 and localhost")
            .into_response();
    }
    let token = host.token.as_bytes();
    if auth::is_signed_in(request.headers(), token) {
        return next.run(request).await;
    }
    if access::session_from(request.headers()).is_some_and(|id| host.access.session_valid(&id)) {
        return next.run(request).await;
    }
    if request.uri().path() == "/login" && request.method() == axum::http::Method::POST {
        return login(&host, request).await;
    }
    if let Some(rest) = auth::sign_in(&request, token) {
        return signed_in(&host, &rest);
    }
    if request.uri().path().starts_with("/api/") {
        return (StatusCode::UNAUTHORIZED, "not signed in to Aurora").into_response();
    }
    if host.access.password_set() {
        let next = request
            .uri()
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| "/agent-window".into());
        return pages::login(pages::safe_next(&next), None, StatusCode::UNAUTHORIZED);
    }
    pages::signed_out(
        "This address needs the sign-in link <code>aurora serve</code> printed when it \
         started, or set a password on the machine with <code>aurora serve password</code> \
         and sign in with that.",
    )
}

/// A new session and the browser sent on to `next`.
fn signed_in(host: &ServeHost, next: &str) -> Response {
    let session = match host.access.new_session() {
        Ok(session) => session,
        Err(error) => {
            crate::logging::log_error("serve", &format!("could not start a session: {error}"));
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("could not sign in: {error}")).into_response();
        }
    };
    let mut response = Redirect::to(pages::safe_next(next)).into_response();
    if let Ok(value) = access::session_cookie(&session).parse() {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

/// The password form (`application/x-www-form-urlencoded`: `password`, `next`).
async fn login(host: &ServeHost, request: Request<Body>) -> Response {
    let bytes = match axum::body::to_bytes(request.into_body(), 16 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "sign-in form too large").into_response(),
    };
    let mut password = String::new();
    let mut next = String::from("/agent-window");
    for (key, value) in form_urlencoded::parse(&bytes) {
        match key.as_ref() {
            "password" => password = value.into_owned(),
            "next" => next = value.into_owned(),
            _ => {}
        }
    }
    let next = pages::safe_next(&next).to_string();
    match host.access.check_password(&password) {
        Ok(()) => signed_in(host, &next),
        Err(access::Refused::Wrong) => {
            pages::login(&next, Some("That password is not right."), StatusCode::UNAUTHORIZED)
        }
        Err(access::Refused::TooMany { wait_secs }) => pages::login(
            &next,
            Some(&format!("Too many wrong passwords. Try again in {wait_secs} s.")),
            StatusCode::TOO_MANY_REQUESTS,
        ),
        Err(access::Refused::NoPassword) => pages::signed_out(
            "No password is set on this machine. Set one with <code>aurora serve password</code>, \
             or use the sign-in link <code>aurora serve</code> printed.",
        ),
    }
}

/// End this browser's session.
async fn logout(State(host): State<Arc<ServeHost>>, request: Request<Body>) -> Response {
    if let Some(id) = access::session_from(request.headers()) {
        host.access.end_session(&id);
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Ok(value) = access::cleared_cookie().parse() {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
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
