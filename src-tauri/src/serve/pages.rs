//! What a host answers that is not a command: the small explanatory pages
//! (signed out, no built interface) and a file from disk for `<img>` /
//! `<video>` (`GET /api/file?path=…`; `localFileUrl` in
//! `src/kernel/lib/ipc/runtime.ts`). Shared by `web_host` and `aurora serve`.

use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};

/// A browser that has not opened the sign-in link (or holds one from an
/// earlier run). `how` says where to get the link on this host.
pub fn signed_out(how: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Html(message("Open Aurora's link to sign in", how)),
    )
        .into_response()
}

/// The password page `aurora serve` shows a signed-out browser when a password
/// is set (`serve::access`). A plain form posting to `/login`, so it works
/// before any script has loaded; `next` is where to go once signed in.
/// Colours are Aurora Dark's (rails #181818 on a #141414 sheet, the field on
/// the raised #232323, the accent button).
pub fn login(next: &str, error: Option<&str>, status: StatusCode) -> Response {
    let next = html_escape(next);
    let error = error
        .map(|text| format!("<p class=\"err\" role=\"alert\">{}</p>", html_escape(text)))
        .unwrap_or_default();
    (
        status,
        Html(format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
             <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
             <title>Sign in · Aurora</title><style>\
             :root{{color-scheme:dark}}*{{box-sizing:border-box}}\
             body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#141414;color:#f0f0f0;\
             font:14px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,sans-serif}}\
             form{{width:min(340px,calc(100vw - 32px));padding:24px;border-radius:12px;background:#181818;\
             box-shadow:inset 0 0 0 1px rgba(255,255,255,.042),0 8px 16px -4px rgba(0,0,0,.12)}}\
             h1{{margin:0 0 4px;font-size:16px;font-weight:600}}\
             p{{margin:0 0 16px;color:rgba(240,240,240,.65);font-size:13px}}\
             label{{display:block;margin-bottom:6px;font-size:13px;color:rgba(240,240,240,.65)}}\
             input{{width:100%;height:32px;padding:0 10px;border-radius:8px;border:1px solid rgba(255,255,255,.084);\
             background:#232323;color:#f0f0f0;font:inherit;outline:none}}\
             input:focus{{border-color:rgba(255,255,255,.3)}}\
             button{{width:100%;height:32px;margin-top:12px;border:0;border-radius:8px;background:#2f90eb;\
             color:#fff;font:inherit;font-weight:500;cursor:pointer}}button:hover{{background:#297dcc}}\
             .err{{margin:10px 0 0;color:#fa423e}}\
             </style></head><body><form method=\"post\" action=\"/login\">\
             <h1>Sign in to Aurora</h1><p>The password set on this machine with <code>aurora serve password</code>.</p>\
             <label for=\"pw\">Password</label>\
             <input id=\"pw\" name=\"password\" type=\"password\" autocomplete=\"current-password\" autofocus required>\
             <input type=\"hidden\" name=\"next\" value=\"{next}\">\
             {error}<button type=\"submit\">Sign in</button></form></body></html>"
        )),
    )
        .into_response()
}

/// Where a sign-in may send the browser: a path on this server, never another
/// site (`//evil.example` and `https://…` fall back to the app).
pub fn safe_next(next: &str) -> &str {
    if next.starts_with('/') && !next.starts_with("//") && !next.contains('\\') {
        next
    } else {
        "/agent-window"
    }
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Page addresses (`/agent-window/p/<slug>/<id>`) have no extension; files do.
pub fn has_extension(path: &str) -> bool {
    path.rsplit('/').next().is_some_and(|last| last.contains('.'))
}

/// A browser only ever gets the agent window: `/` (and any other page address)
/// would mount the editor, which carries no agent and runs its own first-launch
/// tour. `path` has no leading slash.
pub fn is_agent_window(path: &str) -> bool {
    path == "agent-window" || path.starts_with("agent-window/")
}

pub fn message(title: &str, body: &str) -> String {
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

/// A file on this machine, by absolute path. It reads no more than
/// `read_file_content` already can.
pub async fn local_file(path: &str) -> Response {
    match tokio::fs::read(path).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, content_type(path)),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (StatusCode::NOT_FOUND, format!("no such file: {path}")).into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not read {path}: {error}"),
        )
            .into_response(),
    }
}

/// Media type by extension: what the window shows from disk, plus the files
/// a built interface is made of.
pub fn content_type(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_addresses_have_no_extension_and_files_do() {
        assert!(!has_extension("agent-window"));
        assert!(!has_extension("agent-window/p/e--repo/7d5db95e-f37f"));
        assert!(has_extension("assets/index-abc123.js"));
        assert!(has_extension("favicon.ico"));
    }

    #[test]
    fn a_sign_in_only_ever_returns_to_this_server() {
        assert_eq!(safe_next("/agent-window/p/x"), "/agent-window/p/x");
        assert_eq!(safe_next("//evil.example/x"), "/agent-window");
        assert_eq!(safe_next("https://evil.example"), "/agent-window");
        assert_eq!(safe_next("/\\evil.example"), "/agent-window");
    }

    #[test]
    fn media_types_follow_the_extension_in_any_case() {
        assert_eq!(content_type(r"C:\a\shot.PNG"), "image/png");
        assert_eq!(content_type("/tmp/clip.webm"), "video/webm");
        assert_eq!(content_type("assets/index-1.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("notes"), "application/octet-stream");
    }
}
