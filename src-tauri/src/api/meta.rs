//! Meta Model API (Muse) — constants and the two rules that are Meta's own.
//!
//! Unlike [`super::commandcode`] or [`super::cursor`], this provider ships
//! **no adapter**. Meta serves the same three wires Aurora already speaks, off
//! one base URL and one bearer key:
//!
//! | Aurora provider type | Endpoint               | Adapter                        |
//! |----------------------|------------------------|--------------------------------|
//! | `meta-responses`     | `/v1/responses`        | [`super::responses`] (default) |
//! | `meta`               | `/v1/chat/completions` | [`super::openai_compat`]       |
//! | `meta-messages`      | `/v1/messages`         | [`super::anthropic`]           |
//!
//! Responses is the default because it is the only one of the three that
//! carries reasoning across a tool loop — Meta's own docs say so, and the
//! `include: ["reasoning.encrypted_content"]` Aurora already sends on that
//! wire is exactly the switch their docs tell agents to set. On Chat
//! Completions the reasoning is dropped between turns, which their docs warn
//! makes multi-step loops erratic.
//!
//! ## Verified against the live API, not read off the docs
//!
//! - **The Messages wire takes either auth header.** `Authorization: Bearer`
//!   and `x-api-key` both answered 200 with the same key. Aurora's Anthropic
//!   adapter sends `x-api-key`, so it works here unchanged — the one thing
//!   that could have forced a Meta-specific adapter, and it did not.
//! - **The key's delimiter does not matter.** `LLM|<id>|<secret>` and
//!   `LLM_<id>_<secret>` are both accepted. Users paste whichever their
//!   dashboard showed them; neither needs repairing.
//! - **Extended thinking is on by default and spends the output budget.**
//!   A 32-token cap came back with 29 thinking tokens and an EMPTY content
//!   array (`stop_reason: "max_tokens"`). This is why the preset seeds a
//!   131,072-token output ceiling rather than a small one: a tight cap here
//!   does not truncate the answer, it deletes it.
//!
//! ## The one incompatibility, and why it is handled here
//!
//! See [`supports_tool_choice`]. Meta's Responses endpoint accepts only
//! `tool_choice: "auto"`; `"none"`, `"required"` and named functions are a
//! hard 400 naming the field. Aurora sends `"none"` whenever a turn offers
//! tools but must not call them, so this would fail a real turn rather than
//! an exotic one.

/// Base URL for every wire. All three endpoints hang off this one root, so
/// the provider row holds a single address and the adapter appends its own
/// path (`/responses`, `/chat/completions`, `/messages`).
pub const META_BASE_URL: &str = "https://api.meta.ai/v1";

// Two more addresses worth knowing, deliberately NOT consts here because
// nothing in Rust consumes them and an unused const is just a warning:
//
//   https://dev.meta.ai/            — where a user creates a key. The
//                                     frontend renders this link, so it
//                                     lives in `services/providers/meta.ts`.
//   https://api.meta.ai/v1/status   — unauthenticated health check. Answers
//                                     `{"is_alive":true,…}` with no key at
//                                     all, so it can probe reachability
//                                     before asking for credentials.

/// Provider type that routes a row to the Responses wire — the default.
pub const META_RESPONSES_TYPE: &str = "meta-responses";

/// Provider type for the OpenAI Chat Completions wire.
pub const META_CHAT_TYPE: &str = "meta";

/// Provider type for the Anthropic-compatible Messages wire.
pub const META_MESSAGES_TYPE: &str = "meta-messages";

/// Context window shared by every Muse Spark model: 1,048,576 tokens.
pub const META_CONTEXT_WINDOW: u32 = 1_048_576;

/// Output ceiling: 131,072 tokens.
///
/// Deliberately the full published maximum rather than a modest default.
/// Muse Spark reasons by default and reasoning is billed against this same
/// budget, so a small ceiling does not shorten the reply — it spends the
/// whole allowance on thinking and returns nothing. Measured: a 32-token
/// cap produced 29 thinking tokens and zero content.
pub const META_MAX_OUTPUT_TOKENS: u32 = 131_072;

/// Is this provider type one of Meta's three wires?
#[must_use]
pub fn is_meta_type(provider_type: &str) -> bool {
    matches!(
        provider_type.trim(),
        META_CHAT_TYPE | META_RESPONSES_TYPE | META_MESSAGES_TYPE
    )
}

/// Whether this provider type accepts a `tool_choice` other than `"auto"`.
///
/// Meta's Responses endpoint does not:
///
/// ```text
/// only `"auto"` is supported for `tool_choice`. `"none"`, `"required"`,
/// and named function choices are not currently supported
/// ```
///
/// (a 400 `invalid_request_error` with `param: "tool_choice"`, read off the
/// live endpoint.)
///
/// Aurora's [`crate::agent_runtime::api_client::ToolChoice`] only ever holds
/// `Auto` or `None`, so `None` is the single value that trips this. The
/// caller's fix is not to drop the field and send the tools anyway — that
/// would let the model call a tool the runtime just said it must not. It is
/// to withhold the tool catalogue entirely, which is what "none" means and
/// which every provider honours by construction.
#[must_use]
pub fn supports_tool_choice(provider_type: &str) -> bool {
    !is_meta_type(provider_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_all_three_wires_and_nothing_else() {
        for wire in [META_CHAT_TYPE, META_RESPONSES_TYPE, META_MESSAGES_TYPE] {
            assert!(is_meta_type(wire), "{wire} is a Meta wire");
        }
        // Whitespace survives a round trip through the settings form.
        assert!(is_meta_type("  meta-responses  "));

        // Near misses must NOT match: a user-named row called "meta" is
        // caught by the type, not the name, and these are other providers.
        for other in ["", "openai", "anthropic", "metaculus", "meta-llama", "llama"] {
            assert!(!is_meta_type(other), "{other} is not a Meta wire");
        }
    }

    /// The rule that keeps a real turn from 400ing. If this ever returns
    /// true for a Meta wire, `build_responses_body` starts sending
    /// `tool_choice: "none"` again and every no-tools turn fails.
    #[test]
    fn meta_refuses_a_non_auto_tool_choice_and_others_allow_it() {
        for wire in [META_CHAT_TYPE, META_RESPONSES_TYPE, META_MESSAGES_TYPE] {
            assert!(!supports_tool_choice(wire), "{wire} takes only auto");
        }
        for other in ["openai-responses", "openai", "anthropic", "deepseek", ""] {
            assert!(supports_tool_choice(other), "{other} takes tool_choice");
        }
    }
}
