use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogPreset {
    pub id: String,
    pub name: String,
    pub nickname: Option<String>,
    pub base_url: String,
    pub model: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub supports_thinking: bool,
    pub supports_tool_stream: Option<bool>,
    pub custom_models: Option<Vec<String>>,
    pub model_aliases: Option<HashMap<String, String>>,
    pub provider_type: String,
    pub default_temperature: Option<f32>,
    pub default_max_tokens: Option<u32>,
    pub requires_api_key: bool,
    /// Per-model default pricing (USD per 1M tokens). Keyed by the
    /// API model identifier (`customModels[i]` or `model`). Used to
    /// seed the per-model rows on first-run / catalog import. Users
    /// can override via the Model Editor; their edits live in the
    /// `provider_models` table and survive future catalog updates.
    ///
    /// We keep this `Option` so providers without published pricing
    /// (LMStudio, Ollama, generic custom) can omit it; the UI then
    /// hides the cost row for those models.
    #[serde(default)]
    pub model_pricing: Option<HashMap<String, ModelPricing>>,
}

/// USD-denominated pricing for a single model. All three rates are
/// per-million-tokens (matches every public provider's pricing page).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    /// Per-1M-token rate for input served from the provider's prompt
    /// cache. DeepSeek calls this `prompt_cache_hit_tokens`, Anthropic
    /// `cache_read_input_tokens`. Typically ~10% of the cache-miss rate.
    pub cache_hit_per_mtok: f64,
    /// Per-1M-token rate for fresh (non-cached) input.
    pub cache_miss_per_mtok: f64,
    /// Per-1M-token rate for generated output.
    pub output_per_mtok: f64,
}

impl ModelPricing {
    /// Tiny constructor so the catalog literals stay readable.
    pub const fn usd(cache_hit: f64, cache_miss: f64, output: f64) -> Self {
        Self {
            cache_hit_per_mtok: cache_hit,
            cache_miss_per_mtok: cache_miss,
            output_per_mtok: output,
        }
    }
}

