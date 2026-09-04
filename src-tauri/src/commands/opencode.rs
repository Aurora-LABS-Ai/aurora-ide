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
//! Those two entries are **not** two kinds of key. Both are ordinary workspace
//! keys — `sk-` plus 64 characters from the same generator — and the entry name
//! only records which slot the user pasted into. Measured against a real
//! `auth.json` holding both: each key returns the same thing on the same
//! endpoint, and what decides Go access is the **workspace's** subscription,
//! not which name the key sits under.
//!
//! This module used to claim otherwise, and refused to fall back to `opencode`
//! on the strength of it. That cost nothing when the CLI had written both, and
//! everything when it had written only the other one.
//!
//! Reading `opencode-go` first is still right — it is where a Go subscriber's
//! key normally lands — but `opencode` is a candidate, not a trap.
//!
//! Read-only, like the Cursor equivalent: Aurora never writes to another
//! product's credential store.

use serde::Deserialize;
use std::path::PathBuf;

/// Entries that can hold a usable workspace key, best first.
///
/// `opencode-go` leads because that is where a Go subscriber's key normally
/// lands. `opencode` follows because it holds the same kind of key and is
/// sometimes the only one present — a workspace with a live plan works from
/// either slot, and a workspace without one works from neither.
const KEY_ENTRIES: [&str; 2] = ["opencode-go", "opencode"];

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

    Ok(pick_key(&entries))
}

/// The first entry in [`KEY_ENTRIES`] that actually holds a key.
///
/// Split out so the selection is testable without a real credential file on
/// disk — the part worth testing is which entry wins, not whether `read_to_string`
/// works.
fn pick_key(entries: &std::collections::HashMap<String, AuthEntry>) -> Option<String> {
    KEY_ENTRIES.iter().find_map(|name| {
        entries
            .get(*name)
            .and_then(|entry| entry.key.as_deref())
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_string)
    })
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
// Rust has no such restriction. The turn itself runs through the ordinary
// adapters; the one OpenCode-specific piece on that path is the
// `x-opencode-session` header (`api::provider_kernel_adapter::apply_opencode_headers`).

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
        // 401 and 403 mean different things here and used to be reported as one.
        //
        // 401 is the key: the workspace it names does not exist or the key was
        // revoked. 403 is `EntitlementError` — the key is fine and the request
        // reached the account, but that workspace has no live Go plan. Telling
        // someone whose subscription lapsed to "check your key" sends them to
        // re-copy a key that was never the problem, which is exactly how a
        // lapsed plan looked from inside Aurora.
        return Err(match status.as_u16() {
            401 => "OpenCode rejected this key. Copy it again from your workspace's Keys page."
                .to_string(),
            403 => "This key works, but its workspace has no active OpenCode Go plan. \
                    Resubscribe, or add a key from a workspace that is subscribed."
                .to_string(),
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

    fn parse(raw: &str) -> std::collections::HashMap<String, AuthEntry> {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn the_go_entry_wins_when_both_are_present() {
        // Not because the other one is unusable — both are ordinary workspace
        // keys — but because a Go subscriber's key normally lands here, so it
        // is the better first guess.
        let entries = parse(
            r#"{
                "opencode":    { "type": "api", "key": "sk-other" },
                "opencode-go": { "type": "api", "key": "sk-go-key" }
            }"#,
        );
        assert_eq!(pick_key(&entries).as_deref(), Some("sk-go-key"));
    }

    #[test]
    fn the_plain_entry_is_used_when_the_go_one_is_absent() {
        // The case this module used to fail: a real, working key sitting in the
        // file, reported as "no OpenCode sign-in found" because of the name
        // above it.
        let entries = parse(r#"{ "opencode": { "type": "api", "key": "sk-other" } }"#);
        assert_eq!(pick_key(&entries).as_deref(), Some("sk-other"));
    }

    #[test]
    fn a_blank_key_falls_through_to_the_next_entry() {
        let entries = parse(
            r#"{
                "opencode":    { "type": "api", "key": "sk-other" },
                "opencode-go": { "type": "api", "key": "   " }
            }"#,
        );
        assert_eq!(pick_key(&entries).as_deref(), Some("sk-other"));
    }

    #[test]
    fn an_entry_shape_we_do_not_model_does_not_fail_the_read() {
        // The same file carries OAuth entries with `refresh`/`access`/`expires`
        // and no `key` at all. A strict struct would reject the whole file and
        // report "no key" over one that is sitting right there.
        let entries = parse(
            r#"{
                "openai":      { "type": "oauth", "refresh": "rt_x", "expires": 1 },
                "opencode-go": { "type": "api", "key": "sk-go-key" }
            }"#,
        );
        assert_eq!(pick_key(&entries).as_deref(), Some("sk-go-key"));
        assert!(entries.get("openai").unwrap().key.is_none());
    }

    #[test]
    fn no_usable_entry_is_not_an_error() {
        let entries = parse(r#"{ "firepass": { "type": "api", "key": "fw_x" } }"#);
        assert!(pick_key(&entries).is_none());
    }

    #[test]
    fn the_path_lands_under_the_users_home() {
        let path = auth_path().expect("a home directory");
        assert!(path.ends_with("opencode/auth.json") || path.ends_with("opencode\\auth.json"));
    }
}
