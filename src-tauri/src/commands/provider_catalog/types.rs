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
    /// Whether the seeded models accept images. `None` = no.
    ///
    /// Seeding hardcoded "no vision" for every preset, so a vision-capable
    /// model arrived with the capability switched off and the user had to
    /// find the toggle in Settings › Providers before they could paste a
    /// screenshot. A preset that knows its models see now says so.
    #[serde(default)]
    pub supports_vision: Option<bool>,
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
            supports_vision: None,
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
            supports_vision: None,
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
            supports_vision: None,
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
            supports_vision: None,
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
            supports_vision: None,
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
            // A named variant, not a bare `gpt-5.6` — the 5.6 generation
            // ships only as sol/terra/luna, so the bare id 404s and would
            // make this preset's DEFAULT model the one that cannot answer.
            model: "gpt-5.6-terra".to_string(),
            // GPT-5.4 and up carry a ~1.05M context; the mini/nano tier
            // stays at 400K and the 4.x rows lower still. Per-model
            // overrides enrich from models.dev in the UI.
            context_window: 1_050_000,
            max_output_tokens: 128_000,
            // Left FALSE deliberately, even though every gpt-5.x row below
            // reasons. This preset speaks Chat Completions, whose wire shape
            // here is `ThinkingMode::None` — it never sends a reasoning
            // effort, so advertising a thinking control would ship a switch
            // that does nothing. Reasoning-effort control is exactly what the
            // "OpenAI (Responses)" preset below exists to provide.
            supports_thinking: false,
            supports_tool_stream: None,
            // The GPT-5.x rows all take images.
            supports_vision: Some(true),
            custom_models: Some(vec![
                "gpt-5.6-terra".to_string(),
                "gpt-5.6-luna".to_string(),
                "gpt-5.5".to_string(),
                "gpt-5.4".to_string(),
                "gpt-5.4-mini".to_string(),
                "gpt-5.4-nano".to_string(),
                "gpt-4.1".to_string(),
                "gpt-4.1-mini".to_string(),
                "gpt-4o".to_string(),
            ]),
            model_aliases: Some(HashMap::from([
                ("gpt-5.6-terra".to_string(), "GPT-5.6 Terra".to_string()),
                ("gpt-5.6-luna".to_string(), "GPT-5.6 Luna".to_string()),
                ("gpt-5.5".to_string(), "GPT-5.5".to_string()),
                ("gpt-5.4".to_string(), "GPT-5.4".to_string()),
                ("gpt-5.4-mini".to_string(), "GPT-5.4 Mini".to_string()),
                ("gpt-5.4-nano".to_string(), "GPT-5.4 Nano".to_string()),
                ("gpt-4.1".to_string(), "GPT-4.1".to_string()),
                ("gpt-4.1-mini".to_string(), "GPT-4.1 Mini".to_string()),
                ("gpt-4o".to_string(), "GPT-4o".to_string()),
            ])),
            provider_type: "openai".to_string(),
            default_temperature: Some(1.0),
            default_max_tokens: None,
            requires_api_key: true,
            // USD per 1M tokens as (cached input, fresh input, output),
            // transcribed from the models.dev catalogue the UI enriches
            // from — so a seeded row and an enriched row agree instead of
            // the seed quietly reporting a stale rate.
            model_pricing: Some(HashMap::from([
                (
                    "gpt-5.6-terra".to_string(),
                    ModelPricing::usd(0.20, 2.0, 12.0),
                ),
                (
                    "gpt-5.6-luna".to_string(),
                    ModelPricing::usd(0.02, 0.20, 1.20),
                ),
                ("gpt-5.5".to_string(), ModelPricing::usd(0.50, 5.0, 30.0)),
                ("gpt-5.4".to_string(), ModelPricing::usd(0.25, 2.50, 15.0)),
                (
                    "gpt-5.4-mini".to_string(),
                    ModelPricing::usd(0.075, 0.75, 4.50),
                ),
                (
                    "gpt-5.4-nano".to_string(),
                    ModelPricing::usd(0.02, 0.20, 1.25),
                ),
                ("gpt-4.1".to_string(), ModelPricing::usd(0.50, 2.0, 8.0)),
                (
                    "gpt-4.1-mini".to_string(),
                    ModelPricing::usd(0.10, 0.40, 1.60),
                ),
                ("gpt-4o".to_string(), ModelPricing::usd(1.25, 2.50, 10.0)),
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
            // A named variant, not a bare `gpt-5.6` — the 5.6 generation
            // ships only as sol/terra/luna, so the bare id 404s.
            model: "gpt-5.6-sol".to_string(),
            // GPT-5.4 and up carry a ~1.05M context, 128K max output. The
            // mini/nano tier stays at 400K; per-model overrides enrich from
            // models.dev in the UI.
            context_window: 1_050_000,
            max_output_tokens: 128_000,
            supports_thinking: true,
            // Both TRUE, not left to the seeding default. These models stream
            // tool calls and take images, and seeding them as incapable meant
            // the user had to switch both on by hand, per model, before the
            // provider they had just added could do what it does.
            supports_tool_stream: Some(true),
            supports_vision: Some(true),
            // The GPT-5.5 and GPT-5.6 families only. Everything older was
            // retired upstream, and a preset that keeps offering a retired
            // model is worse than one that offers nothing: the row looks
            // selectable, is priced, and fails at the first request. Rows
            // seeded before this trim stay in the user's database — the
            // catalogue seeds, it does not prune — so a stale one is removed
            // in Settings › Providers.
            custom_models: Some(vec![
                "gpt-5.6-sol".to_string(),
                "gpt-5.6-terra".to_string(),
                "gpt-5.6-luna".to_string(),
                "gpt-5.5".to_string(),
                "gpt-5.5-pro".to_string(),
            ]),
            model_aliases: Some(HashMap::from([
                ("gpt-5.6-sol".to_string(), "GPT-5.6 Sol".to_string()),
                ("gpt-5.6-terra".to_string(), "GPT-5.6 Terra".to_string()),
                ("gpt-5.6-luna".to_string(), "GPT-5.6 Luna".to_string()),
                ("gpt-5.5".to_string(), "GPT-5.5".to_string()),
                ("gpt-5.5-pro".to_string(), "GPT-5.5 Pro".to_string()),
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
            id: "kenari".to_string(),
            // "Kenari", capitalised, even though the brand styles itself
            // lowercase. This string sits in a list beside Anthropic, OpenAI
            // and DeepSeek, where a lowercase entry reads as a typo rather than
            // as a style. The MARK keeps their lowercase "k" — that is the part
            // that is actually their identity.
            name: "Kenari".to_string(),
            nickname: None,
            // One account reaches 54 chat models across 17 vendors — Anthropic,
            // OpenAI, Google, DeepSeek, Qwen, GLM, MiniMax, xAI — over ONE key
            // and one address. The wire is chosen by `provider_type`
            // (`kenari` / `kenari-messages` / `kenari-responses`); all three
            // hang off this same base URL, because every client appends its own
            // path to it (`/chat/completions`, `/messages`, `/responses`).
            base_url: "https://kenari.id/v1".to_string(),
            // NO seeded model, deliberately. The catalogue is live and moves
            // (`GET /v1/models`, public, no key) and their own docs say not to
            // hard-code a list. A seeded id would be a guess that goes stale
            // and then 404s in the user's face — worse than an empty list with
            // a working Add box. `model: ""` is what produces zero rows:
            // `modelsFromPreset` filters empty keys out.
            model: String::new(),
            // Provider-level fallbacks only, for a model row added by hand
            // before its real numbers are known. The live catalogue ranges from
            // 32K to 1M, so this is a middle, not a claim.
            context_window: 200_000,
            max_output_tokens: 32_768,
            supports_thinking: true,
            supports_tool_stream: Some(true),
            supports_vision: Some(true),
            custom_models: Some(Vec::new()),
            model_aliases: None,
            provider_type: "kenari".to_string(),
            default_temperature: None,
            default_max_tokens: None,
            requires_api_key: true,
            // Priced in RUPIAH per million tokens, not dollars, so the USD
            // helper here would be a lie. Left to the model rows.
            model_pricing: None,
        },
        ProviderCatalogPreset {
            id: "modal".to_string(),
            name: "Modal".to_string(),
            nickname: None,
            // One Modal WORKSPACE per row. The regional gateway lists every
            // live endpoint in the workspace through `/v1/models` with the
            // workspace's proxy token, and addresses each by its hostname as
            // the model id — so the models are the endpoints, refreshed from
            // the gateway, and the base URL only says which region routes the
            // traffic. See `commands/modal.rs`.
            base_url: crate::commands::modal::gateway_base_url("us-west"),
            // No seeded model: the list is whatever the workspace has deployed
            // right now, and a guessed hostname would 404 as
            // `unknown inference model`.
            model: String::new(),
            context_window: 128_000,
            max_output_tokens: 32_768,
            supports_thinking: true,
            supports_tool_stream: Some(true),
            supports_vision: Some(true),
            custom_models: Some(Vec::new()),
            model_aliases: None,
            provider_type: "modal".to_string(),
            default_temperature: None,
            default_max_tokens: None,
            requires_api_key: true,
            // Endpoints bill for GPU time, not tokens, so there is no per-token
            // price to seed. The cost card stays blank unless the user enters
            // an effective rate on the model row.
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
            supports_vision: None,
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
            supports_vision: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(id: &str) -> ProviderCatalogPreset {
        built_in_provider_presets()
            .into_iter()
            .find(|p| p.id == id)
            .unwrap_or_else(|| panic!("{id} is not in the catalogue"))
    }

    #[test]
    fn kenari_seeds_no_models_at_all() {
        // Deliberate, and load-bearing. kenari's catalogue is live and moves —
        // their own docs say not to hard-code a list — so any id shipped here
        // is a guess with a shelf life. A stale seeded model does not fail
        // quietly: it appears in the picker, looks selectable, and 404s on the
        // first message.
        //
        // The empty `model` is what produces zero rows: the store's
        // `modelsFromPreset` falls back to `[preset.model]` when
        // `custom_models` is empty, then filters blank keys out. Putting any
        // placeholder here would silently seed one model.
        let kenari = preset("kenari");
        assert!(kenari.model.is_empty(), "a non-empty model seeds a row");
        assert_eq!(kenari.custom_models.as_deref(), Some(&[][..]));
        assert!(kenari.model_aliases.is_none());
    }

    #[test]
    fn kenari_ships_on_the_chat_wire_and_asks_for_a_key() {
        let kenari = preset("kenari");
        assert_eq!(kenari.provider_type, "kenari");
        assert_eq!(kenari.base_url, "https://kenari.id/v1");
        assert!(kenari.requires_api_key);
        // Priced in Rupiah upstream, so the USD pricing helper would be wrong.
        assert!(kenari.model_pricing.is_none());
    }

    #[test]
    fn modal_seeds_no_models_and_points_at_the_default_region_gateway() {
        // The models are the workspace's live endpoints, addressed by hostname
        // through the gateway; a seeded hostname is a guess that answers
        // `unknown inference model`.
        let modal = preset("modal");
        assert!(modal.model.is_empty(), "a non-empty model seeds a row");
        assert_eq!(modal.custom_models.as_deref(), Some(&[][..]));
        assert_eq!(modal.provider_type, "modal");
        assert_eq!(
            modal.base_url,
            crate::commands::modal::gateway_base_url("us-west")
        );
        assert!(modal.requires_api_key);
        assert!(modal.model_pricing.is_none(), "endpoints bill GPU time, not tokens");
    }

    #[test]
    fn every_catalogue_id_is_unique() {
        // Two presets sharing an id silently overwrite each other in the
        // store's merge, and the loser's key and models disappear.
        let presets = built_in_provider_presets();
        let mut ids: Vec<&str> = presets.iter().map(|p| p.id.as_str()).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate provider id in the catalogue");
    }
}
