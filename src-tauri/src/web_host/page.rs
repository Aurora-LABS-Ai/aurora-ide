//! The interface itself, for a browser: the same built files the desktop
//! window loads, read from the app (`AssetResolver`), so an installed Aurora
//! needs no dev server. Any address without a file extension is the app
//! (`/agent-window/p/<slug>/<id>`) and gets `index.html`.
//!
//! A dev build (`pnpm tauri:dev`) carries no built files; the interface is
//! Vite's at `http://localhost:5273`, and this says so.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};

use super::WebHost;
use crate::serve::pages::{has_extension, message};

pub(super) async fn handle(State(host): State<Arc<WebHost>>, request: Request<Body>) -> Response {
    let path = request.uri().path().trim_start_matches('/');
    let resolver = host.app.asset_resolver();
    let asset = if path.is_empty() || !has_extension(path) {
        resolver.get("index.html".to_string())
    } else {
        resolver.get(path.to_string())
    };
    match asset {
        Some(asset) => (
            [
                (header::CONTENT_TYPE, asset.mime_type),
                (header::CACHE_CONTROL, "no-cache".to_string()),
            ],
            asset.bytes,
        )
            .into_response(),
        None if path.is_empty() || !has_extension(path) => (
            StatusCode::NOT_FOUND,
            Html(message(
                "This Aurora has no built interface",
                "A development build serves the interface from Vite: open \
                 <code>http://localhost:5273/agent-window</code> instead.",
            )),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// A browser that has not opened the sign-in link (or holds one from an
/// earlier run of Aurora).
pub(super) fn signed_out() -> Response {
    crate::serve::pages::signed_out(
        "This address needs the link Aurora gives you: in the app, the browser \
         button at the bottom of the icon rail, then <b>Open in browser</b> or \
         <b>Copy link</b>. A link from an earlier run stops working when Aurora \
         restarts the web host.",
    )
}
