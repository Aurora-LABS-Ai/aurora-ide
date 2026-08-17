//! Agent runtime — Dropping whole old turns when the request would not fit — the cheap cut
//! that runs before compaction is considered.
//!
//! Split out of `conversation.rs` verbatim; see `mod.rs` for the map.

use super::*;

/// Outcome of [`trim_to_budget`]: the (possibly shrunken) message list
/// the runtime should send to the API plus the count of messages that
/// were dropped from the head so the caller can build a user-facing
/// notice.
pub(super) struct TrimOutcome {
    pub(super) messages: Vec<ConversationMessage>,
    pub(super) dropped: usize,
}

/// How much of the post-reserve budget we want to use before trimming
/// kicks in. 75% leaves headroom for the assistant's reply plus tool
/// results that arrive *during* the upcoming round.
pub(super) const TRIM_THRESHOLD_PCT: u32 = 75;

/// Multiplier applied to `default_max_output_tokens` when reserving
/// space for the response. Models occasionally produce slightly more
/// than the requested cap; the 10% cushion keeps us out of the
/// 400-too-many-tokens window.
pub(super) const OUTPUT_RESERVE_NUMER: u32 = 11;
pub(super) const OUTPUT_RESERVE_DENOM: u32 = 10;

/// Number of trailing user-anchored turns the trim refuses to drop.
/// A "user-anchored turn" starts at a `MessageRole::User` message and
/// runs until the next `User` (or end of list). Keeping the last two
/// preserves the in-flight question + the immediately previous one
/// (often where the user gave context the model now needs).
pub(super) const PRESERVE_LAST_USER_TURNS: usize = 2;

/// Trim the API-view of the session to fit a token budget.
///
/// Pure function: takes ownership of `messages`, returns the kept
/// suffix plus a count of dropped messages. The persisted session is
/// untouched — callers operate on a freshly cloned vector (mirroring
/// the IDE-context injection pattern).
///
/// Algorithm:
/// 1. Compute `budget = context_window - max_output * 1.1` (the
///    space left for the prompt after reserving for the response).
/// 2. Compute `threshold = budget * 0.75`.
/// 3. Count tokens of `system_prompt` plus every message via tiktoken
///    (cl100k). If the sum is within threshold, return unchanged.
/// 4. Find the cut point: the start of the (`PRESERVE_LAST_USER_TURNS`-th
///    from last) `User` message. Everything before that index gets
///    dropped. Cutting at a `User` boundary preserves tool_use ↔
///    tool_result coherence (a tool result never appears before its
///    own user-rooted turn) and keeps the alternation rule both
///    Anthropic and OpenAI APIs require.
/// 5. If there are fewer than `PRESERVE_LAST_USER_TURNS + 1` user
///    messages, no safe cut exists — return unchanged with `dropped: 0`.
///
/// `context_window == None` is the "no budget enforced" case and
/// short-circuits to no-op.
pub(super) fn trim_to_budget(
    messages: Vec<ConversationMessage>,
    context_window: Option<u32>,
    max_output: u32,
    system_prompt: &str,
    replay: ReasoningReplay,
) -> TrimOutcome {
    let Some(window) = context_window else {
        return TrimOutcome {
            messages,
            dropped: 0,
        };
    };

    let reserve = max_output
        .saturating_mul(OUTPUT_RESERVE_NUMER)
        .saturating_div(OUTPUT_RESERVE_DENOM);
    let budget = window.saturating_sub(reserve);
    if budget == 0 {
        // Pathological config (max_output >= window). Don't trim — let
        // the provider reject so the user sees the real error instead
        // of mysterious empty turns.
        return TrimOutcome {
            messages,
            dropped: 0,
        };
    }
    let threshold = budget.saturating_mul(TRIM_THRESHOLD_PCT) / 100;

    let system_tokens = estimate_text_tokens(system_prompt);
    let per_msg_tokens: Vec<u32> = messages
        .iter()
        .map(|m| estimate_message_tokens(m, replay))
        .collect();
    let total: u32 = per_msg_tokens
        .iter()
        .copied()
        .fold(system_tokens, u32::saturating_add);

    if total <= threshold {
        return TrimOutcome {
            messages,
            dropped: 0,
        };
    }

    // Find the indices of all User messages. We cut at one of these
    // boundaries to keep tool_use/tool_result pairing intact.
    let user_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(i, m)| matches!(m.role, MessageRole::User).then_some(i))
        .collect();

    if user_indices.len() <= PRESERVE_LAST_USER_TURNS {
        // Nothing safe to drop — the budget is overrun by the most
        // recent turns themselves. Send as-is and let the provider
        // surface the real over-limit error.
        return TrimOutcome {
            messages,
            dropped: 0,
        };
    }

    // Greedy: pick the latest cut point that gets us under threshold.
    // Walking from oldest user-boundary to newest preserves "drop the
    // smallest amount of history needed".
    // Candidate cut points are the 2nd..=`max_cut`-th user boundaries.
    //
    // Both ends were wrong. Cutting at `user_indices[0]` is index 0, which
    // drops nothing — so the first candidate was always a no-op. And the
    // range excluded `max_cut` itself, even though cutting there still
    // leaves PRESERVE_LAST_USER_TURNS turns standing. Net effect: the trim
    // always under-dropped by one turn, and with exactly three user turns
    // (`max_cut == 1`) the only candidate was the no-op, so trimming never
    // fired at all — the request went out over budget and the provider
    // rejected it.
    let max_cut = user_indices.len() - PRESERVE_LAST_USER_TURNS;
    let mut best_cut_msg_idx = 0;
    let mut running = total;
    for &cut_idx in &user_indices[1..=max_cut] {
        // If we cut here we drop messages [0..cut_idx).
        // Subtract their token counts from `running`.
        // (We've previously subtracted everything up to the *previous*
        // candidate, so just subtract the new range incrementally.)
        let prev = best_cut_msg_idx;
        for tokens in per_msg_tokens.iter().take(cut_idx).skip(prev) {
            running = running.saturating_sub(*tokens);
        }
        best_cut_msg_idx = cut_idx;
        if running <= threshold {
            break;
        }
    }

    if best_cut_msg_idx == 0 {
        // No user boundary was past index 0 — nothing to drop.
        return TrimOutcome {
            messages,
            dropped: 0,
        };
    }

    // The notice we'll inject costs a few tokens too. Don't bother
    // accounting precisely — the threshold's 25% cushion absorbs it.
    let kept: Vec<ConversationMessage> = messages.into_iter().skip(best_cut_msg_idx).collect();
    TrimOutcome {
        messages: kept,
        dropped: best_cut_msg_idx,
    }
}

/// Append a `<context_trim_notice>` block to the system prompt so the
/// model knows it's seeing a partial transcript. Kept short and
/// machine-readable so it doesn't bias the assistant's tone.
pub(super) fn build_trim_notice(base_prompt: &str, dropped: usize) -> String {
    let notice = format!(
        "<context_trim_notice>\n{dropped} earlier message(s) in this thread were trimmed from this request to keep it within the model's context window. The recent conversation is preserved verbatim. If the user asks about something that was in the trimmed history, ask them to restate it.\n</context_trim_notice>",
    );
    if base_prompt.is_empty() {
        notice
    } else {
        format!("{base_prompt}\n\n{notice}")
    }
}
