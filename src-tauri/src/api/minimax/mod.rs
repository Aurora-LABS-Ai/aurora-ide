//! MiniMax — constants and the one thing that is MiniMax's own.
//!
//! Like [`super::meta`] and unlike [`super::cursor`], this provider ships **no
//! adapter**. MiniMax serves a genuine Anthropic Messages wire at
//! `https://api.minimax.io/anthropic/v1`, and Aurora's stock
//! [`super::anthropic`] client reaches it unchanged — verified against the live
//! endpoint, not read off a docs page.
//!
//! What lives here is [`usage`]: the Token Plan quota read, which is not part
//! of the Messages API and has no Anthropic equivalent.
//!
//! ## Verified live on 2026-09-09
//!
//! - **Prompt caching works.** `cache_control: {"type":"ephemeral"}` on the
//!   system block produced `cache_creation_input_tokens: 1582` on the first
//!   call and `cache_read_input_tokens: 1582` on the second, with
//!   `input_tokens: 0` both times. The three usage fields are disjoint and
//!   additive exactly as Anthropic reports them. Aurora had MiniMax excluded
//!   from caching on caution alone; see `supports_prompt_caching`.
//! - **One key does both.** A `sk-cp-` Token Plan subscription key
//!   authenticated the chat endpoint AND the quota endpoint. There is no
//!   browser sign-in to capture, unlike kenari.
//! - **Thinking arrives without being asked for.** The Messages API reference
//!   says `thinking` defaults to disabled; a request that sent no `thinking`
//!   field came back with a `thinking` block carrying a `signature`. Reality
//!   wins over the page.
//!
//! ## Cache rules that differ from Anthropic's
//!
//! - At most **4** `cache_control` markers per request; beyond that only the
//!   last four count. Aurora places at most four.
//! - The cache lives **5 minutes**, refreshed free on every hit.
//! - Invalidation cascades `tools → system → messages`: changing a level
//!   invalidates it and everything after it.

pub mod usage;

/// Base URL for the Anthropic-compatible Messages wire. The adapter appends
/// `/messages` to this.
pub const MINIMAX_BASE_URL: &str = "https://api.minimax.io/anthropic/v1";

/// Provider type that routes a row to the Anthropic adapter and switches on
/// prompt caching.
pub const MINIMAX_PROVIDER_TYPE: &str = "minimax";

/// The account host, which is NOT the API host. Quota lives on `www`, the
/// models live on `api`, and using one for the other answers 404.
pub const MINIMAX_ACCOUNT_BASE: &str = "https://www.minimax.io";
