//! The window's controls for the browser host (`crate::web_host`): the icon
//! rail's browser cell starts it, shows where it is, and stops it.

use crate::web_host::{self, WebHostStatus};

#[tauri::command]
pub async fn web_host_status() -> WebHostStatus {
    web_host::status()
}

/// Start the host (already running: unchanged). `port` defaults to 3721.
#[tauri::command]
pub async fn web_host_start(app: tauri::AppHandle, port: Option<u16>) -> Result<WebHostStatus, String> {
    web_host::start(&app, port).await
}

#[tauri::command]
pub async fn web_host_stop() -> WebHostStatus {
    web_host::stop();
    // The server task reports the stop itself (`web_host_changed`) once it has
    // closed; the status here may still read running for that moment.
    web_host::status()
}
