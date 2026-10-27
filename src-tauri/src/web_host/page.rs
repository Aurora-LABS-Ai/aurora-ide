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
    (
        StatusCode::UNAUTHORIZED,
        Html(message(
            "Open Aurora's link to sign in",
            "This address needs the link Aurora gives you: in the app, the browser \
             button at the bottom of the icon rail, then <b>Open in browser</b> or \
             <b>Copy link</b>. A link from an earlier run stops working when Aurora \
             restarts the web host.",
        )),
    )
        .into_response()
}

fn has_extension(path: &str) -> bool {
    path.rsplit('/').next().is_some_and(|last| last.contains('.'))
}

fn message(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>Aurora</title><style>\
         :root{{color-scheme:dark light}}\
         body{{margin:0;min-height:100vh;display:grid;place-items:center;\
         font:15px/1.5 system-ui,sans-serif;background:#111;color:#ddd}}\
         main{{max-width:440px;padding:24px}}\
         h1{{font-size:17px;font-weight:600;margin:0 0 8px;color:#fff}}\
         p{{margin:0;color:#aaa}}code{{font-size:13px}}\
         @media (prefers-color-scheme: light){{body{{background:#fafafa;color:#222}}\
         h1{{color:#111}}p{{color:#555}}}}\
         </style></head><body><main><h1>{title}</h1><p>{body}</p></main></body></html>"
    )
}

#[cfg(test)]
mod tests {
    use super::has_extension;

    #[test]
    fn app_addresses_have_no_extension_and_files_do() {
        assert!(!has_extension("agent-window"));
        assert!(!has_extension("agent-window/p/e--repo/7d5db95e-f37f"));
        assert!(has_extension("assets/index-abc123.js"));
        assert!(has_extension("favicon.ico"));
    }
}
