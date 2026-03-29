use super::http::{delete_json_ok, post_json, post_text_ok, trim_local_base};
use super::types::{
    OllamaModelDetails, OllamaModelInfo, OllamaRunningModel, OllamaRunningModelsResponse,
    PullProgress,
};
use futures_util::StreamExt;
use parking_lot::RwLock;
use reqwest::Client;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;

lazy_static::lazy_static! {
    static ref ACTIVE_PULLS: Arc<RwLock<HashMap<String, bool>>> = Arc::new(RwLock::new(HashMap::new()));
}

fn cleanup_pull(request_id: &str) {
    let mut pulls = ACTIVE_PULLS.write();
    pulls.remove(request_id);
}

fn is_pull_cancelled(request_id: &str) -> bool {
    let pulls = ACTIVE_PULLS.read();
    pulls.get(request_id).copied().unwrap_or(false)
}

pub fn cancel_pull(request_id: &str) {
    let mut pulls = ACTIVE_PULLS.write();
    pulls.insert(request_id.to_string(), true);
}

pub async fn show_model(base_url: &str, model_name: &str) -> Option<OllamaModelInfo> {
    let client = Client::new();
    let api_host = trim_local_base(base_url);
    let url = format!("{api_host}/api/show");
    post_json::<OllamaModelInfo>(&client, &url, json!({ "model": model_name }), 5000)
        .await
        .ok()
}

pub async fn get_running_models(base_url: &str) -> Vec<OllamaRunningModel> {
    let client = Client::new();
    let api_host = trim_local_base(base_url);
    let url = format!("{api_host}/api/ps");
    let response = super::http::get_json::<OllamaRunningModelsResponse>(&client, &url, 5000).await;
    response
        .ok()
        .and_then(|payload| payload.models)
        .unwrap_or_default()
        .into_iter()
        .map(|model| OllamaRunningModel {
            name: model.name,
            model: model.model,
            size: model.size,
            size_vram: model.size_vram.unwrap_or(0),
            context_length: model.context_length.unwrap_or(0),
            expires_at: model.expires_at.unwrap_or_default(),
            details: model.details.unwrap_or(OllamaModelDetails::default()),
        })
        .collect()
}

pub async fn load_model(base_url: &str, model_name: &str, keep_alive: &str) -> bool {
    let client = Client::new();
    let api_host = trim_local_base(base_url);
    let url = format!("{api_host}/api/generate");
    post_text_ok(
        &client,
        &url,
        json!({
            "model": model_name,
            "keep_alive": keep_alive,
        }),
        120000,
    )
    .await
    .unwrap_or(false)
}

pub async fn unload_model(base_url: &str, model_name: &str) -> bool {
    let client = Client::new();
    let api_host = trim_local_base(base_url);
    let url = format!("{api_host}/api/generate");
    post_text_ok(
        &client,
        &url,
        json!({
            "model": model_name,
            "keep_alive": 0,
        }),
        15000,
    )
    .await
    .unwrap_or(false)
}

pub async fn delete_model(base_url: &str, model_name: &str) -> bool {
    let client = Client::new();
    let api_host = trim_local_base(base_url);
    let url = format!("{api_host}/api/delete");
    delete_json_ok(&client, &url, json!({ "model": model_name }), 10000)
        .await
        .unwrap_or(false)
}

pub async fn pull_model(
    app: tauri::AppHandle,
    request_id: String,
    base_url: &str,
    model_name: &str,
) -> Result<bool, String> {
    {
        let mut pulls = ACTIVE_PULLS.write();
        pulls.insert(request_id.clone(), false);
    }

    let client = Client::new();
    let api_host = trim_local_base(base_url);
    let url = format!("{api_host}/api/pull");
    let response = client
        .post(&url)
        .json(&json!({
            "model": model_name,
            "stream": true,
        }))
        .send()
        .await
        .map_err(|e| format!("Pull request failed: {e}"))?;

    if !response.status().is_success() {
        cleanup_pull(&request_id);
        let status = response.status();
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Pull failed ({}): {}", status, error_text));
    }

    let mut buffer = String::new();
    let mut stream = response.bytes_stream();
    let mut success = false;

    while let Some(chunk) = stream.next().await {
        if is_pull_cancelled(&request_id) {
            cleanup_pull(&request_id);
            return Err("Pull cancelled".to_string());
        }

        let bytes = chunk.map_err(|e| format!("Pull stream error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        let mut lines = buffer
            .split('\n')
            .map(|line| line.to_string())
            .collect::<Vec<_>>();
        buffer = lines.pop().unwrap_or_default();

        for line in lines {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if let Ok(progress) = serde_json::from_str::<PullProgress>(trimmed) {
                if progress.status == "success" {
                    success = true;
                }
                let _ = app.emit(
                    &format!("local-provider-pull-progress-{}", request_id),
                    progress,
                );
            }
        }
    }

    cleanup_pull(&request_id);
    Ok(success)
}
