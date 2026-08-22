//! OpenCode Go — reading the key the OpenCode CLI already has.
//!
//! OpenCode stores its credentials in one JSON file, keyed by provider name:
//!
//! ```json
//! {
//!   "opencode":    { "type": "api", "key": "sk-…" },   // Zen: credit-billed
//!   "opencode-go": { "type": "api", "key": "sk-…" }    // Go: the subscription
//! }
//! ```
//!
//! **The two are different keys, and picking the wrong one fails in a way that
//! reads as a billing problem rather than a configuration one.** A Zen key on
//! the Go endpoint answers `CreditsError: No payment method` — which sends a
//! subscriber to a billing page for a plan they have already paid for. So this
//! reads `opencode-go` and nothing else; there is no fallback to `opencode`,
//! deliberately.
//!
//! Read-only, like the Cursor equivalent: Aurora never writes to another
//! product's credential store.

use serde::Deserialize;
use std::path::PathBuf;

/// The entry Aurora wants. Named for the subscription, not the vendor.
const GO_ENTRY: &str = "opencode-go";

#[derive(Deserialize)]
struct AuthEntry {
    #[serde(default)]
    key: Option<String>,
}

/// Where OpenCode keeps its credentials.
///
/// `~/.local/share` on every platform — including Windows, where OpenCode uses
/// the same path rather than `%APPDATA%`. `XDG_DATA_HOME` is honoured because
/// on Linux it is what actually decides, and a user who has moved it would
/// otherwise be told no key exists while looking straight at one.
fn auth_path() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        let base = PathBuf::from(xdg);
        if !base.as_os_str().is_empty() {
            return Some(base.join("opencode").join("auth.json"));
        }
    }
    Some(
        dirs::home_dir()?
            .join(".local")
            .join("share")
            .join("opencode")
            .join("auth.json"),
    )
}

/// The Go subscription key from a local OpenCode install, if there is one.
///
/// `None` covers every ordinary absence — no install, no file, no Go entry,
/// a blank key — because none of those is an error the user needs told about:
/// the card simply offers the paste field instead. Only a genuinely unreadable
/// or malformed file returns `Err`, since that is worth saying out loud rather
/// than silently showing "no key found" over a file that exists.
#[tauri::command]
pub async fn opencode_local_key() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(read_local_key)
        .await
        .map_err(|err| format!("Could not read the OpenCode credentials: {err}"))?
}

fn read_local_key() -> Result<Option<String>, String> {
    let Some(path) = auth_path() else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }

    let raw = std::fs::read_to_string(&path)
        .map_err(|err| format!("Could not read {}: {err}", path.display()))?;

    // Only the shape Aurora needs is modelled. The file also holds OAuth
    // tokens for other providers, and deserializing into a strict struct would
    // fail the whole read the next time OpenCode adds a field.
    let entries: std::collections::HashMap<String, AuthEntry> = serde_json::from_str(&raw)
        .map_err(|err| format!("{} is not valid JSON: {err}", path.display()))?;

    Ok(entries
        .get(GO_ENTRY)
        .and_then(|entry| entry.key.as_deref())
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string))
}

/// Where Aurora looked — shown when nothing was found, so a user with a
/// relocated install can see the path that came up empty instead of being told
/// "not found" with nowhere to go.
#[tauri::command]
pub async fn opencode_auth_path() -> Result<Option<String>, String> {
    Ok(auth_path().map(|p| p.display().to_string()))
}

// ── Account reads ────────────────────────────────────────────────────────────
//
// The model list and the plan's usage are fetched **here rather than from the
// webview**, and that is not a style choice: `opencode.ai` sends no
// `Access-Control-Allow-Origin`, so a browser `fetch` is refused before it
// leaves. That is true of the packaged app as much as the dev server — the
// webview is still a browser and still enforces CORS.
//
// Rust has no such restriction. Note this is the ONLY Rust in the OpenCode
// provider: the turn itself still runs through `openai_compat.rs` untouched.

const GO_BASE_URL: &str = "https://opencode.ai/zen/go/v1";

async fn get_json(path: &str, api_key: Option<&str>) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|err| format!("Could not reach OpenCode: {err}"))?;

    let mut request = client
        .get(format!("{GO_BASE_URL}{path}"))
        .header("accept", "application/json");
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .map_err(|err| format!("Could not reach OpenCode: {err}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        // The far end explains itself well — an expired key, a plan without a
        // payment method — so its own words beat a status code.
        return Err(match status.as_u16() {
            401 | 403 => "OpenCode rejected this key. Check it at opencode.ai/auth.".to_string(),
            _ => format!("OpenCode returned {status}: {}", body.trim()),
        });
    }

    serde_json::from_str(&body).map_err(|err| {
        format!(
            "OpenCode sent something unreadable ({err}): {}",
            body.trim()
        )
    })
}

/// The models this plan can reach. Needs no key — the list is public.
#[tauri::command]
pub async fn opencode_models() -> Result<serde_json::Value, String> {
    get_json("/models", None).await
}

/// How much of the plan is left, per window. Needs the subscription key.
#[tauri::command]
pub async fn opencode_usage(api_key: String) -> Result<serde_json::Value, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Add your OpenCode subscription key first.".to_string());
    }
    get_json("/usage", Some(key)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_go_key_and_not_the_zen_one() {
        // The whole reason this module names one entry: both keys are `sk-…`
        // and look interchangeable, but the Zen one on the Go endpoint fails
        // as a billing error on a plan the user already pays for.
        let raw = r#"{
            "opencode":    { "type": "api", "key": "sk-zen-key" },
            "opencode-go": { "type": "api", "key": "sk-go-key" }
        }"#;
        let entries: std::collections::HashMap<String, AuthEntry> =
            serde_json::from_str(raw).unwrap();
        assert_eq!(
            entries.get(GO_ENTRY).unwrap().key.as_deref(),
            Some("sk-go-key")
        );
    }

    #[test]
    fn an_entry_shape_we_do_not_model_does_not_fail_the_read() {
        // The same file carries OAuth entries with `refresh`/`access`/`expires`
        // and no `key` at all. A strict struct would reject the whole file and
        // report "no key" over one that is sitting right there.
        let raw = r#"{
            "openai":      { "type": "oauth", "refresh": "rt_x", "expires": 1 },
            "opencode-go": { "type": "api", "key": "sk-go-key" }
        }"#;
        let entries: std::collections::HashMap<String, AuthEntry> =
            serde_json::from_str(raw).unwrap();
        assert_eq!(
            entries.get(GO_ENTRY).unwrap().key.as_deref(),
            Some("sk-go-key")
        );
        assert!(entries.get("openai").unwrap().key.is_none());
    }

    #[test]
    fn a_missing_go_entry_is_not_an_error() {
        let raw = r#"{ "opencode": { "type": "api", "key": "sk-zen-key" } }"#;
        let entries: std::collections::HashMap<String, AuthEntry> =
            serde_json::from_str(raw).unwrap();
        assert!(entries.get(GO_ENTRY).is_none());
    }

    #[test]
    fn the_path_lands_under_the_users_home() {
        let path = auth_path().expect("a home directory");
        assert!(path.ends_with("opencode/auth.json") || path.ends_with("opencode\\auth.json"));
    }
}
