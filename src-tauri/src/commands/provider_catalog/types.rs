use serde::Serialize;
use serde_json::Value;
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
    /// Per-model context window, for a provider whose models do not share one.
    /// Keyed like [`Self::model_pricing`]; anything absent falls back to
    /// [`Self::context_window`].
    ///
    /// This exists because MiniMax ships M3 at 1,000,000 tokens beside an M2.x
    /// family at 204,800, and a provider-wide figure has to be wrong for one of
    /// them. Wrong in the generous direction is the dangerous one: the ring
    /// reads comfortable, nothing compacts, and the provider rejects the
    /// request. Anything a preset knows per model belongs on the model.
    #[serde(default)]
    pub model_context_windows: Option<HashMap<String, u32>>,
    /// Per-model reasoning control to seed, keyed like [`Self::model_pricing`].
    ///
    /// Carried as raw JSON because the shape belongs to the frontend's
    /// `ModelReasoning` type and Rust never reads it — the seeding path hands
    /// it straight to the model row. Without it a seeded model arrives with no
    /// reasoning profile, which means no effort picker in the composer until
    /// somebody edits the row by hand.
    #[serde(default)]
    pub model_reasoning: Option<HashMap<String, Value>>,
    /// Per-model vision, for a provider whose models do not agree.
    ///
    /// [`Self::supports_vision`] answers for the whole provider, and DeepSeek
    /// is the case where that cannot be right: Flash reads images and V4 Pro
    /// answers 400 on them. Wrong in the permissive direction is the damaging
    /// one — a pasted screenshot reaches a model that cannot see it and the
    /// turn fails — so anything a preset knows per model belongs on the model.
    #[serde(default)]
    pub model_vision: Option<HashMap<String, bool>>,
}

