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
        // kenari — one gateway, three wires, one `kn-` key. The wire rides in
        // the provider type so everything downstream (URL builder, streaming
        // client, reasoning replay) follows from a single value rather than
        // from a second setting that could disagree with it.
        //
        // Chat completions is the default and the one to use. It is the only
        // wire every chat model serves. Live probes returned the full reasoning
        // trace for both `deepseek-v4-pro` and `glm-5-3`; the other two wires
        // were model-dependent and lossy for GLM 5.3.
        "kenari" => ProviderPreset {
            auth_header: "Authorization",
            auth_type: AuthType::Bearer,
            chat_endpoint: "/chat/completions",
            default_params: &[],
            format: ProviderFormat::OpenAi,
            include_stream_options: true,
            required_headers: &[],
            // Reasoning is asked for with `reasoning_effort`, which the
            // frontend already puts in `custom_params` for any effort model —
            // verified accepted. Nothing extra to inject here.
            thinking_mode: ThinkingMode::None,
        },
        // The Anthropic wire. Worth having for one measured reason: it is the
        // only kenari wire that streams a `signature` alongside the thinking
        // block, so a Claude model's reasoning can be replayed intact.
        // `x-api-key` authenticates here as well as Bearer, so Aurora's
        // existing Anthropic client needs no special case.
        "kenari-messages" => ProviderPreset {
            auth_header: "x-api-key",
            auth_type: AuthType::XApiKey,
            chat_endpoint: "/messages",
            default_params: &[],
            format: ProviderFormat::Anthropic,
            include_stream_options: false,
            required_headers: &[("anthropic-version", "2023-06-01")],
            thinking_mode: ThinkingMode::None,
        },
        // The Codex wire. Present because kenari offers it, NOT because it is
        // the one to reach for: it is stateless-only and it silently drops any
        // tool that is not a plain function. It exists upstream for Codex CLI,
        // which has no chat wire left.
        //
        // Reasoning support is model-dependent. DeepSeek V4 Pro emitted its
        // trace through `response.reasoning_summary_text.delta`; GLM 5.3 emitted
        // no reasoning and failed a deterministic answer probe at both `high`
        // and `max`. The Provider model test is the authority for a row.
        "kenari-responses" => ProviderPreset {
            auth_header: "Authorization",
            auth_type: AuthType::Bearer,
            chat_endpoint: "/responses",
            default_params: &[],
            format: ProviderFormat::OpenAi,
            include_stream_options: false,
            required_headers: &[],
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

    // Before the vendor checks below, because kenari serves `claude-*`,
    // `gpt-*` and `deepseek-*` ids from its own gateway. Matching on the model
    // name first would route a kenari request at Anthropic's auth scheme and
    // Anthropic's endpoint, and the key would be rejected.
    //
    // Only the default (chat) wire can be inferred from a URL — asking for the
    // Anthropic or Codex wire is a deliberate choice, so it has to be stored on
    // the provider rather than guessed here.
    if lower_url.contains("kenari.id") {
        return "kenari".to_string();
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider_type: &str, base_url: &str, model: &str) -> AuroraProviderConfig {
        AuroraProviderConfig {
            api_key: String::new(),
            base_url: base_url.to_string(),
            custom_headers: None,
            custom_params: None,
            default_max_tokens: None,
            default_temperature: None,
            model: model.to_string(),
            provider_type: provider_type.to_string(),
            supports_thinking: false,
        }
    }

    #[test]
    fn a_kenari_url_is_never_mistaken_for_the_vendor_it_is_serving() {
        // kenari answers for `claude-*`, `gpt-*` and `deepseek-*` ids from its
        // own gateway with its own `kn-` key. If the model name decided the
        // type, a Claude model on kenari would be sent to Anthropic's endpoint
        // with Anthropic's auth scheme, and the key would be rejected — a
        // failure that would read as "the key is wrong" rather than "we routed
        // it to the wrong company".
        for model in [
            "claude-opus-5",
            "gpt-5-6-terra",
            "deepseek-v4-pro",
            "glm-5-2",
        ] {
            assert_eq!(
                normalize_provider_type("", "https://kenari.id/v1", model),
                "kenari",
                "{model} on kenari must stay on kenari"
            );
        }
    }

    #[test]
    fn an_explicit_wire_choice_is_never_overridden_by_url_sniffing() {
        // The Anthropic and Codex wires are deliberate picks. Detection only
        // ever fills in a BLANK type, so choosing one must survive.
        for wire in ["kenari", "kenari-messages", "kenari-responses"] {
            assert_eq!(
                normalize_provider_type(wire, "https://kenari.id/v1", "claude-opus-5"),
                wire
            );
        }
    }

    #[test]
    fn each_kenari_wire_targets_its_own_endpoint_and_shape() {
        // The three wires are three different HTTP endpoints with three
        // different body shapes. Getting the pairing wrong sends an Anthropic
        // body to a chat-completions URL, which fails as a 400 with no hint
        // about the real cause.
        let chat = provider_preset(&config("kenari", "https://kenari.id/v1", ""));
        assert_eq!(chat.chat_endpoint, "/chat/completions");
        assert!(chat.format == ProviderFormat::OpenAi);

        let messages = provider_preset(&config("kenari-messages", "https://kenari.id/v1", ""));
        assert_eq!(messages.chat_endpoint, "/messages");
        assert!(messages.format == ProviderFormat::Anthropic);
        // Measured: kenari accepts `x-api-key` on /messages (HTTP 200), which
        // is what lets Aurora's existing Anthropic client work unchanged.
        assert_eq!(messages.auth_header, "x-api-key");
        assert!(messages
            .required_headers
            .iter()
            .any(|(name, _)| *name == "anthropic-version"));

        let responses = provider_preset(&config("kenari-responses", "https://kenari.id/v1", ""));
        assert_eq!(responses.chat_endpoint, "/responses");
    }

    #[test]
    fn every_kenari_wire_hangs_off_the_one_base_url() {
        // One address, three paths — a user who edits the base URL must not
        // have to know which wire they are on.
        let base = "https://kenari.id/v1";
        for (wire, expected) in [
            ("kenari", "https://kenari.id/v1/chat/completions"),
            ("kenari-messages", "https://kenari.id/v1/messages"),
            ("kenari-responses", "https://kenari.id/v1/responses"),
        ] {
            let preset = provider_preset(&config(wire, base, ""));
            assert_eq!(get_chat_url(base, &preset), expected);
        }
    }
}
