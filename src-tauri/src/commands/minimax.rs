//! Tauri command for the MiniMax provider.
//!
//! One command, because one thing about MiniMax is not already covered by the
//! Anthropic client: reading how much of a Token Plan subscription is left.
//! Chat, tools, thinking and prompt caching all run through
//! [`crate::api::anthropic`] unchanged — see [`crate::api::minimax`] for what
//! was measured to establish that.
//!
//! The key is passed in from the provider row rather than read from disk. There
//! is nothing on disk to read: MiniMax has no CLI that stores credentials the
//! way Command Code and Codex do, and the subscription key that serves chat is
//! the same one that reads the quota.

use crate::api::minimax::usage::{self, MinimaxUsageSnapshot};

/// How much of the Token Plan subscription is left, per metered bucket.
///
/// `async` with the request awaited inline: a sync `#[tauri::command]` runs on
/// the UI thread in Tauri v2, and this one makes a network call.
#[tauri::command]
pub async fn minimax_usage_get(api_key: String) -> Result<MinimaxUsageSnapshot, String> {
    usage::fetch_usage(&api_key).await
}
