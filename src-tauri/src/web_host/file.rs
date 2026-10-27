//! `GET /api/file?path=…`: a file on this machine for `<img>` / `<video>` in
//! a browser, which has no Tauri asset protocol (`localFileUrl` in
//! `src/kernel/lib/ipc/runtime.ts`). Behind the same token and loopback check
//! as every other route; it reads no more than `read_file_content` already can.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::WebHost;

#[derive(Deserialize)]
pub(super) struct FileQuery {
    path: String,
}

pub(super) async fn handle(
    State(_host): State<Arc<WebHost>>,
    Query(query): Query<FileQuery>,
) -> Response {
    match tokio::fs::read(&query.path).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, content_type(&query.path)),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (StatusCode::NOT_FOUND, format!("no such file: {}", query.path)).into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not read {}: {error}", query.path),
        )
            .into_response(),
    }
}

/// Media type by extension, for what the window actually shows from disk.
fn content_type(path: &str) -> &'static str {
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
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::content_type;

    #[test]
    fn media_types_follow_the_extension_in_any_case() {
        assert_eq!(content_type(r"C:\a\shot.PNG"), "image/png");
        assert_eq!(content_type("/tmp/clip.webm"), "video/webm");
        assert_eq!(content_type("notes"), "application/octet-stream");
    }
}
