//! Anthropic's own API — the Claude API on a console.anthropic.com key — as a
//! first-class provider.
//!
//! ## Why this is not the `anthropic` type
//!
//! `anthropic` is a WIRE: the Messages shape, spoken by Anthropic and by a long
//! list of gateways that resell Claude or put other models behind it. A dozen
//! user-added rows use it today. What this provider adds only Anthropic itself
//! accepts — refusal fallbacks, thinking-binding controls, their beta headers —
//! and a gateway that does not know a field answers 400. So the first-party row
//! carries its own type, [`ANTHROPIC_API_PROVIDER_TYPE`], and every `anthropic`
//! row keeps the plain [`super::anthropic`] adapter it had.
//!
//! The wire work is shared, not copied: [`adapter`] builds the body with
//! `build_anthropic_body` and reads the stream with the same driver, then adds
//! what is Anthropic's alone. The per-model reasoning rules (adaptive thinking,
//! effort tiers, which models refuse `disabled`) live in
//! `anthropic_surface_for`, because a gateway serving `claude-opus-5-5` needs
//! them exactly as much as Anthropic does.
//!
//! ## What the first-party adapter adds
//!
//! - **Refusal fallbacks** ([`has_server_fallback`]). Claude Fable 5.1,
//!   Opus 5.5, Opus 5 and Sonnet 5.5 run safety classifiers that can decline a
//!   request with HTTP 200 and `stop_reason: "refusal"`. With
//!   `fallbacks: "default"` Anthropic re-runs a declined request on a model it
//!   picks, inside the same call. Without it the turn simply stops.
//! - **Thinking that survives Aurora's own history edits** ([`binds_thinking`]).
//!   On Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 a thinking block is bound
//!   to the exact conversation that produced it, and accounts created on or
//!   after 2026-08-31 get a 400 when a replayed block's history changed. Aurora
//!   changes history by design — compaction keeps recent turns verbatim behind a
//!   summary, and the system prompt's dynamic half moves when a mode or an MCP
//!   server changes. `prefix_mismatch_behavior: "drop_block"` makes the API drop
//!   the stale block instead of failing the turn.
//! - **The full model list** ([`models`]): `/v1/models` pages at 20 rows unless
//!   asked for more, and the generic lister never asks.

pub mod adapter;
pub mod models;

/// The provider type the frontend stores on the built-in Anthropic row.
pub const ANTHROPIC_API_PROVIDER_TYPE: &str = "anthropic-api";

/// Anthropic's API root. The row's base URL is honoured — the settings page
/// keeps it editable for a proxy — but this is what the preset seeds.
pub const ANTHROPIC_API_BASE_URL: &str = "https://api.anthropic.com/v1";

/// The Messages API version header. Unchanged since 2023; features arrive as
/// beta flags instead.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Beta for `fallbacks: "default"`. The array form uses `-2026-06-01`, and
/// pairing either header with the other form is a 400 — so the two are never
/// mixed here.
pub const SERVER_FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// Beta that unlocks `thinking.block_binding` and adds `input_transformations`
/// to responses. Sending `block_binding` without it is a 400.
pub const THINKING_BINDING_BETA: &str = "thinking-binding-controls-2026-08-01";

/// The row setting for how long Anthropic keeps the prompt cache: absent or
/// `"5m"` is Anthropic's default five minutes, `"1h"` is one hour. An Aurora
/// setting carried in the row's custom params, the way `reasoning_replay` is;
/// `build_anthropic_body` strips it so it never reaches the request body.
pub const PROMPT_CACHE_TTL_PARAM: &str = "prompt_cache_ttl";

/// Did the person pick the one-hour cache on this row?
///
/// The trade, measured against Anthropic's prices: a one-hour cache WRITE
/// costs 2x input instead of 1.25x, reads cost the same 0.1x, and a pause
/// longer than five minutes no longer re-bills the whole conversation at the
/// write rate. Off by default because a person working without breaks pays
/// the higher write rate for nothing.
#[must_use]
pub fn wants_hour_cache(config: &crate::api::client::ProviderConfigSnapshot) -> bool {
    config
        .custom_params
        .as_ref()
        .and_then(|params| params.get(PROMPT_CACHE_TTL_PARAM))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|ttl| ttl.trim().eq_ignore_ascii_case("1h"))
}

/// A model id reduced to the part that names the model: lowercase, without a
/// `provider:` / path prefix or Bedrock's `anthropic.` prefix.
fn normalized(model: &str) -> String {
    let lower = model.trim().to_ascii_lowercase();
    let tail = lower.rsplit(['/', ':']).next().unwrap_or("");
    tail.trim_start_matches("anthropic.").to_string()
}

/// Does Anthropic accept `fallbacks: "default"` for this model?
///
/// The four models whose safety classifiers can decline a request and for
/// which the default fallback routing is published. Exact ids, not prefixes:
/// a model released later is not assumed to accept a parameter that would
/// otherwise fail every one of its requests.
#[must_use]
pub fn has_server_fallback(model: &str) -> bool {
    matches!(
        normalized(model).as_str(),
        "claude-fable-5-1" | "claude-opus-5-5" | "claude-opus-5" | "claude-sonnet-5-5"
    )
}

/// Does this model bind thinking blocks to the conversation that produced
/// them ("preserved thinking")?
///
/// Mythos 5.1 does not run the conversation check but accepts the control,
/// so one request shape serves the whole family.
#[must_use]
pub fn binds_thinking(model: &str) -> bool {
    matches!(
        normalized(model).as_str(),
        "claude-fable-5-1"
            | "claude-mythos-5-1"
            | "claude-opus-5-5"
            | "claude-sonnet-5-5"
            | "claude-haiku-5-5"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallbacks_are_requested_only_for_the_published_models() {
        for model in ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"] {
            assert!(has_server_fallback(model), "{model} takes fallbacks");
        }
        // Haiku 5.5 has no server-side fallback, Sonnet 5 runs no classifier,
        // and an id Aurora has never seen gets nothing it might reject.
        for model in ["claude-haiku-5-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-5-6"] {
            assert!(!has_server_fallback(model), "{model} must not get fallbacks");
        }
    }

    #[test]
    fn a_prefixed_or_cased_id_resolves_to_the_same_model() {
        assert!(has_server_fallback("anthropic-api:claude-opus-5-5"));
        assert!(has_server_fallback("anthropic.claude-opus-5-5"));
        assert!(binds_thinking("Claude-Haiku-5-5"));
    }

    #[test]
    fn only_the_preserved_thinking_models_get_the_binding_control() {
        for model in ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] {
            assert!(binds_thinking(model), "{model} binds thinking");
        }
        for model in ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5"] {
            assert!(!binds_thinking(model), "{model} does not");
        }
    }
}
