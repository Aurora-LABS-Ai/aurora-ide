//! Subscription usage for the settings card.
//!
//! `GET /api/oauth/usage` is what Claude Code's own `/usage` reads: the
//! rolling five-hour window, the seven-day window, and per-family
//! seven-day windows when the plan has them. Needs the `user:profile`
//! scope, which the sign-in requests.

use serde::{Deserialize, Serialize};

use super::auth;
use super::{CLAUDE_CODE_USER_AGENT, CLAUDE_USAGE_URL, OAUTH_BETA};

const USAGE_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// One rolling window, as the endpoint reports it.
#[derive(Debug, Clone, Deserialize)]
struct WireWindow {
    /// 0–100.
    utilization: Option<f64>,
    /// ISO 8601.
    resets_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireExtraUsage {
    is_enabled: Option<bool>,
    monthly_limit: Option<f64>,
    used_credits: Option<f64>,
    utilization: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireUsage {
    five_hour: Option<WireWindow>,
    seven_day: Option<WireWindow>,
    seven_day_opus: Option<WireWindow>,
    seven_day_sonnet: Option<WireWindow>,
    extra_usage: Option<WireExtraUsage>,
}

/// One window for the card. camelCase on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeUsageWindow {
    /// 0–100.
    pub used_percent: f64,
    pub resets_at_ms: Option<i64>,
    pub resets_in_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeExtraUsage {
    pub enabled: bool,
    pub monthly_limit: Option<f64>,
    pub used_credits: Option<f64>,
    pub used_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeUsageSnapshot {
    /// `max`, `pro`, `team`, `enterprise` — or `None` when unknown.
    ///
    /// Carried here rather than fetched separately because the context ring
    /// asks this endpoint and nothing else, and a plan block titled "Claude
    /// plan" over a Max account is a worse answer than one round trip's worth
    /// of work. It comes from the stored sign-in, not from the response.
    pub plan: Option<String>,
    /// Rolling five-hour window.
    pub five_hour: Option<ClaudeCodeUsageWindow>,
    /// Rolling seven-day window.
    pub seven_day: Option<ClaudeCodeUsageWindow>,
    pub seven_day_opus: Option<ClaudeCodeUsageWindow>,
    pub seven_day_sonnet: Option<ClaudeCodeUsageWindow>,
    pub extra_usage: Option<ClaudeCodeExtraUsage>,
    pub fetched_at_ms: i64,
}

fn window_of(wire: Option<WireWindow>, now_ms: i64) -> Option<ClaudeCodeUsageWindow> {
    let wire = wire?;
    let resets_at_ms = wire
        .resets_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis());
    Some(ClaudeCodeUsageWindow {
        used_percent: wire.utilization.unwrap_or(0.0).clamp(0.0, 100.0),
        resets_at_ms,
        resets_in_seconds: resets_at_ms.map(|at| ((at - now_ms) / 1000).max(0)),
    })
}

fn snapshot_of(wire: WireUsage, now_ms: i64, plan: Option<String>) -> ClaudeCodeUsageSnapshot {
    ClaudeCodeUsageSnapshot {
        plan,
        five_hour: window_of(wire.five_hour, now_ms),
        seven_day: window_of(wire.seven_day, now_ms),
        seven_day_opus: window_of(wire.seven_day_opus, now_ms),
        seven_day_sonnet: window_of(wire.seven_day_sonnet, now_ms),
        extra_usage: wire.extra_usage.map(|e| ClaudeCodeExtraUsage {
            enabled: e.is_enabled.unwrap_or(false),
            monthly_limit: e.monthly_limit,
            used_credits: e.used_credits,
            used_percent: e.utilization,
        }),
        fetched_at_ms: now_ms,
    }
}

/// Live usage for the signed-in account.
pub async fn fetch_usage() -> Result<ClaudeCodeUsageSnapshot, String> {
    let access = auth::fresh_access(false).await?;
    let response = reqwest::Client::builder()
        .timeout(USAGE_HTTP_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
        .get(CLAUDE_USAGE_URL)
        .bearer_auth(&access.access_token)
        .header("anthropic-beta", OAUTH_BETA)
        .header(reqwest::header::USER_AGENT, CLAUDE_CODE_USER_AGENT)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .send()
        .await
        .map_err(|err| format!("Couldn't reach the usage endpoint: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let head: String = body.trim().chars().take(160).collect();
        return Err(format!("Usage request failed (HTTP {status}): {head}"));
    }
    let wire = response
        .json::<WireUsage>()
        .await
        .map_err(|err| format!("Usage response was not in the expected shape: {err}"))?;
    // Best effort: the plan only titles the block. A sign-in whose profile
    // never came back still has real windows worth drawing.
    let plan = auth::status().ok().and_then(|status| status.plan);
    Ok(snapshot_of(
        wire,
        chrono::Utc::now().timestamp_millis(),
        plan,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_windows_claude_code_reads() {
        let now = 1_700_000_000_000;
        let wire: WireUsage = serde_json::from_value(serde_json::json!({
            "five_hour": { "utilization": 42.5, "resets_at": "2023-11-14T22:13:20Z" },
            "seven_day": { "utilization": 130.0, "resets_at": null },
            "seven_day_opus": null,
            "extra_usage": { "is_enabled": true, "monthly_limit": 100.0, "used_credits": 12.5, "utilization": 12.5 }
        }))
        .expect("wire");
        let snap = snapshot_of(wire, now, Some("max".into()));
        assert_eq!(snap.plan.as_deref(), Some("max"));
        let five = snap.five_hour.expect("five hour");
        assert_eq!(five.used_percent, 42.5);
        // 2023-11-14T22:13:20Z is exactly 1_700_000_000_000 ms; resets "now".
        assert_eq!(five.resets_at_ms, Some(1_700_000_000_000));
        assert_eq!(five.resets_in_seconds, Some(0));
        let week = snap.seven_day.expect("seven day");
        assert_eq!(week.used_percent, 100.0, "clamped to the meter's range");
        assert!(week.resets_at_ms.is_none());
        assert!(snap.seven_day_opus.is_none());
        assert!(snap.seven_day_sonnet.is_none());
        let extra = snap.extra_usage.expect("extra");
        assert!(extra.enabled);
        assert_eq!(extra.used_credits, Some(12.5));
        assert_eq!(snap.fetched_at_ms, now);
    }
}
