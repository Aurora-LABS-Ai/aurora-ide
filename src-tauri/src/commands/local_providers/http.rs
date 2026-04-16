use reqwest::Client;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::time::Duration;

pub const PROBE_TIMEOUT_MS: u64 = 3000;

pub fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;

    if (bytes as f64) < MB {
        format!("{:.0} KB", bytes as f64 / KB)
    } else if (bytes as f64) < GB {
        format!("{:.1} MB", bytes as f64 / MB)
    } else {
        format!("{:.1} GB", bytes as f64 / GB)
    }
}

pub fn trim_local_base(url: &str) -> String {
    url.trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string()
}

pub fn thinking_supported(model_id: &str) -> bool {
    let lowered = model_id.to_lowercase();
    ["qwen3", "qwq", "deepseek-r1", "phi-4-reasoning"]
        .iter()
        .any(|pattern| lowered.contains(pattern))
}

pub async fn get_json<T: DeserializeOwned>(
    client: &Client,
    url: &str,
    timeout_ms: u64,
) -> Result<T, String> {
    let response = client
        .get(url)
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Request failed with status {}", response.status()));
    }

    response
        .json::<T>()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))
}

pub async fn post_json<T: DeserializeOwned>(
    client: &Client,
    url: &str,
    body: Value,
    timeout_ms: u64,
) -> Result<T, String> {
    let response = client
        .post(url)
        .json(&body)
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Request failed with status {}", response.status()));
    }

    response
        .json::<T>()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))
}

pub async fn delete_json_ok(
    client: &Client,
    url: &str,
    body: Value,
    timeout_ms: u64,
) -> Result<bool, String> {
    let response = client
        .delete(url)
        .json(&body)
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    Ok(response.status().is_success())
}

pub async fn post_text_ok(
    client: &Client,
    url: &str,
    body: Value,
    timeout_ms: u64,
) -> Result<bool, String> {
    let response = client
        .post(url)
        .json(&body)
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !response.status().is_success() {
        return Ok(false);
    }

    let _ = response.text().await;
    Ok(true)
}
