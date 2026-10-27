//! `GET /api/file?path=…`: a file on this machine for `<img>` / `<video>` in
//! a browser, which has no Tauri asset protocol (`localFileUrl` in
//! `src/kernel/lib/ipc/runtime.ts`). Behind the same token and loopback check
//! as every other route. The reading itself is shared with `aurora serve`
//! (`crate::serve::pages::local_file`).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Response;
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
    crate::serve::pages::local_file(&query.path).await
}
