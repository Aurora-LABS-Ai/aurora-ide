//! Codex subscription usage — the data behind the settings card.
//!
//! Fetches `GET https://chatgpt.com/backend-api/wham/usage`, the same
//! endpoint Codex CLI's `/status` reads. The response nests a
//! `rate_limits` payload with a primary (5-hour) and secondary (weekly)
//! window, each carrying `used_percent`, `limit_window_seconds`,
//! `reset_after_seconds`, and `reset_at`.
//!
//! Parsing is deliberately defensive (`serde_json::Value`, every field
//! optional): the endpoint is undocumented, so a shape drift should
//! degrade the card, never error the provider.

use serde::Serialize;
use serde_json::Value;

use super::auth;
use super::{CODEX_BACKEND_BASE, CODEX_ORIGINATOR, CODEX_USER_AGENT};

/// One rate-limit window (5-hour or weekly). camelCase on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageWindow {
    /// 0–100. The backend reports integers but we keep f64 for safety.
    pub used_percent: f64,
    /// Window length in minutes (e.g. 300 for the 5-hour window).
    pub window_minutes: Option<u64>,
    /// Seconds until this window resets.
    pub resets_in_seconds: Option<i64>,
    /// Absolute reset time (unix millis).
    pub resets_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<String>,
}

/// Snapshot for the settings card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageSnapshot {
    pub plan_type: Option<String>,
    pub limit_reached: bool,
    /// Rolling 5-hour window.
    pub primary: Option<CodexUsageWindow>,
    /// Weekly window.
    pub secondary: Option<CodexUsageWindow>,
    pub credits: Option<CodexCredits>,
    pub fetched_at_ms: i64,
}

/// Fetch the current usage snapshot for the signed-in ChatGPT account.
pub async fn fetch_usage() -> Result<CodexUsageSnapshot, String> {
    let access = auth::fresh_access(false).await?;

    let mut request = reqwest::Client::new()
        .get(format!("{CODEX_BACKEND_BASE}/wham/usage"))
        .bearer_auth(&access.access_token)
        .header("User-Agent", CODEX_USER_AGENT)
        .header("originator", CODEX_ORIGINATOR)
        .header("Accept", "application/json");
    if let Some(account_id) = &access.account_id {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    let response = request
        .send()
        .await
        .map_err(|err| format!("Usage request failed: {err}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Usage request failed (HTTP {status}): {}",
            body.chars().take(160).collect::<String>()
        ));
    }

    let value: Value = serde_json::from_str(&body)
        .map_err(|err| format!("Usage response was not JSON: {err}"))?;
    Ok(parse_usage(&value))
}

/// Map the raw payload into the card snapshot. Public within the module
/// tree for tests.
pub(crate) fn parse_usage(root: &Value) -> CodexUsageSnapshot {
    // The endpoint wraps the payload in `rate_limits`; tolerate both the
    // wrapped and bare shapes.
    let payload = root.get("rate_limits").unwrap_or(root);
    let rate_limit = payload.get("rate_limit").filter(|v| !v.is_null());

    CodexUsageSnapshot {
        plan_type: payload
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        limit_reached: rate_limit
            .and_then(|rl| rl.get("limit_reached"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        primary: rate_limit
            .and_then(|rl| rl.get("primary_window"))
            .and_then(parse_window),
        secondary: rate_limit
            .and_then(|rl| rl.get("secondary_window"))
            .and_then(parse_window),
        credits: payload
            .get("credits")
            .filter(|v| !v.is_null())
            .map(|c| CodexCredits {
                has_credits: c
                    .get("has_credits")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                unlimited: c.get("unlimited").and_then(Value::as_bool).unwrap_or(false),
                balance: c
                    .get("balance")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            }),
        fetched_at_ms: chrono::Utc::now().timestamp_millis(),
    }
}

fn parse_window(window: &Value) -> Option<CodexUsageWindow> {
    if window.is_null() {
        return None;
    }
    let used_percent = window.get("used_percent").and_then(Value::as_f64)?;
    Some(CodexUsageWindow {
        used_percent,
        window_minutes: window
            .get("limit_window_seconds")
            .and_then(Value::as_u64)
            .map(|secs| secs / 60),
        resets_in_seconds: window.get("reset_after_seconds").and_then(Value::as_i64),
        resets_at_ms: window
            .get("reset_at")
            .and_then(Value::as_i64)
            .map(|secs| secs * 1000),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_wrapped_payload_with_both_windows() {
        let raw = json!({
            "rate_limits": {
                "plan_type": "plus",
                "rate_limit": {
                    "allowed": true,
                    "limit_reached": false,
                    "primary_window": {
                        "used_percent": 37,
                        "limit_window_seconds": 18000,
                        "reset_after_seconds": 4200,
                        "reset_at": 1_760_000_000
                    },
                    "secondary_window": {
                        "used_percent": 61,
                        "limit_window_seconds": 604800,
                        "reset_after_seconds": 90000,
                        "reset_at": 1_760_100_000
                    }
                },
                "credits": { "has_credits": true, "unlimited": false, "balance": "12.5" }
            }
        });
        let snap = parse_usage(&raw);
        assert_eq!(snap.plan_type.as_deref(), Some("plus"));
        assert!(!snap.limit_reached);
        let primary = snap.primary.expect("primary");
        assert_eq!(primary.used_percent, 37.0);
        assert_eq!(primary.window_minutes, Some(300));
        assert_eq!(primary.resets_in_seconds, Some(4200));
        assert_eq!(primary.resets_at_ms, Some(1_760_000_000_000));
        assert_eq!(snap.secondary.expect("secondary").window_minutes, Some(10080));
        let credits = snap.credits.expect("credits");
        assert!(credits.has_credits);
        assert_eq!(credits.balance.as_deref(), Some("12.5"));
    }

    #[test]
    fn tolerates_missing_windows_and_bare_shape() {
        let raw = json!({ "plan_type": "pro", "rate_limit": null });
        let snap = parse_usage(&raw);
        assert_eq!(snap.plan_type.as_deref(), Some("pro"));
        assert!(snap.primary.is_none());
        assert!(snap.secondary.is_none());
        assert!(snap.credits.is_none());
        assert!(!snap.limit_reached);
    }
}
