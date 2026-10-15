//! Subscription usage for the settings card and the composer ring.
//!
//! Two sources, cheapest first:
//!
//! - **Every model reply.** Anthropic answers each Messages request on a
//!   subscription token with `anthropic-ratelimit-unified-5h-utilization` /
//!   `-5h-reset` and the `7d` pair (a 0–1 fraction and epoch seconds). Claude
//!   Code reads them per reply (`claudeAiLimits.ts::extractRawUtilization`);
//!   the adapter hands them to [`record_headers`], so a chat keeps the numbers
//!   current at no cost.
//! - **`GET /api/oauth/usage`**, what Claude Code's own `/usage` screen reads:
//!   the same two windows plus per-family weekly windows and extra usage. It
//!   is rate limited hard (three reads in a minute were refused), so it is
//!   asked only when nothing recent is known or the person presses refresh.
//!   Needs the `user:profile` scope, which the sign-in requests.
//!
//! Both land in one per-account copy; a failed endpoint read falls back to
//! that copy rather than replacing numbers with an error.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use reqwest::header::HeaderMap;
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
    /// Per-model weekly windows (Fable). Not in the `thirdparty` source;
    /// read out of the installed Claude Code 2.1.282 bundle, where `/usage`
    /// draws every `kind: "weekly_scoped"` entry here as
    /// "Current week (<display_name>)". Kept as raw values so one entry of
    /// an unexpected shape is skipped instead of failing the whole read.
    #[serde(default)]
    limits: Option<Vec<serde_json::Value>>,
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
    /// Weekly windows for other model families (Fable, and whatever the
    /// server adds next), in the order the server sent them. Empty when the
    /// plan reports none.
    pub seven_day_models: Vec<ClaudeCodeModelWindow>,
    pub extra_usage: Option<ClaudeCodeExtraUsage>,
    pub fetched_at_ms: i64,
}

/// One model family's weekly window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeModelWindow {
    /// The server's own label, e.g. `Fable`.
    pub model: String,
    pub window: ClaudeCodeUsageWindow,
}

/// `resets_at` arrives as ISO 8601; Claude Code also accepts epoch seconds.
fn reset_ms(value: Option<&serde_json::Value>) -> Option<i64> {
    match value? {
        serde_json::Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|t| t.timestamp_millis()),
        serde_json::Value::Number(n) => n.as_f64().map(|secs| (secs * 1000.0) as i64),
        _ => None,
    }
}

