//! Serving local files to the browser panel.
//!
//! A `file://` page in the panel renders but cannot answer: the capability
//! grant that injects Tauri IPC into browser webviews (`capabilities/
//! browser.json`) matches `http://*` and `https://*` origins only, so the
//! injected `__aurora` bridge has no way to post results back. Every eval —
//! the post-navigate snapshot, `browser_view`, a click's change summary —
//! then waits out its full 30s timeout. Observed live (2026-08-21): the page
//! visibly loaded while `browser_navigate` sat "running" and every later
//! observation timed out; the agent had to stand up a Python HTTP server to
//! route around its own browser.
//!
//! The fix is to never load `file://` in the panel at all. Aurora registers
//! its own URI scheme, `aurora-page`, whose handler serves the file from
//! disk. On Windows — the platform this app ships on — Tauri surfaces a
//! custom scheme to the webview as `http://aurora-page.localhost/…`, which
//! the EXISTING `http://*` capability already covers: the page gets the full
//! bridge with no loosening of the grant. Other platforms surface it as
//! `aurora-page://localhost/…`, which the capability does not match, so the
//! rewrite is Windows-only and other platforms keep today's behaviour.
//!
//! Cross-origin safety: responses carry no `Access-Control-Allow-Origin`, so
//! a remote page in the panel cannot fetch-and-read local files through this
//! scheme — the browser's same-origin policy does the blocking, exactly as it
//! does for any two unrelated origins.

use std::borrow::Cow;
use std::path::PathBuf;

/// The scheme name registered in `lib.rs`.
pub const SCHEME: &str = "aurora-page";

/// The URL the panel should load instead of a `file://` one.
///
/// `None` when the input is not a `file://` URL, or on platforms where the
/// served origin would not receive the IPC bridge anyway.
#[must_use]
pub fn to_served_url(url: &str) -> Option<String> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let rest = url.strip_prefix("file://")?;
    // `file:///E:/x`, `file://localhost/E:/x` and the (wrong but seen)
    // `file://E:/x` all mean the same file.
    let path = rest
        .strip_prefix("localhost/")
        .or_else(|| rest.strip_prefix('/'))
        .unwrap_or(rest);
    Some(format!("http://{SCHEME}.localhost/{path}"))
}

/// Serve one request against the local filesystem.
///
/// GET only, files only, 404 for everything else. The path is the request
/// path with the leading slash removed — an absolute local path, because the
/// URLs are only ever minted by [`to_served_url`] from absolute `file://`
/// URLs. There is no sandbox root on purpose: the agent's `file_read`
/// already reaches the whole disk, so the panel previewing the same files
/// adds no new reach, and remote pages are held off by same-origin (see the
/// module docs).
#[must_use]
pub fn respond(
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    if request.method() != tauri::http::Method::GET {
        return plain(405, "aurora-page serves GET only");
    }
    let Some(path) = decode_request_path(request.uri().path()) else {
        return plain(404, "aurora-page: not a readable file path");
    };
    if !path.is_file() {
        return plain(404, "aurora-page: no such file");
    }
    match std::fs::read(&path) {
        Ok(bytes) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", mime_for(&path))
            // The whole point of previewing a local file is seeing the
            // version on disk right now.
            .header("Cache-Control", "no-cache")
            .body(Cow::Owned(bytes))
            .unwrap_or_else(|_| plain(500, "aurora-page: response build failed")),
        Err(error) => plain(404, &format!("aurora-page: {error}")),
    }
}

/// `/E:/dir/file.html` (percent-encoded) → the local path it names.
fn decode_request_path(raw: &str) -> Option<PathBuf> {
    let decoded = percent_decode(raw.strip_prefix('/').unwrap_or(raw))?;
    if decoded.is_empty() {
        return None;
    }
    let path = PathBuf::from(&decoded);
    // Only absolute paths can have come from `to_served_url`; a relative one
    // is a hand-typed or hostile URL and resolves against nothing.
    path.is_absolute().then_some(path)
}

/// Minimal percent-decoding. `None` on malformed escapes or invalid UTF-8 —
/// a URL this handler minted never contains either, so failing closed only
/// rejects URLs it never issued.
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Content type by extension. `text/plain` for anything unrecognised — the
/// panel is a preview surface, and showing unknown bytes as text beats a
/// download prompt.
fn mime_for(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("pdf") => "application/pdf",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("txt" | "md" | "log" | "csv") => "text/plain; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    }
}

fn plain(status: u16, body: &str) -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(Cow::Owned(body.as_bytes().to_vec()))
        .expect("a plain-text response always builds")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_urls_become_served_urls_on_windows() {
        if !cfg!(target_os = "windows") {
            return;
        }
        assert_eq!(
            to_served_url("file:///E:/VOID-EDITOR/aurora-testing/toast.html").as_deref(),
            Some("http://aurora-page.localhost/E:/VOID-EDITOR/aurora-testing/toast.html")
        );
        assert_eq!(
            to_served_url("file://localhost/C:/x/y.html").as_deref(),
            Some("http://aurora-page.localhost/C:/x/y.html")
        );
    }

    #[test]
    fn non_file_urls_pass_untouched() {
        assert_eq!(to_served_url("http://localhost:8080"), None);
        assert_eq!(to_served_url("https://example.com"), None);
        assert_eq!(to_served_url("about:blank"), None);
    }

    #[test]
    fn a_real_file_is_served_with_its_type() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("page.html");
        std::fs::write(&file, "<h1>hi</h1>").unwrap();

        let url = format!(
            "http://{SCHEME}.localhost/{}",
            file.to_string_lossy().replace('\\', "/")
        );
        let request = tauri::http::Request::builder()
            .method("GET")
            .uri(url)
            .body(Vec::new())
            .unwrap();
        let response = respond(&request);
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers().get("Content-Type").unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(response.body().as_ref(), b"<h1>hi</h1>");
    }

    #[test]
    fn a_missing_file_is_a_404_not_a_hang() {
        let request = tauri::http::Request::builder()
            .method("GET")
            .uri(format!(
                "http://{SCHEME}.localhost/E:/definitely/not/here.html"
            ))
            .body(Vec::new())
            .unwrap();
        assert_eq!(respond(&request).status(), 404);
    }

    #[test]
    fn a_relative_or_empty_path_is_refused() {
        for path in ["", "relative/only.html"] {
            let request = tauri::http::Request::builder()
                .method("GET")
                .uri(format!("http://{SCHEME}.localhost/{path}"))
                .body(Vec::new())
                .unwrap();
            assert_eq!(respond(&request).status(), 404, "path {path:?}");
        }
    }

    #[test]
    fn percent_encoded_paths_decode() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("with space.txt");
        std::fs::write(&file, "x").unwrap();
        let encoded = file
            .to_string_lossy()
            .replace('\\', "/")
            .replace(' ', "%20");
        let request = tauri::http::Request::builder()
            .method("GET")
            .uri(format!("http://{SCHEME}.localhost/{encoded}"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(respond(&request).status(), 200);
    }
}
