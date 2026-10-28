//! Tauri command for the kenari provider.
//!
//! One command: how much of the plan is left, read with the API key. Chat,
//! tools and thinking run through the generic adapters unchanged.
//!
//! Until 2026-10-26 this file held a browser sign-in (kenari's login page in
//! a WebView window, the `kn_session` and `cf_clearance` cookies copied out of
//! its jar and replayed under the same User-Agent), because the key could not
//! read the account. kenari then documented `GET /v1/account/quota` for the
//! key, and the whole of that went away. See [`crate::api::kenari`].

use crate::api::kenari::usage::{self, KenariUsage};

/// How much of the plan is left. The key is passed in from the provider row.
///
/// `async` with the request awaited inline: a sync `#[tauri::command]` runs on
/// the UI thread in Tauri v2, and this one makes a network call.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn kenari_usage(api_key: String) -> Result<KenariUsage, String> {
    usage::fetch_usage(&api_key).await
}
