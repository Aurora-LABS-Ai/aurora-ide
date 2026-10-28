//! LM Studio / Ollama commands: `#[tauri::command]`s with `desktop`, served to
//! other hosts by `host_commands::local_models`. A pull reports progress as
//! `local-provider-pull-progress-<requestId>` events through the host's sink.

use super::detect::{detect_local_providers, probe_custom_url};
use super::ollama::{
    cancel_pull, delete_model, get_running_models, load_model, pull_model, show_model, unload_model,
};
use super::types::{DetectionResult, LocalProvider, OllamaModelInfo, OllamaRunningModel};
use crate::host_events::Events;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn local_provider_detect(custom_url: Option<String>) -> Result<DetectionResult, String> {
    Ok(detect_local_providers(custom_url).await)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn local_provider_probe_custom(url: String) -> Result<Option<LocalProvider>, String> {
    Ok(probe_custom_url(&url).await)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn local_provider_show_ollama_model(
    base_url: String,
    model_name: String,
) -> Result<Option<OllamaModelInfo>, String> {
    Ok(show_model(&base_url, &model_name).await)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn local_provider_get_running_models(
    base_url: String,
) -> Result<Vec<OllamaRunningModel>, String> {
    Ok(get_running_models(&base_url).await)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn local_provider_load_ollama_model(
    base_url: String,
    model_name: String,
    keep_alive: Option<String>,
) -> Result<bool, String> {
    Ok(load_model(
        &base_url,
        &model_name,
        keep_alive.as_deref().unwrap_or("30m"),
    )
    .await)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn local_provider_unload_ollama_model(
    base_url: String,
    model_name: String,
) -> Result<bool, String> {
    Ok(unload_model(&base_url, &model_name).await)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn local_provider_delete_ollama_model(
    base_url: String,
    model_name: String,
) -> Result<bool, String> {
    Ok(delete_model(&base_url, &model_name).await)
}

/// Download a model into Ollama, reporting progress through `events`.
pub async fn pull_ollama_model(
    events: Events,
    request_id: String,
    base_url: String,
    model_name: String,
) -> Result<bool, String> {
    pull_model(events, request_id, &base_url, &model_name).await
}

/// [`pull_ollama_model`] with the window as the event sink.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn local_provider_pull_ollama_model(
    app: tauri::AppHandle,
    request_id: String,
    base_url: String,
    model_name: String,
) -> Result<bool, String> {
    pull_ollama_model(std::sync::Arc::new(app), request_id, base_url, model_name).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn cancel_local_provider_pull(request_id: String) -> Result<(), String> {
    cancel_pull(&request_id);
    Ok(())
}
