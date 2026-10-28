//! The window's gallery commands. Written once in
//! [`crate::tools::image::gallery`]; copying a picture to this computer's
//! clipboard is the window's own.

use std::sync::Arc;

use tauri::State;

use crate::commands::agent_v2::AgentRegistry;
use crate::tools::image::gallery::{self, GalleryResult};

#[tauri::command]
pub async fn chat_gallery_list(state: State<'_, Arc<AgentRegistry>>) -> Result<GalleryResult, String> {
    gallery::chat_gallery_list(state.chat_store().clone()).await
}

#[tauri::command]
pub async fn chat_gallery_thumbnail(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    name: String,
) -> Result<String, String> {
    gallery::chat_gallery_thumbnail(state.chat_store().clone(), thread_id, name).await
}

#[tauri::command]
pub async fn chat_gallery_copy_image(
    app: tauri::AppHandle,
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    name: String,
) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let store = state.chat_store().clone();
    tokio::task::spawn_blocking(move || {
        let rgba = gallery::decode_for_clipboard(&store, &thread_id, &name)?;
        let (width, height) = rgba.dimensions();
        app.clipboard()
            .write_image(&tauri::image::Image::new_owned(rgba.into_raw(), width, height))
            .map_err(|e| format!("Could not copy image: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn chat_gallery_read_image(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    name: String,
) -> Result<String, String> {
    gallery::chat_gallery_read_image(state.chat_store().clone(), thread_id, name).await
}

#[tauri::command]
pub async fn chat_gallery_set_hidden(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    name: String,
    hidden: bool,
) -> Result<(), String> {
    gallery::chat_gallery_set_hidden(state.chat_store().clone(), thread_id, name, hidden).await
}

#[tauri::command]
pub async fn chat_gallery_delete(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    name: String,
) -> Result<(), String> {
    gallery::chat_gallery_delete(state.chat_store().clone(), thread_id, name).await
}

/// Copy a gallery file to where the user chose in this computer's save
/// dialog (see [`gallery::chat_gallery_save_as`]).
#[tauri::command]
pub async fn chat_gallery_save_as(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    source: String,
    destination: String,
) -> Result<(), String> {
    gallery::chat_gallery_save_as(state.chat_store().clone(), thread_id, source, destination).await
}
