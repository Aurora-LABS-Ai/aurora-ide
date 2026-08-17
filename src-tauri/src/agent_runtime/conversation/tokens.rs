//! Agent runtime — Token estimation. Every function here is an ESTIMATE used for budgeting
//! before a request; the provider's reported usage is the authority after it.
//!
//! Split out of `conversation.rs` verbatim; see `mod.rs` for the map.

use super::*;

/// Estimate token count of a plain string using cl100k (the encoding
/// the existing context engine uses). Falls back to a 4-chars-per-token
/// approximation if tiktoken initialization fails — the trim is
/// best-effort, not load-bearing for correctness.
pub(super) fn estimate_text_tokens(text: &str) -> u32 {
    if text.is_empty() {
        return 0;
    }
    use crate::services::token_service::{EncodingType, TokenService};
    TokenService::count_tokens(text, EncodingType::Cl100k)
        .map(|c| c.tokens as u32)
        .unwrap_or_else(|_| (text.len() as u32 + 3) / 4)
}

/// Flat per-image token estimate for the trim heuristic. Images are sent as
/// real `image`/`image_url` blocks and billed by the provider's tile/area
/// formula (a ~1024px image is roughly this many tokens), NOT by their base64
/// length — so counting the marker as text would over-count by ~100×. The trim
/// threshold's 25% cushion absorbs any imprecision in this flat figure.
pub(super) const IMAGE_TOKEN_ESTIMATE: u32 = 1_100;

/// Token estimate for text that MAY embed `<aurora_image …>BASE64</aurora_image>`
/// markers (user-pasted/dropped images, or `browser_screenshot` results). The
/// base64 payload is excluded from the text token count and each marker instead
/// contributes a flat [`IMAGE_TOKEN_ESTIMATE`]. Without this a single image
/// would read as hundreds of thousands of tokens and falsely trip context
/// trimming.
pub(super) fn estimate_text_with_images(text: &str) -> u32 {
    use crate::api::aurora_image::find_marker;

    let mut images: u32 = 0;
    let mut stripped = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(marker) = find_marker(text, cursor) {
        stripped.push_str(&text[cursor..marker.start]);
        images = images.saturating_add(1);
        cursor = marker.end;
    }
    if images == 0 {
        return estimate_text_tokens(text);
    }
    stripped.push_str(&text[cursor..]);
    estimate_text_tokens(&stripped).saturating_add(images.saturating_mul(IMAGE_TOKEN_ESTIMATE))
}

/// Ciphertext characters per token of the reasoning an encrypted item stands
/// for.
///
/// A Responses-API reasoning item is replayed as an opaque
/// `encrypted_content` blob, and the provider bills it as the reasoning that
/// was encrypted — so its price is a property of the PLAINTEXT, which the
/// blob has inflated twice over: authenticated encryption adds an IV, a tag
/// and block padding, then base64 adds another 4/3. Running tiktoken over the
/// base64 instead (the old behaviour) charges roughly one token per two
/// characters and lands ~2.6× high.
///
/// Working backwards: ~4 plaintext chars per token, ~1.4× for the envelope and
/// base64 → ~5.5 ciphertext chars per real token. Rounded DOWN to 5, which
/// errs slightly high on purpose: over-counting compacts a little early, while
/// under-counting overruns the window and the provider rejects the turn.
pub(super) const ENCRYPTED_REASONING_CHARS_PER_TOKEN: usize = 5;

/// Token cost of a replayed encrypted reasoning item, from its stored
/// signature. `None`/empty (a provider that gave us no item to replay) costs
/// nothing — there is no block to send.
pub(super) fn estimate_encrypted_reasoning_tokens(signature: Option<&str>) -> u32 {
    let Some(sig) = signature.filter(|s| !s.is_empty()) else {
        return 0;
    };
    u32::try_from(sig.len() / ENCRYPTED_REASONING_CHARS_PER_TOKEN).unwrap_or(u32::MAX)
}

pub(super) fn measured_context_tokens(usage: &TokenUsage) -> u32 {
    usage
        .input_tokens
        .saturating_add(usage.cache_creation_input_tokens.unwrap_or(0))
        .saturating_add(usage.cache_read_input_tokens.unwrap_or(0))
        .saturating_add(usage.output_tokens)
}

/// Token cost of the tool catalogue as the provider receives it.
///
/// Counted separately from the messages because the schemas are not part of
/// the transcript, yet they ride on EVERY request — on Aurora's toolset they
/// are tens of thousands of tokens. Leaving them out of the compaction
/// projection made it under-report the request it was deciding about, in the
/// opposite direction to the thinking-block over-count above; two errors of
/// opposite sign meant the number could not be trusted at any size.
pub(super) fn estimate_tool_schema_tokens(schemas: &[ToolSchema]) -> u32 {
    schemas
        .iter()
        .map(|t| {
            estimate_text_tokens(&t.name)
                .saturating_add(estimate_text_tokens(&t.description))
                .saturating_add(estimate_text_tokens(&t.input_schema.to_string()))
        })
        .fold(0u32, u32::saturating_add)
}

/// Estimate the token cost of one [`ConversationMessage`].
///
/// Sums every block's textual content plus a small per-message and
/// per-block overhead matching the heuristic the legacy
/// `context::manager::ContextManager::count_round_tokens` uses (so the
/// trim's view of "how big is this turn" lines up with what the chat
/// indicator displayed under the old engine).
pub(super) fn estimate_message_tokens(
    message: &ConversationMessage,
    replay: ReasoningReplay,
) -> u32 {
    let mut total: u32 = 4; // per-message overhead
    for block in &message.blocks {
        match block {
            ContentBlock::Text { text } => {
                // Excludes embedded image base64 (counts each image as a flat
                // estimate) so a pasted image doesn't read as ~100× its real
                // token cost.
                total = total.saturating_add(estimate_text_with_images(text));
            }
            // Priced by what the PROVIDER will do with it, not by what we
            // stored. See `ReasoningReplay` — for most providers the answer
            // is "nothing", and the stored bytes are pure phantom context.
            ContentBlock::Thinking {
                text, signature, ..
            } => match replay {
                ReasoningReplay::Dropped => {}
                ReasoningReplay::Text => {
                    total = total.saturating_add(estimate_text_tokens(text));
                }
                ReasoningReplay::Opaque => {
                    total = total
                        .saturating_add(estimate_encrypted_reasoning_tokens(signature.as_deref()));
                }
            },
            ContentBlock::ToolUse { name, input, .. } => {
                total = total.saturating_add(estimate_text_tokens(name));
                let json = input.to_string();
                total = total.saturating_add(estimate_text_tokens(&json));
                total = total.saturating_add(3); // tool-call overhead
            }
            ContentBlock::ToolResult { content, .. } => {
                // Screenshot results also embed `<aurora_image>` markers.
                total = total.saturating_add(estimate_text_with_images(content));
                total = total.saturating_add(4); // tool-result overhead
            }
            ContentBlock::Compaction { summary, .. } => {
                // In the model API view a compaction marker is replaced by its
                // summary (a single text block), so its token cost IS the
                // summary's. `apply_compaction` normally strips markers before
                // this runs; counting the summary keeps any stray call honest.
                total = total.saturating_add(estimate_text_tokens(summary));
            }
            ContentBlock::Notice { .. } => {
                // Costs nothing: notices are stripped from every provider view,
                // so counting them would inflate the context ring against
                // tokens that are never sent.
            }
        }
    }
    total
}