/// The `weekly_scoped` entries of `limits[]`, the way Claude Code's `/usage`
/// reads them. Opus and Sonnet are skipped when their own fields already
/// drew them, so no model shows twice.
fn model_windows(
    limits: Option<&[serde_json::Value]>,
    skip: &[&str],
    now_ms: i64,
) -> Vec<ClaudeCodeModelWindow> {
    let mut out: Vec<ClaudeCodeModelWindow> = Vec::new();
    for entry in limits.unwrap_or_default() {
        if entry.get("kind").and_then(|k| k.as_str()) != Some("weekly_scoped") {
            continue;
        }
        let Some(model) = entry
            .pointer("/scope/model/display_name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if skip.iter().any(|s| s.eq_ignore_ascii_case(model))
            || out.iter().any(|w| w.model.eq_ignore_ascii_case(model))
        {
            continue;
        }
        // No percent means no reading, not 0% used.
        let Some(percent) = entry.get("percent").and_then(|p| p.as_f64()) else {
            continue;
        };
        let resets_at_ms = reset_ms(entry.get("resets_at"));
        out.push(ClaudeCodeModelWindow {
            model: model.to_string(),
            window: ClaudeCodeUsageWindow {
                used_percent: percent.clamp(0.0, 100.0),
                resets_at_ms,
                resets_in_seconds: resets_at_ms.map(|at| ((at - now_ms) / 1000).max(0)),
            },
        });
    }
    out
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
    let mut drawn: Vec<&str> = Vec::new();
    if wire.seven_day_opus.is_some() {
        drawn.push("Opus");
    }
    if wire.seven_day_sonnet.is_some() {
        drawn.push("Sonnet");
    }
    ClaudeCodeUsageSnapshot {
        plan,
        seven_day_models: model_windows(wire.limits.as_deref(), &drawn, now_ms),
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

// ---------------------------------------------------------------------------
// Per-account copy
// ---------------------------------------------------------------------------

/// How long a known reading is good enough to answer without asking the
/// endpoint. Chats refresh it on every reply; this only bounds an idle one.
const FRESH_FOR_MS: i64 = 5 * 60 * 1000;

fn known() -> &'static Mutex<HashMap<String, ClaudeCodeUsageSnapshot>> {
    static KNOWN: OnceLock<Mutex<HashMap<String, ClaudeCodeUsageSnapshot>>> = OnceLock::new();
    KNOWN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn known_for(account_id: &str) -> Option<ClaudeCodeUsageSnapshot> {
    known()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(account_id)
        .cloned()
}

fn remember(account_id: &str, snapshot: &ClaudeCodeUsageSnapshot) {
    known()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(account_id.to_string(), snapshot.clone());
}

/// One window from a reply's headers: `-utilization` is a 0–1 fraction,
/// `-reset` epoch seconds. Both must be there, as Claude Code requires.
fn header_window(headers: &HeaderMap, abbrev: &str, now_ms: i64) -> Option<ClaudeCodeUsageWindow> {
    let read = |suffix: &str| {
        headers
            .get(format!("anthropic-ratelimit-unified-{abbrev}-{suffix}"))
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<f64>().ok())
    };
    let utilization = read("utilization")?;
    let reset_secs = read("reset")?;
    let resets_at_ms = (reset_secs * 1000.0) as i64;
    Some(ClaudeCodeUsageWindow {
        used_percent: (utilization * 100.0).clamp(0.0, 100.0),
        resets_at_ms: Some(resets_at_ms),
        resets_in_seconds: Some(((resets_at_ms - now_ms) / 1000).max(0)),
    })
}

/// The two windows a reply's headers carry, laid over what is already known
/// about the account. The per-family weekly windows and extra usage only
/// come from the endpoint, so they are kept as they were.
fn merge_headers(
    previous: Option<ClaudeCodeUsageSnapshot>,
    headers: &HeaderMap,
    now_ms: i64,
) -> Option<ClaudeCodeUsageSnapshot> {
    let five_hour = header_window(headers, "5h", now_ms);
    let seven_day = header_window(headers, "7d", now_ms);
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    let mut snapshot = previous.unwrap_or(ClaudeCodeUsageSnapshot {
        plan: None,
        five_hour: None,
        seven_day: None,
        seven_day_opus: None,
        seven_day_sonnet: None,
        seven_day_models: Vec::new(),
        extra_usage: None,
        fetched_at_ms: now_ms,
    });
    if five_hour.is_some() {
        snapshot.five_hour = five_hour;
    }
    if seven_day.is_some() {
        snapshot.seven_day = seven_day;
    }
    snapshot.fetched_at_ms = now_ms;
    Some(snapshot)
}

/// Note the usage a model reply reported for `account_id`. Called by the
/// adapter on every response, successful or refused; a response without the
/// headers changes nothing.
pub fn record_headers(account_id: &str, headers: &HeaderMap) {
    let now_ms = chrono::Utc::now().timestamp_millis();
    if let Some(snapshot) = merge_headers(known_for(account_id), headers, now_ms) {
        remember(account_id, &snapshot);
    }
}

/// Countdowns move with the clock; recompute them for a stored reading.
fn as_of(mut snapshot: ClaudeCodeUsageSnapshot, now_ms: i64) -> ClaudeCodeUsageSnapshot {
    let tick = |w: &mut ClaudeCodeUsageWindow| {
        w.resets_in_seconds = w.resets_at_ms.map(|at| ((at - now_ms) / 1000).max(0));
    };
    for w in [
        &mut snapshot.five_hour,
        &mut snapshot.seven_day,
        &mut snapshot.seven_day_opus,
        &mut snapshot.seven_day_sonnet,
    ]
    .into_iter()
    .flatten()
    {
        tick(w);
    }
    for m in &mut snapshot.seven_day_models {
        tick(&mut m.window);
    }
    snapshot
}

/// Usage for the main account. `force` asks the endpoint even when a recent
/// reading is known (the card's refresh button); nothing else should.
pub async fn fetch_usage(force: bool) -> Result<ClaudeCodeUsageSnapshot, String> {
    let main = tokio::task::spawn_blocking(super::accounts::load)
        .await
        .map_err(|err| format!("Accounts task failed: {err}"))??
        .main()
        .map(|a| a.id.clone())
        .ok_or("Not signed in to Claude.")?;
    // Best effort: the plan only titles the block. A sign-in whose profile
    // never came back still has real windows worth drawing.
    let plan = auth::status().ok().and_then(|status| status.plan);
    let mut snapshot = usage_for(&main, force).await?;
    snapshot.plan = plan.or(snapshot.plan);
    Ok(snapshot)
}

/// Usage for one stored account, for the account list.
pub async fn fetch_usage_for(id: &str, force: bool) -> Result<ClaudeCodeUsageSnapshot, String> {
    usage_for(id, force).await
}

async fn usage_for(id: &str, force: bool) -> Result<ClaudeCodeUsageSnapshot, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let cached = known_for(id);
    if !force {
        if let Some(snapshot) = cached.as_ref().filter(|s| now_ms - s.fetched_at_ms < FRESH_FOR_MS) {
            return Ok(as_of(snapshot.clone(), now_ms));
        }
    }
    let fetched = async {
        let access = auth::fresh_access_for(id).await?;
        fetch_with(&access.access_token, None).await
    }
    .await;
    match fetched {
        Ok(snapshot) => {
            remember(id, &snapshot);
            Ok(snapshot)
        }
        // An older reading beats an error in place of the numbers; the card
        // says how old it is.
        Err(err) => match cached {
            Some(snapshot) => {
                crate::logging::log_warn(
                    "claude_code.usage",
                    &format!("usage read failed, showing the last known numbers: {err}"),
                );
                Ok(as_of(snapshot, now_ms))
            }
            None => Err(err),
        },
    }
}

async fn fetch_with(
    access_token: &str,
    plan: Option<String>,
) -> Result<ClaudeCodeUsageSnapshot, String> {
    let response = reqwest::Client::builder()
        .timeout(USAGE_HTTP_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
        .get(CLAUDE_USAGE_URL)
        .bearer_auth(access_token)
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
    Ok(snapshot_of(
        wire,
        chrono::Utc::now().timestamp_millis(),
        plan,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(
                reqwest::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        map
    }

    /// The header pair Claude Code reads: a 0–1 fraction and epoch seconds.
    #[test]
    fn reply_headers_become_the_two_windows() {
        let now = 1_700_000_000_000;
        let h = headers(&[
            ("anthropic-ratelimit-unified-5h-utilization", "0.42"),
            ("anthropic-ratelimit-unified-5h-reset", "1700003600"),
            ("anthropic-ratelimit-unified-7d-utilization", "0.07"),
            ("anthropic-ratelimit-unified-7d-reset", "1700600000"),
        ]);
        let snap = merge_headers(None, &h, now).expect("windows");
        let five = snap.five_hour.expect("5h");
        assert!((five.used_percent - 42.0).abs() < 1e-9);
        assert_eq!(five.resets_in_seconds, Some(3_600));
        assert!((snap.seven_day.expect("7d").used_percent - 7.0).abs() < 1e-9);
        assert_eq!(snap.fetched_at_ms, now);
    }

    /// The endpoint's extra windows survive a reply that only knows two.
    #[test]
    fn reply_headers_keep_what_only_the_endpoint_knows() {
        let now = 1_700_000_000_000;
        let wire: WireUsage = serde_json::from_value(serde_json::json!({
            "five_hour": { "utilization": 10.0, "resets_at": null },
            "seven_day_opus": { "utilization": 55.0, "resets_at": null },
            "extra_usage": { "is_enabled": true }
        }))
        .unwrap();
        let earlier = snapshot_of(wire, now - 60_000, Some("max".into()));
        let h = headers(&[
            ("anthropic-ratelimit-unified-5h-utilization", "0.5"),
            ("anthropic-ratelimit-unified-5h-reset", "1700003600"),
        ]);
        let snap = merge_headers(Some(earlier), &h, now).expect("merged");
        assert!((snap.five_hour.unwrap().used_percent - 50.0).abs() < 1e-9);
        assert_eq!(snap.seven_day_opus.unwrap().used_percent, 55.0);
        assert!(snap.extra_usage.unwrap().enabled);
        assert_eq!(snap.plan.as_deref(), Some("max"));
        assert_eq!(snap.fetched_at_ms, now);
    }

    #[test]
    fn a_reply_without_the_headers_changes_nothing() {
        assert!(merge_headers(None, &HeaderMap::new(), 0).is_none());
        // Half a pair is not a reading.
        let h = headers(&[("anthropic-ratelimit-unified-5h-utilization", "0.5")]);
        assert!(merge_headers(None, &h, 0).is_none());
    }

    /// A reading answers without the endpoint while fresh; the countdown is
    /// recomputed for the moment it is read.
    #[tokio::test]
    async fn a_fresh_reading_is_served_without_asking_the_endpoint() {
        let id = "usage-test-fresh-account";
        let now = chrono::Utc::now().timestamp_millis();
        let reset = now / 1000 + 7_200;
        record_headers(
            id,
            &headers(&[
                ("anthropic-ratelimit-unified-5h-utilization", "0.25"),
                ("anthropic-ratelimit-unified-5h-reset", &reset.to_string()),
            ]),
        );
        // No such stored account: reaching the endpoint path would fail.
        let snap = fetch_usage_for(id, false).await.expect("served from the reply's reading");
        let five = snap.five_hour.unwrap();
        assert!((five.used_percent - 25.0).abs() < 1e-9);
        assert!((7_190..=7_200).contains(&five.resets_in_seconds.unwrap()));
    }

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
        assert!(snap.seven_day_models.is_empty());
    }

    /// The `limits[]` shape from the installed Claude Code 2.1.282 bundle:
    /// `weekly_scoped` entries carry a server-named model, `percent` 0–100 and
    /// `resets_at`. Other kinds, nameless entries, entries with no reading,
    /// and a model its own field already drew are skipped. The codename
    /// `seven_day_*` fields (cowork, omelette) are not model rows.
    #[test]
    fn reads_per_model_weekly_windows_from_limits() {
        let now = 1_700_000_000_000;
        let wire: WireUsage = serde_json::from_value(serde_json::json!({
            "five_hour": { "utilization": 10.0, "resets_at": null },
            "seven_day": { "utilization": 20.0, "resets_at": null },
            "seven_day_opus": { "utilization": 5.0, "resets_at": null },
            "seven_day_sonnet": null,
            "seven_day_cowork": { "utilization": 3.0, "resets_at": null },
            "seven_day_omelette": null,
            "limits": [
                { "kind": "weekly_scoped", "group": "weekly", "percent": 37.0,
                  "resets_at": "2023-11-15T22:13:20Z",
                  "scope": { "model": { "display_name": "Fable" } } },
                { "kind": "weekly_scoped", "percent": 9.0, "resets_at": 1_700_003_600,
                  "scope": { "model": { "display_name": "Opus" } } },
                { "kind": "weekly_scoped", "percent": 12.0, "resets_at": 1_700_003_600,
                  "scope": { "model": { "display_name": "Sonnet" } } },
                { "kind": "weekly_scoped", "percent": null,
                  "scope": { "model": { "display_name": "Haiku" } } },
                { "kind": "weekly_scoped", "percent": 1.0, "scope": {} },
                { "kind": "daily", "percent": 50.0,
                  "scope": { "model": { "display_name": "Fable" } } },
                "not an object"
            ]
        }))
        .expect("wire");
        let snap = snapshot_of(wire, now, None);
        let models: Vec<(&str, f64)> = snap
            .seven_day_models
            .iter()
            .map(|m| (m.model.as_str(), m.window.used_percent))
            .collect();
        assert_eq!(models, vec![("Fable", 37.0), ("Sonnet", 12.0)]);
        assert_eq!(snap.seven_day_models[0].window.resets_in_seconds, Some(86_400));
        // Epoch seconds are accepted too.
        assert_eq!(snap.seven_day_models[1].window.resets_in_seconds, Some(3_600));
    }
}
