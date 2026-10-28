use super::http::{format_bytes, get_json, thinking_supported, trim_local_base, PROBE_TIMEOUT_MS};
use super::types::{
    DetectionResult, LmStudioModelsResponse, LocalModel, LocalProvider, OllamaTagsResponse,
    OllamaVersionResponse,
};
use reqwest::Client;

async fn probe_ollama_at(client: &Client, host: &str) -> Option<LocalProvider> {
    let api_host = trim_local_base(host);
    let tags_url = format!("{api_host}/api/tags");
    let data = get_json::<OllamaTagsResponse>(client, &tags_url, PROBE_TIMEOUT_MS)
        .await
        .ok()?;
    let models = data.models?;
    let mapped_models = models
        .into_iter()
        .map(|model| LocalModel {
            id: model.name.clone(),
            name: model
                .name
                .split(':')
                .next()
                .unwrap_or(&model.name)
                .to_string(),
            size: Some(format_bytes(model.size)),
            size_bytes: Some(model.size),
            parameter_size: model
                .details
                .as_ref()
                .and_then(|d| d.parameter_size.clone()),
            family: model.details.as_ref().and_then(|d| d.family.clone()),
            families: model.details.as_ref().and_then(|d| d.families.clone()),
            quantization: model
                .details
                .as_ref()
                .and_then(|d| d.quantization_level.clone()),
            format: model.details.as_ref().and_then(|d| d.format.clone()),
            max_context_length: None,
            trained_for_tool_use: None,
            vision: None,
            supports_thinking: Some(thinking_supported(&model.name)),
        })
        .collect::<Vec<_>>();

    let version_url = format!("{api_host}/api/version");
    let version = get_json::<OllamaVersionResponse>(client, &version_url, 2000)
        .await
        .ok()
        .and_then(|response| response.version);

    Some(LocalProvider {
        r#type: "ollama".to_string(),
        name: "Ollama".to_string(),
        base_url: format!("{api_host}/v1"),
        models: mapped_models,
        version,
    })
}

async fn probe_lmstudio_at(client: &Client, host: &str) -> Option<LocalProvider> {
    let api_host = trim_local_base(host);
    let url = format!("{api_host}/v1/models");
    let data = get_json::<LmStudioModelsResponse>(client, &url, PROBE_TIMEOUT_MS)
        .await
        .ok()?;
    let models = data.data?;
    let mapped_models = models
        .into_iter()
        .map(|model| LocalModel {
            id: model.id.clone(),
            name: model.display_name.clone().unwrap_or_else(|| {
                model
                    .id
                    .split('/')
                    .next_back()
                    .unwrap_or(&model.id)
                    .to_string()
            }),
            size: model.size_bytes.map(format_bytes),
            size_bytes: model.size_bytes,
            parameter_size: model.params_string,
            family: model.architecture,
            families: None,
            quantization: None,
            format: None,
            max_context_length: model.max_context_length,
            trained_for_tool_use: model.trained_for_tool_use,
            vision: model.vision,
            supports_thinking: Some(thinking_supported(&model.id)),
        })
        .collect::<Vec<_>>();

    Some(LocalProvider {
        r#type: "lmstudio".to_string(),
        name: "LM Studio".to_string(),
        base_url: format!("{api_host}/v1"),
        models: mapped_models,
        version: None,
    })
}

pub async fn probe_custom_url(url: &str) -> Option<LocalProvider> {
    let client = Client::new();
    let host = trim_local_base(url);
    if let Some(provider) = probe_ollama_at(&client, &host).await {
        return Some(provider);
    }
    probe_lmstudio_at(&client, &host).await
}

pub async fn detect_local_providers(custom_url: Option<String>) -> DetectionResult {
    let client = Client::new();

    let ollama_fut = probe_ollama_at(&client, "http://localhost:11434");
    let lmstudio_fut = probe_lmstudio_at(&client, "http://localhost:1234");
    let (ollama, lmstudio) = tokio::join!(ollama_fut, lmstudio_fut);

    let mut providers = Vec::new();
    if let Some(provider) = ollama {
        if !provider.models.is_empty() {
            providers.push(provider);
        }
    }
    if let Some(provider) = lmstudio {
        if !provider.models.is_empty() {
            providers.push(provider);
        }
    }

    if let Some(url) = custom_url {
        if let Some(provider) = probe_custom_url(&url).await {
            let already_present = providers.iter().any(|existing| {
                trim_local_base(&existing.base_url)
                    .eq_ignore_ascii_case(&trim_local_base(&provider.base_url))
            });
            if !already_present {
                providers.push(provider);
            }
        }
    }

    let best_provider = providers
        .iter()
        .max_by_key(|provider| provider.models.len())
        .cloned();

    DetectionResult {
        providers,
        best_provider,
    }
}
