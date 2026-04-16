use super::types::AuroraProviderConfig;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderFormat {
    OpenAi,
    Anthropic,
}

#[derive(Clone, Copy)]
pub(crate) enum AuthType {
    Bearer,
    XApiKey,
}

#[derive(Clone, Copy)]
pub(crate) enum ThinkingMode {
    None,
    ReasoningEffortHigh,
    ReasoningEffortMedium,
    OpenAiThinkingEnabled,
    OpenAiThinkingPreserved,
}

pub(crate) struct ProviderPreset {
    pub(crate) auth_header: &'static str,
    pub(crate) auth_type: AuthType,
    pub(crate) chat_endpoint: &'static str,
    pub(crate) default_params: &'static [(&'static str, &'static str)],
    pub(crate) format: ProviderFormat,
    pub(crate) include_stream_options: bool,
    pub(crate) required_headers: &'static [(&'static str, &'static str)],
    pub(crate) thinking_mode: ThinkingMode,
}

pub(crate) fn provider_preset(config: &AuroraProviderConfig) -> ProviderPreset {
    let provider_type =
        normalize_provider_type(&config.provider_type, &config.base_url, &config.model);

    match provider_type.as_str() {
        "anthropic" => ProviderPreset {
            auth_header: "x-api-key",
            auth_type: AuthType::XApiKey,
            chat_endpoint: "/messages",
            default_params: &[],
            format: ProviderFormat::Anthropic,
            include_stream_options: false,
            required_headers: &[("anthropic-version", "2023-06-01")],
            thinking_mode: ThinkingMode::None,
        },
        "minimax" => ProviderPreset {
            auth_header: "x-api-key",
            auth_type: AuthType::XApiKey,
            chat_endpoint: "/messages",
            default_params: &[],
            format: ProviderFormat::Anthropic,
            include_stream_options: false,
            required_headers: &[("anthropic-version", "2023-06-01")],
            thinking_mode: ThinkingMode::None,
        },
        "glm" => ProviderPreset {
            auth_header: "Authorization",
            auth_type: AuthType::Bearer,
            chat_endpoint: "/chat/completions",
            default_params: &[],
            format: ProviderFormat::OpenAi,
            include_stream_options: true,
            required_headers: &[],
            thinking_mode: ThinkingMode::OpenAiThinkingPreserved,
        },
        "deepseek" => ProviderPreset {
            auth_header: "Authorization",
            auth_type: AuthType::Bearer,
            chat_endpoint: "/chat/completions",
            default_params: &[],
            format: ProviderFormat::OpenAi,
            include_stream_options: true,
            required_headers: &[],
            thinking_mode: ThinkingMode::OpenAiThinkingEnabled,
        },
        "fireworks" => ProviderPreset {
            auth_header: "Authorization",
            auth_type: AuthType::Bearer,
            chat_endpoint: "/chat/completions",
            default_params: &[],
            format: ProviderFormat::OpenAi,
            include_stream_options: false,
            required_headers: &[],
            thinking_mode: ThinkingMode::ReasoningEffortMedium,
        },
        "lmstudio" => ProviderPreset {
            auth_header: "Authorization",
            auth_type: AuthType::Bearer,
            chat_endpoint: "/chat/completions",
            default_params: &[],
            format: ProviderFormat::OpenAi,
            include_stream_options: true,
            required_headers: &[],
            thinking_mode: ThinkingMode::ReasoningEffortHigh,
        },
        "ollama" => ProviderPreset {
            auth_header: "Authorization",
            auth_type: AuthType::Bearer,
            chat_endpoint: "/chat/completions",
            default_params: &[],
            format: ProviderFormat::OpenAi,
            include_stream_options: false,
            required_headers: &[],
            thinking_mode: ThinkingMode::None,
        },
        "openai" => ProviderPreset {
            auth_header: "Authorization",
            auth_type: AuthType::Bearer,
            chat_endpoint: "/chat/completions",
            default_params: &[],
            format: ProviderFormat::OpenAi,
            include_stream_options: true,
            required_headers: &[],
            thinking_mode: ThinkingMode::None,
        },
        _ => ProviderPreset {
            auth_header: "Authorization",
            auth_type: AuthType::Bearer,
            chat_endpoint: "/chat/completions",
            default_params: &[],
            format: ProviderFormat::OpenAi,
            include_stream_options: false,
            required_headers: &[],
            thinking_mode: ThinkingMode::None,
        },
    }
}

pub(crate) fn normalize_provider_type(provider_type: &str, base_url: &str, model: &str) -> String {
    if !provider_type.trim().is_empty() {
        return provider_type.to_ascii_lowercase();
    }

    let lower_url = base_url.to_ascii_lowercase();
    let lower_model = model.to_ascii_lowercase();

    if lower_url.contains("anthropic.com") || lower_model.contains("claude") {
        return "anthropic".to_string();
    }
    if lower_url.contains("minimax") || lower_model.contains("minimax") {
        return "minimax".to_string();
    }
    if lower_url.contains("deepseek.com") || lower_model.contains("deepseek") {
        return "deepseek".to_string();
    }
    if lower_url.contains("fireworks.ai") {
        return "fireworks".to_string();
    }
    if lower_url.contains("z.ai") || lower_url.contains("zhipuai") || lower_model.contains("glm") {
        return "glm".to_string();
    }
    if lower_url.contains("openai.com") || lower_model.contains("gpt") || lower_model.contains("o1")
    {
        return "openai".to_string();
    }

    "custom".to_string()
}

pub(crate) fn get_chat_url(base_url: &str, preset: &ProviderPreset) -> String {
    let base = base_url.trim_end_matches('/');
    let endpoint = preset.chat_endpoint;
    let endpoint_without_slash = endpoint.trim_start_matches('/');

    if base.ends_with(endpoint) || base.ends_with(endpoint_without_slash) {
        return base.to_string();
    }

    if base.ends_with("/v1") && endpoint.starts_with("/chat") {
        return format!("{base}{endpoint}");
    }

    format!("{base}{endpoint}")
}
