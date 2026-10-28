//! kenari — constants and the one thing that is kenari's own.
//!
//! Like [`super::minimax`], this provider ships **no adapter**: its three
//! wires are served by [`super::openai_compat`], [`super::anthropic`] and
//! [`super::responses`] unchanged. What lives here is [`usage`]: the plan
//! quota read, which is specific to kenari and has no OpenAI or Anthropic
//! equivalent.
//!
//! Until 2026-10-26 the quota could only be read by a signed-in browser, so
//! Aurora opened kenari's login page in a window and kept the session
//! cookies (`commands/kenari.rs`, now gone). kenari then documented
//! `GET /v1/account/quota` for the API key and `x-kenari-plan-remaining` on
//! chat replies; both were checked live the same day
//! (`scripts/probe-kenari-quota.py`).

pub mod commands;
pub mod usage;

/// Every account read hangs off the API origin, the same one chat uses.
pub const KENARI_API_BASE: &str = "https://kenari.id/v1";
