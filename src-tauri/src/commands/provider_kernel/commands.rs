use super::builders::{build_headers, build_request_body, build_stream_headers};
use super::parsers::{parse_anthropic_response, parse_openai_response};
use super::presets::{get_chat_url, provider_preset, ProviderFormat};
use super::streaming::{
    cancel_stream, cleanup_stream, emit_error, register_stream, stream_anthropic_compatible,
    stream_openai_compatible,
};
use super::types::{AuroraProviderRequest, AuroraProviderResponse};
use serde_json::Value;

#[tauri::command]
pub fn cancel_aurora_provider_stream(request_id: String) -> Result<(), String> {
    cancel_stream(&request_id);
    Ok(())
}

#[tauri::command]
pub async fn aurora_provider_chat(
    request: AuroraProviderRequest,
) -> Result<AuroraProviderResponse, String> {
    let preset = provider_preset(&request.provider);
    let url = get_chat_url(&request.provider.base_url, &preset);
    let headers = build_headers(&request.provider, &preset)?;
    let body = build_request_body(&request, &preset)?;

    let client = reqwest::Client::new();
    let response = client
        .post(url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {error_body}"));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|error| format!("failed to parse response: {error}"))?;

    match preset.format {
        ProviderFormat::OpenAi => Ok(parse_openai_response(&json)),
        ProviderFormat::Anthropic => Ok(parse_anthropic_response(&json)),
    }
}

#[tauri::command]
pub async fn aurora_provider_stream(
    app: tauri::AppHandle,
    request_id: String,
    request: AuroraProviderRequest,
) -> Result<(), String> {
    let cancel_token = register_stream(&request_id);

    let preset = provider_preset(&request.provider);
    let url = get_chat_url(&request.provider.base_url, &preset);
    let headers = build_stream_headers(&request.provider, &preset)?;
    let body = build_request_body(&request, &preset)?;
    let client = reqwest::Client::builder()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .build()
        .map_err(|error| format!("failed to build client: {error}"))?;

    let response = match client.post(url).headers(headers).json(&body).send().await {
        Ok(response) => response,
        Err(error) => {
            emit_error(&app, &request_id, &format!("failed to connect: {error}"));
            cleanup_stream(&request_id);
            return Err(format!("failed to connect: {error}"));
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        let message = format!("HTTP {status}: {error_body}");
        emit_error(&app, &request_id, &message);
        cleanup_stream(&request_id);
        return Err(message);
    }

    let result = match preset.format {
        ProviderFormat::OpenAi => {
            stream_openai_compatible(app.clone(), &request_id, response, cancel_token).await
        }
        ProviderFormat::Anthropic => {
            stream_anthropic_compatible(app.clone(), &request_id, response, cancel_token).await
        }
    };

    cleanup_stream(&request_id);
    result
}