/// DeepSeek's effort picker, as the composer's `ModelReasoning` shape.
///
/// A function rather than a constant because it is used once per model row and
/// `serde_json::json!` is not const. `toggleable` is true because DeepSeek's
/// thinking genuinely switches off (`{"thinking": {"type": "disabled"}}`),
/// unlike the natively-reasoning families where the composer must not offer a
/// switch that does nothing.
fn deepseek_effort_control() -> Value {
    serde_json::json!({
        "type": "effort",
        "levels": ["low", "high", "max"],
        "default": "max",
        "supported": ["effort", "toggle"],
        "toggleable": true,
    })
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
            model_context_windows: None,
            model_reasoning: None,
            model_vision: None,
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
            model_context_windows: None,
            model_reasoning: None,
            model_vision: None,
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
            model_context_windows: None,
            model_reasoning: None,
            model_vision: None,
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
            id: "meta".to_string(),
            name: "Meta Model API".to_string(),
            // "Muse" is what the models are actually called; "Meta" alone
            // reads as the company, and the row sits in a list of companies.
            nickname: Some("Muse".to_string()),
            // One root for all three wires — the adapter appends `/responses`,
            // `/chat/completions` or `/messages` to it.
            base_url: crate::api::meta::META_BASE_URL.to_string(),
            // The contributor tier is the default on purpose: it is the tier a
            // Muse Code subscription is meant to be spent through, and it is
            // what Meta's own dashboard hands people in the Claude Code
            // snippet. The trade is stated plainly on the model row — Meta
            // trains on prompts and completions sent to a `-contributor`
            // model. `muse-spark-1.3` is the same model without that term and
            // is one click away in the picker.
            model: "muse-spark-1.3-contributor".to_string(),
            context_window: crate::api::meta::META_CONTEXT_WINDOW,
            max_output_tokens: crate::api::meta::META_MAX_OUTPUT_TOKENS,
            supports_thinking: true,
            supports_tool_stream: Some(true),
            // Text, image, video and PDF in; text out.
            supports_vision: Some(true),
            // The Muse Spark family only. `GET /v1/models` also lists
            // `muse-image-1.0` and `muse-voice-transcribe-1.0`, and both are
            // deliberately absent: they are an image endpoint and a
            // transcription endpoint, not chat models, so seeding them would
            // put rows in the model picker that look selectable and fail on
            // the first message.
            custom_models: Some(vec![
                "muse-spark-1.3-contributor".to_string(),
                "muse-spark-1.3".to_string(),
                "muse-spark-1.2-contributor".to_string(),
                "muse-spark-1.2".to_string(),
                "muse-spark-1.1".to_string(),
            ]),
            model_aliases: Some(HashMap::from([
                (
                    "muse-spark-1.3-contributor".to_string(),
                    "Muse Spark 1.3 (Contributor)".to_string(),
                ),
                ("muse-spark-1.3".to_string(), "Muse Spark 1.3".to_string()),
                (
                    "muse-spark-1.2-contributor".to_string(),
                    "Muse Spark 1.2 (Contributor)".to_string(),
                ),
                ("muse-spark-1.2".to_string(), "Muse Spark 1.2".to_string()),
                ("muse-spark-1.1".to_string(), "Muse Spark 1.1".to_string()),
            ])),
            // Responses, not Chat Completions. Meta serves all three wires,
            // but only this one replays reasoning across a tool loop; their
            // own docs warn that the Chat Completions adapter drops it and
            // makes multi-step loops erratic. `meta` and `meta-messages` are
            // selectable in the API-type dropdown for anyone who needs them.
            provider_type: crate::api::meta::META_RESPONSES_TYPE.to_string(),
            // Reasoning models reject `temperature` on `/responses`; the
            // adapter gates it by model family, so no preset default. Same
            // reasoning as the OpenAI (Responses) preset above.
            default_temperature: None,
            default_max_tokens: None,
            requires_api_key: true,
            model_context_windows: None,
            model_reasoning: None,
            model_vision: None,
            // Meta's published rates (USD per 1M tokens: cached input, fresh
            // input, output). Seeded, unlike Command Code's, because these are
            // what a pay-as-you-go account is actually charged — and
            // pay-as-you-go is the state every account starts in.
            //
            // The contributor rows are an order of magnitude cheaper for one
            // reason: Meta keeps what you send them and trains on it. The
            // price gap IS the trade, so showing both rates side by side in
            // the model picker is the clearest way to state it.
            //
            // A Muse Code subscription covers API usage and makes the
            // dashboard read $0.00 against millions of tokens. Aurora cannot
            // detect that — there is no endpoint that reports plan state (the
            // API key 404s on every billing path and the sign-in token is
            // refused by the API outright) — so a subscriber sees an estimate
            // of what the same traffic would have cost, and can zero these
            // rates on the model row. That is the honest failure direction:
            // over-reporting a cost is noticed and corrected, silently
            // under-reporting one is not.
            model_pricing: Some(HashMap::from([
                (
                    "muse-spark-1.3-contributor".to_string(),
                    ModelPricing::usd(0.002, 0.10, 0.20),
                ),
                (
                    "muse-spark-1.2-contributor".to_string(),
                    ModelPricing::usd(0.002, 0.10, 0.20),
                ),
                (
                    "muse-spark-1.3".to_string(),
                    ModelPricing::usd(0.15, 1.25, 4.25),
                ),
                (
                    "muse-spark-1.2".to_string(),
                    ModelPricing::usd(0.15, 1.25, 4.25),
                ),
                (
                    "muse-spark-1.1".to_string(),
                    ModelPricing::usd(0.15, 1.25, 4.25),
                ),
            ])),
        },
        ProviderCatalogPreset {
            id: "minimax".to_string(),
            name: "MiniMax M3".to_string(),
            nickname: Some("MiniMax".to_string()),
            base_url: crate::api::minimax::MINIMAX_BASE_URL.to_string(),
            // M3 is the current frontier model and was missing from this list
            // entirely. Its 1M window and 524,288-token output ceiling come
            // from MiniMax's own Messages reference; the M2.x family is
            // 204,800, which is what the old `200000` here was rounding away.
            model: "MiniMax-M3".to_string(),
            // The FALLBACK, which is the M2.x family's real figure (204,800 —
            // the old `200000` here rounded it away). M3's own 1M window is a
            // per-model override below, because a provider-wide number has to
            // be wrong for one family or the other, and wrong-generous is the
            // dangerous direction: the ring reads comfortable, nothing
            // compacts, and the provider rejects the request.
            context_window: 204_800,
            max_output_tokens: 204_800,
            supports_thinking: true,
            supports_tool_stream: None,
            // M3 takes image and video content blocks; the M2.x rows do not,
            // and carry their own overrides.
            supports_vision: Some(true),
            custom_models: Some(vec![
                "MiniMax-M3".to_string(),
                "MiniMax-M2.7".to_string(),
                "MiniMax-M2.7-highspeed".to_string(),
                "MiniMax-M2.5".to_string(),
                "MiniMax-M2.5-highspeed".to_string(),
                "MiniMax-M2.1".to_string(),
                "MiniMax-M2.1-highspeed".to_string(),
                "MiniMax-M2".to_string(),
            ]),
            model_aliases: Some(HashMap::from([
                ("MiniMax-M3".to_string(), "MiniMax M3".to_string()),
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
            provider_type: crate::api::minimax::MINIMAX_PROVIDER_TYPE.to_string(),
            default_temperature: Some(1.0),
            default_max_tokens: None,
            requires_api_key: true,
            // Published pay-as-you-go rates, USD per 1M tokens. These exist so
            // the cost card can price a MiniMax chat at all — it showed a dash
            // before, because a model with no price is a request the card
            // cannot count.
            //
            // The cache-read column is the point: at $0.06 against $0.30 fresh,
            // a cached prefix is 20x cheaper, which is exactly what Aurora was
            // throwing away by withholding `cache_control` from this provider.
            //
            // M3's listed rates carry a "permanent 50% off" and step up beyond
            // a 512k prompt ($0.60 / $2.40 / $0.12); the row below is the
            // under-512k tier, which is where a coding turn lives.
            model_pricing: Some(HashMap::from([
                (
                    "MiniMax-M3".to_string(),
                    ModelPricing::usd(0.06, 0.30, 1.20),
                ),
                (
                    "MiniMax-M2.7".to_string(),
                    ModelPricing::usd(0.06, 0.30, 1.20),
                ),
                (
                    "MiniMax-M2.7-highspeed".to_string(),
                    ModelPricing::usd(0.06, 0.60, 2.40),
                ),
            ])),
            // Only M3 differs from the family fallback above. Its 1M window
            // and 524,288 output ceiling are from MiniMax's own Messages
            // reference; every M2.x row is 204,800 and needs no entry.
            model_context_windows: Some(HashMap::from([(
                "MiniMax-M3".to_string(),
                1_000_000,
            )])),
            model_reasoning: None,
            model_vision: None,
        },
        ProviderCatalogPreset {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            nickname: None,
            base_url: "https://api.deepseek.com/v1".to_string(),
            model: "deepseek-flash".to_string(),
            // DeepSeek V4 ships with a 1M-token context window and a
            // 384K-token max output — published on the official model card and
            // the same for both models, so nothing needs a per-model override.
            context_window: 1_000_000,
            max_output_tokens: 384_000,
            supports_thinking: true,
            supports_tool_stream: None,
            // Per model below: Flash sees, V4 Pro does not. A provider-wide
            // answer has to be wrong for one of them, and wrong in the
            // permissive direction means a pasted screenshot reaches a model
            // that answers 400.
            supports_vision: None,
            // The live roster, not a remembered one. `GET /models` on
            // 2026-09-20 returns exactly these two. `deepseek-v4-flash`,
            // `deepseek-chat` and `deepseek-reasoner` are gone: the first is a
            // retired alias DeepSeek still accepts and serves with V4.1-Flash
            // at the Flash price, and the V3 pair is withdrawn. Seeding a name
            // that silently resolves to a different model is worse than not
            // offering it — the cost row would quote V3's price for V4's work.
            custom_models: Some(vec![
                "deepseek-flash".to_string(),
                "deepseek-v4-pro".to_string(),
            ]),
            model_aliases: Some(HashMap::from([
                (
                    "deepseek-flash".to_string(),
                    "DeepSeek V4.1 Flash".to_string(),
                ),
                ("deepseek-v4-pro".to_string(), "DeepSeek V4 Pro".to_string()),
            ])),
            provider_type: "deepseek".to_string(),
            default_temperature: Some(1.0),
            default_max_tokens: None,
            requires_api_key: true,
            model_context_windows: None,
            // Both models take `low | high | max` and both think by default,
            // which is why `toggleable` is true and the default is the top
            // tier: DeepSeek's own default effort is `high`, and a coding turn
            // is what `max` exists for.
            model_reasoning: Some(HashMap::from([
                ("deepseek-flash".to_string(), deepseek_effort_control()),
                ("deepseek-v4-pro".to_string(), deepseek_effort_control()),
            ])),
            model_vision: Some(HashMap::from([
                ("deepseek-flash".to_string(), true),
                ("deepseek-v4-pro".to_string(), false),
            ])),
            // OFF-PEAK rates from the official pricing table (USD per 1M
            // tokens). DeepSeek bills two rates for the same tokens — peak is
            // exactly double — and Aurora's catalogue holds one number per
            // model, so this has to pick.
            //
            // Off-peak, because it is what the clock says most of the time:
            // peak is 01:00–04:00 and 06:00–10:00 UTC on weekdays only, which
            // is 35 hours of every 168. The other 133 are billed at these
            // rates. The provider card and the context ring both say which
            // window is running, so a doubled bill is never a silent one.
            //
            //   peak (double these):  Flash $0.006 / $0.3  / $1.2
            //                         V4 Pro $0.044 / $1.32 / $3.96
            model_pricing: Some(HashMap::from([
                (
                    "deepseek-flash".to_string(),
                    ModelPricing::usd(0.003, 0.15, 0.6),
                ),
                (
                    "deepseek-v4-pro".to_string(),
                    ModelPricing::usd(0.022, 0.66, 1.98),
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
            model_context_windows: None,
            model_reasoning: None,
            model_vision: None,
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
            model_context_windows: None,
            model_reasoning: None,
            model_vision: None,
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
            model_context_windows: None,
            model_reasoning: None,
            model_vision: None,
            // Priced in RUPIAH per million tokens, not dollars, so the USD
            // helper here would be a lie. Left to the model rows.
            model_pricing: None,
        },
        ProviderCatalogPreset {
            id: "ark".to_string(),
            name: "Volcano Ark".to_string(),
            nickname: Some("Ark".to_string()),
            // The CODING PLAN address, not Ark's general inference one. Using
            // `/api/v3` with a Coding Plan key spends pay-as-you-go credit
            // instead of the subscription, and Volcano's own docs warn that
            // the plan's quota only applies on this path.
            //
            // THREE wires answer here, all driven live, and the wire rides in
            // `provider_type` (`ark-messages` / `ark` / `ark-responses`) the
            // way it does for kenari, Modal and Meta. What is different about
            // Ark is that its wires are on DIFFERENT PATHS rather than
            // different suffixes of one: `/api/coding/v1` for messages,
            // `/api/coding/v3` for chat completions and responses. So the
            // frontend rewrites this URL when the wire changes
            // (`arkBaseUrlForWire`), and a wire swap that only changed the
            // type would 404.
            //
            // Messages is seeded, on two measurements rather than taste: it is
            // the only Ark wire that signs its thinking blocks — so reasoning
            // replays across a tool loop — and the only one that reports cache
            // writes apart from cache reads, which is the whole point of the
            // context ring's cache row. It costs ~40 tokens of Volcano's own
            // injected instructions per call, which chat completions does not
            // charge; that is the trade, and it is worth it.
            base_url: "https://ark.cn-beijing.volces.com/api/coding/v1".to_string(),
            // The console-controlled router, and the plan's own default.
            //
            // `Auto` — the name the docs give it — is a hard 404
            // (`UnsupportedModel`) in both cases. `ark-code-latest` is the id
            // that works and it echoes `"model": "auto"` back, so it IS the
            // Auto option; which model it routes to is chosen in Volcano's
            // console rather than here.
            model: "ark-code-latest".to_string(),
            // The CONSERVATIVE fallback: 262,144, which is what the Doubao
            // Seed 2.x rows and Kimi K2.7 Code actually have. The 1M models
            // carry their own overrides below.
            //
            // Wrong-generous is the dangerous direction — the ring reads
            // comfortable, nothing compacts, and the provider rejects the
            // request — so the default is the small one and every larger
            // window is stated explicitly.
            context_window: 262_144,
            max_output_tokens: 131_072,
            supports_thinking: true,
            supports_tool_stream: Some(true),
            supports_vision: Some(true),
            // Every id here answered a live request through a Coding Plan key.
            // `auto` is deliberately absent: it is refused, and only
            // `ark-code-latest` reaches the router.
            custom_models: Some(vec![
                "ark-code-latest".to_string(),
                "doubao-seed-evolving".to_string(),
                "doubao-seed-2.1-turbo".to_string(),
                "doubao-seed-2.0-lite".to_string(),
                "kimi-k3".to_string(),
                "kimi-k2.7-code".to_string(),
                "glm-5.3".to_string(),
                "glm-5.3-flash".to_string(),
                "MiniMax-M3".to_string(),
                "deepseek-v4-pro".to_string(),
                "deepseek-v4-flash".to_string(),
            ]),
            model_aliases: Some(HashMap::from([
                ("ark-code-latest".to_string(), "Auto (console)".to_string()),
                (
                    "doubao-seed-evolving".to_string(),
                    "Doubao Seed Evolving".to_string(),
                ),
                (
                    "doubao-seed-2.1-turbo".to_string(),
                    "Doubao Seed 2.1 Turbo".to_string(),
                ),
                (
                    "doubao-seed-2.0-lite".to_string(),
                    "Doubao Seed 2.0 Lite".to_string(),
                ),
                ("kimi-k3".to_string(), "Kimi K3".to_string()),
                ("kimi-k2.7-code".to_string(), "Kimi K2.7 Code".to_string()),
                ("glm-5.3".to_string(), "GLM 5.3".to_string()),
                ("glm-5.3-flash".to_string(), "GLM 5.3 Flash".to_string()),
                ("MiniMax-M3".to_string(), "MiniMax M3".to_string()),
                (
                    "deepseek-v4-pro".to_string(),
                    "DeepSeek V4 Pro".to_string(),
                ),
                (
                    "deepseek-v4-flash".to_string(),
                    "DeepSeek V4 Flash".to_string(),
                ),
            ])),
            // Volcano's published per-model windows. Everything absent falls
            // back to the conservative 262,144 above.
            model_context_windows: Some(HashMap::from([
                ("doubao-seed-evolving".to_string(), 1_048_576),
                ("kimi-k3".to_string(), 1_048_576),
                ("glm-5.3".to_string(), 1_048_576),
                ("glm-5.3-flash".to_string(), 1_048_576),
                ("MiniMax-M3".to_string(), 1_048_576),
                ("deepseek-v4-pro".to_string(), 1_048_576),
                ("deepseek-v4-flash".to_string(), 1_048_576),
            ])),
            model_reasoning: None,
            model_vision: None,
            // The wire. `ark-messages` routes to the Anthropic adapter;
            // `ark` falls through to the OpenAI-compatible one, which is
            // exactly what that wire is. Either way the `ark` prefix is what
            // lets the provider card and the context ring recognise the row
            // and read its quota.
            provider_type: "ark-messages".to_string(),
            default_temperature: None,
            // 32,768 rather than the 131,072 ceiling above. Kimi K2.7 Code caps
            // its output — thinking included — at 32K, so a higher default
            // would 400 on one of the eleven rows out of the box. The ceiling
            // is what a person can raise a row to; this is what every row can
            // safely start at.
            default_max_tokens: Some(32_768),
            requires_api_key: true,
            // Subscription-billed, like Command Code's. Seeding per-token rates
            // would put dollar figures on a card for requests that cost quota,
            // not money.
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
            model_context_windows: None,
            model_reasoning: None,
            model_vision: None,
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
            model_context_windows: None,
            model_reasoning: None,
            model_vision: None,
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
            model_context_windows: None,
            model_reasoning: None,
            model_vision: None,
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

    /// Meta ships on the Responses wire and seeds only chat models.
    ///
    /// The wire is the load-bearing half: Chat Completions drops reasoning
    /// between turns on this API, so a row seeded onto `meta` would look
    /// identical in the UI and behave erratically in a tool loop — the exact
    /// failure Meta's own docs warn about.
    #[test]
    fn meta_defaults_to_the_responses_wire_and_the_contributor_model() {
        let meta = preset("meta");
        assert_eq!(meta.provider_type, "meta-responses");
        assert_eq!(meta.base_url, "https://api.meta.ai/v1");
        assert_eq!(meta.model, "muse-spark-1.3-contributor");
        assert!(meta.requires_api_key);
        assert_eq!(meta.context_window, 1_048_576);

        // The default model must be one of the seeded rows, or the picker
        // opens on a model the provider does not list.
        let models = meta.custom_models.as_ref().expect("seeded models");
        assert!(models.contains(&meta.model));

        // Every seeded row is nameable, or the picker shows raw ids for some
        // models and friendly names for others.
        let aliases = meta.model_aliases.as_ref().expect("aliases");
        for model in models {
            assert!(aliases.contains_key(model), "{model} has no display name");
        }
    }

    /// `GET /v1/models` also returns an image model and a transcription
    /// model. Neither answers a chat request, so neither belongs in a picker
    /// whose every other row does.
    #[test]
    fn meta_seeds_no_image_or_voice_models() {
        let meta = preset("meta");
        let models = meta.custom_models.as_ref().expect("seeded models");
        for model in models {
            assert!(
                model.starts_with("muse-spark-"),
                "{model} is not a chat model",
            );
        }
    }

    /// Every seeded model carries a rate, and the contributor rows are the
    /// cheap ones.
    ///
    /// The gap is the point: contributor models cost roughly a twelfth of
    /// their private twins because Meta trains on what is sent to them. A
    /// picker that showed one price for both would hide the only thing that
    /// distinguishes the two rows.
    #[test]
    fn meta_prices_every_model_and_the_contributor_tier_is_far_cheaper() {
        let meta = preset("meta");
        let pricing = meta.model_pricing.as_ref().expect("seeded pricing");
        let models = meta.custom_models.as_ref().expect("seeded models");

        for model in models {
            assert!(pricing.contains_key(model), "{model} has no rate");
        }

        let contributor = &pricing["muse-spark-1.3-contributor"];
        let standard = &pricing["muse-spark-1.3"];
        assert!(contributor.cache_miss_per_mtok < standard.cache_miss_per_mtok);
        assert!(contributor.output_per_mtok < standard.output_per_mtok);
        // Meta's published numbers, not a ratio someone reasoned to.
        assert_eq!(contributor.cache_miss_per_mtok, 0.10);
        assert_eq!(contributor.output_per_mtok, 0.20);
        assert_eq!(standard.cache_miss_per_mtok, 1.25);
        assert_eq!(standard.output_per_mtok, 4.25);
    }

    /// One provider, two families, two window sizes. A single provider-wide
    /// figure has to be wrong for one of them, and wrong-GENEROUS is the
    /// dangerous direction: the ring reads comfortable, compaction never
    /// fires, and the provider rejects the request.
    #[test]
    fn minimax_sizes_m3_and_the_m2_family_separately() {
        let presets = built_in_provider_presets();
        let minimax = presets
            .iter()
            .find(|p| p.id == "minimax")
            .expect("minimax ships");

        // The fallback is the M2.x family's real figure, not a rounded one.
        assert_eq!(minimax.context_window, 204_800);

        let windows = minimax
            .model_context_windows
            .as_ref()
            .expect("M3 needs its own window");
        assert_eq!(windows.get("MiniMax-M3"), Some(&1_000_000));
        // Every other model takes the fallback; an entry here that merely
        // repeats it is one more place to forget to change.
        assert_eq!(windows.len(), 1, "only M3 differs from the family");
        for model in minimax.custom_models.as_ref().expect("models") {
            if model != "MiniMax-M3" {
                assert!(!windows.contains_key(model), "{model} should inherit");
            }
        }
    }

    /// The measured cache-read rate is the whole reason prompt caching was
    /// turned on for MiniMax, so the catalogue has to carry it.
    #[test]
    fn minimax_prices_cache_reads_far_below_fresh_input() {
        let presets = built_in_provider_presets();
        let minimax = presets.iter().find(|p| p.id == "minimax").expect("ships");
        let pricing = minimax.model_pricing.as_ref().expect("priced");
        let m3 = pricing.get("MiniMax-M3").expect("M3 priced");
        assert!(
            m3.cache_hit_per_mtok * 4.0 < m3.cache_miss_per_mtok,
            "a cache read is meant to be far cheaper than fresh input"
        );
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