pub fn built_in_provider_presets() -> Vec<ProviderCatalogPreset> {
    vec![
        ProviderCatalogPreset {
            id: "fireworks".to_string(),
            name: "Fireworks AI".to_string(),
            nickname: Some("Fireworks".to_string()),
            base_url: "https://api.fireworks.ai/inference/v1".to_string(),
            model: "accounts/fireworks/routers/glm-5p2-fast".to_string(),
            context_window: 200000,
            max_output_tokens: 32768,
            supports_thinking: true,
            supports_tool_stream: None,
            custom_models: Some(vec![
                "accounts/fireworks/routers/glm-5p2-fast".to_string(),
                "accounts/fireworks/routers/kimi-k2p7-code-fast".to_string(),
            ]),
            model_aliases: Some(HashMap::from([
                (
                    "accounts/fireworks/routers/glm-5p2-fast".to_string(),
                    "GLM 5.2 Fast".to_string(),
                ),
                (
                    "accounts/fireworks/routers/kimi-k2p7-code-fast".to_string(),
                    "Kimi K2.7 Code Fast".to_string(),
                ),
            ])),
            provider_type: "fireworks".to_string(),
            default_temperature: Some(1.0),
            default_max_tokens: None,
            requires_api_key: true,
            model_pricing: None,
        },
        ProviderCatalogPreset {
            id: "glm".to_string(),
            name: "GLM-4.7 (Z.AI)".to_string(),
            nickname: Some("GLM".to_string()),
            base_url: "https://api.z.ai/api/coding/paas/v4".to_string(),
            model: "glm-4.7".to_string(),
            context_window: 200000,
            max_output_tokens: 128000,
            supports_thinking: true,
            supports_tool_stream: None,
            custom_models: Some(vec![
                "glm-4.7".to_string(),
                "glm-4.6".to_string(),
                "glm-4.5".to_string(),
                "glm-4.5-flash".to_string(),
            ]),
            model_aliases: None,
            provider_type: "glm".to_string(),
            default_temperature: Some(1.0),
            default_max_tokens: None,
            requires_api_key: true,
            model_pricing: None,
        },
        ProviderCatalogPreset {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            nickname: Some("Claude".to_string()),
            base_url: "https://api.anthropic.com/v1".to_string(),
            model: "claude-sonnet-4-20250514".to_string(),
            context_window: 200000,
            max_output_tokens: 8192,
            supports_thinking: true,
            supports_tool_stream: None,
            custom_models: Some(vec![
                "claude-opus-4-5-20251101".to_string(),
                "claude-sonnet-4-20250514".to_string(),
                "claude-3-5-sonnet-20241022".to_string(),
                "claude-3-5-haiku-20241022".to_string(),
            ]),
            model_aliases: None,
            provider_type: "anthropic".to_string(),
            default_temperature: Some(1.0),
            default_max_tokens: None,
            requires_api_key: true,
            // Anthropic published pricing (USD per 1M tokens). Cache
            // read = `cache_read_input_tokens` rate, cache write is a
            // separate cost we don't currently expose; the cache_hit
            // field here is the read rate (~10% of input list price).
            model_pricing: Some(HashMap::from([
                (
                    "claude-opus-4-5-20251101".to_string(),
                    ModelPricing::usd(1.50, 15.0, 75.0),
                ),
                (
                    "claude-sonnet-4-20250514".to_string(),
                    ModelPricing::usd(0.30, 3.0, 15.0),
                ),
                (
                    "claude-3-5-sonnet-20241022".to_string(),
                    ModelPricing::usd(0.30, 3.0, 15.0),
                ),
                (
                    "claude-3-5-haiku-20241022".to_string(),
                    ModelPricing::usd(0.08, 0.80, 4.0),
                ),
            ])),
        },
        ProviderCatalogPreset {
            id: "minimax".to_string(),
            name: "MiniMax M2.7".to_string(),
            nickname: Some("MiniMax".to_string()),
            base_url: "https://api.minimax.io/anthropic/v1".to_string(),
            model: "MiniMax-M2.7".to_string(),
            context_window: 200000,
            max_output_tokens: 128000,
            supports_thinking: true,
            supports_tool_stream: None,
            custom_models: Some(vec![
                "MiniMax-M2.7".to_string(),
                "MiniMax-M2.7-highspeed".to_string(),
                "MiniMax-M2.5".to_string(),
                "MiniMax-M2.5-highspeed".to_string(),
                "MiniMax-M2.1".to_string(),
                "MiniMax-M2.1-highspeed".to_string(),
                "MiniMax-M2".to_string(),
            ]),
            model_aliases: Some(HashMap::from([
                ("MiniMax-M2.7".to_string(), "MiniMax M2.7".to_string()),
                (
                    "MiniMax-M2.7-highspeed".to_string(),
                    "MiniMax M2.7 Highspeed".to_string(),
                ),
                ("MiniMax-M2.5".to_string(), "MiniMax M2.5".to_string()),
                (
                    "MiniMax-M2.5-highspeed".to_string(),
                    "MiniMax M2.5 Highspeed".to_string(),
                ),
                ("MiniMax-M2.1".to_string(), "MiniMax M2.1".to_string()),
                (
                    "MiniMax-M2.1-highspeed".to_string(),
                    "MiniMax M2.1 Highspeed".to_string(),
                ),
                ("MiniMax-M2".to_string(), "MiniMax M2".to_string()),
            ])),
            provider_type: "minimax".to_string(),
            default_temperature: Some(1.0),
            default_max_tokens: None,
            requires_api_key: true,
            model_pricing: None,
        },
        ProviderCatalogPreset {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            nickname: None,
            base_url: "https://api.deepseek.com/v1".to_string(),
            model: "deepseek-v4-pro".to_string(),
            // DeepSeek V4 ships with a 1M-token context window and a
            // 384K-token max output — published on the official model
            // card. The V3 family (`deepseek-chat`, `deepseek-reasoner`)
            // is still capped at 128K, but those overrides live on the
            // per-model rows when needed.
            context_window: 1_000_000,
            max_output_tokens: 384_000,
            supports_thinking: true,
            supports_tool_stream: None,
            custom_models: Some(vec![
                "deepseek-v4-pro".to_string(),
                "deepseek-v4-flash".to_string(),
                "deepseek-chat".to_string(),
                "deepseek-reasoner".to_string(),
            ]),
            model_aliases: Some(HashMap::from([
                ("deepseek-v4-pro".to_string(), "DeepSeek V4 Pro".to_string()),
                (
                    "deepseek-v4-flash".to_string(),
                    "DeepSeek V4 Flash".to_string(),
                ),
                (
                    "deepseek-chat".to_string(),
                    "DeepSeek Chat (V3)".to_string(),
                ),
                (
                    "deepseek-reasoner".to_string(),
                    "DeepSeek Reasoner (R1)".to_string(),
                ),
            ])),
            provider_type: "deepseek".to_string(),
            default_temperature: Some(1.0),
            default_max_tokens: None,
            requires_api_key: true,
            // Pricing taken from the official DeepSeek pricing table
            // (USD per 1M tokens). V4 Pro is shown at its post-launch
            // 75% discounted rate; list price is documented inline so a
            // future migration can swap them back without re-reading
            // the docs:
            //   - V4 Pro list:  cache_hit $0.0145  cache_miss $1.74    output $3.48
            //   - V4 Pro 75% off: $0.003625 / $0.435 / $0.87  (active)
            //   - V4 Flash:        $0.0028   / $0.14  / $0.28
            // V3 family numbers below are the pre-V4 published prices;
            // users on legacy contracts can override them in the UI.
            model_pricing: Some(HashMap::from([
                (
                    "deepseek-v4-pro".to_string(),
                    ModelPricing::usd(0.003625, 0.435, 0.87),
                ),
                (
                    "deepseek-v4-flash".to_string(),
                    ModelPricing::usd(0.0028, 0.14, 0.28),
                ),
                (
                    "deepseek-chat".to_string(),
                    ModelPricing::usd(0.07, 0.27, 1.10),
                ),
                (
                    "deepseek-reasoner".to_string(),
                    ModelPricing::usd(0.14, 0.55, 2.19),
                ),
            ])),
        },
        ProviderCatalogPreset {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            nickname: None,
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o".to_string(),
            context_window: 128000,
            max_output_tokens: 16384,
            supports_thinking: false,
            supports_tool_stream: None,
            custom_models: Some(vec![
                "gpt-4o".to_string(),
                "gpt-4o-mini".to_string(),
                "gpt-4-turbo".to_string(),
                "gpt-3.5-turbo".to_string(),
                "o1".to_string(),
                "o1-mini".to_string(),
            ]),
            model_aliases: None,
            provider_type: "openai".to_string(),
            default_temperature: Some(1.0),
            default_max_tokens: None,
            requires_api_key: true,
            // OpenAI list prices (USD per 1M tokens). Cached input
            // for the `*-mini`/o-series is a flat 50% discount per
            // OpenAI's docs; we approximate the o1/gpt-4o cache rate
            // at 50% of input.
            model_pricing: Some(HashMap::from([
                ("gpt-4o".to_string(), ModelPricing::usd(1.25, 2.50, 10.0)),
                (
                    "gpt-4o-mini".to_string(),
                    ModelPricing::usd(0.075, 0.15, 0.60),
                ),
                (
                    "gpt-4-turbo".to_string(),
                    ModelPricing::usd(5.0, 10.0, 30.0),
                ),
                (
                    "gpt-3.5-turbo".to_string(),
                    ModelPricing::usd(0.25, 0.50, 1.50),
                ),
                ("o1".to_string(), ModelPricing::usd(7.50, 15.0, 60.0)),
                ("o1-mini".to_string(), ModelPricing::usd(1.50, 3.0, 12.0)),
            ])),
        },
        ProviderCatalogPreset {
            id: "openai-responses".to_string(),
            name: "OpenAI (Responses)".to_string(),
            nickname: None,
            // Same base URL as Chat Completions — the adapter appends
            // `/responses` instead of `/chat/completions`. This preset
            // is an ADDITIONAL wire shape (typed streaming events +
            // reasoning persistence across tool calls), not a
            // replacement for the "openai" preset above.
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-5.5".to_string(),
            // GPT-5.x reasoning family: 400K context window, 128K max
            // output. Per-model overrides enrich from models.dev in
            // the UI.
            context_window: 400_000,
            max_output_tokens: 128_000,
            supports_thinking: true,
            supports_tool_stream: None,
            custom_models: Some(vec![
                "gpt-5.5".to_string(),
                "gpt-5.1".to_string(),
                "gpt-5".to_string(),
                "gpt-5-mini".to_string(),
            ]),
            model_aliases: Some(HashMap::from([
                ("gpt-5.5".to_string(), "GPT-5.5".to_string()),
                ("gpt-5.1".to_string(), "GPT-5.1".to_string()),
                ("gpt-5".to_string(), "GPT-5".to_string()),
                ("gpt-5-mini".to_string(), "GPT-5 Mini".to_string()),
            ])),
            provider_type: "openai-responses".to_string(),
            // Reasoning models reject `temperature` on /responses; the
            // adapter gates it by model family, so no preset default.
            default_temperature: None,
            default_max_tokens: None,
            requires_api_key: true,
            // Pricing intentionally omitted — the UI enriches models
            // from models.dev, which stays current across releases.
            model_pricing: None,
        },
        ProviderCatalogPreset {
            id: "lmstudio".to_string(),
            name: "LM Studio".to_string(),
            nickname: None,
            base_url: "http://localhost:1234/v1".to_string(),
            model: "local-model".to_string(),
            context_window: 128000,
            max_output_tokens: 8192,
            supports_thinking: false,
            supports_tool_stream: None,
            custom_models: Some(Vec::new()),
            model_aliases: None,
            provider_type: "lmstudio".to_string(),
            default_temperature: Some(1.0),
            default_max_tokens: None,
            requires_api_key: false,
            model_pricing: None,
        },
        ProviderCatalogPreset {
            id: "ollama".to_string(),
            name: "Ollama".to_string(),
            nickname: None,
            base_url: "http://localhost:11434/v1".to_string(),
            model: "llama3".to_string(),
            context_window: 128000,
            max_output_tokens: 8192,
            supports_thinking: false,
            supports_tool_stream: None,
            custom_models: Some(Vec::new()),
            model_aliases: None,
            provider_type: "ollama".to_string(),
            default_temperature: Some(1.0),
            default_max_tokens: None,
            requires_api_key: false,
            model_pricing: None,
        },
    ]
}
